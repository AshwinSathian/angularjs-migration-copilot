#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createScheduler } from 'provider-scheduler';
import { Command } from 'commander';
import {
  transformArrayStyleDiToConstructor,
  transformBindingsToInput,
  transformControllerAsToClass,
  transformDirectiveToComponent,
  transformEventBusToSubject,
  transformFilterToPipe,
  transformHttpThenToHttpClient,
  transformNgDirectivesToControlFlow,
  transformRoutesToRouterConfig,
  transformScopeAssignmentToClassProperty,
  type CodemodResult,
} from './codemods/index.js';
import { runIngest } from './ingest/index.js';
import { runInventoryScan } from './inventory/index.js';
import { scaffoldTargetWorkspace, verifyWorkspaceBuilds } from './scaffold/index.js';
import { runVerificationGate } from './verification/index.js';
import { runPipeline } from './pipeline/index.js';
import {
  createMockProviders,
  createRealProviders,
  parseProvidersConfig,
  type ProvidersConfig,
  type Stage3Options,
} from './llm-fallback/index.js';

const CODEMODS: Record<string, (sourceText: string) => CodemodResult> = {
  'array-di-to-constructor': transformArrayStyleDiToConstructor,
  'scope-assignment-to-class-property': transformScopeAssignmentToClassProperty,
  'controlleras-to-class': transformControllerAsToClass,
  'directive-to-component': transformDirectiveToComponent,
  'bindings-to-input': transformBindingsToInput,
  'filter-to-pipe': transformFilterToPipe,
  'routes-to-router-config': transformRoutesToRouterConfig,
  'event-bus-to-subject': transformEventBusToSubject,
  'http-then-to-httpclient': transformHttpThenToHttpClient,
  'ng-control-flow': transformNgDirectivesToControlFlow,
};

const program = new Command();

program
  .name('angularjs-migration-copilot')
  .description(
    'Migrates AngularJS 1.x codebases to modern Angular. See https://github.com/AshwinSathian/angularjs-migration-copilot'
  );

program
  .command('inventory')
  .description(
    'Stage 0+1 only: detect tooling and produce a dependency-graph report. Report-only — makes no changes to the target repo.'
  )
  .argument('<repoPath>', 'path to the AngularJS repo to scan')
  .option('-o, --out <file>', 'write the JSON report to this file instead of stdout')
  .action(async (repoPath: string, options: { out?: string }) => {
    const repoRoot = resolve(repoPath);
    const [ingest, inventory] = await Promise.all([
      runIngest(repoRoot),
      runInventoryScan(repoRoot),
    ]);

    const report = { repoRoot, ingest, inventory };
    const json = JSON.stringify(report, null, 2);

    if (options.out) {
      await writeFile(options.out, json, 'utf8');
      console.error(`Wrote report to ${options.out}`);
    } else {
      console.log(json);
    }
  });

program
  .command('scaffold')
  .description(
    'Stage 1.5: generate a real Angular workspace via the Angular CLI into an empty output directory, then confirm it builds. Never touches the source repo.'
  )
  .argument('<outputDir>', 'empty (or non-existent) directory to generate the workspace into')
  .option('-n, --name <appName>', 'app name passed to `ng new`', 'migrated-app')
  .option('--angular-cli-version <version>', 'override the pinned Angular CLI version')
  .option('--skip-build-check', 'skip running `ng build` after scaffolding')
  .action(
    async (
      outputDir: string,
      options: { name: string; angularCliVersion?: string; skipBuildCheck?: boolean }
    ) => {
      const outDir = resolve(outputDir);
      const scaffoldResult = await scaffoldTargetWorkspace({
        outputDir: outDir,
        appName: options.name,
        angularCliVersion: options.angularCliVersion,
      });

      if (!scaffoldResult.success) {
        console.error(scaffoldResult.stderr || scaffoldResult.stdout);
        process.exitCode = 1;
        return;
      }
      console.error(`Scaffolded ${options.name} into ${outDir}`);

      if (options.skipBuildCheck) return;

      const buildResult = await verifyWorkspaceBuilds(outDir);
      if (!buildResult.success) {
        console.error(buildResult.stderr || buildResult.stdout);
        process.exitCode = 1;
        return;
      }
      console.error('ng build succeeded');
    }
  );

program
  .command('codemod')
  .description(
    'Stage 2: run one deterministic codemod pattern against a single file and print the result. Never writes back to the source repo.'
  )
  .argument('<pattern>', `pattern to run: ${Object.keys(CODEMODS).join(', ')}`)
  .argument('<filePath>', 'file to transform')
  .option('-o, --out <file>', 'write the transformed output to this file instead of stdout')
  .action(async (pattern: string, filePath: string, options: { out?: string }) => {
    const transform = CODEMODS[pattern];
    if (!transform) {
      console.error(`Unknown pattern "${pattern}". Available: ${Object.keys(CODEMODS).join(', ')}`);
      process.exitCode = 1;
      return;
    }

    const inputPath = resolve(filePath);
    const sourceText = await readFile(inputPath, 'utf8');
    const result = transform(sourceText);

    if (!result.matched) {
      console.error(`No transform applied: ${result.reason}`);
      process.exitCode = 1;
      return;
    }

    if (result.warnings?.length) {
      console.error(`Warnings (other registrations in this file left untouched):\n${result.warnings.join('\n')}`);
    }

    if (options.out) {
      const outPath = resolve(options.out);
      if (outPath === inputPath) {
        console.error('Refusing to write --out over the input file — never writes back to the source repo.');
        process.exitCode = 1;
        return;
      }
      await writeFile(outPath, result.output, 'utf8');
      console.error(`Wrote transformed file to ${outPath}`);
    } else {
      console.log(result.output);
    }
  });

program
  .command('verify')
  .description(
    'Stage 4: compile a scaffolded workspace with the Angular compiler and, if given, run one spec. Prints MEDIUM, LOW, or REJECTED; without a characterization target (library-only) the best outcome is LOW.'
  )
  .argument('<workspaceDir>', 'an M0.5-scaffolded Angular workspace directory')
  .option('-t, --artifact-type <type>', 'controller | service | filter | directive', 'service')
  .option('-s, --spec <specPath>', 'path to a migrated spec file, relative to workspaceDir, if one exists')
  .option('--ts-config <path>', 'app tsconfig path, relative to workspaceDir', 'tsconfig.app.json')
  .action(
    async (
      workspaceDir: string,
      options: { artifactType: string; spec?: string; tsConfig: string }
    ) => {
      const result = await runVerificationGate({
        workspaceDir: resolve(workspaceDir),
        artifactType: options.artifactType as 'controller' | 'service' | 'filter' | 'directive',
        appTsConfigPath: options.tsConfig,
        migratedSpecPath: options.spec,
      });

      console.log(JSON.stringify(result, null, 2));
      if (result.tier === 'REJECTED') process.exitCode = 1;
    }
  );

/** Exit code for a job paused on rate limits (BSD `EX_TEMPFAIL`): not a failure, run the same command again later. */
const EXIT_PAUSED = 75;

interface MigrateOptions {
  report?: string;
  provider?: string;
  providersConfig?: string;
  state?: string;
  tokenCap: string;
  maxOutputTokens: string;
  wait?: boolean;
}

async function stage3Options(workspaceDir: string, options: MigrateOptions): Promise<Stage3Options | undefined> {
  if (!options.provider) return undefined;
  if (options.provider !== 'mock' && options.provider !== 'real') {
    throw new Error(`--provider must be "mock" or "real", got "${options.provider}"`);
  }
  const config: ProvidersConfig = options.providersConfig
    ? parseProvidersConfig(await readFile(resolve(options.providersConfig), 'utf8'))
    : {};

  let providers;
  if (options.provider === 'mock') {
    providers = createMockProviders(config);
  } else {
    if (!options.providersConfig) {
      throw new Error('--provider real needs --providers-config <file>: models and limits are never assumed (see providers.example.json)');
    }
    const real = createRealProviders(config, process.env);
    for (const reason of real.skipped) console.error(`provider not used — ${reason}`);
    if (real.providers.length === 0) throw new Error('no real provider is usable');
    providers = real.providers;
  }

  // Mock and real keep separate state: a mock run must not spend, or be throttled by, real budgets.
  const stateDir = resolve(options.state ?? join(workspaceDir, '.migrate-state'), options.provider);
  return {
    scheduler: createScheduler({ providers, stateFile: join(stateDir, 'scheduler.json') }),
    mode: options.provider,
    cacheFile: join(stateDir, 'answers.json'),
    capTokens: Number(options.tokenCap),
    maxOutputTokens: Number(options.maxOutputTokens),
    wait: options.wait
      ? async (resumeAt) => {
          const ms = Math.max(0, resumeAt - Date.now());
          console.error(`all providers exhausted — waiting ${Math.ceil(ms / 1000)}s, until ${new Date(resumeAt).toISOString()}`);
          await new Promise((done) => setTimeout(done, ms));
        }
      : undefined,
  };
}

program
  .command('migrate')
  .description(
    'Stages 2–4 over a whole repo: apply every codemod, emit standalone Angular files into a scaffolded workspace, compile them, and tier each one MEDIUM / LOW / REJECTED. With --provider, files the codemods could not migrate go to an LLM and its patches go through the same compile and tiering. Never writes to the source repo; replaces src/app/migrated in the workspace.'
  )
  .argument('<repoPath>', 'path to the AngularJS repo')
  .argument('<workspaceDir>', 'an M0.5-scaffolded Angular workspace directory (see the scaffold command)')
  .option('-r, --report <file>', 'write the full JSON report here instead of stdout')
  .option('--provider <mode>', 'run Stage 3: "mock" (scripted, no network) or "real" (keys from GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY)')
  .option('--providers-config <file>', 'JSON: model and limits per provider; required for "real", optional limits for "mock"')
  .option('--state <dir>', 'where provider budgets and finished answers are kept (default: <workspaceDir>/.migrate-state)')
  .option('--token-cap <n>', 'source tokens per request; a larger file is split by function or class', '2000')
  .option('--max-output-tokens <n>', 'output tokens allowed per request', '3000')
  .option('--wait', 'when every provider is exhausted, wait in-process for the next window instead of exiting paused')
  .action(async (repoPath: string, workspaceDirArg: string, options: MigrateOptions) => {
    const workspaceDir = resolve(workspaceDirArg);
    const report = await runPipeline({
      repoDir: resolve(repoPath),
      workspaceDir,
      llm: await stage3Options(workspaceDir, options),
    });
    const json = JSON.stringify(report, null, 2);
    if (options.report) await writeFile(resolve(options.report), json, 'utf8');
    else console.log(json);

    const { sourceFiles, mechanical, byArtifactType, llmAssisted } = report;
    console.error(`${sourceFiles.inScope} AngularJS files in scope (${sourceFiles.scripts} scripts, ${sourceFiles.templates} templates)`);
    console.error(`mechanical — pattern matched: ${mechanical.matched} (${(mechanical.matchRate * 100).toFixed(1)}%)`);
    console.error(`mechanical — compiled in workspace: ${mechanical.compiled} (${(mechanical.compiledRate * 100).toFixed(1)}%)`);
    for (const [type, counts] of Object.entries(byArtifactType)) {
      console.error(`  ${type}: ${counts.total} emitted — MEDIUM ${counts.medium}, LOW ${counts.low}, REJECTED ${counts.rejected}`);
    }
    if (!llmAssisted) return;

    const mock = llmAssisted.provider === 'mock' ? ' [mock provider: stand-in patches, not a migration rate]' : '';
    console.error(`llm-assisted${mock} — work list: ${llmAssisted.workList} scripts`);
    console.error(`llm-assisted — patched: ${llmAssisted.patched} (${(llmAssisted.patchedRate * 100).toFixed(1)}%)`);
    console.error(`llm-assisted — compiled in workspace: ${llmAssisted.compiled} (${(llmAssisted.compiledRate * 100).toFixed(1)}%)`);
    console.error(
      `llm-assisted — empty patch: ${llmAssisted.emptyPatch}, manual review: ${llmAssisted.manualReview}, pending: ${llmAssisted.pending}`
    );
    for (const [type, counts] of Object.entries(llmAssisted.byArtifactType)) {
      console.error(`  ${type}: ${counts.total} emitted — MEDIUM ${counts.medium}, LOW ${counts.low}, REJECTED ${counts.rejected}`);
    }
    for (const [provider, usage] of Object.entries(llmAssisted.usage)) {
      console.error(`  ${provider}: ${usage.calls} calls, ${usage.rateLimited} rate-limited, ${usage.tokensIn} tokens in, ${usage.tokensOut} out`);
    }
    if (llmAssisted.status === 'paused-rate-limit') {
      console.error(`PAUSED: every provider is exhausted. Run the same command again after ${llmAssisted.resumeAt} to continue; finished answers are kept.`);
      process.exitCode = EXIT_PAUSED;
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
