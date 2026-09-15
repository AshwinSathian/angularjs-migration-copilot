# AngularJS → Angular Migration Copilot
### Architecture & Build-Execution Document

This is the how, complementing [docs/product-spec.md](product-spec.md), which is the what. It covers system architecture, module boundaries, and how the build itself gets executed with Claude Code doing the implementation work — including how the same "never trust AI output without verification" principle that governs the *product* also governs *building* the product.

---

## 1. Repository & Workspace Structure

A standalone Nx workspace in its own public GitHub repo, not folded into an existing monorepo. This is an OSS portfolio artifact — independent discoverability (its own README, its own stars and forks, its own issue tracker) matters more here than monorepo convenience. See [docs/decisions.md ADR-001](decisions.md).

```
angularjs-migration-copilot/
├── apps/
│   ├── api/                 # NestJS orchestration API
│   └── web/                 # Angular frontend
├── libs/
│   ├── migration-core/      # Stages 0–5 pipeline, zero framework deps
│   │   ├── ingest/
│   │   ├── inventory/
│   │   ├── scaffold/        # Stage 1.5
│   │   ├── codemods/        # the 10 fixed patterns
│   │   ├── llm-fallback/
│   │   ├── verification/    # compile + test + characterization gate
│   │   └── report/
│   ├── provider-scheduler/  # product spec §7 — standalone lib, no Mongo dep at this layer
│   ├── shared-types/        # DTOs shared between api/web/migration-core
│   └── secrets-scan/        # Stage 0's redaction pass — standalone, unit-testable in isolation
├── fixtures/                # the 3 vetted demo repos, vendored as git submodules with pinned commits
├── docs/
│   ├── product-spec.md
│   ├── architecture.md              # this document
│   ├── decisions.md                 # ADR log
│   └── milestones/
│       ├── m0-inventory.md
│       ├── m0.5-scaffold.md
│       ├── m1-codemods.md
│       ├── m2-verification.md
│       ├── m3-llm-fallback.md
│       ├── m4-web-layer.md
│       └── m5-fixtures-and-report.md
├── CLAUDE.md
└── .github/workflows/       # see §5
```

**Why `migration-core` has zero framework dependencies:** it has to be usable as a pure CLI with no NestJS, Angular, or Mongo in the loop at all, per the product spec's standalone-core architecture note. Keeping the Nx dependency graph enforced — `nx graph`, plus lint rules against illegal imports — means `apps/api` can depend on `libs/migration-core`, never the reverse, and that's checked in CI, not just asserted in a README.

The boundary is declared at the import level, but it's also verified at the build-artifact level, because the two catch different failures. A lint rule catches a stray `import` statement. It doesn't catch an Nx executor transitively bundling a framework dependency into the built output. CI includes a step that builds `migration-core` standalone and diffs its resulting dependency tree against an explicit allowlist, failing the build if anything framework-shaped sneaks in, regardless of how it got there.

## 2. Technology Choices & Versions

| Layer | Choice | Note |
|---|---|---|
| Monorepo tool | Nx, latest stable at scaffold time | Verify Angular-version compatibility before scaffolding — Nx's Angular support sometimes trails the newest Angular release by a point version. Check `nx.dev`'s compatibility notes at build time rather than assuming latest-latest works together. |
| Package manager | npm | No extra tooling required on a contributor's machine; this workspace doesn't operate at a scale where pnpm's linking performance matters. See [ADR-002](decisions.md). |
| Node version | 24 (Active LTS), pinned via `.nvmrc` | Will move to 26 once that becomes Active LTS, roughly October 2026. See [ADR-004](decisions.md). |
| Frontend | Angular, latest stable | Standalone components, signals-based state where it fits |
| Test runner | Vitest, across the whole workspace including `apps/web` | Angular CLI's own default for new workspaces as of Angular 21 — not a project-specific choice to revisit later. See [ADR-003](decisions.md). |
| Backend | NestJS, latest stable | |
| Database | MongoDB Atlas, M0 free tier | Per product spec §8 |
| AST engine | ts-morph + ng-morph | Per product spec §3 — reused, not reinvented. `ng-morph` is Apache-2.0, not MIT; permissive and fine as a dependency, just labeled correctly |
| Sandbox execution | Docker, per-job ephemeral container, resource-capped | Sufficient for the local-CLI and pre-vetted-fixture-only hosted model in product spec §11. Explicitly not sufficient if the future arbitrary-private-repo hosted feature is ever built — that needs gVisor/Firecracker, already flagged there |
| CI | GitHub Actions | Free and unlimited minutes on public repos, which matters since M1–M2's fixture-repo integration tests run repeatedly in CI |
| Secrets scanning | gitleaks | Named specifically, not "gitleaks or equivalent" — a coding agent implementing this needs one concrete tool. Pre-commit hook and CI gate. See [ADR-007](decisions.md) |

## 3. Module Boundaries & Data Flow

```
CLI entrypoint ──▶ migration-core (Stages 0–5) ──▶ local report (SQLite/JSON, CLI mode)
                         │
                         ▼ (hosted mode only)
                  NestJS API ──▶ provider-scheduler ──▶ [Groq | Gemini | OpenRouter]
                         │
                         ▼
                     MongoDB (fixture-demo data only, per product spec §8 storage boundary)
                         │
                         ▼
                  Angular frontend (job progress, diff viewer, confidence-tier filter)
```

`migration-core` never imports anything from `apps/api`. The NestJS layer is a thin orchestrator: it invokes migration-core as a library call, or spawns it as a sandboxed subprocess for hosted-demo jobs, persists the results migration-core returns, and exposes them over HTTP/SSE. This is what keeps the CLI genuinely standalone rather than standalone in theory and secretly coupled in practice.

## 4. Fixture Repositories

| Repo | License | Role |
|---|---|---|
| `angular/angular-phonecat` | MIT, confirmed | Clean baseline — expect a high mechanical-hit-rate, mostly HIGH tier |
| `mrholek/CoreUI-AngularJS` | MIT, confirmed, with a README caveat | Real-world scale, heavy `ui-router`. See product spec §11 for the caveat and why it doesn't apply to a transformed derivative |
| `akveo/blur-admin` | MIT, confirmed | The messiest fixture — expected to surface out-of-scope patterns (custom directives, `transclude`) and produce the lowest mechanical-hit-rate of the three, which is a valuable, honest data point in itself. See product spec §11 for a note on why GitHub's own license badge disagrees with the actual license text |

All three are vendored as git submodules pinned to a specific commit SHA, not tracking `main`, so a demo run stays reproducible indefinitely even if the upstream repo changes or disappears.

**Bit-rot risk:** these are 2013–2016-era codebases. Their original lockfiles, where they have one at all, will very likely fail `npm install` or `bower install` outright on any current Node version — deprecated registry entries, native `node-gyp` modules that no longer compile, removed transitive packages. Mitigation: the sandboxed container that runs each fixture's own build/test tooling pins an older Node version via a per-fixture `.nvmrc`, documented per-fixture rather than assumed uniform, and M0's due-diligence pass budgets explicit time to patch or vendor any dependency that still won't install even on a period-appropriate Node version. This is expected work, not a surprise if it happens — the same "expected default, not edge case" framing the product spec applies to broken legacy test runners applies here too, one layer up.

## 5. CI/CD Pipeline (GitHub Actions)

```
on: push, pull_request
jobs:
  secrets-scan         # gitleaks, blocking — active from commit 1, see below
  lint-and-typecheck   # nx affected:lint, affected:build — added once M0.5 scaffolds the workspace
  unit-tests           # nx affected:test — migration-core, provider-scheduler, secrets-scan in isolation
  verification-negative-controls  # runs the 3 planted-failure fixtures, every push, once M2 lands
  dependency-boundary-check       # builds migration-core standalone, diffs deps against allowlist
  fixture-integration  # full Stages 0–5 against the 3 pinned fixture repos, path-filtered
```

**Only `secrets-scan` is active from the first commit.** The rest of this pipeline gets added incrementally as each milestone lands the tooling it depends on — there's no point running `nx affected:lint` in CI before M0.5 has generated a workspace for it to lint. A red CI badge before there's anything to build is worse for a public repo than a small one that grows honestly. See [ADR-009](decisions.md).

**`fixture-integration` triggering strategy, once it exists:** running Docker-sandboxed builds of three legacy repos, each with its own old-tooling `npm install`, on every single push is slow and burns free-tier Actions compute fast. This job is path-filtered to trigger only on changes under `libs/migration-core/**`, plus a manual `workflow_dispatch` trigger for on-demand runs. It always runs in full, unfiltered, as a required check before the M5 publish step — a milestone that's specifically about the fixture-repo numbers being real can't ship on a possibly-stale integration result.

**Security note specific to a public repo with API keys:** the `fixture-integration` job needs Groq/Gemini keys as repository secrets to actually exercise Stage 3. GitHub doesn't expose repo secrets to workflows triggered from a fork's pull request by default, and that default stays in place. This project does not use `pull_request_target` to "fix" that for external contributors — that trigger runs with repo-secret access against untrusted code and is a well-known way public OSS repos get their API keys exfiltrated. External contributions to Stage 3 logic get tested manually, with results pasted into the PR, not automatically with secret access.

## 6. Claude-Code-Powered Build Plan

### 6.1 CLAUDE.md

The repo's [CLAUDE.md](../CLAUDE.md) carries the guardrails a coding agent needs that a human contributor mostly wouldn't — module boundary rules, the verification-gate review exception, scope discipline on the 10 patterns, and the instruction to read `docs/decisions.md` before starting any milestone.

### 6.2 Architecture Decision Log

A 9–12.5 week build across many separate Claude Code sessions has no persistent memory between sessions beyond what's in the repo itself. Feeding an entire multi-thousand-word spec into every session both wastes context and risks a session missing something buried in it. The fix is a single running ADR log, append-only, that every session reads first — a handful of short entries, not the whole spec, carrying forward exactly the decisions that would otherwise silently drift. "Stage 3's schema retry count is 1, not configurable" is easy to get subtly wrong if re-derived from memory each session instead of read from a log.

Entry structure is fixed rather than left free-form: `[ID] [date] [one-line decision] — [reason] — [superseded-by: none | ID]`, one line each, so a new session can skim IDs and one-liners rather than reading full prose for every past decision — the same principle as skimming a directory listing before opening a file. Superseded entries stay in the log with a pointer forward, never deleted. The log is a history, not a current-state document.

### 6.3 Milestone-to-Session Mapping

Each milestone in `docs/milestones/` is scoped to be a single Claude Code session's worth of work, roughly matching the estimates in the product spec's §13 table, ending in a PR, never a direct commit to main, regardless of how the session's own tests looked.

| Milestone doc | Session scope | Definition of done |
|---|---|---|
| m0-inventory.md | AST scanner + dependency graph | Produces a correct report against `angular-phonecat`, checked by a human against the repo's actual structure, not just "the JSON output looks reasonable" |
| m0.5-scaffold.md | Angular workspace scaffold generator | A generated workspace actually builds with `ng build`, run and confirmed, not assumed from the generator's own exit code |
| m1-codemods.md | The 10 fixed patterns | Each pattern has its own before/after fixture-file test; mechanical-hit-rate reported on all 3 fixture repos, including the low one — a session that quietly only reports the flattering repo fails this milestone's definition of done |
| m2-verification.md | Compile/test gate + characterization testing | Human-written or human-reviewed line by line, not Claude-Code-authored without heavy scrutiny. This is the "guard the guards" exception below |
| m3-llm-fallback.md | Schema-constrained patch generation + scheduler | Tested primarily against a local mock provider (§6.5), with a real-provider smoke test each week per §6.4a, not deferred entirely to a single end-of-milestone integration pass |
| m4-web-layer.md | NestJS + Angular + Mongo | Standard Nx generator scaffolding, lower-risk, normal Claude Code workflow applies |
| m5-fixtures-and-report.md | Final fixture runs, license verification, published numbers | Human confirms the `blur-admin` and CoreUI license notes from product spec §11 before this milestone is called done, not something delegated to the agent's own judgment |

### 6.4 "Guard the Guards"

The entire product's credibility rests on Stage 4 actually verifying, not just appearing to. Having the same kind of system — an LLM-driven coding agent — write and be the sole judge of whether that gate works correctly is a circularity worth naming rather than glossing over: an agent that makes a subtle mistake in the verification harness (a wrapper that swallows a non-zero exit code and reports success, say) could plausibly also produce tests that don't catch its own mistake, for the same underlying reason.

`libs/migration-core/verification/__fixtures__/negative-controls/` ships three planted, deliberately-broken cases from day one of M2: a file with a genuine `tsc` error, a module whose test is written to fail, and a function whose characterization diff is engineered to mismatch. The verification gate is only considered done when it correctly returns REJECTED on all three. This isn't a one-time human glance — it's a permanent fixture directory that runs in CI on every change to the verification module, turning "guard the guards" into a standing regression contract rather than a review that happens once and is trusted forever after.

### 6.4a Real-Provider Testing Cadence

Deferring all Stage 3 testing to the mock provider (§6.5) until one final integration pass invites discovering a design flaw at the most expensive possible moment. Minimum cadence: one real-provider smoke test run — a handful of actual Groq/Gemini calls against a small fixture, not the full suite — at the end of each week of M3 work, not only at M3's close. This is cheap against the free-tier budget and catches rate-limit-response-shape or scheduler-timing surprises while there's still time in the milestone to redesign around them, rather than after the mock-driven implementation is already considered finished.

### 6.5 Mock LLM Provider for Development

Stage 3 development and testing defaults to a local, deterministic mock provider — canned structured-patch responses, including a deliberately-invalid-schema response to exercise the retry-then-fail path from product spec §6.4 — rather than live Groq/Gemini calls for the bulk of iteration. Two reasons: it keeps development fast, no network latency in the loop across many Claude Code iterations per session, and it keeps free-tier daily quota untouched during development so it's fully available for the fixture-repo integration runs in CI and the final M5 demo runs. Live-provider calls are reserved for M3's final integration pass and the CI `fixture-integration` job.

### 6.6 Secrets Hygiene During the Build Itself

Claude Code sessions have real Groq/Gemini keys available in the local dev environment to run integration tests, so the same gitleaks pre-commit hook and CI gate from §5 apply from the repository's very first commit, not added later once the product's own Stage 0 redaction feature is built. This project's own build process gets the same secrets-handling discipline as its output, from day one.
