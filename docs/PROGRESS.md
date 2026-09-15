# Build Progress

This is the single source of truth for where this project actually stands — read it first, before anything else, at the start of any session. It answers two questions: what's built and verified so far, and what's the next concrete thing to do. `docs/decisions.md` is the complementary log of *why* specific technical choices were made; this file is *where things are right now*.

Update this file at the end of every session — rewrite the status table and "Where things stand" section to reflect current reality, and append one entry to the session log. Never leave it describing a past state as if it were current.

## Status at a glance

| Milestone | Status | PR |
|---|---|---|
| M0 — Inventory scanner | done | [#1](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/1) |
| M0.5 — Target workspace scaffold | done | [#3](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/3) |
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
- Re-verified against the live npm registry (not cached docs, which were a full minor behind): Angular's actual latest stable is `22.1.x`, not `21.x` — see ADR-020. `@angular/cli@22.1.8` pinned as a root devDependency.
- Real, unmocked runs performed and confirmed, not assumed, twice — once pre-review, once after the fixes below: `ng new` generates a real workspace at the exact requested absolute path, `ng build` exits 0, `dist/<name>/browser/` contains real build output.
- Merged only after a 4-angle adversarial review (silent-failure, type-design, test-coverage, general) found and fixed real defects, not style nits — see ADR-021 and ADR-022: `ng new --directory` silently mishandling an absolute path (nests under cwd instead of erroring); `appName`/`angularCliVersion` reaching `spawn`'s argv unvalidated, confirmed exploitable via `ng new` flag-injection and npm's `name@npm:other-package@version` alias syntax; a timeout that only signaled the immediate `npx` process, never the `npm install` grandchild doing the real work; and a directory-emptiness check that silently treated permission errors as "safe to proceed," disabling its own guard exactly when it mattered.
- 99 total unit tests across the workspace (84 in `migration-core`, 15 in `secrets-scan`), all passing; `typecheck` and `lint` clean.

**Not built yet:** all 10 codemod patterns (M1), the verification gate (M2 — the component this whole project's credibility rests on), LLM-assisted fallback (M3), the NestJS/Angular/Mongo web layer (M4), and the final fixture runs with published numbers (M5). `mrholek/CoreUI-AngularJS` and `akveo/blur-admin` are picked as fixtures and license-checked (`docs/product-spec.md §11`) but not vendored yet.

**Known, open, non-blocking:**
- A Dependabot PR may exist proposing an `nx` downgrade to fix the `smol-toml` advisory (ADR-012). Don't merge it without re-deriving the same tradeoff ADR-012 already made — downgrading `nx` was deliberately rejected once already, for reasons that don't go away just because Dependabot found the same CVE.
- `scan-routes.ts`/`scan-watches.ts` don't resolve identifier aliasing (ADR-019) — a documented, low-prevalence gap, not a TODO.
- The four `inventory/scan-*.ts` files still each do their own traversal of the parsed project (ADR-019) — fine at M0's scale, worth revisiting if M1's larger fixtures show it mattering.

## What's next — prompt for the next session

Start **M1 — Deterministic codemods** (`docs/milestones/m1-codemods.md`, 2–3 week estimate). Read that file, `docs/product-spec.md §6.3`, and `docs/decisions.md` ADR-015/ADR-019 first — ADR-015's full `angular.Module` registration surface and ADR-019's known scan-routes/scan-watches limitations both directly bound what these codemods can assume about their input.

The 10 patterns are fixed v1 scope (`docs/product-spec.md §6.3`) — don't add an 11th opportunistically. Don't build this as one big-bang PR: land it as a vertical slice per pattern (transform + before/after fixture-file unit test + wiring), same incremental style M0 and M0.5 used, so each pattern is independently reviewable and mergeable. Suggested order: start with pattern #1 (`$scope.x = y` → class property) or #3 (array-style DI → constructor injection) — both are small, self-contained, and don't depend on the others, good for standing up the shared codemod plumbing (`libs/migration-core/src/codemods/`, presumably ts-morph-based like `inventory/` already is) before tackling the harder patterns (#4 directive→Component, #6 `$http` chains, #8 router config).

**Before writing pattern code, resolve one real blocker:** `mrholek/CoreUI-AngularJS` and `akveo/blur-admin` are picked and license-checked (ADR-006, `docs/product-spec.md §11`) but not vendored yet — only `angular-phonecat` is. M1's definition of done requires mechanical-hit-rate reported against **all three** fixture repos, `blur-admin` (the messiest) included, never just the flattering one. Vendor both the same way `angular-phonecat` was (pinned git submodule, commit SHA recorded), and actually run `npm install` against them once to confirm they still install on Node 24 before assuming any fixture-based test plan works — the M0 session found real problems (ADR-010, ADR-018) only by doing exactly this, not by reading the repos.

Per CLAUDE.md's scope-discipline and reporting-honesty rules: hit-rate and characterization-eligibility numbers (the latter is M2's job, but keep the per-artifact-type breakdown requirement in mind now since it shapes what metadata each codemod should emit) must never be a single smoothed aggregate — report per-repo and, once M2 exists, per-artifact-type. Each pattern's fixture test should capture a real hit *and* a real miss (something that looks like the pattern but has a documented reason to skip it, e.g. a directive with `transclude` for pattern #4) — M0's adversarial review repeatedly found bugs in the "why we skip this" branch, not the happy path.

As with every milestone here: ends in a PR, not a direct commit to `main`; nothing is "done" until actually run and its output checked, not inferred from the code looking right. Before closing the session, update this file's status table, "Where things stand," and session log — and if you deliberately reorder anything (e.g. vendoring fixtures before pattern #1, or doing patterns in a different order than suggested above), log why in `docs/decisions.md`, not just here.

## Session log

Append one entry per session, newest last. Keep each entry to a few lines — this is a changelog, not a transcript; `docs/decisions.md` and the milestone docs carry the detail.

- **2026-09-15** — Repo created from scratch: product spec and architecture doc adversarially reviewed and rewritten for public consumption (license verification, current-defaults verification, ADR-001–009), GitHub repo pushed with branch protection and CI. M0 implemented (`libs/secrets-scan`, `libs/migration-core` ingest + inventory, CLI), then put through an 8-angle adversarial review that found and fixed real bugs before merge (ADR-010, ADR-014–019). Merged via PR #1. This file created to track progress going forward.
- **2026-09-15** — M0.5 implemented: re-verified Nx/Angular/Node/TypeScript compatibility against the live npm registry, correcting a stale assumption that Angular 21 was current (it's 22.1.x — ADR-020). Built `libs/migration-core/src/scaffold/` (subprocess-only Angular CLI invocation, no `@angular/*` dependency added to `migration-core`), wired a `scaffold` CLI command, added `@angular/cli@22.1.8` as a root devDependency. Real, unmocked run performed: found and fixed a genuine bug where `ng new --directory` mishandles absolute paths (ADR-021). Opened as [PR #3](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/3) — `git` was initially non-functional in this session's shell (macOS Xcode license not accepted); user accepted it mid-session and the branch/commit/push/PR flow completed normally after.
- **2026-09-15** — PR #3 put through a 4-angle adversarial review (silent-failure, type-design, test-coverage, general) before merge, same practice as M0's. Found and fixed real defects: unvalidated `appName`/`angularCliVersion` were a confirmed, working `ng new` flag-injection and npm alias-injection vector; the subprocess timeout only signaled the immediate process, not the `npm install` grandchild doing the real work; a directory-emptiness check silently treated permission errors as "safe to proceed." All fixed, re-verified with real (not mocked) scaffold + build runs plus real injection-payload rejection checks, 99/99 tests passing — see ADR-022. Merged via [PR #3](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/3) (squash, branch deleted). `docs/milestones/m0.5-scaffold.md` status corrected from stale "not started." Next session: M1 codemods, prompt above.
