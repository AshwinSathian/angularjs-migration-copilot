#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { runIngest } from './ingest/index.js';
import { runInventoryScan } from './inventory/index.js';
import { scaffoldTargetWorkspace, verifyWorkspaceBuilds } from './scaffold/index.js';

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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
