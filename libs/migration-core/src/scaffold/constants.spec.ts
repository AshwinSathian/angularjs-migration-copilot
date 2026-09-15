import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANGULAR_CLI_VERSION } from './constants.js';

describe('DEFAULT_ANGULAR_CLI_VERSION', () => {
  it('matches the root package.json devDependency pin, so the two never silently drift apart', async () => {
    const rootPackageJsonPath = fileURLToPath(
      new URL('../../../../package.json', import.meta.url)
    );
    const rootPackageJson = JSON.parse(await readFile(rootPackageJsonPath, 'utf8'));

    expect(rootPackageJson.devDependencies['@angular/cli']).toBe(DEFAULT_ANGULAR_CLI_VERSION);
  });
});
