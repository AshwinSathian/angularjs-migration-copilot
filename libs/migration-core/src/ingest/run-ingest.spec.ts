import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIngest } from './run-ingest.js';

describe('runIngest', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'migration-core-ingest-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('combines version, tooling, test runner, and secrets detection into one report', async () => {
    await writeFile(join(repoRoot, 'bower.json'), JSON.stringify({ dependencies: { angular: '1.5.8' } }));
    await writeFile(join(repoRoot, 'Gruntfile.js'), '');
    await writeFile(
      join(repoRoot, 'karma.conf.js'),
      "config.set({ browsers: ['PhantomJS'] });"
    );
    await writeFile(join(repoRoot, 'secrets.js'), 'const key = "AKIAABCDEFGHIJKLMNOP";');

    const report = await runIngest(repoRoot);

    expect(report.angularVersion).toEqual({
      detected: true,
      version: '1.5.8',
      source: 'bower.json',
    });
    expect(report.buildTool).toBe('grunt');
    expect(report.testRunner.usesPhantomJs).toBe(true);
    expect(report.secretsFound).toBe(1);
  });

  it('reports honest negatives for a repo with none of the above', async () => {
    const report = await runIngest(repoRoot);
    expect(report).toEqual({
      angularVersion: { detected: false },
      buildTool: 'none',
      testRunner: { tool: 'none', usesPhantomJs: false },
      secretsFound: 0,
    });
  });
});
