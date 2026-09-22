/**
 * The verification gate's tiering contract (docs/product-spec.md §6.5):
 * every Stage-3 patch exits tagged HIGH, MEDIUM, or REJECTED — never a
 * bare pass/fail. A discriminated union on `tier`, not an optional-field
 * bag, for the same reason codemods/types.ts's `CodemodResult` is one —
 * a REJECTED result missing `reason`, or a HIGH result carrying a stale
 * `characterization` field from an unrelated branch, isn't representable.
 */
export type ArtifactType = 'controller' | 'service' | 'filter' | 'directive';

export interface CompileCheckResult {
  readonly passed: boolean;
  readonly log: string;
}

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
 * anything but their own parameters. That's not an extra constraint
 * this type invents; it's a direct consequence of the §6.5 eligibility
 * criteria (no $scope/$rootScope/DOM-global/async-service reference),
 * which `eligibility.ts` (Task 4) enforces on `originalFunctionSource`
 * before any of this is used.
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

export type SandboxOutcome =
  | { readonly type: 'return'; readonly value: unknown }
  | { readonly type: 'throw'; readonly message: string };

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
   * Relative to `workspaceDir`. Optional by deliberate scope decision
   * (confirmed with the user this session): no producer of migrated spec
   * files exists yet (M1 never touches test files, M3 isn't built), so
   * this is caller-supplied and will be absent for every real input this
   * project can test against today. When present, clause 2 runs it via
   * the real Angular test runner; when absent, clause 2 is skipped
   * entirely and clause 3 (characterization) runs instead — exactly
   * §6.5's own "if no functioning coverage exists" branch.
   */
  readonly migratedSpecPath?: string;
  /** Used only when `migratedSpecPath` is absent. */
  readonly characterization?: CharacterizationTarget;
}

export type VerificationResult =
  | {
      readonly tier: 'HIGH';
      readonly artifactType: ArtifactType;
      readonly compileLog: string;
      readonly testLog: string;
    }
  | {
      readonly tier: 'MEDIUM';
      readonly artifactType: ArtifactType;
      readonly compileLog: string;
      readonly characterization: Extract<CharacterizationResult, { matched: true }>;
    }
  | {
      readonly tier: 'REJECTED';
      readonly artifactType: ArtifactType;
      readonly reason: string;
      readonly compileLog?: string;
      readonly testLog?: string;
      readonly characterization?: CharacterizationResult;
    };
