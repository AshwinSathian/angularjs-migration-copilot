# libs/migration-core

The actual pipeline — Stages 0 through 5. Zero dependencies on `@nestjs/*` or `@angular/*` packages; runs standalone as a CLI with no framework in the loop. This boundary is enforced in CI, not just documented. See [docs/architecture.md §1](../../docs/architecture.md) and [CLAUDE.md](../../CLAUDE.md).

| Directory | Stage |
|---|---|
| `ingest/` | 0 — clone, detect tooling, secrets scan |
| `inventory/` | 1 — AST scan, dependency graph |
| `scaffold/` | 1.5 — target Angular workspace generation |
| `codemods/` | 2 — the 10 fixed deterministic patterns |
| `llm-fallback/` | 3 — schema-constrained patch generation |
| `verification/` | 4 — compile/test/characterization gate. Changes here require human review, no exceptions — see [CLAUDE.md](../../CLAUDE.md) |
| `report/` | 5 — side-by-side diff, confidence tiers, honest numbers |

Not built yet. Milestones [M0](../../docs/milestones/m0-inventory.md) through [M3](../../docs/milestones/m3-llm-fallback.md) land this incrementally.
