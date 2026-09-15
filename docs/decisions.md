# Architecture Decision Log

Append-only. Each entry: `[ID] [date] [decision] — [reason] — [superseded-by: none | ID]`.
Superseded entries stay in the log with a pointer forward — this is a
history, not a current-state document. Read this before starting work on any
milestone; it's a handful of short lines, not the whole spec.

- **ADR-001** 2026-09-15 — Standalone Nx repo, own public GitHub repo, not folded into an existing monorepo — independent discoverability (own README, stars, issue tracker) matters more here than monorepo convenience for a portfolio artifact — superseded-by: none
- **ADR-002** 2026-09-15 — npm as the package manager, not pnpm or yarn — zero extra tooling required on a contributor's machine, and this workspace's scale doesn't need pnpm's workspace-linking performance — superseded-by: none
- **ADR-003** 2026-09-15 — Vitest as the test runner across the whole workspace, including `apps/web` — Angular CLI's own default for new workspaces as of Angular 21, confirmed against the live `@angular/build:unit-test` schema rather than assumed from memory — superseded-by: none
- **ADR-004** 2026-09-15 — Node 24, pinned via `.nvmrc` — current Active LTS as of this project's start; will move to 26 when that becomes Active LTS (~October 2026) — superseded-by: none
- **ADR-005** 2026-09-15 — Full v1 scope committed to (all 7 milestones, ~9–12.5 weeks), not a trimmed mechanical-only v1 — the verification gate is the actual differentiator against every existing AngularJS migration tool; cutting it ships a codemod script with a slower story — superseded-by: none
- **ADR-006** 2026-09-15 — Fixture repos locked in: `angular/angular-phonecat`, `mrholek/CoreUI-AngularJS`, `akveo/blur-admin`. All three directly license-checked (not assumed) — see `docs/product-spec.md §11` for the specific caveats on the latter two — superseded-by: none
- **ADR-007** 2026-09-15 — `gitleaks` named as the specific secrets-scanning tool, not "gitleaks or equivalent" — a coding agent implementing CI/pre-commit hooks needs one concrete tool to wire up, not an open choice to make later — superseded-by: none
- **ADR-008** 2026-09-15 — Provider rate limits (Groq/Gemini/OpenRouter) are not hardcoded as fact anywhere in the spec beyond priority order — direct verification against both providers' own docs during this project's setup showed the numbers already drifting from third-party trackers, and free-tier terms are each provider's unilateral policy per `docs/product-spec.md §7`. Priority order (Groq → Gemini Flash-Lite → Gemini Flash → OpenRouter) is fixed; exact RPM/RPD figures get checked at M3 build time, not copied from this log — superseded-by: none
- **ADR-009** 2026-09-15 — CI ships on day one with only the `secrets-scan` job active and passing. The rest of the pipeline in `docs/architecture.md §5` (lint, typecheck, unit tests, dependency-boundary check, fixture integration) gets added incrementally as each milestone lands the tooling it depends on — a red CI badge before there's a workspace to lint or build is worse than a small badge for now — superseded-by: none
