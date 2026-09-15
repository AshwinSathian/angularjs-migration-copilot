#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { runIngest } from './ingest/index.js';
import { runInventoryScan } from './inventory/index.js';

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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
