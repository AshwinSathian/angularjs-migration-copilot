import { mkdir, readdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { runCommand } from './run-command.js';
import { DEFAULT_ANGULAR_CLI_VERSION } from './constants.js';
import type { ScaffoldOptions, ScaffoldResult } from './types.js';

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true; // doesn't exist — `ng new` will create it
  }
}

/**
 * Generates a real Angular workspace via the Angular CLI into `outputDir`,
 * as a subprocess only — this function never imports `@angular/*`, so
 * `migration-core` stays framework-free per CLAUDE.md's module-boundary
 * rule even though this step's whole job is invoking the Angular CLI.
 *
 * `outputDir` must not already contain files: this is Stage 1.5
 * (docs/product-spec.md §6.2a) and the source repo being migrated stays
 * read-only for the entire pipeline, so refusing to write into a
 * non-empty directory is the guard against ever landing here by mistake.
 *
 * `ng new --directory` doesn't accept an absolute path — confirmed by
 * actually running it (PLAN-m0.5-scaffold.md's whole point): given an
 * absolute path it silently strips the leading `/` and nests the result
 * under the process's cwd instead of erroring. So `ng new` is always run
 * with `cwd` set to `outputDir`'s parent and only the basename passed to
 * `--directory`, which lands the workspace at exactly `outputDir`
 * regardless of what cwd the caller happens to be running from.
 */
export async function scaffoldTargetWorkspace(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const angularCliVersion = options.angularCliVersion ?? DEFAULT_ANGULAR_CLI_VERSION;

  if (!(await isEmptyOrMissing(options.outputDir))) {
    return {
      success: false,
      outputDir: options.outputDir,
      angularCliVersion,
      exitCode: -1,
      stdout: '',
      stderr: `refusing to scaffold into non-empty directory: ${options.outputDir}`,
    };
  }

  const parentDir = dirname(options.outputDir);
  await mkdir(parentDir, { recursive: true });

  const result = await runCommand(
    'npx',
    [
      '--yes',
      `@angular/cli@${angularCliVersion}`,
      'new',
      options.appName,
      '--directory',
      basename(options.outputDir),
      '--skip-git',
      '--package-manager',
      'npm',
      '--defaults',
    ],
    { cwd: parentDir }
  );

  return { ...result, success: result.exitCode === 0, outputDir: options.outputDir, angularCliVersion };
}
