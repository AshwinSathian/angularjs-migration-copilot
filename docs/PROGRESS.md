# Build Progress

This is the single source of truth for where this project actually stands — read it first, before anything else, at the start of any session. It answers two questions: what's built and verified so far, and what's the next concrete thing to do. `docs/decisions.md` is the complementary log of *why* specific technical choices were made; this file is *where things are right now*.

Update this file at the end of every session — rewrite the status table and "Where things stand" section to reflect current reality, and append one entry to the session log. Never leave it describing a past state as if it were current.

## Status at a glance

| Milestone | Status | PR |
|---|---|---|
| M0 — Inventory scanner | done | [#1](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/1) |
| M0.5 — Target workspace scaffold | code done, PR blocked on local git | — |
| M1 — Deterministic codemods | not started | — |
| M2 — Verification gate | not started | — |
| M3 — LLM fallback + scheduler | not started | — |
| M4 — Web layer | not started | — |
| M5 — Fixtures, licensing, published report | not started | — |

Full scope and definition-of-done for each milestone: `docs/milestones/`.

## Where things stand

**Repo and tooling:** Nx workspace scaffolded (npm, Node 24, TypeScript 6, ESLint 10, Vitest 4 — see `docs/decisions.md` ADR-001–004). CI runs one job (`secrets-scan`, gitleaks) — the rest of the pipeline described in `docs/architecture.md §5` gets added as each milestone lands the tooling it needs (ADR-009). Branch protection on `main` requires a PR and a passing `secrets-scan` check; there is no working direct-push path, by design.

**Built and verified (M0):**
- `libs/secrets-scan` — pattern-based credential detection and redaction, used before any content reaches an LLM prompt.
- `libs/migration-core/src/ingest/` — AngularJS version detection, build-tool detection, structural (AST-based) Karma/PhantomJS detection and remediation-generation, and the repo-wide secrets scan.
- `libs/migration-core/src/inventory/` — an AST scanner (ts-morph) covering module declarations, the full `angular.Module` registration surface (controller/directive/component/service/factory/provider/value/constant/filter/decorator/animation) with DI extraction, ngRoute/ui-router routes, `$watch` usage, and vendored-framework-source exclusion.
- A CLI (`inventory <repoPath>`) wiring both into one JSON report. Not published to npm yet — run locally via `node libs/migration-core/dist/cli.js`.
- `fixtures/angular-phonecat` vendored as a pinned git submodule (commit `ef6f6eb`); its `npm install` and real Karma suite (5/5 specs) have both actually been run on Node 24, not assumed to still work.
- 84 unit tests, all passing. Went through an 8-angle adversarial review before merge that found and fixed several real bugs — see `docs/decisions.md` ADR-010 and ADR-014–019, and the "Adversarial review round" section of `docs/milestones/m0-inventory.md` for the specifics (a couple are worth reading even if you skip everything else: a regex-based remediation that could corrupt unrelated code, and a scanner that briefly mistook AngularJS's own framework source for the application being migrated).

**Built and verified (M0.5):**
- `libs/migration-core/src/scaffold/` — `scaffoldTargetWorkspace()` shells out to the real Angular CLI (`npx @angular/cli@22.1.8 new ...`, subprocess only — no `@angular/*` import, so the module-boundary rule holds) to generate a real Angular workspace into a caller-specified, empty output directory; `verifyWorkspaceBuilds()` runs `ng build` inside it and reports the real exit code. Wired into the CLI as `angularjs-migration-copilot scaffold <outputDir>`.
- Re-verified this session against the live npm registry (not cached docs, which were a full minor behind): Angular's actual latest stable is `22.1.x`, not `21.x` — see ADR-020. `@angular/cli@22.1.8` pinned as a root devDependency.
- Real, unmocked run performed and confirmed, not assumed: `ng new` generated a real workspace at the exact requested absolute path, `ng build` exited 0, and `dist/<name>/browser/` contained real build output. This surfaced and fixed a real bug — `ng new --directory` silently mishandles an absolute path by stripping the leading `/` and nesting under the process's cwd instead of erroring — see ADR-021.
- 11 new unit tests (mocked subprocess for argv/cwd assertions, real trivial subprocess for the generic command-runner). 95 total unit tests across the workspace (80 in `migration-core`, 15 in `secrets-scan`), all passing; `typecheck` and `lint` clean.

**Not built yet:** all 10 codemod patterns (M1), the verification gate (M2 — the component this whole project's credibility rests on), LLM-assisted fallback (M3), the NestJS/Angular/Mongo web layer (M4), and the final fixture runs with published numbers (M5). `mrholek/CoreUI-AngularJS` and `akveo/blur-admin` are picked as fixtures and license-checked (`docs/product-spec.md §11`) but not vendored yet.

**Known, open, non-blocking:**
- A Dependabot PR may exist proposing an `nx` downgrade to fix the `smol-toml` advisory (ADR-012). Don't merge it without re-deriving the same tradeoff ADR-012 already made — downgrading `nx` was deliberately rejected once already, for reasons that don't go away just because Dependabot found the same CVE.
- `scan-routes.ts`/`scan-watches.ts` don't resolve identifier aliasing (ADR-019) — a documented, low-prevalence gap, not a TODO.
- The four `inventory/scan-*.ts` files still each do their own traversal of the parsed project (ADR-019) — fine at M0's scale, worth revisiting if M1's larger fixtures show it mattering.

**Blocking, needs the user:** `git` doesn't run at all in this session's shell — every invocation (even `git status`) prints `You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window...` and does nothing. M0.5's code is complete and verified, but it cannot be committed, pushed, or opened as a PR until that's accepted interactively (needs a real Terminal and the user's own `sudo` password — not something to attempt from here). Once resolved: `git checkout -b m0.5-scaffold`, commit `libs/migration-core/src/scaffold/`, `libs/migration-core/src/cli.ts`, `libs/migration-core/src/index.ts`, `package.json`, `package-lock.json`, `docs/decisions.md` (ADR-020, ADR-021), this file, and `PLAN-m0.5-scaffold.md`, then open the PR.

## What's next

Finish M0.5: once `git` works again, open the PR described above (see "Blocking, needs the user").

Then **M1 — Deterministic codemods** (`docs/milestones/m1-codemods.md`), consuming `scaffoldTargetWorkspace`'s output as the real compile context for `tsc --noEmit` verification per `docs/product-spec.md §6.5`.

## Session log

Append one entry per session, newest last. Keep each entry to a few lines — this is a changelog, not a transcript; `docs/decisions.md` and the milestone docs carry the detail.

- **2026-09-15** — Repo created from scratch: product spec and architecture doc adversarially reviewed and rewritten for public consumption (license verification, current-defaults verification, ADR-001–009), GitHub repo pushed with branch protection and CI. M0 implemented (`libs/secrets-scan`, `libs/migration-core` ingest + inventory, CLI), then put through an 8-angle adversarial review that found and fixed real bugs before merge (ADR-010, ADR-014–019). Merged via PR #1. This file created to track progress going forward.
- **2026-09-15** — M0.5 implemented: re-verified Nx/Angular/Node/TypeScript compatibility against the live npm registry, correcting a stale assumption that Angular 21 was current (it's 22.1.x — ADR-020). Built `libs/migration-core/src/scaffold/` (subprocess-only Angular CLI invocation, no `@angular/*` dependency added to `migration-core`), wired a `scaffold` CLI command, added `@angular/cli@22.1.8` as a root devDependency. Real, unmocked run performed: found and fixed a genuine bug where `ng new --directory` mishandles absolute paths (ADR-021), then re-ran and confirmed `ng build` exits 0 against a real generated workspace. 95/95 unit tests passing, typecheck and lint clean. PR not yet opened — this session's shell has a non-functional `git` (macOS Xcode license not accepted); see "Blocking, needs the user" above.
