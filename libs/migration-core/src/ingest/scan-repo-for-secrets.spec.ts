import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanRepoForSecrets } from './scan-repo-for-secrets.js';

describe('scanRepoForSecrets', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'migration-core-secrets-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('finds a secret committed in a source file', async () => {
    await writeFile(join(repoRoot, 'config.js'), 'const key = "AKIAABCDEFGHIJKLMNOP";');
    expect(await scanRepoForSecrets(repoRoot)).toBe(1);
  });

  it('finds a secret in a dotfile like .env', async () => {
    await writeFile(join(repoRoot, '.env'), 'DATABASE_PASSWORD=hunter2hunter2hunter2');
    expect(await scanRepoForSecrets(repoRoot)).toBe(1);
  });

  it('returns 0 for a repo with no credential-shaped content', async () => {
    await writeFile(join(repoRoot, 'app.js'), "angular.module('app', []);");
    expect(await scanRepoForSecrets(repoRoot)).toBe(0);
  });

  it('does not scan minified vendor bundles', async () => {
    await writeFile(
      join(repoRoot, 'jquery.min.js'),
      'const key="AKIAABCDEFGHIJKLMNOP";' // a real minified file has no line breaks to hide behind
    );
    expect(await scanRepoForSecrets(repoRoot)).toBe(0);
  });

  it('does not descend into .git, even though dot-files are otherwise matched', async () => {
    await mkdir(join(repoRoot, '.git', 'objects'), { recursive: true });
    await writeFile(
      join(repoRoot, '.git', 'objects', 'leaked.json'),
      '{"key": "AKIAABCDEFGHIJKLMNOP"}'
    );
    expect(await scanRepoForSecrets(repoRoot)).toBe(0);
  });

  it('does not scan node_modules or bower_components', async () => {
    await mkdir(join(repoRoot, 'node_modules'), { recursive: true });
    await writeFile(
      join(repoRoot, 'node_modules', 'leaked.js'),
      'const key = "AKIAABCDEFGHIJKLMNOP";'
    );
    expect(await scanRepoForSecrets(repoRoot)).toBe(0);
  });

  it('aggregates findings across multiple files', async () => {
    await writeFile(join(repoRoot, 'a.js'), 'const key = "AKIAABCDEFGHIJKLMNOP";');
    await writeFile(join(repoRoot, '.env.production'), 'API_TOKEN=abcdefghijklmnop1234');
    expect(await scanRepoForSecrets(repoRoot)).toBe(2);
  });
});
