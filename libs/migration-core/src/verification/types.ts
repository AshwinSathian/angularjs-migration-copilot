/**
 * The verification gate's tiering contract (docs/product-spec.md §6.5):
 * every migrated file exits tagged MEDIUM, LOW, or REJECTED — never a
 * bare pass/fail. HIGH is not reported in v1 (docs/decisions.md ADR-060).
 * A discriminated union on `tier`, not an optional-field bag, for the
 * same reason codemods/types.ts's `CodemodResult` is one — a REJECTED
 * result missing `failedCheck`, or a LOW result carrying a passing
 * characterization, isn't representable.
 */
export const ARTIFACT_TYPES = ['controller', 'service', 'filter', 'directive', 'route'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface CompileDiagnostic {
  /** Path as the compiler printed it — relative to the workspace root. */
  readonly file: string;
  /** e.g. `TS2322`, `NG2003`. */
  readonly code: string;
  readonly message: string;
}

/**
 * `could-not-run` (timeout, spawn failure, or a non-zero exit with no
 * parseable diagnostic) is kept apart from `diagnostics`: both fail
 * closed, but "the compiler rejected this file" and "the compiler never
 * ran" are different findings and must not share a label.
 */
export type CompileCheckResult =
  | { readonly passed: true; readonly log: string }
  | {
      readonly passed: false;
      readonly log: string;
      readonly failure: 'diagnostics' | 'could-not-run';
      readonly diagnostics: readonly CompileDiagnostic[];
    };

export interface TestSuiteCheckResult {
  readonly passed: boolean;
  readonly log: string;
}

/**
 * One parameter's real usage type, when a caller can infer it — used to
 * generate the type-based boundary values §6.5 calls for (empty string,
 * zero, null, empty array/object, one populated example). Left
 * `undefined` when it can't be inferred; boundary-value generation is
 * then skipped for that parameter rather than guessed at — same
 * "skip when ambiguous, don't guess" precedent every M1 codemod uses.
 */
export type ParameterType = 'string' | 'number' | 'boolean' | 'array' | 'object';

/**
 * Everything the characterization engine needs for one function. Both
 * source strings must be standalone, self-contained function/arrow
 * expressions callable with positional args alone — no closure over
 * anything but their own parameters. `eligibility.ts` enforces that on
 * `originalFunctionSource` (any free variable outside a small pure
 * built-in allowlist is ineligible); a `migratedFunctionSource` that
 * breaks it fails to run in the sandbox and comes back ineligible too.
 * `migratedFunctionSource` may be TypeScript; types are stripped before
 * it runs.
 */
export interface CharacterizationTarget {
  readonly artifactType: ArtifactType;
  readonly originalFunctionSource: string;
  readonly migratedFunctionSource: string;
  readonly parameterNames: readonly string[];
  readonly parameterTypes?: readonly (ParameterType | undefined)[];
  /** Literal argument tuples found at real call sites (collect-call-site-args.ts, Task 5). Caller-supplied here — this type doesn't know how they were derived. */
  readonly callSiteArgLiterals: readonly (readonly unknown[])[];
}

/**
 * `unrunnable` is an environment failure (syntax error, unresolved free
 * variable, timeout), not behaviour of the function under test. It is
 * never comparable: two sides failing the same way proves nothing.
 */
export type SandboxOutcome =
  | { readonly type: 'return'; readonly value: unknown }
  | { readonly type: 'throw'; readonly name: string; readonly message: string }
  | { readonly type: 'unrunnable'; readonly message: string };

export interface CharacterizationMismatch {
  readonly input: readonly unknown[];
  readonly original: SandboxOutcome;
  readonly migrated: SandboxOutcome;
}

export type CharacterizationResult =
  | { readonly eligible: true; readonly matched: true; readonly casesRun: number }
  | { readonly eligible: true; readonly matched: false; readonly mismatch: CharacterizationMismatch }
  | { readonly eligible: false; readonly reason: string };

export interface VerificationInput {
  /** Absolute path to an M0.5-scaffolded Angular workspace. Never the source repo. */
  readonly workspaceDir: string;
  readonly artifactType: ArtifactType;
  /** Relative to `workspaceDir`. Defaults to `tsconfig.app.json`. */
  readonly appTsConfigPath?: string;
  /**
   * Relative to `workspaceDir`. Caller-supplied; nothing in this project
   * produces a migrated spec. When present it is an extra hard gate — a
   * failure is REJECTED — but a pass does not raise the tier (ADR-060).
   */
  readonly migratedSpecPath?: string;
  readonly characterization?: CharacterizationTarget;
}

export type FailedCheck = 'compile' | 'tests' | 'characterization';

export type VerificationResult =
  | {
      readonly tier: 'MEDIUM';
      readonly artifactType: ArtifactType;
      readonly compileLog: string;
      readonly testLog?: string;
      readonly characterization: Extract<CharacterizationResult, { matched: true }>;
    }
  | {
      /** Compiled clean, behaviour not verifiable — flagged for manual review (ADR-059). */
      readonly tier: 'LOW';
      readonly artifactType: ArtifactType;
      readonly reason: string;
      readonly compileLog: string;
      readonly testLog?: string;
    }
  | {
      readonly tier: 'REJECTED';
      readonly artifactType: ArtifactType;
      readonly failedCheck: FailedCheck;
      readonly reason: string;
      readonly compileLog: string;
      readonly testLog?: string;
      readonly characterization?: Extract<CharacterizationResult, { matched: false }>;
    };

/** Everything `decideTier` needs; gathered by `runVerificationGate` or by a caller that batches the compile step. */
export interface VerificationEvidence {
  readonly artifactType: ArtifactType;
  readonly compile: CompileCheckResult;
  readonly tests?: TestSuiteCheckResult;
  readonly characterization?: CharacterizationResult;
}
