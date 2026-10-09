# Build Progress

This is the single source of truth for where this project actually stands — read it first, before anything else, at the start of any session. It answers two questions: what's built and verified so far, and what's the next concrete thing to do. `docs/decisions.md` is the complementary log of *why* specific technical choices were made; this file is *where things are right now*.

Update this file at the end of every session — rewrite the status table and "Where things stand" section to reflect current reality, and append one entry to the session log. Never leave it describing a past state as if it were current.

## Status at a glance

| Milestone | Status | PR |
|---|---|---|
| M0 — Inventory scanner | done | [#1](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/1) |
| M0.5 — Target workspace scaffold | done | [#3](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/3) |
| M1 — Deterministic codemods | done (10/10 patterns) | [#5](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/5), [#6](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/6), [#8](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/8), [#10](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/10), [#11](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/11), [#12](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/12), [#13](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/13), [#15](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/15), [#16](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/16), [#17](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/17), [#18](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/18), [#19](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/19), [#21](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/21) |
| M2 — Verification gate | built, fix pass done, CI green — **awaiting human line-by-line review** | [#23](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/23) (draft) |
| M2.5 — Pipeline assembler | built and run on all three fixtures — awaiting review (stacked on #23) | see below |
| M3 — LLM fallback + scheduler | not started | — |
| M4 — Web layer | not started | — |
| M5 — Fixtures, licensing, published report | not started | — |

Full scope and definition-of-done for each milestone: `docs/milestones/`.

## Where things stand

Keep this section short. It states what is true now; the reasoning and the bugs found along the way live in `docs/decisions.md` and in git history (`git log -p docs/PROGRESS.md` has the long per-pattern narrative this section used to carry).

**Tooling.** Nx workspace, npm, Node 24, TypeScript 6, ESLint 10, Vitest 4. CI runs gitleaks, `lint`/`typecheck`/`test` for every project, a check that `migration-core`'s production dependency tree is framework-free, and — on changes under the verification module — the real gate controls. `main` requires a PR.

**Built and verified.**
- **M0** `ingest/`, `inventory/`, `libs/secrets-scan` — tooling detection, AST inventory, secrets redaction. CLI: `inventory`.
- **M0.5** `scaffold/` — real Angular workspace via `ng new` (pinned `@angular/cli@22.1.8`), confirmed with `ng build`. CLI: `scaffold`.
- **M1** `codemods/` — all 10 patterns, each a single-file string transform. CLI: `codemod`. On its own a codemod's output is not an Angular file (it leaves the AngularJS registration beside the new class); M2.5 is what makes it one.
- **M2** `verification/` — compile check through the Angular compiler (`ngc`), optional supplied spec, characterization diff in a `node:vm` sandbox, one pure tiering function (`decideTier`): **MEDIUM / LOW / REJECTED**. Nine real, unmocked controls (4 negative asserting the failed check and its evidence, 3 positive, 2 false-accept regressions). CLI: `verify`.
- **M2.5** `pipeline/` — `migrate <repo> <workspace>`: every codemod per file, output lifted into standalone exported `.ts` files with imports inside the scaffolded workspace, compiled in rounds so each file is judged on its own errors, each artifact tiered by the gate, JSON report.

**First real numbers (2026-10-09, `migrate` against each pinned fixture, ADR-064).** "Matched" is what every earlier hit count in this project measured: a pattern recognized something. "Compiled" is files with at least one artifact the Angular compiler accepted. Never quote the first as if it were the second.

| Fixture | AngularJS files in scope | Pattern matched | Compiled in workspace |
|---|---|---|---|
| `angular-phonecat` | 14 (11 scripts, 3 templates) | 4 (28.6%) | 2 (14.3%) |
| `CoreUI-AngularJS` | 21 (11 scripts, 10 templates) | 5 (23.8%) | 4 (19.0%) |
| `blur-admin` | 213 (138 scripts, 75 templates) | 62 (29.1%) | 14 (6.6%) |

Emitted artifacts by type and tier (MEDIUM / LOW / REJECTED):

| Fixture | controller | service | filter | directive | route |
|---|---|---|---|---|---|
| `angular-phonecat` | — | 0 / 1 / 0 | 1 / 0 / 0 | — | 0 / 0 / 1 |
| `CoreUI-AngularJS` | 0 / 18 / 23 | — | — | — | — |
| `blur-admin` | 0 / 12 / 12 | 0 / 1 / 0 | 1 / 0 / 4 | 0 / 0 / 3 | 0 / 0 / 2 |

Characterization eligibility by artifact type: filters 2 of 2 that compiled were eligible and matched (4 more never compiled — an untyped DI parameter, `NG2003`, or the `angular` global); controllers, services, directives and routes 0 — no producer exists for them, so every one that compiles is LOW. There is no MEDIUM outside pure filters.

Why things are rejected, most common first: a free AngularJS-era global (`angular`, `$`, a chart library — `TS2304`/`TS2592`); an untyped callback parameter (`TS7006`); routes naming components nobody migrated; component templates still written in AngularJS syntax (`ng-src`, unknown elements and pipes); pipes whose DI parameter has no injection token.

**Not built yet:** LLM-assisted fallback (M3), the web layer (M4), published fixture runs (M5).

**Known, open:**
- In `blur-admin`, 149 of 213 files match no pattern at all (103 scripts, 46 templates), and 27 of the 62 "matched" files are templates pattern #7 transformed that nothing compiled — a template is only compiled when a migrated component owns it, and only 2 do (both rejected). The same holds for the one transformed template in each of the other two fixtures.
- `collect-call-site-args.ts` matches callees by name and nothing calls it (ADR-050). Filters are called from templates, which carry no literal arguments.
- `nx build migration-core` can exit 0 having written nothing (ADR-055; seen again 2026-10-09). `npx tsc -b libs/migration-core/tsconfig.lib.json` is the build that can be trusted.
- No sandbox: the compiler and test runner run on the host. Only run `migrate` against code you trust.
- `ng-morph` is named in the spec as an AST engine and has never been needed or installed.
- The two previously-unseen repos the v1 definition of done requires have not been chosen.
- Dependabot PR #22 (`ip-address` 10.7.0 → 10.7.3, lockfile only) is open and mergeable.
- Versions re-checked 2026-10-09, deliberately not bumped (ADR-066). Revisit Node 26 after it becomes Active LTS on 2026-10-28.

## What's next — prompt for the next session

1. **Human review of PR #23** (`verification/`, every line) — CLAUDE.md rule, nothing merges before it. The M2.5 PR is stacked on it and also touches `verification/` (a `route` artifact type, parameter-type inference, one richer string boundary value); same rule.
2. **Raise the mechanical compiled rate before spending LLM calls.** The rejection list above is mostly mechanical: type untyped callback parameters `any`; give migrated classes typed DI tokens instead of `any`; emit a stub or skip for route components that were not migrated. Each is a change to an existing pattern's output, not an 11th pattern. Re-run `migrate` on all three fixtures after each and update the tables.
3. **Characterization producers beyond filters** — a `.factory`/`.service` returning an object of pure functions is the next cheapest; controllers will stay LOW by design.
4. **M3** (`docs/milestones/m3-llm-fallback.md`) once 2 stops moving the numbers. Check provider limits first (ADR-008). Its input is the REJECTED and NO_MATCH files in the `migrate` report; its output goes back through `decideTier`.
5. Pick the two unseen repos; run `migrate` on them early rather than at M5.

Every milestone ends in a PR, never a direct commit to `main`. Nothing is done until it has been run and its output checked.

## Session log

One line per session, newest last. Detail belongs in `docs/decisions.md`.

- **2026-09-15** — Repo, spec, M0, M0.5; M1 patterns #3, #1, #2 (ADR-001–033).
- **2026-09-16** — M1 patterns #3 follow-ups, #4, #9, #5 (ADR-034–043).
- **2026-09-21** — M1 patterns #8, #10, #6, #7 (ADR-044–048).
- **2026-09-22** — Pattern #7 merged; M2 first implementation on `worktree-m2-verification-gate`, not pushed (ADR-049–056).
- **2026-10-09** — Adversarial review by execution: stages did not connect, gate false-accepted, controls were vacuous (ADR-057). Plan re-locked (ADR-058–061). M2 fix pass, CI checks job and real module boundaries, draft PR #23 green (ADR-062). M2.5 assembler built and run on all three fixtures; first compiled-in-workspace numbers (ADR-063–065). This file cut from 124 KB to its current size.
