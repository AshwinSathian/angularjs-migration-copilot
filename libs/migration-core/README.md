# libs/migration-core

The actual pipeline — Stages 0 through 5. Zero dependencies on `@nestjs/*` or `@angular/*` packages; runs standalone as a CLI with no framework in the loop. This boundary is enforced in CI, not just documented. See [docs/architecture.md §1](../../docs/architecture.md) and [CLAUDE.md](../../CLAUDE.md).

| Directory | Stage | Status |
|---|---|---|
| `src/ingest/` | 0 — clone, detect tooling, secrets scan | shipped (M0) |
| `src/inventory/` | 1 — AST scan, dependency graph | shipped (M0) |
| `src/scaffold/` | 1.5 — target Angular workspace generation | not started (M0.5) |
| `src/codemods/` | 2 — the 10 fixed deterministic patterns | not started (M1) |
| `src/llm-fallback/` | 3 — schema-constrained patch generation | not started (M3) |
| `src/verification/` | 4 — compile/test/characterization gate. Changes here require human review, no exceptions — see [CLAUDE.md](../../CLAUDE.md) | not started (M2) |
| `src/report/` | 5 — side-by-side diff, confidence tiers, honest numbers | not started (M5) |

The CLI (`bin: angularjs-migration-copilot`) currently exposes one command, `inventory <repoPath>`, running Stages 0–1 and writing a JSON report. It isn't published to npm yet — run it locally via `node dist/cli.js` after building. See [docs/milestones/m0-inventory.md](../../docs/milestones/m0-inventory.md) for what M0 actually shipped and how it was checked.
