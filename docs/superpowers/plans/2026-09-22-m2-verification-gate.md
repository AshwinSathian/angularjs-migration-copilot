# M2 — Verification Gate Implementation Plan

> **Superseded 2026-10-09.** Kept as a record of how the first implementation was built. The code samples below use bare `tsc`, a HIGH tier, tier-only negative controls and a five-name eligibility check — all replaced after review (docs/decisions.md ADR-057, ADR-059–062, ADR-067). Do not implement from this file.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Stage-4 verification gate (`docs/product-spec.md §6.5`) — the pipeline component that decides whether a migrated patch is `HIGH`, `MEDIUM`, or `REJECTED` by actually compiling it, running its existing tests if any, or generating and diffing a characterization test if not.

**Architecture:** A `libs/migration-core/src/verification/` module, structured the same way `codemods/` and `scaffold/` already are: small, single-responsibility files wired together by one orchestrator (`runVerificationGate`). Clause 1 (`tsc --noEmit`) and clause 2 (existing test suite) are real subprocess runs against a real M0.5-scaffolded Angular workspace, reusing `scaffold/run-command.ts`'s `runCommand` rather than re-deriving subprocess/timeout handling. Clause 3 (characterization testing) is a self-contained engine (eligibility check → input generation → sandboxed golden-master execution → tolerant structural diff) that never touches the filesystem or a real Angular runtime — eligible functions are pure by definition (§6.5's own criteria), so they can run directly in a `node:vm` sandbox without Angular's DI or a browser-like environment.

**Tech Stack:** TypeScript, ts-morph (already a `migration-core` dependency — no new one added), `node:vm` (stdlib), Vitest, real Angular CLI subprocess calls (`tsc`, `ng test`) against a real scaffolded workspace.

**Spec:** `docs/product-spec.md §6.5` (Stage 4 definition), `docs/architecture.md §6.4` ("Guard the Guards" — the human-review requirement this plan operationalizes), `docs/milestones/m2-verification.md` (scope + definition of done), `docs/decisions.md` ADR-048 (most recent shared-infra precedent this plan follows).

## Global Constraints

- `libs/migration-core` has zero `@nestjs/*`/`@angular/*` dependencies, framework-wise (CLAUDE.md module boundary). Every real Angular-workspace interaction in this plan is a subprocess call (`tsc`, `ng test` via `npx`), never an `@angular/*` import — same discipline `scaffold/` already established.
- The source repo being migrated stays read-only for the whole pipeline (`docs/product-spec.md §6.2a`). This module only ever reads from and writes into the **scaffolded target workspace** (M0.5's output), never the original AngularJS repo.
- **Any change to `libs/migration-core/verification/` requires human review before merge, regardless of how confident CI looks — CLAUDE.md, non-negotiable.** `docs/milestones/m2-verification.md` states it more strongly: this code is "human-written or human-reviewed line by line, not Claude-Code-authored without heavy scrutiny." Per the user's own explicit choice for this milestone (recorded in session), the authorship model is: draft with the same TDD + multi-round adversarial review cadence M1 used, but **nothing in this directory merges until the user has read every line themselves** — not a PR skim. Flag this again at the point a PR is opened, don't just note it once here.
- Package manager is npm, Node 24. Test runner is Vitest (`npx vitest run <path>` from repo root, or `npx nx test migration-core`).
- Every file the gate verifies exits tagged **HIGH**, **MEDIUM**, or **REJECTED** — never a bare pass/fail (`§6.5`).
- Characterization-eligibility criteria are exact, not approximated (`§6.5`): a function qualifies only if it (a) doesn't reference `$scope`/`$rootScope`/DOM globals beyond its own parameters, (b) doesn't call `$http`/`$q`/`$timeout`/other async/side-effecting services, (c) returns a value derived only from its inputs.
- Reporting is broken down by artifact type (controller/service/filter/directive), never a single smoothed aggregate (CLAUDE.md, `§6.5`).
- `docs/milestones/m2-verification.md`'s definition of done: the gate correctly returns REJECTED on all three planted negative-control fixtures in `libs/migration-core/verification/__fixtures__/negative-controls/`. This isn't a one-time check — it's a permanent CI regression contract (the `.github/workflows/ci.yml` comment already reserves the job name `verification-negative-controls` for it).
- Never accept an AI-generated change without independent verification (`§6.5` line 18) — this is why an *ineligible* characterization target (can't be verified by any of the three methods) resolves to REJECTED, not a silent pass. This is a design decision made in this plan (see Task 9), not lifted verbatim from the spec text — flag it to the user as such when the PR opens.

---

## File Structure

```
libs/migration-core/src/verification/
  types.ts                          # Task 1 — the whole module's discriminated-union contract
  check-compiles.ts                 # Task 2 — clause 1: tsc --noEmit
  check-compiles.spec.ts
  run-existing-tests.ts             # Task 3 — clause 2: ng test --include
  run-existing-tests.spec.ts
  characterization/
    eligibility.ts                  # Task 4
    eligibility.spec.ts
    collect-call-site-args.ts       # Task 5
    collect-call-site-args.spec.ts
    boundary-values.ts              # Task 6
    boundary-values.spec.ts
    sandbox-run.ts                  # Task 7 — node:vm execution + diff.ts's tolerant compare
    diff.ts
    sandbox-run.spec.ts
    diff.spec.ts
    run-characterization.ts         # Task 8 — orchestrates the above into clause 3
    run-characterization.spec.ts
  run-verification-gate.ts          # Task 9 — orchestrates clauses 1 → 2 → 3, assigns tier
  run-verification-gate.spec.ts
  summarize-verification-results.ts # Task 11 — artifact-type breakdown reporting
  summarize-verification-results.spec.ts
  index.ts                          # Task 12 — barrel export

libs/migration-core/verification/__fixtures__/negative-controls/
  README.md                         # already exists, unchanged
  01-compile-error/broken.ts        # Task 10
  02-failing-test/module.ts         # Task 10
  02-failing-test/module.spec.ts    # Task 10
  03-characterization-mismatch/original.js    # Task 10
  03-characterization-mismatch/migrated.ts    # Task 10
  negative-controls.integration.spec.ts       # Task 10 — the real, unmocked, CI-gated test

libs/migration-core/src/scaffold/index.ts     # Task 0 — export runCommand
libs/migration-core/src/cli.ts                # Task 13 — wire the `verify` command
.github/workflows/ci.yml                      # Task 14 — the verification-negative-controls job
docs/decisions.md, docs/PROGRESS.md, docs/milestones/m2-verification.md  # Task 14
```

---

### Task 0: Export `runCommand` from `scaffold/index.ts`

`scaffold/run-command.ts`'s `runCommand` (subprocess spawn, whole-process-tree timeout/kill, never throws) is exactly what clauses 1 and 2 need for running `tsc`/`ng test`. It already exists and is already tested (`run-command.spec.ts`) — this task only adds it to the module's public exports so `verification/` can import it without reaching into `scaffold/`'s internals.

**Files:**
- Modify: `libs/migration-core/src/scaffold/index.ts`

**Interfaces:**
- Produces: `runCommand(command: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult>` — importable as `import { runCommand } from '../scaffold/index.js'`.

- [ ] **Step 1: Add the export**

```ts
// libs/migration-core/src/scaffold/index.ts
export { scaffoldTargetWorkspace } from './scaffold-workspace.js';
export { verifyWorkspaceBuilds } from './verify-workspace-build.js';
export { runCommand } from './run-command.js';
export { DEFAULT_ANGULAR_CLI_VERSION } from './constants.js';
export { commandSucceeded } from './types.js';
export type {
  BuildVerificationResult,
  CommandResult,
  ScaffoldOptions,
  ScaffoldResult,
} from './types.js';
```

- [ ] **Step 2: Confirm the existing suite still passes (pure addition, no behavior change)**

Run: `npx vitest run libs/migration-core/src/scaffold/run-command.spec.ts`
Expected: PASS, unchanged test count.

- [ ] **Step 3: Commit**

```bash
git add libs/migration-core/src/scaffold/index.ts
git commit -m "M2: export runCommand from scaffold/index.ts for verification/ to reuse"
```

---

### Task 1: `verification/types.ts`

The module's whole contract, written first so every later task implements against fixed signatures — same discipline `codemods/types.ts` established for `CodemodResult`.

**Files:**
- Create: `libs/migration-core/src/verification/types.ts`

**Interfaces:**
- Produces every type every later task consumes. No test file — this is a pure type-only module (no runtime behavior to assert against); its correctness is enforced by every later task's `tsc` compile succeeding against it.

- [ ] **Step 1: Write the file**

```ts
// libs/migration-core/src/verification/types.ts
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
```

- [ ] **Step 2: Confirm it compiles standalone**

Run: `npx tsc --noEmit libs/migration-core/src/verification/types.ts --strict --target es2022 --module esnext --moduleResolution bundler`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add libs/migration-core/src/verification/types.ts
git commit -m "M2: add verification module's type contract"
```

---

### Task 2: `check-compiles.ts` — clause 1 (`tsc --noEmit`)

Real, verified command (confirmed by actually scaffolding a workspace and running it this session, both against a clean workspace and against one with a deliberately injected error): `npx tsc -p tsconfig.app.json --noEmit`, run with `cwd` set to the workspace directory. Exit `0` on a clean compile, non-zero (confirmed `2` for a real type error) otherwise.

**Files:**
- Create: `libs/migration-core/src/verification/check-compiles.ts`
- Test: `libs/migration-core/src/verification/check-compiles.spec.ts`

**Interfaces:**
- Consumes: `runCommand` from `../scaffold/index.js` (Task 0).
- Produces: `runCompileCheck(workspaceDir: string, appTsConfigPath?: string): Promise<CompileCheckResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// libs/migration-core/src/verification/check-compiles.spec.ts
import { describe, expect, it, vi } from 'vitest';

const runCommandMock = vi.fn();
vi.mock('../scaffold/index.js', () => ({ runCommand: (...args: unknown[]) => runCommandMock(...args) }));

const { runCompileCheck } = await import('./check-compiles.js');

describe('runCompileCheck', () => {
  it('runs tsc --noEmit against the app tsconfig, cwd set to the workspace', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await runCompileCheck('/ws');

    expect(runCommandMock).toHaveBeenCalledWith(
      'npx',
      ['tsc', '-p', 'tsconfig.app.json', '--noEmit'],
      { cwd: '/ws' }
    );
  });

  it('accepts a non-default app tsconfig path', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await runCompileCheck('/ws', 'tsconfig.custom.json');

    expect(runCommandMock).toHaveBeenCalledWith(
      'npx',
      ['tsc', '-p', 'tsconfig.custom.json', '--noEmit'],
      { cwd: '/ws' }
    );
  });

  it('passed is true on a zero exit code', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const result = await runCompileCheck('/ws');
    expect(result.passed).toBe(true);
  });

  it('passed is false and log carries stderr on a non-zero exit code', async () => {
    runCommandMock.mockResolvedValue({
      exitCode: 2,
      stdout: '',
      stderr: `src/app/broken.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
    });
    const result = await runCompileCheck('/ws');
    expect(result.passed).toBe(false);
    expect(result.log).toContain('TS2322');
  });

  it('log includes both stdout and stderr — tsc puts diagnostics on stdout, not stderr', async () => {
    runCommandMock.mockResolvedValue({
      exitCode: 2,
      stdout: `src/app/broken.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
      stderr: '',
    });
    const result = await runCompileCheck('/ws');
    expect(result.log).toContain('TS2322');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/migration-core/src/verification/check-compiles.spec.ts`
Expected: FAIL — `Failed to resolve import "./check-compiles.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/migration-core/src/verification/check-compiles.ts
import { runCommand } from '../scaffold/index.js';
import type { CompileCheckResult } from './types.js';

const DEFAULT_APP_TSCONFIG = 'tsconfig.app.json';

/**
 * Runs `tsc -p <appTsConfigPath> --noEmit` inside `workspaceDir` — a
 * real, M0.5-scaffolded Angular workspace, never the source repo. This
 * is Stage 4 clause 1 (docs/product-spec.md §6.5): a hard fail here is
 * an immediate REJECTED, no need to run clauses 2/3.
 *
 * Deliberately `tsc`, not `ng build`: §6.5 names `tsc --noEmit`
 * specifically, distinct from M0.5's own `ng build`-based
 * `verifyWorkspaceBuilds` (which confirms the *whole scaffolded
 * workspace* builds once, at scaffold time) — this check runs once per
 * migrated file/patch, and `tsc --noEmit` is faster than a full build
 * while still exercising real Angular decorator/template type-checking
 * via `tsconfig.app.json`'s `angularCompilerOptions` — confirmed by
 * actually running it against a real scaffolded workspace, both clean
 * (exit 0) and with an injected type error (exit 2, diagnostic on
 * stdout).
 */
export async function runCompileCheck(
  workspaceDir: string,
  appTsConfigPath: string = DEFAULT_APP_TSCONFIG
): Promise<CompileCheckResult> {
  const result = await runCommand('npx', ['tsc', '-p', appTsConfigPath, '--noEmit'], { cwd: workspaceDir });
  return {
    passed: result.exitCode === 0,
    log: `${result.stdout}${result.stderr}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/migration-core/src/verification/check-compiles.spec.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add libs/migration-core/src/verification/check-compiles.ts libs/migration-core/src/verification/check-compiles.spec.ts
git commit -m "M2: clause 1 — tsc --noEmit compile check"
```

---

### Task 3: `run-existing-tests.ts` — clause 2 (existing test suite)

Real, verified command: `npx ng test --watch=false --include <specPath>` inside the workspace. Confirmed against a real scaffolded workspace: exit `0` with the default passing spec, exit `1` with a spec containing a deliberately failing `it()` (verified directly — first probe attempt piped through `tail` and silently observed the wrong exit code, a reminder that `$?` after a pipe is the last command's, not the one you meant; re-verified without the pipe).

**Files:**
- Create: `libs/migration-core/src/verification/run-existing-tests.ts`
- Test: `libs/migration-core/src/verification/run-existing-tests.spec.ts`

**Interfaces:**
- Consumes: `runCommand` from `../scaffold/index.js`.
- Produces: `runExistingTestSuite(workspaceDir: string, specPath: string): Promise<TestSuiteCheckResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// libs/migration-core/src/verification/run-existing-tests.spec.ts
import { describe, expect, it, vi } from 'vitest';

const runCommandMock = vi.fn();
vi.mock('../scaffold/index.js', () => ({ runCommand: (...args: unknown[]) => runCommandMock(...args) }));

const { runExistingTestSuite } = await import('./run-existing-tests.js');

describe('runExistingTestSuite', () => {
  it('runs ng test scoped to the one migrated spec, watch disabled', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await runExistingTestSuite('/ws', 'src/app/foo.spec.ts');

    expect(runCommandMock).toHaveBeenCalledWith(
      'npx',
      ['ng', 'test', '--watch=false', '--include', 'src/app/foo.spec.ts'],
      { cwd: '/ws' }
    );
  });

  it('passed is true on a zero exit code', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: 'Tests  2 passed (2)', stderr: '' });
    const result = await runExistingTestSuite('/ws', 'src/app/foo.spec.ts');
    expect(result.passed).toBe(true);
  });

  it('passed is false on a non-zero exit code, and log carries the failure output', async () => {
    runCommandMock.mockResolvedValue({
      exitCode: 1,
      stdout: 'FAIL src/app/foo.spec.ts\nexpected 1 to be 2',
      stderr: '',
    });
    const result = await runExistingTestSuite('/ws', 'src/app/foo.spec.ts');
    expect(result.passed).toBe(false);
    expect(result.log).toContain('expected 1 to be 2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/migration-core/src/verification/run-existing-tests.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/migration-core/src/verification/run-existing-tests.ts
import { runCommand } from '../scaffold/index.js';
import type { TestSuiteCheckResult } from './types.js';

/**
 * Runs the one migrated spec file — via `ng test --include`, not the
 * whole workspace's suite — inside a real M0.5-scaffolded workspace.
 * Stage 4 clause 2 (docs/product-spec.md §6.5). `--include` accepts a
 * bare file path (not just a glob), confirmed against a real scaffolded
 * workspace. `--watch=false` is required: `ng test`'s own default is
 * `true` in a TTY, which would hang this call forever.
 *
 * Confirmed the real exit code on failure by direct execution (initial
 * probe piped through `tail` and silently observed `tail`'s own exit
 * code instead — re-run without the pipe): a failing spec exits `1`,
 * not `0`, so a plain non-zero check is correct here.
 */
export async function runExistingTestSuite(
  workspaceDir: string,
  specPath: string
): Promise<TestSuiteCheckResult> {
  const result = await runCommand(
    'npx',
    ['ng', 'test', '--watch=false', '--include', specPath],
    { cwd: workspaceDir }
  );
  return {
    passed: result.exitCode === 0,
    log: `${result.stdout}${result.stderr}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/migration-core/src/verification/run-existing-tests.spec.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add libs/migration-core/src/verification/run-existing-tests.ts libs/migration-core/src/verification/run-existing-tests.spec.ts
git commit -m "M2: clause 2 — existing migrated-spec test run"
```

---

### Task 4: `characterization/eligibility.ts`

Implements §6.5's exact eligibility definition against `CharacterizationTarget.originalFunctionSource`, via a private ts-morph `Project` — same "own private Project, source text in, never touches the caller's tree" discipline `codemods/types.ts` documents for every codemod.

**Before writing detection code**, per this project's standing practice (every M1 pattern gathered real-fixture evidence first): grep the three vendored fixtures for candidate service/filter functions and spot-check a handful by hand against these three criteria, to confirm the AST shapes below (bare identifier references to `$scope`/`$rootScope`, `document`/`window`/`navigator` globals, calls to `$http`/`$q`/`$timeout`/`$interval`/`$animate`) are the real shapes worth checking, not a guessed-at list. Record what's found in the PR description, same as every M1 pattern's own evidence paragraph.

**Files:**
- Create: `libs/migration-core/src/verification/characterization/eligibility.ts`
- Test: `libs/migration-core/src/verification/characterization/eligibility.spec.ts`

**Interfaces:**
- Consumes: `ts-morph`'s `Project`.
- Produces: `checkEligibility(functionSource: string): { readonly eligible: true } | { readonly eligible: false; readonly reason: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// libs/migration-core/src/verification/characterization/eligibility.spec.ts
import { describe, expect, it } from 'vitest';
import { checkEligibility } from './eligibility.js';

describe('checkEligibility', () => {
  it('accepts a pure function referencing only its own parameters', () => {
    const result = checkEligibility('function total(items) { return items.reduce((a, b) => a + b, 0); }');
    expect(result.eligible).toBe(true);
  });

  it('accepts a pure arrow function', () => {
    const result = checkEligibility('(price, taxRate) => price * (1 + taxRate)');
    expect(result.eligible).toBe(true);
  });

  it('rejects a function referencing $scope', () => {
    const result = checkEligibility('function greet() { return "hi " + $scope.name; }');
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/\$scope/);
  });

  it('rejects a function referencing $rootScope', () => {
    const result = checkEligibility('function isLoggedIn() { return !!$rootScope.user; }');
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/\$rootScope/);
  });

  it('rejects a function referencing a DOM global not among its own parameters', () => {
    const result = checkEligibility('function title() { return document.title; }');
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/document/);
  });

  it('does not reject a parameter merely named like a DOM global — it is a parameter, not the global', () => {
    const result = checkEligibility('function f(document) { return document.length; }');
    expect(result.eligible).toBe(true);
  });

  it('rejects a function calling $http', () => {
    const result = checkEligibility('function load($http) { return $http.get("/api"); }');
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/\$http/);
  });

  it('rejects a function calling $q', () => {
    const result = checkEligibility('function defer($q) { return $q.defer(); }');
    expect(result.eligible).toBe(false);
  });

  it('rejects a function calling $timeout', () => {
    const result = checkEligibility('function delay($timeout, fn) { return $timeout(fn, 100); }');
    expect(result.eligible).toBe(false);
  });

  it('rejects a function with no return statement — nothing to diff against a golden master', () => {
    const result = checkEligibility('function log(msg) { console.log(msg); }');
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/return/);
  });

  it('rejects unparseable source rather than throwing', () => {
    const result = checkEligibility('function broken( {{{');
    expect(result.eligible).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/migration-core/src/verification/characterization/eligibility.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/migration-core/src/verification/characterization/eligibility.ts
import { Node, Project, SyntaxKind } from 'ts-morph';

/**
 * §6.5's exact characterization-eligibility definition, implemented
 * exactly rather than approximated (docs/milestones/m2-verification.md's
 * own scope note): a function qualifies only if it (a) doesn't reference
 * `$scope`/`$rootScope`/a DOM global beyond its own parameters, (b)
 * doesn't call one of the known async/side-effecting Angular services,
 * (c) returns a value derived only from its inputs.
 *
 * (c) is enforced heuristically, not proven: "has at least one `return`
 * with an expression" is a necessary, not sufficient, condition for
 * input-only derivation — a function could still close over external
 * state through some path (a) and (b) don't catch. Documented as an
 * accepted limitation, same precedent as assert-compiles.ts's own
 * ignored-diagnostic list and assert-valid-template.ts's brace-balance
 * gap: a false positive here (accepting a function that isn't really
 * pure) still gets caught downstream by the golden-master diff itself
 * disagreeing, so it degrades to a REJECTED rather than a silent wrong
 * accept.
 */
const DISALLOWED_BARE_REFERENCES = ['$scope', '$rootScope', 'document', 'window', 'navigator'];
const DISALLOWED_SERVICE_CALLS = ['$http', '$q', '$timeout', '$interval', '$animate'];

function parseAsFunction(functionSource: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('/virtual/target.ts', `const __target = ${functionSource};`, {
    overwrite: true,
  });
  const declaration = sourceFile.getVariableDeclarationOrThrow('__target');
  const initializer = declaration.getInitializer();
  if (!initializer || !(Node.isFunctionExpression(initializer) || Node.isArrowFunction(initializer))) {
    return undefined;
  }
  return initializer;
}

export function checkEligibility(
  functionSource: string
): { readonly eligible: true } | { readonly eligible: false; readonly reason: string } {
  let fn;
  try {
    fn = parseAsFunction(functionSource);
  } catch {
    fn = undefined;
  }
  if (!fn) return { eligible: false, reason: 'not a parseable standalone function or arrow expression' };

  const ownParamNames = new Set(fn.getParameters().map((p) => p.getName()));

  for (const identifier of fn.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const name = identifier.getText();
    if (!DISALLOWED_BARE_REFERENCES.includes(name)) continue;
    if (ownParamNames.has(name)) continue; // a parameter merely named like a global is not the global
    // Exclude the parameter-declaration site itself and property-access names (`x.document`).
    if (Node.isParameterDeclaration(identifier.getParent())) continue;
    const parent = identifier.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) continue;
    return { eligible: false, reason: `references ${name}, disallowed by §6.5 eligibility criterion (a)` };
  }

  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const calleeText = Node.isPropertyAccessExpression(expr) ? expr.getExpression().getText() : expr.getText();
    if (DISALLOWED_SERVICE_CALLS.includes(calleeText) || DISALLOWED_SERVICE_CALLS.includes(expr.getText())) {
      return {
        eligible: false,
        reason: `calls ${expr.getText()}, disallowed by §6.5 eligibility criterion (b)`,
      };
    }
  }

  const hasReturnWithValue = fn.getDescendantsOfKind(SyntaxKind.ReturnStatement).some((r) => r.getExpression())
    || (Node.isArrowFunction(fn) && !Node.isBlock(fn.getBody()));
  if (!hasReturnWithValue) {
    return { eligible: false, reason: 'no return statement with a value — nothing to diff against a golden master' };
  }

  return { eligible: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/migration-core/src/verification/characterization/eligibility.spec.ts`
Expected: PASS, 11/11.

- [ ] **Step 5: Commit**

```bash
git add libs/migration-core/src/verification/characterization/eligibility.ts libs/migration-core/src/verification/characterization/eligibility.spec.ts
git commit -m "M2: characterization eligibility check (§6.5 criteria a/b/c)"
```

---

### Task 5: `characterization/collect-call-site-args.ts`

Collects literal argument tuples from every real call site of a named function, project-wide — reuses the `findReferencesAsNodes()`-based symbol-resolution discipline `class-wrapping.ts` already established (real symbol binding, not text matching), applied here to *read* call arguments rather than to guard a deletion.

**Files:**
- Create: `libs/migration-core/src/verification/characterization/collect-call-site-args.ts`
- Test: `libs/migration-core/src/verification/characterization/collect-call-site-args.spec.ts`

**Interfaces:**
- Consumes: `ts-morph`'s `Project`, `FunctionDeclaration`.
- Produces: `collectCallSiteArgLiterals(project: Project, functionName: string): readonly (readonly unknown[])[]`. Only literal (string/number/boolean/array-of-literals/object-of-literals) argument tuples are collected; a call with any non-literal argument is skipped whole (conservative — no partial-tuple guessing).

- [ ] **Step 1: Write the failing test**

```ts
// libs/migration-core/src/verification/characterization/collect-call-site-args.spec.ts
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { collectCallSiteArgLiterals } from './collect-call-site-args.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(path, content);
  }
  return project;
}

describe('collectCallSiteArgLiterals', () => {
  it('collects literal argument tuples from real call sites', () => {
    const project = projectWith({
      '/def.ts': 'function total(a, b) { return a + b; }',
      '/use.ts': 'import {} from "./def"; total(1, 2); total(3, 4);',
    });
    const results = collectCallSiteArgLiterals(project, 'total');
    expect(results).toContainEqual([1, 2]);
    expect(results).toContainEqual([3, 4]);
  });

  it('collects string, boolean, array, and object literal arguments', () => {
    const project = projectWith({
      '/def.ts': 'function f(s, b, arr, obj) { return s; }',
      '/use.ts': 'f("x", true, [1, 2], { k: "v" });',
    });
    const results = collectCallSiteArgLiterals(project, 'f');
    expect(results).toContainEqual(['x', true, [1, 2], { k: 'v' }]);
  });

  it('skips a call whose arguments include a non-literal expression', () => {
    const project = projectWith({
      '/def.ts': 'function f(a) { return a; }',
      '/use.ts': 'const x = compute(); f(x); f(5);',
    });
    const results = collectCallSiteArgLiterals(project, 'f');
    expect(results).toEqual([[5]]);
  });

  it('deduplicates identical argument tuples', () => {
    const project = projectWith({
      '/def.ts': 'function f(a) { return a; }',
      '/use.ts': 'f(1); f(1); f(1);',
    });
    const results = collectCallSiteArgLiterals(project, 'f');
    expect(results).toEqual([[1]]);
  });

  it('returns an empty array when the function has no real call sites', () => {
    const project = projectWith({ '/def.ts': 'function unused(a) { return a; }' });
    expect(collectCallSiteArgLiterals(project, 'unused')).toEqual([]);
  });

  it('returns an empty array when no function of that name exists', () => {
    const project = projectWith({ '/def.ts': 'function other(a) { return a; }' });
    expect(collectCallSiteArgLiterals(project, 'missing')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/migration-core/src/verification/characterization/collect-call-site-args.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/migration-core/src/verification/characterization/collect-call-site-args.ts
import { Node, Project, SyntaxKind } from 'ts-morph';

function literalValue(node: Node): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return { ok: true, value: node.getLiteralText() };
  if (Node.isNumericLiteral(node)) return { ok: true, value: Number(node.getText()) };
  if (node.getKind() === SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (node.getKind() === SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (node.getKind() === SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (Node.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const el of node.getElements()) {
      const r = literalValue(el);
      if (!r.ok) return { ok: false };
      values.push(r.value);
    }
    return { ok: true, value: values };
  }
  if (Node.isObjectLiteralExpression(node)) {
    const obj: Record<string, unknown> = {};
    for (const prop of node.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) return { ok: false };
      const name = prop.getName();
      const valueNode = prop.getInitializer();
      if (!valueNode) return { ok: false };
      const r = literalValue(valueNode);
      if (!r.ok) return { ok: false };
      obj[name] = r.value;
    }
    return { ok: true, value: obj };
  }
  return { ok: false };
}

function tupleKey(tuple: readonly unknown[]): string {
  return JSON.stringify(tuple);
}

/**
 * Every literal argument tuple found at a real call site of a
 * function/method named `functionName`, anywhere in `project`, deduped.
 * §6.5: "seed inputs are drawn from... literal argument values found at
 * every existing call-site of the function across the codebase." A call
 * with any non-literal argument (a variable, a computed expression) is
 * skipped whole, not partially substituted — no evidence in this
 * project's own vendored fixtures yet justifies guessing at a partial
 * tuple, and a wrong guessed input would produce false confidence in
 * exactly the way §6.5 explicitly warns against for the single-input
 * degenerate case.
 */
export function collectCallSiteArgLiterals(
  project: Project,
  functionName: string
): readonly (readonly unknown[])[] {
  const seen = new Map<string, readonly unknown[]>();

  for (const sourceFile of project.getSourceFiles()) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      const calleeName = Node.isPropertyAccessExpression(expr) ? expr.getNameNode().getText() : expr.getText();
      if (calleeName !== functionName) continue;

      const args = call.getArguments();
      const tuple: unknown[] = [];
      let allLiteral = true;
      for (const arg of args) {
        const r = literalValue(arg);
        if (!r.ok) {
          allLiteral = false;
          break;
        }
        tuple.push(r.value);
      }
      if (!allLiteral) continue;
      seen.set(tupleKey(tuple), tuple);
    }
  }

  return [...seen.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/migration-core/src/verification/characterization/collect-call-site-args.spec.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add libs/migration-core/src/verification/characterization/collect-call-site-args.ts libs/migration-core/src/verification/characterization/collect-call-site-args.spec.ts
git commit -m "M2: collect literal call-site arguments for golden-master input generation"
```

---

### Task 6: `characterization/boundary-values.ts`

Type-based boundary values per §6.5 ("empty string, zero, null, empty array or object, one populated example"), generated one-parameter-at-a-time (other parameters held at a populated default) rather than a full cartesian product across all parameters — a deliberate scope decision to avoid combinatorial explosion, documented here rather than silently assumed.

**Files:**
- Create: `libs/migration-core/src/verification/characterization/boundary-values.ts`
- Test: `libs/migration-core/src/verification/characterization/boundary-values.spec.ts`

**Interfaces:**
- Consumes: `ParameterType` from `../types.js`.
- Produces: `generateBoundaryValueRows(parameterTypes: readonly (ParameterType | undefined)[]): readonly (readonly unknown[])[]`.

- [ ] **Step 1: Write the failing test**

```ts
// libs/migration-core/src/verification/characterization/boundary-values.spec.ts
import { describe, expect, it } from 'vitest';
import { generateBoundaryValueRows } from './boundary-values.js';

describe('generateBoundaryValueRows', () => {
  it('returns no rows when every parameter type is unknown', () => {
    expect(generateBoundaryValueRows([undefined, undefined])).toEqual([]);
  });

  it('varies one string parameter through its boundary set, holding a second unknown-typed parameter at a placeholder', () => {
    const rows = generateBoundaryValueRows(['string', undefined]);
    expect(rows).toContainEqual(['', undefined]);
    expect(rows.some((r) => typeof r[0] === 'string' && r[0].length > 0)).toBe(true);
  });

  it('covers number boundaries: zero, a positive, a negative', () => {
    const rows = generateBoundaryValueRows(['number']);
    const values = rows.map((r) => r[0]);
    expect(values).toContain(0);
    expect(values.some((v) => typeof v === 'number' && v > 0)).toBe(true);
    expect(values.some((v) => typeof v === 'number' && v < 0)).toBe(true);
  });

  it('covers boolean boundaries: both values', () => {
    const rows = generateBoundaryValueRows(['boolean']);
    expect(rows.map((r) => r[0])).toEqual(expect.arrayContaining([true, false]));
  });

  it('covers array boundaries: empty and one populated', () => {
    const rows = generateBoundaryValueRows(['array']);
    const values = rows.map((r) => r[0]);
    expect(values).toContainEqual([]);
    expect(values.some((v) => Array.isArray(v) && v.length > 0)).toBe(true);
  });

  it('covers object boundaries: empty and one populated', () => {
    const rows = generateBoundaryValueRows(['object']);
    const values = rows.map((r) => r[0]);
    expect(values).toContainEqual({});
    expect(values.some((v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0)).toBe(true);
  });

  it('holds sibling typed parameters at a populated default while varying the target parameter', () => {
    const rows = generateBoundaryValueRows(['number', 'string']);
    // every row's second (string) slot is a real string, not undefined, since it has a known type
    for (const row of rows) {
      expect(typeof row[1]).toBe('string');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/migration-core/src/verification/characterization/boundary-values.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/migration-core/src/verification/characterization/boundary-values.ts
import type { ParameterType } from '../types.js';

const BOUNDARY_SETS: Record<ParameterType, readonly unknown[]> = {
  string: ['', 'x'],
  number: [0, 1, -1],
  boolean: [true, false],
  array: [[], [1]],
  object: [{}, { k: 'v' }],
};

const POPULATED_DEFAULT: Record<ParameterType, unknown> = {
  string: 'x',
  number: 1,
  boolean: true,
  array: [1],
  object: { k: 'v' },
};

/**
 * §6.5's type-based boundary values, one parameter varied at a time
 * (siblings held at a populated default) rather than a full cartesian
 * product across every parameter — a deliberate v1 scope decision to
 * avoid combinatorial explosion on a function with several parameters,
 * documented here rather than silently assumed. A parameter with no
 * inferable type contributes `undefined` to every row it isn't the one
 * being varied, and no rows at all if it's the only parameter (no type
 * to generate boundaries from).
 */
export function generateBoundaryValueRows(
  parameterTypes: readonly (ParameterType | undefined)[]
): readonly (readonly unknown[])[] {
  const rows: unknown[][] = [];

  parameterTypes.forEach((targetType, targetIndex) => {
    if (!targetType) return;
    for (const boundaryValue of BOUNDARY_SETS[targetType]) {
      const row = parameterTypes.map((siblingType, i) => {
        if (i === targetIndex) return boundaryValue;
        return siblingType ? POPULATED_DEFAULT[siblingType] : undefined;
      });
      rows.push(row);
    }
  });

  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/migration-core/src/verification/characterization/boundary-values.spec.ts`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add libs/migration-core/src/verification/characterization/boundary-values.ts libs/migration-core/src/verification/characterization/boundary-values.spec.ts
git commit -m "M2: type-based boundary value generation for golden-master inputs"
```

---

### Task 7: `characterization/sandbox-run.ts` + `diff.ts`

`sandbox-run.ts` executes a standalone function/arrow source string against one input tuple inside a fresh `node:vm` context, with a timeout guard, capturing either the return value or a thrown error. `diff.ts` compares two `SandboxOutcome`s with the exact tolerances §6.5 names (key-ordering, `Date`-serialization) via a canonicalize-then-compare approach, no new dependency.

**Files:**
- Create: `libs/migration-core/src/verification/characterization/sandbox-run.ts`
- Create: `libs/migration-core/src/verification/characterization/diff.ts`
- Test: `libs/migration-core/src/verification/characterization/sandbox-run.spec.ts`
- Test: `libs/migration-core/src/verification/characterization/diff.spec.ts`

**Interfaces:**
- Produces: `runInSandbox(functionSource: string, args: readonly unknown[]): SandboxOutcome` (synchronous — every eligible function is pure and synchronous by construction, criterion (b) having already excluded async services).
- Produces: `outcomesMatch(a: SandboxOutcome, b: SandboxOutcome): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// libs/migration-core/src/verification/characterization/sandbox-run.spec.ts
import { describe, expect, it } from 'vitest';
import { runInSandbox } from './sandbox-run.js';

describe('runInSandbox', () => {
  it('returns the function result for a normal call', () => {
    const result = runInSandbox('function add(a, b) { return a + b; }', [2, 3]);
    expect(result).toEqual({ type: 'return', value: 5 });
  });

  it('supports arrow function source', () => {
    const result = runInSandbox('(a, b) => a * b', [4, 5]);
    expect(result).toEqual({ type: 'return', value: 20 });
  });

  it('captures a thrown error as a throw outcome, not a JS exception out of this function', () => {
    const result = runInSandbox('function f() { throw new Error("boom"); }', []);
    expect(result).toEqual({ type: 'throw', message: 'boom' });
  });

  it('returns objects and arrays intact', () => {
    const result = runInSandbox('function f(x) { return { doubled: x * 2, tag: [x] }; }', [3]);
    expect(result).toEqual({ type: 'return', value: { doubled: 6, tag: [3] } });
  });

  it('kills a function that runs longer than the timeout, reporting it as a throw outcome', () => {
    const result = runInSandbox('function f() { while (true) {} }', [], { timeoutMs: 50 });
    expect(result.type).toBe('throw');
  });
});
```

```ts
// libs/migration-core/src/verification/characterization/diff.spec.ts
import { describe, expect, it } from 'vitest';
import { outcomesMatch } from './diff.js';

describe('outcomesMatch', () => {
  it('matches identical return values', () => {
    expect(outcomesMatch({ type: 'return', value: 5 }, { type: 'return', value: 5 })).toBe(true);
  });

  it('does not match different return values', () => {
    expect(outcomesMatch({ type: 'return', value: 5 }, { type: 'return', value: 6 })).toBe(false);
  });

  it('tolerates object key ordering differences', () => {
    const a = { type: 'return' as const, value: { x: 1, y: 2 } };
    const b = { type: 'return' as const, value: { y: 2, x: 1 } };
    expect(outcomesMatch(a, b)).toBe(true);
  });

  it('tolerates Date-serialization differences between equivalent instants', () => {
    const a = { type: 'return' as const, value: new Date('2026-01-01T00:00:00.000Z') };
    const b = { type: 'return' as const, value: new Date('2026-01-01T00:00:00.000Z') };
    expect(outcomesMatch(a, b)).toBe(true);
  });

  it('does not match a return outcome against a throw outcome', () => {
    expect(outcomesMatch({ type: 'return', value: 5 }, { type: 'throw', message: 'boom' })).toBe(false);
  });

  it('matches identical throw messages', () => {
    expect(outcomesMatch({ type: 'throw', message: 'boom' }, { type: 'throw', message: 'boom' })).toBe(true);
  });

  it('does not match different throw messages — a genuine behavioral difference', () => {
    expect(outcomesMatch({ type: 'throw', message: 'boom' }, { type: 'throw', message: 'bang' })).toBe(false);
  });

  it('matches nested arrays of objects regardless of inner key order', () => {
    const a = { type: 'return' as const, value: [{ a: 1, b: 2 }] };
    const b = { type: 'return' as const, value: [{ b: 2, a: 1 }] };
    expect(outcomesMatch(a, b)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run libs/migration-core/src/verification/characterization/sandbox-run.spec.ts libs/migration-core/src/verification/characterization/diff.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/migration-core/src/verification/characterization/sandbox-run.ts
import vm from 'node:vm';
import type { SandboxOutcome } from '../types.js';

const DEFAULT_TIMEOUT_MS = 1000;

/**
 * Runs a standalone, self-contained function/arrow source string against
 * one input tuple inside a fresh `node:vm` context — deliberately not a
 * real Angular runtime or a real Node module system. Characterization
 * eligibility (eligibility.ts) already guarantees the function neither
 * touches `$scope`/DOM globals nor calls an async Angular service, so it
 * needs nothing from either runtime to execute correctly; running it
 * this way instead of bootstrapping Angular's DI is what makes clause 3
 * fast and dependency-free rather than a second, slower compile-and-run
 * cycle on top of clause 1's already-real `tsc` check.
 *
 * A timeout (default 1s, generous for a pure function operating on
 * boundary-sized inputs) guards against an accidental infinite loop in
 * extracted source; a timed-out or throwing call is reported as a
 * `throw` outcome, never propagated as a real exception out of this
 * function — the caller (run-characterization.ts) treats every outcome,
 * including a timeout, as one more thing to diff against the other
 * side, not a reason to abort the whole verification run.
 */
export function runInSandbox(
  functionSource: string,
  args: readonly unknown[],
  options: { readonly timeoutMs?: number } = {}
): SandboxOutcome {
  const context = vm.createContext({});
  const script = new vm.Script(
    `(function () {
      const __fn = (${functionSource});
      const __args = ${JSON.stringify(args)};
      return __fn(...__args);
    })()`
  );
  try {
    const value = script.runInContext(context, { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS }) as unknown;
    return { type: 'return', value };
  } catch (error) {
    return { type: 'throw', message: error instanceof Error ? error.message : String(error) };
  }
}
```

```ts
// libs/migration-core/src/verification/characterization/diff.ts
import type { SandboxOutcome } from '../types.js';

/**
 * §6.5's diffing tolerance: "structural deep-equality with explicit
 * tolerance for non-deterministic object-key ordering and Date
 * serialization differences." Canonicalizes both sides (sorted object
 * keys, `Date` instances normalized to their ISO string) before
 * comparing, rather than a library-based deep-equal — this project's own
 * ladder precedent (no new dependency for something this small) and it
 * keeps the exact tolerance rules explicit and auditable in one place,
 * which matters more than usual here given this file lives under the
 * heavy-scrutiny verification/ directory.
 */
function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function outcomesMatch(a: SandboxOutcome, b: SandboxOutcome): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'throw' && b.type === 'throw') return a.message === b.message;
  if (a.type === 'return' && b.type === 'return') {
    return JSON.stringify(canonicalize(a.value)) === JSON.stringify(canonicalize(b.value));
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run libs/migration-core/src/verification/characterization/sandbox-run.spec.ts libs/migration-core/src/verification/characterization/diff.spec.ts`
Expected: PASS, 5/5 and 8/8.

- [ ] **Step 5: Commit**

```bash
git add libs/migration-core/src/verification/characterization/sandbox-run.ts libs/migration-core/src/verification/characterization/diff.ts libs/migration-core/src/verification/characterization/sandbox-run.spec.ts libs/migration-core/src/verification/characterization/diff.spec.ts
git commit -m "M2: sandboxed golden-master execution and tolerant outcome diffing"
```

---

### Task 8: `characterization/run-characterization.ts`

Orchestrates Tasks 4–7 into clause 3: eligibility → union of call-site + boundary inputs → run original (golden master) → run migrated → diff every pair, first mismatch wins.

**Files:**
- Create: `libs/migration-core/src/verification/characterization/run-characterization.ts`
- Test: `libs/migration-core/src/verification/characterization/run-characterization.spec.ts`

**Interfaces:**
- Consumes: `checkEligibility` (Task 4), `generateBoundaryValueRows` (Task 6), `runInSandbox`/`outcomesMatch` (Task 7), `CharacterizationTarget`/`CharacterizationResult` (Task 1).
- Produces: `runCharacterization(target: CharacterizationTarget): CharacterizationResult`.

- [ ] **Step 1: Write the failing test**

```ts
// libs/migration-core/src/verification/characterization/run-characterization.spec.ts
import { describe, expect, it } from 'vitest';
import { runCharacterization } from './run-characterization.js';
import type { CharacterizationTarget } from '../types.js';

const baseTarget: CharacterizationTarget = {
  artifactType: 'service',
  originalFunctionSource: 'function double(x) { return x * 2; }',
  migratedFunctionSource: 'function double(x) { return x * 2; }',
  parameterNames: ['x'],
  parameterTypes: ['number'],
  callSiteArgLiterals: [[3], [4]],
};

describe('runCharacterization', () => {
  it('is ineligible when the original function fails the §6.5 static checks', () => {
    const target: CharacterizationTarget = {
      ...baseTarget,
      originalFunctionSource: 'function double(x) { return $scope.x * 2; }',
    };
    const result = runCharacterization(target);
    expect(result.eligible).toBe(false);
  });

  it('is ineligible when there are fewer than two call-site examples and no inferable parameter types', () => {
    const target: CharacterizationTarget = {
      ...baseTarget,
      parameterTypes: undefined,
      callSiteArgLiterals: [[3]],
    };
    const result = runCharacterization(target);
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/fewer than two/);
  });

  it('matches when original and migrated behave identically across every generated input', () => {
    const result = runCharacterization(baseTarget);
    expect(result).toMatchObject({ eligible: true, matched: true });
  });

  it('reports a mismatch, with the exact offending input and both outcomes, when behavior diverges', () => {
    const target: CharacterizationTarget = {
      ...baseTarget,
      migratedFunctionSource: 'function double(x) { return x * 3; }', // engineered bug
    };
    const result = runCharacterization(target);
    expect(result.eligible).toBe(true);
    if (result.eligible && !result.matched) {
      expect(result.mismatch.original).toEqual({ type: 'return', value: 6 });
      expect(result.mismatch.migrated).toEqual({ type: 'return', value: 9 });
    } else {
      throw new Error('expected a mismatch');
    }
  });

  it('two distinct call-site examples alone (no inferable types) are enough to be eligible', () => {
    const target: CharacterizationTarget = {
      ...baseTarget,
      parameterTypes: undefined,
      callSiteArgLiterals: [[3], [4]],
    };
    const result = runCharacterization(target);
    expect(result.eligible).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/migration-core/src/verification/characterization/run-characterization.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/migration-core/src/verification/characterization/run-characterization.ts
import { checkEligibility } from './eligibility.js';
import { generateBoundaryValueRows } from './boundary-values.js';
import { runInSandbox } from './sandbox-run.js';
import { outcomesMatch } from './diff.js';
import type { CharacterizationResult, CharacterizationTarget } from '../types.js';

function dedupeRows(rows: readonly (readonly unknown[])[]): readonly (readonly unknown[])[] {
  const seen = new Map<string, readonly unknown[]>();
  for (const row of rows) seen.set(JSON.stringify(row), row);
  return [...seen.values()];
}

/**
 * Stage 4 clause 3 (docs/product-spec.md §6.5): the characterization-test
 * branch, taken only when clause 2 (run-verification-gate.ts) found no
 * migrated spec to run.
 *
 * Ineligibility resolves this function's own result to
 * `{ eligible: false }`; it is `run-verification-gate.ts` (Task 9), not
 * this function, that turns that into a REJECTED tier — this function
 * stays a pure decision, not a tiering policy.
 */
export function runCharacterization(target: CharacterizationTarget): CharacterizationResult {
  const eligibility = checkEligibility(target.originalFunctionSource);
  if (!eligibility.eligible) return { eligible: false, reason: eligibility.reason };

  const inferredTypesExist = (target.parameterTypes ?? []).some((t) => t !== undefined);
  if (target.callSiteArgLiterals.length < 2 && !inferredTypesExist) {
    return {
      eligible: false,
      reason: 'fewer than two distinct call-site examples and no inferable parameter types (§6.5)',
    };
  }

  const boundaryRows = target.parameterTypes ? generateBoundaryValueRows(target.parameterTypes) : [];
  const inputs = dedupeRows([...target.callSiteArgLiterals, ...boundaryRows]);

  for (const input of inputs) {
    const originalOutcome = runInSandbox(target.originalFunctionSource, input);
    const migratedOutcome = runInSandbox(target.migratedFunctionSource, input);
    if (!outcomesMatch(originalOutcome, migratedOutcome)) {
      return {
        eligible: true,
        matched: false,
        mismatch: { input, original: originalOutcome, migrated: migratedOutcome },
      };
    }
  }

  return { eligible: true, matched: true, casesRun: inputs.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/migration-core/src/verification/characterization/run-characterization.spec.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add libs/migration-core/src/verification/characterization/run-characterization.ts libs/migration-core/src/verification/characterization/run-characterization.spec.ts
git commit -m "M2: clause 3 — characterization test orchestration"
```

---

### Task 9: `run-verification-gate.ts`

The top-level orchestrator: clause 1 → clause 2 (if `migratedSpecPath` given) → clause 3 (otherwise), assigning the final tier. This is also where the "an unverifiable patch is REJECTED, not silently accepted" decision (flagged in Global Constraints) is implemented — call this out explicitly in the PR description as a decision made during planning, not lifted from spec text, so the user's line-by-line review specifically weighs it.

**Files:**
- Create: `libs/migration-core/src/verification/run-verification-gate.ts`
- Test: `libs/migration-core/src/verification/run-verification-gate.spec.ts`

**Interfaces:**
- Consumes: `runCompileCheck` (Task 2), `runExistingTestSuite` (Task 3), `runCharacterization` (Task 8).
- Produces: `runVerificationGate(input: VerificationInput): Promise<VerificationResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// libs/migration-core/src/verification/run-verification-gate.spec.ts
import { describe, expect, it, vi } from 'vitest';

const runCompileCheckMock = vi.fn();
const runExistingTestSuiteMock = vi.fn();
const runCharacterizationMock = vi.fn();
vi.mock('./check-compiles.js', () => ({ runCompileCheck: (...a: unknown[]) => runCompileCheckMock(...a) }));
vi.mock('./run-existing-tests.js', () => ({ runExistingTestSuite: (...a: unknown[]) => runExistingTestSuiteMock(...a) }));
vi.mock('./characterization/run-characterization.js', () => ({
  runCharacterization: (...a: unknown[]) => runCharacterizationMock(...a),
}));

const { runVerificationGate } = await import('./run-verification-gate.js');

describe('runVerificationGate', () => {
  it('REJECTED when clause 1 (compile) fails, never running clause 2 or 3', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: false, log: 'TS2322' });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'service' });

    expect(result.tier).toBe('REJECTED');
    expect(runExistingTestSuiteMock).not.toHaveBeenCalled();
    expect(runCharacterizationMock).not.toHaveBeenCalled();
  });

  it('HIGH when clause 1 passes and a migrated spec is given and it passes', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runExistingTestSuiteMock.mockResolvedValue({ passed: true, log: '2 passed' });

    const result = await runVerificationGate({
      workspaceDir: '/ws',
      artifactType: 'service',
      migratedSpecPath: 'src/app/foo.spec.ts',
    });

    expect(result.tier).toBe('HIGH');
    expect(runCharacterizationMock).not.toHaveBeenCalled();
  });

  it('REJECTED when clause 1 passes but the given migrated spec fails — never falls through to clause 3', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runExistingTestSuiteMock.mockResolvedValue({ passed: false, log: 'expected 1 to be 2' });

    const result = await runVerificationGate({
      workspaceDir: '/ws',
      artifactType: 'service',
      migratedSpecPath: 'src/app/foo.spec.ts',
    });

    expect(result.tier).toBe('REJECTED');
    expect(runCharacterizationMock).not.toHaveBeenCalled();
  });

  it('MEDIUM when clause 1 passes, no spec is given, and characterization matches', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runCharacterizationMock.mockReturnValue({ eligible: true, matched: true, casesRun: 4 });

    const result = await runVerificationGate({
      workspaceDir: '/ws',
      artifactType: 'service',
      characterization: {
        artifactType: 'service',
        originalFunctionSource: 'function f(x) { return x; }',
        migratedFunctionSource: 'function f(x) { return x; }',
        parameterNames: ['x'],
        callSiteArgLiterals: [[1], [2]],
      },
    });

    expect(result.tier).toBe('MEDIUM');
    expect(runExistingTestSuiteMock).not.toHaveBeenCalled();
  });

  it('REJECTED when characterization finds a mismatch', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runCharacterizationMock.mockReturnValue({
      eligible: true,
      matched: false,
      mismatch: { input: [1], original: { type: 'return', value: 1 }, migrated: { type: 'return', value: 2 } },
    });

    const result = await runVerificationGate({
      workspaceDir: '/ws',
      artifactType: 'service',
      characterization: {
        artifactType: 'service',
        originalFunctionSource: 'function f(x) { return x; }',
        migratedFunctionSource: 'function f(x) { return x + 1; }',
        parameterNames: ['x'],
        callSiteArgLiterals: [[1], [2]],
      },
    });

    expect(result.tier).toBe('REJECTED');
  });

  it('REJECTED when characterization is ineligible — an unverifiable patch is never silently accepted', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runCharacterizationMock.mockReturnValue({ eligible: false, reason: 'references $scope' });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'controller' });

    expect(result.tier).toBe('REJECTED');
  });

  it('REJECTED when no spec and no characterization target are given at all', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'controller' });

    expect(result.tier).toBe('REJECTED');
    expect(runCharacterizationMock).not.toHaveBeenCalled();
  });

  it('every result carries the input artifactType through unchanged', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: false, log: '' });
    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'directive' });
    expect(result.artifactType).toBe('directive');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/migration-core/src/verification/run-verification-gate.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/migration-core/src/verification/run-verification-gate.ts
import { runCompileCheck } from './check-compiles.js';
import { runExistingTestSuite } from './run-existing-tests.js';
import { runCharacterization } from './characterization/run-characterization.js';
import type { VerificationInput, VerificationResult } from './types.js';

/**
 * Stage 4 (docs/product-spec.md §6.5): clears in order — (1) compile,
 * (2) the migrated spec if one was supplied, (3) characterization
 * testing otherwise. A hard fail at (1) or (2) is an immediate REJECTED;
 * neither later clause runs once an earlier one has failed.
 *
 * **Design decision made in this plan, not lifted verbatim from the
 * spec text — flagged for the user's line-by-line review**: when
 * neither a migrated spec nor a characterization target is available at
 * all (or the one given is ineligible), this resolves to REJECTED, not
 * a silent pass. Grounded in §6.5's own stated principle ("never accept
 * an AI-generated change without independent verification") — a patch
 * with zero verification evidence available can't be accepted by that
 * principle's own logic, but this is this plan's inference from that
 * principle, not something §6.5 states in those exact words.
 */
export async function runVerificationGate(input: VerificationInput): Promise<VerificationResult> {
  const compile = await runCompileCheck(input.workspaceDir, input.appTsConfigPath);
  if (!compile.passed) {
    return { tier: 'REJECTED', artifactType: input.artifactType, reason: 'tsc --noEmit failed', compileLog: compile.log };
  }

  if (input.migratedSpecPath) {
    const testResult = await runExistingTestSuite(input.workspaceDir, input.migratedSpecPath);
    if (!testResult.passed) {
      return {
        tier: 'REJECTED',
        artifactType: input.artifactType,
        reason: 'existing migrated test suite failed',
        compileLog: compile.log,
        testLog: testResult.log,
      };
    }
    return { tier: 'HIGH', artifactType: input.artifactType, compileLog: compile.log, testLog: testResult.log };
  }

  if (!input.characterization) {
    return {
      tier: 'REJECTED',
      artifactType: input.artifactType,
      reason: 'no migrated spec and no characterization target — nothing to verify against',
      compileLog: compile.log,
    };
  }

  const characterization = runCharacterization(input.characterization);
  if (!characterization.eligible) {
    return {
      tier: 'REJECTED',
      artifactType: input.artifactType,
      reason: `characterization ineligible: ${characterization.reason}`,
      compileLog: compile.log,
      characterization,
    };
  }
  if (!characterization.matched) {
    return {
      tier: 'REJECTED',
      artifactType: input.artifactType,
      reason: 'characterization diff mismatch',
      compileLog: compile.log,
      characterization,
    };
  }

  return { tier: 'MEDIUM', artifactType: input.artifactType, compileLog: compile.log, characterization };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/migration-core/src/verification/run-verification-gate.spec.ts`
Expected: PASS, 9/9.

- [ ] **Step 5: Commit**

```bash
git add libs/migration-core/src/verification/run-verification-gate.ts libs/migration-core/src/verification/run-verification-gate.spec.ts
git commit -m "M2: top-level verification gate orchestrator (clauses 1-3, tiering)"
```

---

### Task 10: Negative-control fixtures + the real, unmocked integration spec

**This is the milestone's actual definition of done** (`docs/milestones/m2-verification.md`): the gate must correctly return REJECTED on all three planted fixtures, verified by actually running it — not inferred from the unit tests above, which all mock the subprocess layer.

**Files:**
- Create: `libs/migration-core/verification/__fixtures__/negative-controls/01-compile-error/broken.ts`
- Create: `libs/migration-core/verification/__fixtures__/negative-controls/02-failing-test/module.ts`
- Create: `libs/migration-core/verification/__fixtures__/negative-controls/02-failing-test/module.spec.ts`
- Create: `libs/migration-core/verification/__fixtures__/negative-controls/03-characterization-mismatch/original.js`
- Create: `libs/migration-core/verification/__fixtures__/negative-controls/03-characterization-mismatch/migrated.ts`
- Create: `libs/migration-core/verification/__fixtures__/negative-controls/negative-controls.integration.spec.ts`
- Modify: `libs/migration-core/vitest.config.mts` (exclude `*.integration.spec.ts` from the default fast suite)

**Interfaces:**
- Consumes: `scaffoldTargetWorkspace` (`scaffold/index.ts`), `runVerificationGate` (Task 9).

- [ ] **Step 1: Write the three fixtures**

```ts
// libs/migration-core/verification/__fixtures__/negative-controls/01-compile-error/broken.ts
// Planted negative control #1 (docs/milestones/m2-verification.md): a genuine tsc compile error.
export const misTyped: number = 'not a number';
```

```ts
// libs/migration-core/verification/__fixtures__/negative-controls/02-failing-test/module.ts
// Planted negative control #2: valid, compiling source...
export function double(x: number): number {
  return x * 2;
}
```

```ts
// libs/migration-core/verification/__fixtures__/negative-controls/02-failing-test/module.spec.ts
// ...paired with a spec written to fail regardless of what module.ts does.
import { describe, expect, it } from 'vitest';
import { double } from './module';

describe('double', () => {
  it('is deliberately wrong — this spec exists to prove the gate rejects a real test failure', () => {
    expect(double(2)).toBe(999);
  });
});
```

```js
// libs/migration-core/verification/__fixtures__/negative-controls/03-characterization-mismatch/original.js
// Planted negative control #3: the "original AngularJS" side of an engineered characterization mismatch.
function priceWithTax(price, taxRate) {
  return price * (1 + taxRate);
}
```

```ts
// libs/migration-core/verification/__fixtures__/negative-controls/03-characterization-mismatch/migrated.ts
// The "migrated" side — deliberately wrong (uses the tax rate as a flat addition, not a multiplier), engineered so the characterization diff mismatches.
function priceWithTax(price: number, taxRate: number): number {
  return price + taxRate;
}
```

- [ ] **Step 2: Write the failing integration test**

```ts
// libs/migration-core/verification/__fixtures__/negative-controls/negative-controls.integration.spec.ts
/**
 * Real, unmocked: scaffolds one real Angular workspace and actually runs
 * `tsc`/`ng test` against it for fixtures #1 and #2. This is the
 * milestone's own definition of done (m2-verification.md) — "the code
 * looks correct" is explicitly not sufficient. Deliberately excluded
 * from the default fast `vitest` suite (see vitest.config.mts) — slow
 * (a real `ng new`/npm install), run via its own CI job
 * (`verification-negative-controls`, .github/workflows/ci.yml) gated to
 * changes under the verification module, per CLAUDE.md's requirement
 * that this fixture directory runs in CI on every such change,
 * permanently.
 */
import { readFile, mkdir, mkdtemp, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scaffoldTargetWorkspace } from '../../../src/scaffold/index.js';
import { runVerificationGate } from '../../../src/verification/run-verification-gate.js';

const FIXTURES_DIR = join(import.meta.dirname);

describe('verification gate — negative controls', () => {
  let workspaceDir: string;

  beforeAll(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'm2-negative-controls-'));
    workspaceDir = join(parent, 'workspace');
    const result = await scaffoldTargetWorkspace({ outputDir: workspaceDir, appName: 'm2negctrl' });
    if (!result.success) throw new Error(`fixture setup: scaffold failed: ${result.stderr}`);
  }, 300_000);

  afterAll(async () => {
    if (workspaceDir) await rm(join(workspaceDir, '..'), { recursive: true, force: true });
  });

  it('#1 — a genuine tsc compile error is REJECTED', async () => {
    const targetDir = join(workspaceDir, 'src/app/negative-control-01');
    await mkdir(targetDir, { recursive: true });
    await cp(join(FIXTURES_DIR, '01-compile-error/broken.ts'), join(targetDir, 'broken.ts'));

    const result = await runVerificationGate({ workspaceDir, artifactType: 'service' });

    expect(result.tier).toBe('REJECTED');
    await rm(targetDir, { recursive: true, force: true });
  }, 120_000);

  it('#2 — a test written to fail is REJECTED', async () => {
    const targetDir = join(workspaceDir, 'src/app/negative-control-02');
    await mkdir(targetDir, { recursive: true });
    await cp(join(FIXTURES_DIR, '02-failing-test/module.ts'), join(targetDir, 'module.ts'));
    await cp(join(FIXTURES_DIR, '02-failing-test/module.spec.ts'), join(targetDir, 'module.spec.ts'));

    const result = await runVerificationGate({
      workspaceDir,
      artifactType: 'service',
      migratedSpecPath: 'src/app/negative-control-02/module.spec.ts',
    });

    expect(result.tier).toBe('REJECTED');
    await rm(targetDir, { recursive: true, force: true });
  }, 120_000);

  it('#3 — an engineered characterization mismatch is REJECTED', async () => {
    const originalSource = await readFile(join(FIXTURES_DIR, '03-characterization-mismatch/original.js'), 'utf8');
    const migratedSource = await readFile(join(FIXTURES_DIR, '03-characterization-mismatch/migrated.ts'), 'utf8');

    const extractFunction = (source: string) =>
      source.replace(/^\/\/.*\n/, '').replace(/^function priceWithTax/, 'function priceWithTax').trim();

    const result = await runVerificationGate({
      workspaceDir,
      artifactType: 'service',
      characterization: {
        artifactType: 'service',
        originalFunctionSource: extractFunction(originalSource),
        migratedFunctionSource: extractFunction(migratedSource).replace(/^\/\/.*\n/, ''),
        parameterNames: ['price', 'taxRate'],
        parameterTypes: ['number', 'number'],
        callSiteArgLiterals: [[100, 0.2], [50, 0.1]],
      },
    });

    expect(result.tier).toBe('REJECTED');
  }, 60_000);
});
```

- [ ] **Step 3: Exclude the integration spec from the default fast suite**

```ts
// libs/migration-core/vitest.config.mts
import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/migration-core',
  test: {
    name: 'migration-core',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['**/node_modules/**', '**/*.integration.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
```

- [ ] **Step 4: Run the integration spec directly (not part of the default suite) and confirm all three REJECTED**

Run: `npx vitest run libs/migration-core/verification/__fixtures__/negative-controls/negative-controls.integration.spec.ts --config libs/migration-core/vitest.config.mts`

(This one command needs `--config` explicitly since it's excluded from the workspace's default project discovery by Step 3's `exclude`.)

Expected: PASS, 3/3 — all three fixtures resolve to `REJECTED`. Read the actual `compileLog`/`testLog`/`characterization` output printed on any unexpected failure — this is the one place in the whole milestone where "run it for real and read the output" is the literal definition of done, not just a best practice.

- [ ] **Step 5: Confirm the default fast suite still excludes it and stays fast**

Run: `npx nx test migration-core`
Expected: PASS, the integration spec does not appear in the run.

- [ ] **Step 6: Commit**

```bash
git add libs/migration-core/verification/__fixtures__/negative-controls libs/migration-core/vitest.config.mts
git commit -m "M2: plant the three required negative-control fixtures, verified REJECTED for real"
```

---

### Task 11: `summarize-verification-results.ts` — artifact-type breakdown reporting

CLAUDE.md and this milestone's own brief: characterization-eligibility (and, by the same reporting-honesty logic, tier outcomes generally) must be reported broken down by artifact type, never smoothed into one aggregate. This is the small, general-purpose aggregator that makes that concrete rather than a promise kept only in prose.

**Files:**
- Create: `libs/migration-core/src/verification/summarize-verification-results.ts`
- Test: `libs/migration-core/src/verification/summarize-verification-results.spec.ts`

**Interfaces:**
- Consumes: `VerificationResult`, `ArtifactType` (Task 1).
- Produces: `summarizeByArtifactType(results: readonly VerificationResult[]): Record<ArtifactType, { readonly total: number; readonly high: number; readonly medium: number; readonly rejected: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// libs/migration-core/src/verification/summarize-verification-results.spec.ts
import { describe, expect, it } from 'vitest';
import { summarizeByArtifactType } from './summarize-verification-results.js';
import type { VerificationResult } from './types.js';

describe('summarizeByArtifactType', () => {
  it('buckets counts per artifact type, never a single blended total', () => {
    const results: VerificationResult[] = [
      { tier: 'HIGH', artifactType: 'controller', compileLog: '', testLog: '' },
      { tier: 'REJECTED', artifactType: 'controller', reason: 'x' },
      { tier: 'MEDIUM', artifactType: 'service', compileLog: '', characterization: { eligible: true, matched: true, casesRun: 3 } },
    ];

    const summary = summarizeByArtifactType(results);

    expect(summary.controller).toEqual({ total: 2, high: 1, medium: 0, rejected: 1 });
    expect(summary.service).toEqual({ total: 1, high: 0, medium: 1, rejected: 0 });
    expect(summary.filter).toEqual({ total: 0, high: 0, medium: 0, rejected: 0 });
    expect(summary.directive).toEqual({ total: 0, high: 0, medium: 0, rejected: 0 });
  });

  it('every artifact type is present even with zero results — no silently-omitted category', () => {
    const summary = summarizeByArtifactType([]);
    expect(Object.keys(summary).sort()).toEqual(['controller', 'directive', 'filter', 'service']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run libs/migration-core/src/verification/summarize-verification-results.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// libs/migration-core/src/verification/summarize-verification-results.ts
import type { ArtifactType, VerificationResult } from './types.js';

interface TierCounts {
  readonly total: number;
  readonly high: number;
  readonly medium: number;
  readonly rejected: number;
}

const ARTIFACT_TYPES: readonly ArtifactType[] = ['controller', 'service', 'filter', 'directive'];

/**
 * CLAUDE.md's reporting-honesty rule, made concrete: every artifact type
 * is present in the output even at zero, so a caller can't silently drop
 * a category that happened to have no results this run — the same
 * "never omit, always report the messiest bucket too" discipline M1's
 * own per-repo hit-count reporting used throughout.
 */
export function summarizeByArtifactType(
  results: readonly VerificationResult[]
): Record<ArtifactType, TierCounts> {
  const summary = Object.fromEntries(
    ARTIFACT_TYPES.map((type) => [type, { total: 0, high: 0, medium: 0, rejected: 0 }])
  ) as Record<ArtifactType, TierCounts>;

  for (const result of results) {
    const bucket = summary[result.artifactType];
    summary[result.artifactType] = {
      total: bucket.total + 1,
      high: bucket.high + (result.tier === 'HIGH' ? 1 : 0),
      medium: bucket.medium + (result.tier === 'MEDIUM' ? 1 : 0),
      rejected: bucket.rejected + (result.tier === 'REJECTED' ? 1 : 0),
    };
  }

  return summary;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run libs/migration-core/src/verification/summarize-verification-results.spec.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add libs/migration-core/src/verification/summarize-verification-results.ts libs/migration-core/src/verification/summarize-verification-results.spec.ts
git commit -m "M2: per-artifact-type verification result summary (never a blended aggregate)"
```

---

### Task 12: `verification/index.ts` barrel export

**Files:**
- Create: `libs/migration-core/src/verification/index.ts`

- [ ] **Step 1: Write the file**

```ts
// libs/migration-core/src/verification/index.ts
export { runCompileCheck } from './check-compiles.js';
export { runExistingTestSuite } from './run-existing-tests.js';
export { runCharacterization } from './characterization/run-characterization.js';
export { checkEligibility } from './characterization/eligibility.js';
export { collectCallSiteArgLiterals } from './characterization/collect-call-site-args.js';
export { generateBoundaryValueRows } from './characterization/boundary-values.js';
export { runInSandbox } from './characterization/sandbox-run.js';
export { outcomesMatch } from './characterization/diff.js';
export { runVerificationGate } from './run-verification-gate.js';
export { summarizeByArtifactType } from './summarize-verification-results.js';
export type {
  ArtifactType,
  CharacterizationMismatch,
  CharacterizationResult,
  CharacterizationTarget,
  CompileCheckResult,
  ParameterType,
  SandboxOutcome,
  TestSuiteCheckResult,
  VerificationInput,
  VerificationResult,
} from './types.js';
```

- [ ] **Step 2: Confirm the whole lib still builds**

Run: `npx nx build migration-core`
Expected: exit 0, no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add libs/migration-core/src/verification/index.ts
git commit -m "M2: barrel-export the verification module"
```

---

### Task 13: CLI wiring — `verify` command

Mirrors `scaffold`/`codemod`'s existing CLI command shape. Scoped to clauses 1 and 2 only (compile + optional spec run) — characterization needs a `CharacterizationTarget`, which nothing produces from a CLI argument yet (no Stage-3 LLM output exists), so it stays a library-only API for now, same as every other not-yet-fully-wired seam in this project is left flagged rather than stubbed.

**Files:**
- Modify: `libs/migration-core/src/cli.ts`

**Interfaces:**
- Consumes: `runVerificationGate` from `./verification/index.js`.

- [ ] **Step 1: Add the command**

```ts
// libs/migration-core/src/cli.ts — add near the other stage commands, after the `codemod` command
import { runVerificationGate } from './verification/index.js';
// (add alongside the existing top-of-file imports)

program
  .command('verify')
  .description(
    'Stage 4: run the compile + existing-test-suite checks against a migrated file already placed in a scaffolded workspace. Characterization testing (no prior coverage) is library-only for now — no CLI producer of a CharacterizationTarget exists yet.'
  )
  .argument('<workspaceDir>', 'an M0.5-scaffolded Angular workspace directory')
  .option('-t, --artifact-type <type>', 'controller | service | filter | directive', 'service')
  .option('-s, --spec <specPath>', 'path to a migrated spec file, relative to workspaceDir, if one exists')
  .option('--ts-config <path>', 'app tsconfig path, relative to workspaceDir', 'tsconfig.app.json')
  .action(
    async (
      workspaceDir: string,
      options: { artifactType: string; spec?: string; tsConfig: string }
    ) => {
      const result = await runVerificationGate({
        workspaceDir: resolve(workspaceDir),
        artifactType: options.artifactType as 'controller' | 'service' | 'filter' | 'directive',
        appTsConfigPath: options.tsConfig,
        migratedSpecPath: options.spec,
      });

      console.log(JSON.stringify(result, null, 2));
      if (result.tier === 'REJECTED') process.exitCode = 1;
    }
  );
```

- [ ] **Step 2: Confirm the CLI still builds and dispatches**

Run: `npx nx build migration-core && node libs/migration-core/dist/cli.js verify --help`
Expected: exit 0, help text shows the new `verify` command with its options.

- [ ] **Step 3: Commit**

```bash
git add libs/migration-core/src/cli.ts
git commit -m "M2: wire the verify command (clauses 1-2) into the CLI"
```

---

### Task 14: CI job, ADR, and PROGRESS.md

The last task — CI wiring plus the documentation CLAUDE.md requires before this can be considered actually done, not just code-complete.

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/decisions.md` (append ADR entry)
- Modify: `docs/PROGRESS.md` (status table, "Where things stand", session log)
- Modify: `docs/milestones/m2-verification.md` (status: not started → done, once merged)

- [ ] **Step 1: Add the CI job**

```yaml
# .github/workflows/ci.yml — add alongside the existing secrets-scan job
  verification-negative-controls:
    name: Verification gate — negative controls
    runs-on: ubuntu-latest
    if: >
      github.event_name == 'push' ||
      contains(github.event.pull_request.changed_files, 'libs/migration-core/src/verification') ||
      contains(github.event.pull_request.changed_files, 'libs/migration-core/verification')
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npx nx build migration-core
      - run: npx vitest run libs/migration-core/verification/__fixtures__/negative-controls/negative-controls.integration.spec.ts --config libs/migration-core/vitest.config.mts
        timeout-minutes: 15
```

Note for the PR: GitHub Actions' `changed_files` isn't directly usable in an `if:` condition the way written above (it's an output of a separate step, e.g. `tj-actions/changed-files`, not a bare `github.event.pull_request` field) — this needs an actual `dorny/paths-filter`-or-equivalent step wired in correctly and verified against a real PR run before merge, not assumed correct from this plan's own pseudocode. Flag this specifically during self-review; don't let CI YAML be the one piece of this milestone that ships unverified against real execution, which would be exactly the kind of gap CLAUDE.md's "done means run and checked" rule exists to catch.

- [ ] **Step 2: Push a throwaway branch touching only `libs/migration-core/src/verification/types.ts` (a comment-only change) and confirm the new job actually triggers and passes in the real GitHub Actions run — then a second push touching only an unrelated file (e.g. `README.md`) and confirm the job is correctly skipped**

This step has no local command — it requires a real PR. Do not mark this task done without having actually observed both real outcomes in the Actions tab, per this project's "done means run and checked, not inferred" rule.

- [ ] **Step 3: Append the ADR entry to `docs/decisions.md`**

Write a real entry (not here — the actual content depends on what Tasks 1–13 turn up during implementation and review, same as every prior ADR entry in this file was written after the fact, not planned in advance). Cover: the two verified real commands (`tsc -p tsconfig.app.json --noEmit`, `ng test --watch=false --include`), the clause-2 optional-spec scope decision (confirmed with the user this session), the "ineligible/unverifiable → REJECTED" design call (Task 9), the one-parameter-at-a-time boundary-value scope decision (Task 6), and whatever real bugs the adversarial review rounds find — same format every prior ADR uses.

- [ ] **Step 4: Update `docs/PROGRESS.md`**

Status table: `M2 — Verification gate | done | [PR link]`. "Where things stand": a new "Built and verified (M2)" paragraph, same density and honesty as the M1 entries — real per-fixture REJECTED confirmations, real review-round findings, real test counts. Session log: one entry, same format as every prior one.

- [ ] **Step 5: Flip `docs/milestones/m2-verification.md`'s status line**

`**Status:** not started` → `**Status:** done`.

- [ ] **Step 6: Final commit and PR — human-review checkpoint**

```bash
git add .github/workflows/ci.yml docs/decisions.md docs/PROGRESS.md docs/milestones/m2-verification.md
git commit -m "M2: CI negative-control gate, ADR, and progress docs"
```

**Do not merge this PR without the user reading every line of `libs/migration-core/src/verification/` and `libs/migration-core/verification/` themselves** — restate this explicitly when opening the PR, per the Global Constraints section and the user's own explicit choice this session for how M2's authorship/review model works.

---

## Self-Review Notes

**Spec coverage**: §6.5 clause 1 (Task 2), clause 2 (Task 3, scoped per confirmed user decision), clause 3 including exact eligibility criteria (Tasks 4-8), input generation from call sites + boundary values (Tasks 5-6), diff tolerance for key-ordering/Date (Task 7), HIGH/MEDIUM/REJECTED tiering (Task 9), per-artifact-type reporting (Task 11), the three negative-control fixtures and their permanent CI enforcement (Tasks 10, 14) — all covered. `§6.4a` (real-provider testing cadence) is M3's concern, not M2's, correctly out of scope here.

**Type consistency**: `VerificationInput`/`VerificationResult`/`CharacterizationTarget`/`CharacterizationResult` are defined once in Task 1 and consumed identically by name in every later task — checked against each task's own code above.

**Known scope decisions this plan makes that a reviewer should weigh specifically** (flagged inline at each site above, collected here for visibility): (1) `migratedSpecPath` is caller-supplied/optional, not something this milestone derives itself (confirmed with the user). (2) An ineligible or entirely-absent verification path resolves to REJECTED (this plan's own inference from §6.5's stated principle, not a literal spec quote). (3) Boundary-value generation varies one parameter at a time rather than a full cartesian product. (4) Call-site argument collection skips a call whole if any argument isn't a literal, rather than partially substituting. None of these are silently assumed — each is called out at its task and again here, for the human-review-line-by-line pass this directory specifically requires.
