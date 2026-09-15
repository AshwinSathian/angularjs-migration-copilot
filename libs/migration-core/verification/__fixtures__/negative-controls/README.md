# Negative-control fixtures

Three deliberately-broken cases the verification gate has to correctly reject. This directory is a permanent regression contract, not a one-time test — it runs in CI on every change to `libs/migration-core/verification/`. See [docs/architecture.md §6.4](../../../../../docs/architecture.md) and [docs/milestones/m2-verification.md](../../../../../docs/milestones/m2-verification.md).

Planted here in M2:

1. A file with a genuine `tsc` compile error.
2. A module whose test is written to fail.
3. A function whose characterization diff is engineered to mismatch.

The gate isn't considered built until it returns REJECTED on all three.
