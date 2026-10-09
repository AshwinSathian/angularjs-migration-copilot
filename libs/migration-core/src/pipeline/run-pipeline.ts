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
import { assembleScript, type AssembledDeclaration } from './assemble.js';
import { pipeCharacterizationTarget } from './characterize-pipe.js';

const TEMPLATE_PATTERN = '#7 ng-control-flow';
const MIGRATED_ROOT = 'src/app/migrated';
/** An AngularJS script: registers something on, or declares, a module. */
const ANGULARJS_SCRIPT = /\bangular\s*\.\s*module\s*\(/;
/** An AngularJS template: uses an `ng-*`/`data-ng-*` directive or an interpolation. */
const ANGULARJS_TEMPLATE = /\b(?:data-)?ng-[a-z]|\{\{/;
const MAX_COMPILE_ROUNDS = 25;

export interface ArtifactRecord {
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
  readonly byArtifactType: Record<ArtifactType, TierCounts>;
  readonly compileRounds: number;
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
        const url = declaration.templateUrl.replace(/^\//, '');
        templateSource = [url, posix.join('src', url), posix.join('app', url), posix.join(posix.dirname(path), url)].find(
          (candidate) => templates.has(candidate)
        );
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

  // Compile in rounds.
  const compileResults = new Map<Pending, CompileCheckResult>();
  let remaining = [...pending];
  let compileRounds = 0;
  let lastLog = '';
  while (remaining.length > 0) {
    compileRounds++;
    const compile = await runCompileCheck(workspaceDir);
    lastLog = compile.log;
    if (compile.passed) break;

    const owner = (file: string) => {
      const normalized = toPosix(relative(workspaceDir, join(workspaceDir, file)));
      return remaining.find((item) => item.emittedPath === normalized || item.templatePath === normalized);
    };
    const failing = new Map<Pending, CompileDiagnostic[]>();
    for (const diagnostic of compile.diagnostics) {
      const item = owner(diagnostic.file);
      if (item) failing.set(item, [...(failing.get(item) ?? []), diagnostic]);
    }
    // Nothing attributable (the compiler never ran, or the errors are outside what this run emitted),
    // or the round budget is spent: fail everything left, closed, with the real log.
    const rejectAll = failing.size === 0 || compileRounds >= MAX_COMPILE_ROUNDS;
    for (const item of remaining) {
      const diagnostics = failing.get(item);
      if (!diagnostics && !rejectAll) continue;
      compileResults.set(
        item,
        diagnostics
          ? { passed: false, log: compile.log, failure: 'diagnostics', diagnostics }
          : { passed: false, log: compile.log, failure: 'could-not-run', diagnostics: [] }
      );
      await rm(join(workspaceDir, item.emittedPath), { force: true });
      if (item.templatePath) await rm(join(workspaceDir, item.templatePath), { force: true });
    }
    remaining = remaining.filter((item) => !compileResults.has(item));
  }
  for (const item of remaining) compileResults.set(item, { passed: true, log: lastLog });

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

  const files: SourceFileRecord[] = [...fileRecords].map(([sourceFile, record]) => {
    const own = artifacts.filter((a) => a.sourceFile === sourceFile || a.templateSource === sourceFile);
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
    artifacts,
    files: files.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile)),
  };
}
