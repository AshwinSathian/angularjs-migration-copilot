import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectBuildTooling } from './detect-build-tooling.js';

describe('detectBuildTooling', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'migration-core-tooling-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('detects webpack', async () => {
    await writeFile(join(repoRoot, 'webpack.config.js'), 'module.exports = {};');
    expect(await detectBuildTooling(repoRoot)).toBe('webpack');
  });

  it('detects gulp', async () => {
    await writeFile(join(repoRoot, 'gulpfile.js'), '');
    expect(await detectBuildTooling(repoRoot)).toBe('gulp');
  });

  it('detects grunt', async () => {
    await writeFile(join(repoRoot, 'Gruntfile.js'), '');
    expect(await detectBuildTooling(repoRoot)).toBe('grunt');
  });

  it('prefers webpack when a leftover Gulpfile is also present', async () => {
    await writeFile(join(repoRoot, 'gulpfile.js'), '');
    await writeFile(join(repoRoot, 'webpack.config.js'), 'module.exports = {};');
    expect(await detectBuildTooling(repoRoot)).toBe('webpack');
  });

  it('reports none when no known build tool config exists', async () => {
    expect(await detectBuildTooling(repoRoot)).toBe('none');
  });
});
