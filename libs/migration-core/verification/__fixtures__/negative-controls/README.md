# Verification-gate controls

A permanent regression contract for the verification gate, run for real — a scaffolded Angular workspace, the real Angular compiler, the real test runner — in CI on every change to `libs/migration-core/src/verification/` or this directory. See [docs/architecture.md §6.4](../../../../../docs/architecture.md) and [docs/milestones/m2-verification.md](../../../../../docs/milestones/m2-verification.md).

Negative controls — each must be REJECTED **by the named check, with the named evidence in its log**. Asserting the tier alone is not enough: a gate that rejects everything would pass.

1. `01-compile-error` — a genuine type error. `failedCheck: compile`, `TS2322` against `broken.ts`.
2. `02-failing-test` — a spec written to fail. `failedCheck: tests`, the assertion message in the test log.
3. `03-characterization-mismatch` — a migrated function that computes something else. `failedCheck: characterization`, both outcomes in the result.
4. `04-angular-only-error` — valid TypeScript with an unresolvable DI token. `failedCheck: compile`, `NG2003`. Bare `tsc` accepts this file; this control fails if the compile check ever stops running the Angular compiler.

Positive controls — the same spec also requires that an untouched workspace compiles (LOW with nothing to verify), that a matching characterization reaches MEDIUM, and that a passing supplied spec does not raise the tier. Without these, the negative controls cannot distinguish a working gate from a broken one.

False-accept regressions — shapes the first version of the gate tiered MEDIUM (docs/decisions.md ADR-057) must come back LOW.
