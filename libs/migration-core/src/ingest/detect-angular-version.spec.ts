import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectAngularVersion } from './detect-angular-version.js';

describe('detectAngularVersion', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'migration-core-version-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('detects AngularJS from bower.json', async () => {
    await writeFile(
      join(repoRoot, 'bower.json'),
      JSON.stringify({ dependencies: { angular: '1.5.8' } })
    );
    expect(await detectAngularVersion(repoRoot)).toEqual({
      detected: true,
      version: '1.5.8',
      source: 'bower.json',
    });
  });

  it('falls back to package.json when there is no bower.json', async () => {
    await writeFile(
      join(repoRoot, 'package.json'),
      JSON.stringify({ dependencies: { angular: '1.6.9' } })
    );
    expect(await detectAngularVersion(repoRoot)).toEqual({
      detected: true,
      version: '1.6.9',
      source: 'package.json',
    });
  });

  it('prefers bower.json over package.json when both declare angular', async () => {
    await writeFile(
      join(repoRoot, 'bower.json'),
      JSON.stringify({ dependencies: { angular: '1.5.8' } })
    );
    await writeFile(
      join(repoRoot, 'package.json'),
      JSON.stringify({ devDependencies: { angular: '1.6.9' } })
    );
    const result = await detectAngularVersion(repoRoot);
    expect(result.source).toBe('bower.json');
    expect(result.version).toBe('1.5.8');
  });

  it('does not mistake @angular/core for AngularJS', async () => {
    await writeFile(
      join(repoRoot, 'package.json'),
      JSON.stringify({ dependencies: { '@angular/core': '18.0.0' } })
    );
    expect(await detectAngularVersion(repoRoot)).toEqual({ detected: false });
  });

  it('reports not detected when neither manifest exists', async () => {
    expect(await detectAngularVersion(repoRoot)).toEqual({ detected: false });
  });

  it('reports not detected on a malformed JSON manifest rather than throwing', async () => {
    await writeFile(join(repoRoot, 'package.json'), '{ not valid json');
    await expect(detectAngularVersion(repoRoot)).resolves.toEqual({ detected: false });
  });
});
