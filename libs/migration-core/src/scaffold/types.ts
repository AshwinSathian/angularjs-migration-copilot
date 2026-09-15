/** Result of running a subprocess to completion. Never throws on a non-zero exit — the caller decides what that means. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ScaffoldOptions {
  /** Absolute path the workspace gets generated into. Must not already exist, or must be empty. */
  readonly outputDir: string;
  /** Name passed to `ng new`. Caller-supplied — not derived from the source repo (see PLAN-m0.5-scaffold.md Open Questions). */
  readonly appName: string;
  /** Overrides `DEFAULT_ANGULAR_CLI_VERSION`. */
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
