# M2 — Verification Gate

**Status:** not started
**Estimate:** 1.5–2.5 weeks
**Depends on:** M0.5 (doesn't strictly need M1, but in practice needs something to verify)

## Scope

The compile/test/characterization gate described in [product-spec.md §6.5](../product-spec.md): `tsc --noEmit`, the target module's existing test suite if it functions, and a generated characterization test (golden-master diffing) if it doesn't.

- Characterization-test eligibility is precisely defined in the spec — implement that definition exactly, don't approximate it.
- Golden-master input generation pulls from real call-site arguments across the codebase, unioned with type-based boundary values. A function with fewer than two call-site examples and no inferable parameter types is ineligible, not tested against a single degenerate input.
- Diffing uses structural deep-equality with explicit tolerance for key-ordering and Date-serialization differences, so a format change doesn't get mislabeled as a behavioral regression.
- Every file exits tagged HIGH, MEDIUM, or REJECTED — never a bare pass/fail.

## The exception to normal workflow

This is the one component whose correctness the entire project's credibility rests on. Changes here are **human-written or human-reviewed line by line**, not Claude-Code-authored without heavy scrutiny — see [architecture.md §6.4](../architecture.md) for why an agent grading its own verification code is a circularity worth taking seriously rather than trusting by default.

From day one of this milestone, `libs/migration-core/verification/__fixtures__/negative-controls/` ships three planted, deliberately-broken cases:

1. A file with a genuine `tsc` compile error.
2. A module whose test is written to fail.
3. A function whose characterization diff is engineered to mismatch.

## Definition of done

The gate correctly returns REJECTED on all three negative-control fixtures. This isn't a one-time check — the fixture directory runs in CI on every subsequent change to the verification module, permanently, per [decisions.md](../decisions.md) and [CLAUDE.md](../../CLAUDE.md).
