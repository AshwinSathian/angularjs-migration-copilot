/** Result of running a subprocess to completion. Never throws on a non-zero exit — the caller decides what that means. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Set only when `exitCode` alone would be ambiguous (it's `-1` for both
   * of these cases, and for an ordinary non-zero exit it's absent). Kept
   * separate from `exitCode` rather than folded into a bigger discriminated
   * union — this project's own reporting rules (CLAUDE.md: never smooth a
   * number that hides a distinction) need "why did it fail," not just
   * "did it fail," without redesigning every caller of `CommandResult`.
   */
  readonly reason?: 'timeout' | 'spawn-error';
}

/** True iff the command exited zero. The one place this check lives — see run-command.ts's callers. */
export function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0;
}

export interface ScaffoldOptions {
  /** Absolute path the workspace gets generated into. Must not already exist, or must be empty. */
  readonly outputDir: string;
  /**
   * Name passed to `ng new`. Caller-supplied — not derived from the source
   * repo (see PLAN-m0.5-scaffold.md Open Questions). Validated against
   * `^[a-z][a-z0-9-]*$` before use: this is an Angular CLI project name,
   * not a shell string, but an unvalidated leading `-` would still be
   * parsed by `ng new` as a flag rather than a name.
   */
  readonly appName: string;
  /**
   * Overrides `DEFAULT_ANGULAR_CLI_VERSION`. Validated as exact
   * `major.minor.patch` before use — npm's `name@npm:other-package@version`
   * alias syntax means an unvalidated version string here could silently
   * install and run an unrelated package under the `@angular/cli` name.
   */
  readonly angularCliVersion?: string;
}

export interface ScaffoldResult extends CommandResult {
  readonly success: boolean;
  readonly outputDir: string;
  readonly angularCliVersion: string;
}

export interface BuildVerificationResult extends CommandResult {
  readonly success: boolean;
}
