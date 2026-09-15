import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AngularVersionDetection } from './types.js';

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function angularVersionFrom(manifest: Record<string, unknown> | undefined): string | undefined {
  if (!manifest) return undefined;
  const deps = manifest['dependencies'] as Record<string, string> | undefined;
  const devDeps = manifest['devDependencies'] as Record<string, string> | undefined;
  // "angular" is AngularJS 1.x; "@angular/core" or "angular2" are the
  // modern framework and its old package name — excluded so a workspace
  // mid-migration doesn't get misreported as still-AngularJS.
  return deps?.['angular'] ?? devDeps?.['angular'];
}

/**
 * Detects the AngularJS version a repo depends on, checking `bower.json`
 * first since that's how most 1.x-era apps declared it, falling back to
 * `package.json` for the (less common, usually later-era) npm-based setups.
 */
export async function detectAngularVersion(repoRoot: string): Promise<AngularVersionDetection> {
  const bower = await readJsonIfExists(join(repoRoot, 'bower.json'));
  const bowerVersion = angularVersionFrom(bower);
  if (bowerVersion) {
    return { detected: true, version: bowerVersion, source: 'bower.json' };
  }

  const pkg = await readJsonIfExists(join(repoRoot, 'package.json'));
  const pkgVersion = angularVersionFrom(pkg);
  if (pkgVersion) {
    return { detected: true, version: pkgVersion, source: 'package.json' };
  }

  return { detected: false };
}
