# Plan: M0.5 — Target Workspace Scaffold
> Status: PROPOSED
> Scale: Standard
> Estimated effort: 1.5 days
> Created: 2026-09-15
> Author: (session-generated, per user request)

## Goal

`libs/migration-core/src/scaffold/` gains a `scaffoldTargetWorkspace()` function
that shells out to the real Angular CLI to generate a fresh Angular workspace
into a caller-specified, empty output directory — never touching the source
repo being migrated. A companion `verifyWorkspaceBuilds()` runs `ng build`
inside that generated workspace and reports its real exit code. Technical
outcome: both are unit-tested (mocked subprocess) and, once, run for real
against a scratch directory with `ng build` exit code 0 confirmed and
recorded in `docs/PROGRESS.md` — not assumed from the generator's own exit
code, per `docs/milestones/m0.5-scaffold.md`'s definition of done.

## Background

Stage 1.5 per `docs/product-spec.md §6.2a`: "Scaffold a real Angular
workspace, via the Angular CLI, into a separate output directory — never
in-place over the source repo." This is what gives Stage 4's `tsc --noEmit`
(§6.5) a real `angular.json`/module graph/decorator context to compile
against later — compiling one migrated file in isolation proves nothing.

M0 (merged, PR #1) built `libs/migration-core/src/ingest/` and
`src/inventory/` with zero `@angular/*`/`@nestjs/*` dependencies, per
`CLAUDE.md`'s module-boundary rule. M0.5 is the first milestone where that
boundary is genuinely at risk: the task *needs* the Angular CLI to run.
Resolution (see Key Decisions below): invoke it as a subprocess, never as an
imported package — `migration-core`'s own `package.json` and build output
stay `@angular/*`-free, satisfying both the letter (lint, import graph) and
the intent (CI's standalone-build dependency-tree diff) of the boundary rule.

Version pins re-verified this session against the live npm registry (not
cached docs) — see `docs/decisions.md` ADR-020: Angular's actual latest
stable is `22.1.x` (not `21.x`, which two secondary sources both wrongly
reported as current), `@angular/cli@22.1.8` requires Node
`^22.22.3 || ^24.15.0 || >=26.0.0` (this repo's Node 24.19.0 satisfies it),
and `@angular/compiler-cli@22.1.6`'s peer `typescript: ">=6.0 <6.1"` matches
this repo's pinned `~6.0.3` exactly.

## Non-Goals

- Not wiring the scaffold output into a full pipeline orchestrator (no
  `POST /jobs`, no consuming it from Stage 2 codemods) — that's M1's and
  M4's job. This milestone ships the scaffold capability and its CLI
  command in isolation, matching how M0 shipped `inventory` standalone.
- Not making the generated *target* workspace an Nx workspace, or otherwise
  coupling it to this repo's own Nx tooling. The repo being migrated gets a
  plain `ng new`-generated workspace; this repo's own Nx/Angular/Node/TS
  version check (ADR-020) is about what's safe to run *inside* this
  monorepo, not about the shape of the thing it generates.
- Not adding new CI jobs (lint-and-typecheck, unit-tests,
  dependency-boundary-check) — ADR-009 already has those landing
  incrementally as each milestone needs them; this plan doesn't force that
  decision. Flagged as a candidate in Follow-up Work below, not decided here.
- Not building `apps/web` (the product's own Angular frontend) — unrelated;
  that's M4, and it's a different Angular app entirely (this tool's UI, not
  the migration target).

## Technical Design

### Overview

```
migration-core CLI ──"scaffold <outputDir>"──▶ scaffoldTargetWorkspace()
                                                      │
                                          spawn: npx ng new <name>
                                          --directory <outputDir> ...
                                                      │
                                          (subprocess only — no
                                           @angular/* import, ever)
                                                      ▼
                                          real Angular workspace on disk
                                                      │
                                          verifyWorkspaceBuilds(outputDir)
                                                      │
                                          spawn: npx ng build (cwd=outputDir)
                                                      ▼
                                          { success, exitCode, stdout, stderr }
```

### Key Components

| Component | File / Path | Change Type | Notes |
|-----------|-------------|--------------|-------|
| Scaffold types | `libs/migration-core/src/scaffold/types.ts` | New | `ScaffoldResult`, `BuildVerificationResult` — `readonly` fields, matching `ingest/types.ts` style |
| Scaffold runner | `libs/migration-core/src/scaffold/scaffold-workspace.ts` | New | `scaffoldTargetWorkspace(options)`; pre-flight check that `outputDir` is absent or empty before spawning anything |
| Build verifier | `libs/migration-core/src/scaffold/verify-workspace-build.ts` | New | `verifyWorkspaceBuilds(workspaceDir)`; spawns `npx ng build`, cwd = workspaceDir |
| Subprocess helper | `libs/migration-core/src/scaffold/run-command.ts` | New | Thin `node:child_process.spawn` → `Promise<{exitCode, stdout, stderr}>` wrapper, shared by both of the above — no new dependency (`execa` etc.), stdlib only |
| Version constant | `libs/migration-core/src/scaffold/constants.ts` | New | `DEFAULT_ANGULAR_CLI_VERSION = '22.1.8'`, cross-referenced from ADR-020 |
| Barrel export | `libs/migration-core/src/scaffold/index.ts` | New | Re-exports, matching `ingest/index.ts` / `inventory/index.ts` pattern |
| CLI wiring | `libs/migration-core/src/cli.ts` | Modify | New `scaffold <outputDir>` command (commander), mirrors the existing `inventory` command's shape |
| Root tooling pin | `package.json` (repo root) | Modify | Add `"@angular/cli": "22.1.8"` to `devDependencies` — exact-pinned, matching how `nx`/`typescript` are pinned here, not caret-ranged |
| ADR entry | `docs/decisions.md` | Modify | Record the exact `ng new` flags landed on, once the manual run confirms which prompts they suppress (see Open Questions) |

### Data Model Changes

None — no Mongo/DTO changes; this is CLI-mode, offline, no persistence layer touched.

### API / Interface Changes

New public exports from `migration-core`'s `src/index.ts`:
`scaffoldTargetWorkspace`, `verifyWorkspaceBuilds`, and the two result types.
New CLI subcommand: `angularjs-migration-copilot scaffold <outputDir> [--name <appName>] [--angular-cli-version <version>]`.

### Key Decisions

- **Subprocess, not import** → Rationale: `CLAUDE.md`'s module boundary
  forbids `@angular/*` as a *dependency* of `migration-core`; shelling out
  to `ng` never adds it to `migration-core/package.json` or its build
  output, so the standalone-build dependency-tree diff (ADR context:
  `CLAUDE.md` "Module boundaries") stays clean. → Alternative considered:
  use `@angular-devkit/schematics` programmatically for a cleaner API —
  rejected, because that *is* an `@angular/*` import, which is exactly the
  dependency the boundary rule exists to keep out of this library.
- **`npx ng ...` over a bare `spawn('ng', ...)`** → Rationale: `npx`
  resolves the root workspace's hoisted `node_modules/.bin/ng` (once
  `@angular/cli` is a root devDependency) without needing this repo's CI or
  local shells to have `ng` on `PATH` directly, and without an extra
  network fetch once it's already installed at the root. → Alternative:
  resolve the binary path manually via `require.resolve` — rejected as
  more code for no behavioral difference; `npx` already does exactly this
  walk-up-and-reuse resolution.
- **Exact-pinned `@angular/cli` version, not `^22.1.8`** → Rationale:
  matches this repo's existing convention (`"nx": "23.2.1"` exact,
  `"typescript": "~6.0.3"`) and keeps the scaffold's output reproducible
  run-to-run instead of drifting silently on a future `npm install`.

## Alternatives Considered

| Option | Pros | Cons | Why Rejected |
|--------|------|------|--------------|
| Use `@angular-devkit/schematics` API directly | No subprocess, structured errors | Pulls `@angular/*` into `migration-core`'s own dependency graph | Violates `CLAUDE.md`'s module-boundary rule outright |
| Put the scaffold module in `apps/api` instead of `migration-core` | Sidesteps the boundary question entirely | Contradicts `docs/product-spec.md §6.2a`'s explicit placement of Stage 1.5 inside the Stage 0–5 pipeline, and would make `migration-core` unusable as a standalone CLI (per `product-spec.md §5`) for this one stage | Spec explicitly scopes this to the core pipeline, not the web layer |
| Skip pinning `@angular/cli` at root; always `npx --yes @angular/cli@<version>` | No new devDependency to maintain | Network fetch on every scaffold call in a fresh environment; version string only lives in source, not `package.json`, easy to drift unnoticed | Root pin costs one `package.json` line and buys reproducibility + no repeated network hit |

## Work Breakdown

### Phase 1: Scaffold module core (~0.5d)
- [ ] `run-command.ts`: promise-wrapped `spawn` helper — AC: unit test confirms it resolves `{exitCode, stdout, stderr}` for both a zero and non-zero exit, using a real trivial child process (e.g. `node -e`), not a mock, since this file has no external dependency to mock
- [ ] `types.ts`, `constants.ts` — AC: `tsc --noEmit` on the lib passes; `DEFAULT_ANGULAR_CLI_VERSION` matches the root `package.json` pin exactly (asserted by a unit test that imports both)
- [ ] `scaffold-workspace.ts` — AC: unit test with `vi.mock('node:child_process')` asserts the exact `npx ng new` argv for given options, and that a non-empty `outputDir` short-circuits with a failure result *without* calling `spawn` at all
- [ ] `verify-workspace-build.ts` — AC: unit test with the same mock asserts `npx ng build` is invoked with `cwd` set to the given workspace directory
- [ ] `index.ts` barrel + `src/index.ts` re-export — AC: `import { scaffoldTargetWorkspace } from 'migration-core'` resolves from a test file outside `scaffold/`

### Phase 2: Wiring + real verification (~0.5d)
- [ ] Add `"@angular/cli": "22.1.8"` to root `package.json` devDependencies, run `npm install` — AC: `node_modules/.bin/ng --version` reports `22.1.8`
- [ ] `cli.ts`: add `scaffold <outputDir>` command — AC: `node dist/cli.js scaffold --help` prints the command with its options
- [ ] Real manual run: `scaffoldTargetWorkspace` against a scratch directory (session scratchpad, not committed), then `verifyWorkspaceBuilds` against it — AC: process exit code 0 for both steps, `angular.json` and a real `@angular/core` entry in the generated `package.json` exist on disk, confirmed by actually reading them, not by trusting the reported exit code alone
- [ ] Adjust `ng new` flags based on whatever the real run reveals about interactive prompts (Angular 22's generator may ask about AI-tooling integration, SSR, zoneless change detection) — AC: the real run above completes non-interactively with no hang, on the first attempt after flags are finalized

### Phase 3: Docs + PR (~0.5d)
- [ ] `docs/decisions.md`: add an ADR for the final `ng new`/`ng build` flag set landed on in Phase 2, if it differs from what's guessed in Phase 1 — AC: entry exists, dated, with rationale
- [ ] `docs/PROGRESS.md`: flip M0.5 to done in the status table, rewrite "Where things stand" and "What's next", append one session-log line — AC: diff reviewed, no stale M0.5-as-"not started" text remains
- [ ] Open a PR (never a direct commit to `main`, per `CLAUDE.md` Workflow) — AC: PR exists, CI's `secrets-scan` passes on it

## Testing Strategy

- **Unit tests**: `run-command.ts` (real trivial subprocess, both exit codes),
  `scaffold-workspace.ts` and `verify-workspace-build.ts` (mocked
  `node:child_process.spawn`, asserting argv/cwd construction and
  success/failure mapping), the empty-output-dir pre-flight guard
  (asserted with *no* mock needed to prove `spawn` was never called).
- **Integration / manual verification**: one real, unmocked run of both
  functions against a scratch directory in this session, per Phase 2 —
  this is the milestone's actual definition of done and is not satisfied
  by the mocked unit tests alone.
- **Regression check**: `nx run-many -t test` — all 84 existing M0 tests
  plus the new scaffold tests must pass; `nx run-many -t typecheck` and
  `nx run-many -t lint` clean.

## Risks & Mitigations

| Risk | Likelihood | Impact | Score | Mitigation |
|------|------------|--------|-------|------------|
| `ng new`'s interactive prompts (Angular 22 adds prompts beyond older versions — AI-tooling integration, SSR, zoneless) aren't all suppressed by the flags guessed in Phase 1, causing a hang in a non-interactive shell | Medium | High (silently blocks the whole scaffold step, looks like a hang not a failure) | 6 | Phase 2's real run is scoped specifically to surface this; spawn wrapper enforces a hard timeout that fails loudly instead of hanging forever, regardless |
| Generated workspace's own `npm install` (triggered inside `ng new`) needs registry network access, which can flake or be blocked in a constrained CI runner later | Medium | Medium (Phase 2 verification fails, but visibly — not silent) | 4 | Capture and surface full `stdout`/`stderr` on failure rather than swallowing; this is a one-time manual verification in this milestone, not yet a per-commit CI job (see Non-Goals) |
| Angular CLI's actual latest version moves again between this plan and execution (already happened once today — this session initially assumed 21.x from cached docs) | Low | Low | 2 | Version lives in one exported constant plus one `package.json` line; re-check `npm view @angular/cli version` immediately before Phase 2, not from this plan's text |

## Dependencies

- **Internal**: follows file/style conventions already established in
  `libs/migration-core/src/ingest/` (readonly types, async functions
  returning structured results rather than throwing, doc comments stating
  what is/isn't proven).
- **External**: `@angular/cli@22.1.8` (new root devDependency), Node ≥24.15.0
  (already satisfied, `.nvmrc` pins `24`), npm registry network access at
  scaffold-run time for the *generated* workspace's own install (not for
  this repo's own install).
- **Blocked by**: none. M0 is merged (PR #1); this has no dependency on M1–M5.

## Open Questions

- [ ] Exact `ng new` flag set needed to fully suppress every Angular 22
  interactive prompt non-interactively — owner: this session, resolved
  empirically in Phase 2, not guessable from docs alone with full
  confidence.
- [ ] Should `scaffoldTargetWorkspace`'s `appName` ever be auto-derived from
  the source repo's `package.json` `name` field, instead of always being a
  required caller-supplied argument? Assumption for this plan: always
  caller-supplied — keeps the module's contract minimal; a future pipeline
  orchestrator (M1+) can derive it. Revisit only if that turns out awkward.

## Follow-up Work (Out of Scope)

- Adding a `dependency-boundary-check` CI job (per `docs/architecture.md §5`
  / ADR-009) is arguably timelier now that `migration-core` has its first
  real temptation to import an `@angular/*` package — flagged here as a
  candidate for a future session's call, not decided or built in this plan.
- Wiring `scaffoldTargetWorkspace` into an actual pipeline orchestrator that
  chains Stage 0 → 1 → 1.5 → 2 is M1+ work once codemods exist to consume
  the scaffolded workspace.
