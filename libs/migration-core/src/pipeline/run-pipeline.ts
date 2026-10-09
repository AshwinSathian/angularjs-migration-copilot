import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import fg from 'fast-glob';
import { transformNgDirectivesToControlFlow } from '../codemods/index.js';
import { DEFAULT_IGNORE, isVendoredAngularSource } from '../inventory/run-inventory-scan.js';
import {
  decideTier,
  runCharacterization,
  runCompileCheck,
  summarizeByArtifactType,
  type ArtifactType,
  type CompileCheckResult,
  type CompileDiagnostic,
  type TierCounts,
  type VerificationResult,
} from '../verification/index.js';
import type { ProviderUsage } from 'provider-scheduler';
import { generatePatch, type Generation, type Stage3Options, type WorkItem } from '../llm-fallback/index.js';
import { assembleScript, type AssembledDeclaration } from './assemble.js';
import { pipeCharacterizationTarget } from './characterize-pipe.js';

const TEMPLATE_PATTERN = '#7 ng-control-flow';
const MIGRATED_ROOT = 'src/app/migrated';
/** An AngularJS script: registers something on, or declares, a module. */
const ANGULARJS_SCRIPT = /\bangular\s*\.\s*module\s*\(/;
/** An AngularJS template: uses an `ng-*`/`data-ng-*` directive or an interpolation. */
const ANGULARJS_TEMPLATE = /\b(?:data-)?ng-[a-z]|\{\{/;
const MAX_COMPILE_ROUNDS = 25;
const LLM_PATTERN = 'llm-fallback';

export interface ArtifactRecord {
  /** Which stage produced the file (docs/product-spec.md §8). The two are never summed into one figure. */
  readonly transformType: 'mechanical' | 'llm-assisted';
  /** Provider id(s) that answered, for an llm-assisted artifact. */
  readonly providerUsed?: string;
  readonly sourceFile: string;
  readonly pattern: string;
  readonly name: string;
  readonly artifactType: ArtifactType;
  readonly emittedPath: string;
  readonly templateSource?: string;
  readonly tier: VerificationResult['tier'];
  readonly reason: string;
  readonly diagnostics: readonly CompileDiagnostic[];
  /** Work still owed for this artifact to run, even where it compiled — see `AssembledDeclaration.followUps`. */
  readonly followUps: readonly string[];
}

export interface SourceFileRecord {
  readonly sourceFile: string;
  readonly kind: 'script' | 'template';
  readonly matchedPatterns: readonly string[];
  /** Best tier among this file's emitted artifacts; `NOT_EMITTED` when a pattern matched but nothing reached the compiler. */
  readonly outcome: VerificationResult['tier'] | 'NOT_EMITTED' | 'NO_MATCH';
  readonly notes: readonly string[];
  /**
   * Stage 3's result for a file on its work list (mechanical `outcome`
   * REJECTED, NO_MATCH or NOT_EMITTED). Absent when Stage 3 did not run or
   * the file was not on the list. `outcome` above stays the mechanical one.
   */
  readonly llm?: {
    readonly status: VerificationResult['tier'] | 'EMPTY_PATCH' | 'MANUAL_REVIEW' | 'PENDING' | 'NOT_SENT';
    readonly reason: string;
    readonly providers: readonly string[];
  };
}

/** Stage 3 over the run. Script files only: a template is sent with the script that names it, never on its own. */
export interface LlmAssistedReport {
  /** `mock` or `real`. A mock run's patches are stand-ins: its numbers measure the plumbing, not a migration rate. */
  readonly provider: string;
  /** `paused-rate-limit`: every provider was exhausted. Re-running `migrate` with the same state continues from `pending`. */
  readonly status: 'complete' | 'paused-rate-limit';
  readonly resumeAt?: string;
  readonly workList: number;
  /** A valid, non-empty patch came back. The Stage 3 analogue of "matched": not yet a claim that anything compiles. */
  readonly patched: number;
  /** Files with at least one patch file the Angular compiler accepted. */
  readonly compiled: number;
  readonly emptyPatch: number;
  readonly manualReview: number;
  readonly pending: number;
  /** Over all files in scope, the same denominator as `mechanical`. */
  readonly patchedRate: number;
  readonly compiledRate: number;
  readonly byArtifactType: Record<ArtifactType, TierCounts>;
  readonly compileRounds: number;
  readonly usage: Record<string, ProviderUsage>;
}

export interface PipelineReport {
  readonly repoDir: string;
  readonly workspaceDir: string;
  readonly sourceFiles: {
    /** AngularJS scripts and templates — the denominator of every rate below. */
    readonly inScope: number;
    readonly scripts: number;
    readonly templates: number;
    readonly vendoredSkipped: number;
  };
  /**
   * Two different numbers, never to be reported as one (CLAUDE.md
   * "Reporting has to stay honest"): `matched` is what M1's own counts
   * measured — a pattern recognized something in the file. `compiled` is
   * files with at least one artifact the Angular compiler accepted.
   */
  readonly mechanical: {
    readonly matched: number;
    readonly compiled: number;
    readonly matchRate: number;
    readonly compiledRate: number;
  };
  /** Mechanical artifacts only. Stage 3's are under `llmAssisted.byArtifactType`. */
  readonly byArtifactType: Record<ArtifactType, TierCounts>;
  readonly compileRounds: number;
  /** Present only when Stage 3 ran. */
  readonly llmAssisted?: LlmAssistedReport;
  readonly artifacts: readonly ArtifactRecord[];
  readonly files: readonly SourceFileRecord[];
}

interface Pending {
  readonly sourceFile: string;
  readonly sourceText: string;
  readonly declaration: AssembledDeclaration;
  readonly emittedPath: string;
  readonly content: string;
  readonly templatePath?: string;
  readonly templateSource?: string;
}

const toPosix = (path: string) => path.split(sep).join(posix.sep);
const rate = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000);
const TIER_ORDER = ['MEDIUM', 'LOW', 'REJECTED'] as const;

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Compilation is whole-workspace, so files are judged in rounds: every
 * item the compiler names is rejected with its diagnostics and its files
 * removed, and what remains is compiled again — a file that only failed
 * because it imported a rejected one fails in its own right next round,
 * and a clean file is never rejected for a neighbour's error. Shared by
 * the mechanical stage and Stage 3 so both are judged the same way.
 */
async function compileInRounds<T>(
  workspaceDir: string,
  items: readonly T[],
  pathsOf: (item: T) => readonly string[]
): Promise<{ results: Map<T, CompileCheckResult>; rounds: number }> {
  const results = new Map<T, CompileCheckResult>();
  let remaining = [...items];
  let rounds = 0;
  let lastLog = '';
  while (remaining.length > 0) {
    rounds++;
    const compile = await runCompileCheck(workspaceDir);
    lastLog = compile.log;
    if (compile.passed) break;

    const owner = (file: string) => {
      const normalized = toPosix(relative(workspaceDir, join(workspaceDir, file)));
      return remaining.find((item) => pathsOf(item).includes(normalized));
    };
    const failing = new Map<T, CompileDiagnostic[]>();
    for (const diagnostic of compile.diagnostics) {
      const item = owner(diagnostic.file);
      if (item) failing.set(item, [...(failing.get(item) ?? []), diagnostic]);
    }
    // Nothing attributable (the compiler never ran, or the errors are outside what this run emitted),
    // or the round budget is spent: fail everything left, closed, with the real log.
    const rejectAll = failing.size === 0 || rounds >= MAX_COMPILE_ROUNDS;
    for (const item of remaining) {
      const diagnostics = failing.get(item);
      if (!diagnostics && !rejectAll) continue;
      results.set(
        item,
        diagnostics
          ? { passed: false, log: compile.log, failure: 'diagnostics', diagnostics }
          : { passed: false, log: compile.log, failure: 'could-not-run', diagnostics: [] }
      );
      for (const path of pathsOf(item)) await rm(join(workspaceDir, path), { force: true });
    }
    remaining = remaining.filter((item) => !results.has(item));
  }
  for (const item of remaining) results.set(item, { passed: true, log: lastLog });
  return { results, rounds };
}

/**
 * The artifact type of a Stage 3 file, read from what it declares. An
 * undecorated file falls back to what the AngularJS source registered.
 */
function llmArtifactType(content: string, sourceText: string): ArtifactType {
  if (/@Pipe\s*\(/.test(content)) return 'filter';
  if (/@(Component|Directive)\s*\(/.test(content)) return 'directive';
  if (/@Injectable\s*\(/.test(content)) return 'service';
  if (/:\s*Routes\b/.test(content)) return 'route';
  return /\.controller\s*\(/.test(sourceText) ? 'controller' : 'service';
}

/**
 * Stages 2 and 4 over a whole repository (docs/milestones/m2.5-assembler.md):
 * assemble every script's codemod output into standalone Angular files
 * inside an already-scaffolded workspace, compile them with the gate's
 * own compile check, and tier each emitted artifact through the gate's
 * own `decideTier`. The source repository is only ever read.
 *
 * Compilation is whole-workspace, so files are judged in rounds: every
 * emitted file the compiler names is rejected with its diagnostics and
 * removed, and what remains is compiled again — a file that only failed
 * because it imported a rejected one fails in its own right next round,
 * and a clean file is never rejected for a neighbour's error.
 */
export async function runPipeline(options: {
  readonly repoDir: string;
  readonly workspaceDir: string;
  /** Stage 3. Absent: the run is mechanical only, as before. */
  readonly llm?: Stage3Options;
}): Promise<PipelineReport> {
  const { repoDir, workspaceDir } = options;
  const paths = (await fg(['**/*.js', '**/*.html'], { cwd: repoDir, ignore: DEFAULT_IGNORE })).sort();

  const scripts = new Map<string, string>();
  const templates = new Map<string, string>();
  let vendoredSkipped = 0;
  for (const path of paths) {
    const text = await readOrUndefined(join(repoDir, path));
    if (text === undefined) continue;
    if (path.endsWith('.html')) {
      if (ANGULARJS_TEMPLATE.test(text)) templates.set(toPosix(path), text);
    } else if (isVendoredAngularSource(text)) {
      vendoredSkipped++;
    } else if (ANGULARJS_SCRIPT.test(text)) {
      scripts.set(toPosix(path), text);
    }
  }

  // Pattern #7, per template.
  const templateOutput = new Map<string, string>();
  const fileRecords = new Map<string, { kind: 'script' | 'template'; matchedPatterns: string[]; notes: string[] }>();
  for (const [path, text] of templates) {
    const result = transformNgDirectivesToControlFlow(text);
    const record = { kind: 'template' as const, matchedPatterns: [] as string[], notes: [] as string[] };
    if (result.matched) {
      templateOutput.set(path, result.output);
      record.matchedPatterns.push(TEMPLATE_PATTERN);
      record.notes.push(...(result.warnings ?? []));
    } else {
      record.notes.push(`${TEMPLATE_PATTERN}: ${result.reason}`);
    }
    fileRecords.set(path, record);
  }

  const resolveTemplate = (url: string, scriptPath: string) => {
    const bare = url.replace(/^\//, '');
    return [bare, posix.join('src', bare), posix.join('app', bare), posix.join(posix.dirname(scriptPath), bare)].find(
      (candidate) => templates.has(candidate)
    );
  };

  // Patterns #1–#6, #8–#10, per script; resolve each component's template.
  const pending: Pending[] = [];
  const takenPaths = new Set<string>();
  const ownedTemplates = new Set<string>();
  for (const [path, text] of scripts) {
    const assembled = assembleScript(path, text);
    const notes = [...assembled.notes];
    for (const declaration of assembled.declarations) {
      let emittedPath = declaration.emittedPath;
      for (let n = 2; takenPaths.has(emittedPath); n++) {
        emittedPath = declaration.emittedPath.replace(/(\.[a-z]+\.ts)$/, `-${n}$1`);
      }
      takenPaths.add(emittedPath);

      let content = declaration.content;
      let templatePath: string | undefined;
      let templateSource: string | undefined;
      if (declaration.templateUrl !== undefined) {
        templateSource = resolveTemplate(declaration.templateUrl, path);
        if (templateSource) {
          ownedTemplates.add(templateSource);
          templatePath = emittedPath.replace(/\.ts$/, '.html');
          content = content.replace(
            `templateUrl: '${declaration.templateUrl}'`,
            `templateUrl: './${posix.basename(templatePath)}'`
          );
        } else {
          notes.push(`${declaration.name}: templateUrl '${declaration.templateUrl}' not found in the repository — left as written`);
        }
      }
      pending.push({ sourceFile: path, sourceText: text, declaration, emittedPath, content, templatePath, templateSource });
    }
    fileRecords.set(path, { kind: 'script', matchedPatterns: [...assembled.matchedPatterns], notes });
  }

  // The run's own positive control: the workspace must compile before anything is emitted into it,
  // or every rejection below would be unattributable. A missing or broken workspace is an error, not a result.
  await rm(join(workspaceDir, MIGRATED_ROOT), { recursive: true, force: true });
  const baseline = await runCompileCheck(workspaceDir);
  if (!baseline.passed) {
    throw new Error(
      `workspace does not compile before migration (${baseline.failure}) — is ${workspaceDir} a scaffolded Angular workspace with dependencies installed?\n${baseline.log.trim()}`
    );
  }

  // Emit.
  for (const item of pending) {
    const target = join(workspaceDir, item.emittedPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, item.content, 'utf8');
    if (item.templatePath && item.templateSource) {
      const html = templateOutput.get(item.templateSource) ?? (templates.get(item.templateSource) as string);
      await writeFile(join(workspaceDir, item.templatePath), html, 'utf8');
    }
  }

  const pathsOfPending = (item: Pending) => (item.templatePath ? [item.emittedPath, item.templatePath] : [item.emittedPath]);
  const { results: compileResults, rounds: compileRounds } = await compileInRounds(workspaceDir, pending, pathsOfPending);

  // Tier.
  const artifacts: ArtifactRecord[] = [];
  const results: VerificationResult[] = [];
  for (const item of pending) {
    const compile = compileResults.get(item) as CompileCheckResult;
    const target =
      compile.passed && item.declaration.artifactType === 'filter'
        ? pipeCharacterizationTarget(item.sourceText, item.content)
        : undefined;
    const result = decideTier({
      artifactType: item.declaration.artifactType,
      compile,
      characterization: target ? runCharacterization(target) : undefined,
    });
    results.push(result);
    artifacts.push({
      transformType: 'mechanical',
      sourceFile: item.sourceFile,
      pattern: item.declaration.pattern,
      name: item.declaration.name,
      artifactType: item.declaration.artifactType,
      emittedPath: item.emittedPath,
      templateSource: item.templateSource,
      tier: result.tier,
      reason:
        result.tier === 'MEDIUM' ? `characterization matched on ${result.characterization.casesRun} inputs` : result.reason,
      diagnostics: compile.passed ? [] : compile.diagnostics,
      followUps: item.declaration.followUps,
    });
  }

  const mechanicalArtifacts = [...artifacts];
  let files: SourceFileRecord[] = [...fileRecords].map(([sourceFile, record]) => {
    const own = mechanicalArtifacts.filter((a) => a.sourceFile === sourceFile || a.templateSource === sourceFile);
    const best = TIER_ORDER.find((tier) => own.some((a) => a.tier === tier));
    const notes = [...record.notes];
    if (record.kind === 'template' && record.matchedPatterns.length > 0 && !ownedTemplates.has(sourceFile)) {
      notes.push('template transformed but not compiled: no migrated component references it');
    }
    return {
      sourceFile,
      kind: record.kind,
      matchedPatterns: record.matchedPatterns,
      outcome: best ?? (record.matchedPatterns.length > 0 ? 'NOT_EMITTED' : 'NO_MATCH'),
      notes,
    };
  });

  // Stage 3: everything the mechanical stage left without a compiled file.
  let llmAssisted: LlmAssistedReport | undefined;
  if (options.llm) {
    const llm = options.llm;
    const onWorkList = (file: SourceFileRecord) =>
      file.outcome === 'REJECTED' || file.outcome === 'NO_MATCH' || file.outcome === 'NOT_EMITTED';
    const compiledSiblings = pending
      .filter((item) => compileResults.get(item)?.passed)
      .map((item) => ({ path: item.emittedPath, content: item.content }));
    const workItems: WorkItem[] = files
      .filter((file) => file.kind === 'script' && onWorkList(file))
      .map((file) => {
        const sourceText = scripts.get(file.sourceFile) as string;
        const directory = posix.join(MIGRATED_ROOT, posix.dirname(file.sourceFile));
        const urls = [...sourceText.matchAll(/templateUrl\s*:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
        const templatePaths = [...new Set(urls.map((url) => resolveTemplate(url, file.sourceFile)).filter((path) => path !== undefined))];
        return {
          sourceFile: file.sourceFile,
          sourceText,
          outcome: file.outcome as WorkItem['outcome'],
          rejected: pending
            .filter((item) => item.sourceFile === file.sourceFile)
            .map((item) => {
              const compile = compileResults.get(item) as CompileCheckResult;
              return {
                content: item.content,
                diagnostics: compile.passed ? [] : compile.diagnostics,
                followUps: item.declaration.followUps,
              };
            }),
          templates: templatePaths.map((path) => ({ path, text: templates.get(path) as string })),
          siblings: [
            ...compiledSiblings.filter((sibling) => posix.dirname(sibling.path) === directory),
            ...compiledSiblings.filter((sibling) => posix.dirname(sibling.path) !== directory),
          ],
        };
      });

    // Generate. A pause stops the loop; what was answered so far is still compiled and tiered below.
    const generations = new Map<string, Generation>();
    let resumeAt: number | undefined;
    for (const item of workItems) {
      const generation = await generatePatch(item, llm);
      if (generation.status === 'paused') {
        resumeAt = generation.resumeAt;
        break;
      }
      generations.set(item.sourceFile, generation);
    }

    // Emit each patch beside where its source lived. A patch may not overwrite a file that already compiled.
    interface LlmPending {
      readonly item: WorkItem;
      readonly providers: readonly string[];
      readonly files: readonly { readonly emittedPath: string; readonly content: string }[];
    }
    const live = new Set(pending.filter((item) => compileResults.get(item)?.passed).flatMap(pathsOfPending));
    const llmPending: LlmPending[] = [];
    const llmStatus = new Map<string, NonNullable<SourceFileRecord['llm']>>();
    for (const item of workItems) {
      const generation = generations.get(item.sourceFile);
      if (!generation || generation.status === 'paused') {
        llmStatus.set(item.sourceFile, { status: 'PENDING', reason: 'providers exhausted before this file was sent', providers: [] });
        continue;
      }
      if (generation.status === 'manual-review') {
        llmStatus.set(item.sourceFile, { status: 'MANUAL_REVIEW', reason: generation.reason, providers: generation.providers });
        continue;
      }
      if (generation.status === 'empty') {
        llmStatus.set(item.sourceFile, {
          status: 'EMPTY_PATCH',
          reason: 'the provider returned no files: nothing here needs an Angular counterpart, by its account',
          providers: generation.providers,
        });
        continue;
      }
      const emitted = generation.patch.files.map((file) => ({
        emittedPath: posix.join(MIGRATED_ROOT, posix.dirname(item.sourceFile), file.path),
        content: file.content,
      }));
      const clash = emitted.find((file) => live.has(file.emittedPath));
      if (clash) {
        llmStatus.set(item.sourceFile, {
          status: 'MANUAL_REVIEW',
          reason: `patch would overwrite ${clash.emittedPath}, which another file already owns`,
          providers: generation.providers,
        });
        continue;
      }
      for (const file of emitted) {
        live.add(file.emittedPath);
        await mkdir(dirname(join(workspaceDir, file.emittedPath)), { recursive: true });
        await writeFile(join(workspaceDir, file.emittedPath), file.content, 'utf8');
      }
      llmPending.push({ item, providers: generation.providers, files: emitted });
    }

    const llmCompile = await compileInRounds(workspaceDir, llmPending, (entry) => entry.files.map((file) => file.emittedPath));

    // Tier through the same `decideTier` as mechanical output — there is no second tiering path.
    const llmResults: VerificationResult[] = [];
    for (const entry of llmPending) {
      const compile = llmCompile.results.get(entry) as CompileCheckResult;
      const own: ArtifactRecord[] = [];
      for (const file of entry.files.filter((candidate) => candidate.emittedPath.endsWith('.ts'))) {
        const artifactType = llmArtifactType(file.content, entry.item.sourceText);
        const target =
          compile.passed && artifactType === 'filter' ? pipeCharacterizationTarget(entry.item.sourceText, file.content) : undefined;
        const result = decideTier({
          artifactType,
          compile,
          characterization: target ? runCharacterization(target) : undefined,
        });
        llmResults.push(result);
        own.push({
          transformType: 'llm-assisted',
          providerUsed: entry.providers.join(', '),
          sourceFile: entry.item.sourceFile,
          pattern: LLM_PATTERN,
          name: /export\s+(?:abstract\s+)?(?:class|const|function)\s+(\w+)/.exec(file.content)?.[1] ?? posix.basename(file.emittedPath),
          artifactType,
          emittedPath: file.emittedPath,
          tier: result.tier,
          reason:
            result.tier === 'MEDIUM' ? `characterization matched on ${result.characterization.casesRun} inputs` : result.reason,
          diagnostics: compile.passed ? [] : compile.diagnostics.filter((d) => toPosix(d.file) === file.emittedPath),
          followUps: [...file.content.matchAll(/@Inject\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
            (match) => `provide '${match[1]}': an AngularJS injectable with no Angular provider yet`
          ),
        });
      }
      artifacts.push(...own);
      const best = TIER_ORDER.find((tier) => own.some((artifact) => artifact.tier === tier)) ?? 'REJECTED';
      llmStatus.set(entry.item.sourceFile, {
        status: best,
        reason: own.find((artifact) => artifact.tier === best)?.reason ?? 'patch contained no .ts file',
        providers: entry.providers,
      });
    }

    const sentWith = new Map<string, string>();
    for (const item of workItems) for (const template of item.templates) sentWith.set(template.path, item.sourceFile);
    files = files.map((file) => {
      if (!onWorkList(file)) return file;
      if (file.kind === 'script') return { ...file, llm: llmStatus.get(file.sourceFile) };
      const script = sentWith.get(file.sourceFile);
      return {
        ...file,
        llm: {
          status: 'NOT_SENT' as const,
          reason: script
            ? `templates are not sent on their own; this one went as context with ${script}`
            : 'templates are not sent on their own, and no script on the work list names this one',
          providers: [],
        },
      };
    });

    const count = (...statuses: string[]) => [...llmStatus.values()].filter((entry) => statuses.includes(entry.status)).length;
    const llmCompiled = count('MEDIUM', 'LOW');
    llmAssisted = {
      provider: llm.mode,
      status: resumeAt === undefined ? 'complete' : 'paused-rate-limit',
      resumeAt: resumeAt === undefined ? undefined : new Date(resumeAt).toISOString(),
      workList: workItems.length,
      patched: llmPending.length,
      compiled: llmCompiled,
      emptyPatch: count('EMPTY_PATCH'),
      manualReview: count('MANUAL_REVIEW'),
      pending: count('PENDING'),
      patchedRate: rate(llmPending.length, files.length),
      compiledRate: rate(llmCompiled, files.length),
      byArtifactType: summarizeByArtifactType(llmResults),
      compileRounds: llmCompile.rounds,
      usage: llm.scheduler.usage(),
    };
  }

  const inScope = files.length;
  const matched = files.filter((f) => f.matchedPatterns.length > 0).length;
  const compiled = files.filter((f) => f.outcome === 'MEDIUM' || f.outcome === 'LOW').length;
  return {
    repoDir,
    workspaceDir,
    sourceFiles: { inScope, scripts: scripts.size, templates: templates.size, vendoredSkipped },
    mechanical: { matched, compiled, matchRate: rate(matched, inScope), compiledRate: rate(compiled, inScope) },
    byArtifactType: summarizeByArtifactType(results),
    compileRounds,
    llmAssisted,
    artifacts,
    files: files.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile)),
  };
}
