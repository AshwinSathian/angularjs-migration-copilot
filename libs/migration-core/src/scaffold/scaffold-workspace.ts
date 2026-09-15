import { mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { runCommand } from './run-command.js';
import { DEFAULT_ANGULAR_CLI_VERSION } from './constants.js';
import { commandSucceeded } from './types.js';
import type { ScaffoldOptions, ScaffoldResult } from './types.js';

const APP_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Rejects anything that could turn `appName`/`angularCliVersion` into an
 * argument-injection or npm-alias-injection vector before either ever
 * reaches `spawn`. `spawn` isn't shell-interpreted, so classic shell
 * injection is already out — but a leading `-` in `appName` is still
 * parsed by `ng new` as a flag, not a name, and npm's
 * `name@npm:other-package@version` alias syntax means an unvalidated
 * `angularCliVersion` could install and run a completely different
 * package under the `@angular/cli` name.
 */
function validateScaffoldOptions(options: ScaffoldOptions, angularCliVersion: string): string | undefined {
  if (!isAbsolute(options.outputDir)) {
    return `outputDir must be an absolute path, got: ${options.outputDir}`;
  }
  if (!APP_NAME_PATTERN.test(options.appName)) {
    return `appName must match ${APP_NAME_PATTERN} (lowercase, starts with a letter), got: ${options.appName}`;
  }
  if (!EXACT_SEMVER_PATTERN.test(angularCliVersion)) {
    return `angularCliVersion must be an exact major.minor.patch version, got: ${angularCliVersion}`;
  }
  return undefined;
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; // doesn't exist — `ng new` will create it
    throw error; // EACCES, ENOTDIR, etc. — a real problem, not "safe to proceed"
  }
}

function failureResult(
  outputDir: string,
  angularCliVersion: string,
  stderr: string
): ScaffoldResult {
  return { success: false, outputDir, angularCliVersion, exitCode: -1, stdout: '', stderr };
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
 *
 * Never throws — every failure mode (bad input, an unreadable/non-empty
 * output directory, a `mkdir` failure, the Angular CLI itself failing)
 * comes back as a `ScaffoldResult` with `success: false`.
 */
export async function scaffoldTargetWorkspace(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const angularCliVersion = options.angularCliVersion ?? DEFAULT_ANGULAR_CLI_VERSION;

  const validationError = validateScaffoldOptions(options, angularCliVersion);
  if (validationError) {
    return failureResult(options.outputDir, angularCliVersion, validationError);
  }

  let parentDir: string;
  try {
    if (!(await isEmptyOrMissing(options.outputDir))) {
      return failureResult(
        options.outputDir,
        angularCliVersion,
        `refusing to scaffold into non-empty directory: ${options.outputDir}`
      );
    }
    parentDir = dirname(options.outputDir);
    await mkdir(parentDir, { recursive: true });
  } catch (error) {
    return failureResult(
      options.outputDir,
      angularCliVersion,
      `cannot prepare output directory: ${(error as Error).message}`
    );
  }

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

  return {
    ...result,
    success: commandSucceeded(result),
    outputDir: options.outputDir,
    angularCliVersion,
  };
}
