import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectTestRunner } from './detect-test-runner.js';

describe('detectTestRunner', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'migration-core-testrunner-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('reports none when there is no karma config', async () => {
    expect(await detectTestRunner(repoRoot)).toEqual({ tool: 'none', usesPhantomJs: false });
  });

  it('flags a PhantomJS launcher as the expected default failure mode', async () => {
    const configPath = join(repoRoot, 'karma.conf.js');
    await writeFile(
      configPath,
      "module.exports = function (config) { config.set({ browsers: ['PhantomJS'] }); };"
    );
    const result = await detectTestRunner(repoRoot);
    expect(result.tool).toBe('karma');
    expect(result.usesPhantomJs).toBe(true);
    expect(result.configPath).toBe(configPath);
  });

  it('does not flag a config using a modern launcher', async () => {
    await writeFile(
      join(repoRoot, 'karma.conf.js'),
      "module.exports = function (config) { config.set({ browsers: ['ChromeHeadless'] }); };"
    );
    const result = await detectTestRunner(repoRoot);
    expect(result.tool).toBe('karma');
    expect(result.usesPhantomJs).toBe(false);
  });

  it('finds a karma config under test/ when the root has none', async () => {
    await mkdir(join(repoRoot, 'test'));
    const configPath = join(repoRoot, 'test', 'karma.conf.js');
    await writeFile(configPath, "config.set({ browsers: ['PhantomJS'] });");

    const result = await detectTestRunner(repoRoot);
    expect(result).toEqual({ tool: 'karma', configPath, usesPhantomJs: true });
  });
});
