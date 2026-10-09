# Build Progress

This is the single source of truth for where this project actually stands — read it first, before anything else, at the start of any session. It answers two questions: what's built and verified so far, and what's the next concrete thing to do. `docs/decisions.md` is the complementary log of *why* specific technical choices were made; this file is *where things are right now*.

Update this file at the end of every session — rewrite the status table and "Where things stand" section to reflect current reality, and append one entry to the session log. Never leave it describing a past state as if it were current.

## Status at a glance

| Milestone | Status | PR |
|---|---|---|
| M0 — Inventory scanner | done | [#1](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/1) |
| M0.5 — Target workspace scaffold | done | [#3](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/3) |
| M1 — Deterministic codemods | done (10/10 patterns) | [#5](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/5), [#6](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/6), [#8](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/8), [#10](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/10), [#11](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/11), [#12](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/12), [#13](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/13), [#15](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/15), [#16](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/16), [#17](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/17), [#18](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/18), [#19](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/19), [#21](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/21) |
| M2 — Verification gate | done — maintainer has read `verification/` line by line (ADR-070) | [#23](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/23) |
| M2.5 — Pipeline assembler | done — run on three fixtures and two unseen repos | [#24](https://github.com/AshwinSathian/angularjs-migration-copilot/pull/24) |
| M3 — LLM fallback + scheduler | not started | — |
| M4 — Web layer | not started | — |
| M5 — Fixtures, licensing, published report | not started | — |

Full scope and definition-of-done for each milestone: `docs/milestones/`.

## Where things stand

Keep this section short. It states what is true now; the reasoning and the bugs found along the way live in `docs/decisions.md` and in git history (`git log -p docs/PROGRESS.md` has the long per-pattern narrative this section used to carry).

**Tooling.** Nx workspace, npm, Node 24, TypeScript 6, ESLint 10, Vitest 4. CI runs gitleaks, `lint`/`typecheck`/`test` for every project, a check that `migration-core`'s production dependency tree is framework-free, and — on changes under the verification module — the real gate controls. `main` requires a PR.

**Built and verified.**
- **M0** `ingest/`, `inventory/`, `libs/secrets-scan` — tooling detection, AST inventory, secrets redaction. CLI: `inventory`.
- **M0.5** `scaffold/` — real Angular workspace via `ng new` (pinned `@angular/cli@22.2.2`, ADR-069), confirmed with `ng build`. CLI: `scaffold`.
- **M1** `codemods/` — all 10 patterns, each a single-file string transform. CLI: `codemod`. On its own a codemod's output is not an Angular file (it leaves the AngularJS registration beside the new class); M2.5 is what makes it one.
- **M2** `verification/` — compile check through the Angular compiler (`ngc`), optional supplied spec, characterization diff in a `node:vm` sandbox, one pure tiering function (`decideTier`): **MEDIUM / LOW / REJECTED**. Nine real, unmocked controls (4 negative asserting the failed check and its evidence, 3 positive, 2 false-accept regressions). CLI: `verify`.
- **M2.5** `pipeline/` — `migrate <repo> <workspace>`: every codemod per file, output lifted into standalone exported `.ts` files with imports inside the scaffolded workspace, compiled in rounds so each file is judged on its own errors, each artifact tiered by the gate, JSON report.

**Numbers (2026-10-09, `migrate` on Angular 22.2.2, ADR-064/071/072).** "Matched" is what every earlier hit count in this project measured: a pattern recognized something. "Compiled" is files with at least one artifact the Angular compiler accepted. Never quote the first as if it were the second.

| Repo | AngularJS files in scope | Pattern matched | Compiled in workspace |
|---|---|---|---|
| `angular-phonecat` (fixture) | 14 | 4 (28.6%) | 2 (14.3%) |
| `CoreUI-AngularJS` (fixture) | 21 | 5 (23.8%) | 4 (19.0%) |
| `blur-admin` (fixture) | 213 | 62 (29.1%) | 23 (10.8%) |
| `angular-app/angular-app` @ `92c579a` (unseen) | 59 | 36 (61.0%) | 11 (18.6%) |
| `gothinkster/angularjs-realworld-example-app` @ `08755ca` (unseen) | 28 | 11 (39.3%) | 0 (0%) |

Emitted artifacts by type and tier (MEDIUM / LOW / REJECTED):

| Repo | controller | service | filter | directive | route |
|---|---|---|---|---|---|
| `angular-phonecat` | — | 0 / 1 / 0 | 1 / 0 / 0 | — | 0 / 0 / 1 |
| `CoreUI-AngularJS` | 0 / 21 / 20 | — | — | — | — |
| `blur-admin` | 0 / 18 / 6 | 0 / 1 / 0 | 1 / 3 / 1 | 0 / 0 / 3 | 0 / 0 / 2 |
| `angular-app` | 0 / 11 / 7 | 0 / 1 / 8 | — | — | 0 / 0 / 2 |
| `angularjs-realworld` | — | — | — | — | — |

Characterization eligibility by artifact type: filters — 2 eligible and matched (MEDIUM), 3 compiled but ineligible because they close over an injected dependency (LOW), 1 never compiled; controllers, services, directives, routes — 0 eligible, no producer exists and none has a real target yet (ADR-073). There is no MEDIUM outside pure filters, and for mechanical output MEDIUM is a weak claim: both sides derive from the same source text, so it shows the lift broke nothing, not that a rewrite is correct. It will mean more for Stage 3 output.

LOW is not an accept. Every LOW controller, service and pipe that takes an AngularJS injectable lists it under `followUps` in the report: the file compiles, and nothing provides that dependency yet.

Why things are rejected, most common first: a name declared in another file or by a third-party library (`brandPrimary`, `angular`, `$`, `Chart` — `TS2304`/`TS2592`); a `.factory` body returning an object from what is now a constructor (`TS2409`, `angular-app`); routes naming components nobody migrated; component templates still in AngularJS syntax (`ng-src`, `::` one-time bindings, unknown elements and pipes). None of these is mechanical; they are Stage 3's input.

**Not built yet:** LLM-assisted fallback (M3), the web layer (M4), published fixture runs (M5).

**Known, open:**
- A transformed template is compiled only when a migrated component owns it. In `blur-admin` 27 of the 62 matched files are templates nothing compiled; 15 in `angular-app`, 11 in `angularjs-realworld`.
- `migrate` scopes by content, not directory: two third-party files under `angular-app`'s `client/vendor/` are counted in scope. Directory names are deliberately not used to exclude (ADR-018).
- `collect-call-site-args.ts` matches callees by name and nothing calls it (ADR-050).
- `nx build migration-core` can exit 0 having written nothing (ADR-055). `npx tsc -b libs/migration-core/tsconfig.lib.json` is the build that can be trusted. After `npm install`, `npx nx reset` clears a stale "workspace is out of sync" error.
- No sandbox: the compiler and test runner run on the host, and `node:vm` (characterization) is not a security boundary. Only run `migrate` against code you trust.
- `npm audit --omit=dev`: 3 high, one advisory in `braces` via `fast-glob`, no fix published; the glob patterns are this project's constants, not target-repo input. Node's built-in `fs.promises.glob` would remove the dependency. Dev-tooling advisories under `nx` remain (ADR-012).
- No provider API keys exist in the dev environment or CI yet; M3's real-provider smoke tests need them.
- `ng-morph` is named in the spec as an AST engine and has never been needed or installed.
- Nx 23.3 and TypeScript 7 deliberately not adopted (ADR-066). Revisit Node 26 after it becomes Active LTS on 2026-10-28.

## What's next — prompt for the next session

**M3 — LLM fallback + provider scheduler** (`docs/milestones/m3-llm-fallback.md`, which now states the concrete contract with what already exists). Nothing is owed before it: the gate has had its human read, CI runs the suite and requires it, the mechanical pipeline runs end to end, and the mechanical rejections that could be fixed mechanically have been.

Start by reading the M3 milestone doc and running `migrate` once yourself to see a report. Then, before any code: check current provider limits (ADR-008), and ask the maintainer for provider keys — none exist in the environment.

Every milestone ends in a PR, never a direct commit to `main`. Nothing is done until it has been run and its output checked. Any change under `verification/` needs the maintainer's line-by-line read before merge.

## Session log

One line per session, newest last. Detail belongs in `docs/decisions.md`.

- **2026-09-15** — Repo, spec, M0, M0.5; M1 patterns #3, #1, #2 (ADR-001–033).
- **2026-09-16** — M1 patterns #3 follow-ups, #4, #9, #5 (ADR-034–043).
- **2026-09-21** — M1 patterns #8, #10, #6, #7 (ADR-044–048).
- **2026-09-22** — Pattern #7 merged; M2 first implementation on `worktree-m2-verification-gate`, not pushed (ADR-049–056).
- **2026-10-09** — Adversarial review by execution: stages did not connect, gate false-accepted, controls were vacuous (ADR-057). Plan re-locked (ADR-058–061). M2 fix pass, CI checks job and real module boundaries, draft PR #23 green (ADR-062). M2.5 assembler built and run on all three fixtures; first compiled-in-workspace numbers (ADR-063–065). Pre-merge adversarial review with mutation testing hardened the gate and CI (ADR-067); merge of #22/#23/#24 left to the maintainer — the harness blocks an agent merging without review (ADR-068). This file cut from 124 KB to its current size.
- **2026-10-09 (later)** — #23, #24, #22 merged by the maintainer; `main` CI green on all four jobs. Status table and next steps brought in line.
- **2026-10-09 (wrap-up)** — Maintainer read `verification/` line by line (ADR-070). Angular CLI pin to 22.2.2 (ADR-069, #29); Dependabot #26/#27 merged, #25 closed as superseded. Assembler completions lifted `blur-admin` to 10.8% compiled (ADR-071). Two unseen repos run (ADR-072). `Lint, typecheck, unit tests` made a required check on `main`. Ready for M3.
