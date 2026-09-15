# AngularJS → Angular Migration Copilot
### Product & Technical Specification

This spec went through a structured adversarial review before any code was written — technical correctness, privacy/security/legal, and a final consistency pass — plus a further round verifying every external claim (fixture licenses, framework defaults, provider rate limits) against current sources rather than assumption. The decisions that came out of both rounds are logged in [docs/decisions.md](decisions.md); this document states where the project landed, not the back-and-forth that got it there.

---

## 1. Summary

A CLI-first tool that migrates AngularJS 1.x codebases to modern Angular by combining deterministic AST codemods, for the transforms that are mechanically safe, with LLM assistance for the rest. Every AI-touched change is only accepted after it clears a real compile-and-test verification gate. A thin NestJS/Angular/Mongo layer wraps the CLI core to provide a hosted, browsable demo against a small set of pre-vetted fixture repos.

The product is the pipeline. The portfolio artifact is the report it produces: precise, honestly-reported numbers on what fraction of a real migration was mechanical, AI-assisted-and-verified, or flagged for manual review. Not a claim that AI migrates your app.

## 2. Goals / Non-Goals

**Goals**
- Migrate a defined, documented set of AngularJS patterns to Angular automatically and safely.
- Never accept an AI-generated change without independent verification — compile, existing tests, or a generated characterization test.
- Produce an honest, per-file confidence-tiered report, including the mechanical-only failure cases.
- Run at $0 ongoing cost regardless of public demo traffic.

**Non-goals (v1)**
- Not a hybrid-vs-full-rewrite strategy advisor. Assumes full rewrite is already the chosen path.
- Not attempting full-coverage migration. Scope is the fixed pattern list in §6.3; everything else is flagged, not force-fitted.
- Not supporting jQuery-heavy DOM manipulation inside controllers as a first-class case. Documented as out of scope.
- Not an auto-merge tool. Output is always a branch, a PR, and a report.
- Not a hosted service that executes arbitrary user-supplied repositories. See §11.

## 3. Prior Art & Positioning

| Existing tool | What it does | Gap this project fills |
|---|---|---|
| ngMigration Assistant | Heuristic analysis recommending hybrid-upgrade vs. rewrite | Doesn't perform transforms; this starts where it stops |
| ng-morph (Taiga UI) | Angular-aware AST manipulation on ts-morph, virtual-tree testing | Used as the AST engine here, not reinvented |
| jscodeshift + scattered single-purpose codemods | One-off transforms (e.g. wrap controller logic in `$onInit`) | No chaining into a full pipeline with a verification gate |
| Kendo UI Upgrade Assistant | AI-assisted migration, scoped to Kendo's own component library | Not a general-purpose app migration tool |

No consolidated open-source tool chains mechanical codemods → LLM fallback → compile/test verification → confidence-tiered report. That chain is the thesis of this project; the AST/codemod primitives are assembled from existing libraries, not reinvented.

## 4. Personas & Use Cases

- **Portfolio reviewer / interviewer** — lands on the hosted demo, sees a real migrated repo with a transparent, tiered report. This is the primary audience for v1.
- **A developer with a legacy AngularJS app** — runs the CLI locally against their own repo with their own free-tier API key, gets a branch and a PR to review.
- **Future, not v1** — a team wanting a hosted "point at my private repo" service. Explicitly deferred; see §11 for why.

## 5. System Architecture

```
                        ┌─────────────────────────┐
                        │   Angular Frontend       │
                        │ (Cloudflare Pages, free) │
                        │  - job progress view     │
                        │  - diff viewer           │
                        │  - confidence-tier filter│
                        └───────────┬─────────────┘
                                    │ REST + SSE
                        ┌───────────▼─────────────┐
                        │      NestJS API          │
                        │ (Render/Fly free tier)   │
                        │  - job orchestration     │
                        │  - provider scheduler    │
                        └───┬───────────────────┬─┘
                            │                   │
                 ┌──────────▼─────────┐   ┌────▼─────────────┐
                 │  Migration Core     │   │   MongoDB Atlas   │
                 │  (CLI, invoked as   │   │   (M0 free tier)  │
                 │   a sandboxed job)  │   │  jobs / files /   │
                 │  Stages 0–5, §6     │   │  providerUsage    │
                 └──────────┬─────────┘   └───────────────────┘
                            │
              ┌─────────────┼──────────────┐
              │             │              │
        ┌─────▼────┐  ┌─────▼─────┐  ┌─────▼─────┐
        │  Groq     │  │  Gemini   │  │ OpenRouter │
        │ (primary) │  │ (fallback)│  │ (tertiary) │
        │ free tier │  │ free tier │  │ free models│
        └───────────┘  └───────────┘  └───────────┘
```

Migration Core is a standalone CLI/library with no dependency on NestJS, Angular, or Mongo — it runs entirely offline against a local repo. The web layer is a thin orchestration and presentation shell around it.

## 6. Pipeline Detail

### 6.1 Stage 0 — Ingest

- Clone the target repo — a local path for CLI use, a fixed fixture list only for the hosted demo (§11).
- Detect AngularJS version, build tooling (Gulp, Grunt, Webpack, or none), and test runner.
- A test runner that's detected but non-functional in the current environment is the expected default for legacy AngularJS code, not an edge case. Attempt one automated remediation — swap a dead PhantomJS launcher for headless Chrome in the existing Karma config — and if that fails, mark the module untested and route it to characterization testing in Stage 4. "Tests pass" only means something for a suite that can actually run.
- Secrets scan, always, regardless of mode. Before any file content reaches an LLM provider, a redaction pass runs for common credential patterns — API keys, `.env` contents, connection strings. This applies to local CLI use with the user's own key too. The point isn't who's paying for the call; it's not sending secrets to a third-party API by accident.

### 6.2 Stage 1 — Inventory

- Full AST scan (ts-morph, ng-morph) producing a dependency graph: controllers, directives, services and factories, filters, route definitions, `$scope.$watch` usage.
- Shippable as a standalone milestone (M0): report-only, no transforms.

### 6.2a Stage 1.5 — Target workspace scaffold

- Scaffold a real Angular workspace, via the Angular CLI, into a separate output directory — never in-place over the source repo. This is what makes Stage 4's `tsc --noEmit` mean anything: compiling a single migrated file in isolation, with no real `angular.json`, module graph, or decorator context around it, doesn't actually verify anything. It also means a failed or partial run never leaves the original source repo in a broken state — the source tree is read-only for the entire pipeline.
- This step completes before any Stage 2 file-level transform begins.

### 6.3 Stage 2 — Deterministic codemods (fixed v1 scope)

| # | Pattern | Target |
|---|---|---|
| 1 | `$scope.x = y` | class property assignment |
| 2 | `controllerAs` syntax | normalized to component class |
| 3 | Array-style DI (`['$http', fn]`) | constructor injection |
| 4 | Simple directive (no `transclude`/`compile`) | `@Component`/`@Directive` |
| 5 | Pure filters (no external state) | Angular pipes |
| 6 | `$http` + `.then()` chains, depth ≤ 2 | `HttpClient` + RxJS |
| 7 | `ng-repeat`/`ng-if`/`ng-show` | `@for`/`@if` control flow |
| 8 | Flat `$routeProvider`/`ui-router` states | Angular Router config |
| 9 | One-way `bindings: { x: '<' }` | `@Input()` |
| 10 | `$emit`/`$broadcast`/`$on` within one module | typed RxJS `Subject` service |

Explicitly out of scope for mechanical transform, always flagged to Stage 3 or manual review: nested abstract router states, `transclude`, custom `compile` functions, `$watch` with a deep-equality comparator, cross-module event buses, jQuery-in-controller DOM manipulation.

Mechanical hit-rate is expected to vary widely, roughly 15%–60%, depending on codebase cleanliness. This gets reported per-repo, never smoothed by demoing only the cleanest fixture.

### 6.4 Stage 3 — LLM-assisted fallback

- Flagged files go to the model with: original source, already-migrated sibling files in the same module (for idiom consistency), and a schema-constrained output contract — a structured patch of file path plus full content, never freeform prose.
- Invalid-schema output gets one retry, then a hard fail to manual review.
- Per-file token cap; files exceeding it are split by function or class, never silently truncated.
- A job-level provider scheduler (§7) governs call pacing across the whole job, not just per-file limits.
- Provider and model choice within Groq's free tier is decided at M3 build time against whatever Groq currently publishes at `console.groq.com/docs/rate-limits` — the specific model families on that free tier (and their limits) change often enough that naming one here would likely be stale before M3 starts. See §7 and [docs/decisions.md ADR-008](decisions.md).

### 6.5 Stage 4 — Verification gate

Every Stage-3 patch, applied on a scratch branch, must clear in order:

1. `tsc --noEmit` — a hard fail is a reject.
2. The existing, functioning test suite for that module — a hard fail is a reject.
3. If no functioning coverage exists — the expected default for legacy AngularJS, not an edge case — generate a characterization test: run the original function against representative inputs, record outputs as a golden master (Feathers' characterization-testing technique), replay post-migration, diff against the golden master.

**Eligibility for characterization testing**, precisely defined: a function qualifies only if static analysis confirms it (a) doesn't reference `$scope`, `$rootScope`, or DOM globals beyond its own parameters, (b) doesn't call `$http`, `$q`, `$timeout`, or other async/side-effecting services directly without a mockable fixture, (c) returns a value derived only from its inputs.

This covers services and pure filters well. It covers controller logic — the majority of typical AngularJS code — only partially, because `$scope` coupling is the idiom there, not an exception. This ratio gets reported broken down by artifact type (controller, service, filter, directive), never as a single aggregate figure — an aggregate can hide exactly the imbalance this section describes. A 40% blended rate could mean 5% for controllers and 90% for services, which is a materially different and more honest picture than "40%."

**Input generation for golden masters:** seed inputs are drawn from two sources — literal argument values found at every existing call-site of the function across the codebase (the app's own usage is the best available signal of realistic inputs), unioned with type-based boundary values for each parameter (empty string, zero, null, empty array or object, one populated example). A function with fewer than two distinct call-site examples and no inferable parameter types is marked **ineligible** rather than tested against a single degenerate input that would produce false confidence.

**Diffing tolerance:** golden-master comparison uses structural deep-equality with explicit tolerance for non-deterministic object-key ordering and Date serialization differences. Migrating away from AngularJS's own `angular.copy`/`toJson` semantics to native JS must not itself register as a behavioral regression. A genuine logic change and a serialization-format change are different failure classes, labeled differently in the output, not collapsed into one REJECTED tag.

A golden master captures the AngularJS code's *existing* behavior, bugs included, by design. The goal of this gate is behavioral equivalence between old and new, not correctness of the old implementation. A pre-existing bug that survives migration unchanged is, by this gate's definition, a pass — and the generated report says so explicitly, rather than leaving it implicit.

Every file exits tagged **HIGH** (real tests passed), **MEDIUM** (compiled clean plus a passing characterization diff, no prior coverage), or **REJECTED** (failed compile or characterization diff). Never a bare pass or fail.

### 6.6 Stage 5 — Report + PR

Per-file side-by-side rendering — old AngularJS content next to new Angular content, not a line-diff. The two are structurally different enough that a unified diff is close to unreadable. Each entry carries transform type, confidence tier, compile/test logs, and the run-wide mechanical-hit-rate and characterization-eligibility-rate (broken down by artifact type per §6.5), reported honestly.

**Git and auth model:** by default, output is a local branch only — no network operation, no credentials required. Pushing to a remote and opening a PR is opt-in and requires an explicitly-scoped token (contents and pull-requests only, never a broad personal-access token). Separate from, and not dependent on, any LLM provider key.

**Trust boundary:** the CLI executes the target repo's own build and test scripts locally, the same as running `npm install` on it would. Only run this against code you already trust — true of any migration or build tool, stated here because this tool specifically invites pointing it at "some legacy app," not necessarily one's own.

## 7. Provider Scheduling

A single job-level scheduler, not just a per-file cap:

- Token-bucket tracking per provider, persisted in `providerUsage` (Mongo), reset on each provider's actual reset window — daily for RPD, rolling for RPM.
- Priority order: Groq first (fastest free tier), Gemini Flash-Lite second, Gemini Flash third, OpenRouter's free model pool last — treated as lowest-reliability, used only when everything above is exhausted.
- On a 429 from the active provider: immediate fallback to the next in priority order, not a retry-with-backoff against the same exhausted provider.
- If all providers are exhausted for a real, non-demo job: the job pauses and resumes automatically at the next window reset. It doesn't fail. Progress and partial results are preserved.
- Demo jobs never hit this path live. Every fixture-repo demo run is pre-computed once, offline, and served as cached, static results afterward — public traffic never triggers a live LLM call, which is what keeps the hosted demo's cost fixed regardless of visitor count. The "provider usage meter" shown in the demo UI (§10) is a replay of the recorded usage data from that offline run, not a live measurement, and it's labeled as such — nobody should mistake it for their own click triggering inference.
- **Exact RPM/RPD figures are deliberately not stated here.** They were checked directly against Groq's and Google's own rate-limit docs while writing this spec, and even in that single pass, third-party trackers were already citing numbers the providers' own pages didn't confirm. Free-tier terms are each provider's unilateral policy, not a guarantee — hardcoding today's numbers into a spec that outlives them just builds in a future correction. The scheduler reads live limits from configuration, checked against `console.groq.com/docs/rate-limits` and `ai.google.dev/gemini-api/docs/rate-limits` at M3 build time, not from a number frozen here.
- If both primary providers' terms change materially, the CLI's local mode can fall back further to a small quantized open-weight model run entirely on the user's own machine (llama.cpp or Ollama), keeping true $0 operation independent of any provider's future decisions. Not built in v1, but the scheduler's provider-abstraction interface is designed to accept it without a redesign.

## 8. Data Model (MongoDB)

CLI-mode runs write results to a local file — SQLite or JSON — by default, never to the hosted Mongo instance. A private repo's diffs, compile logs, and code content have no business leaving the user's machine unless they explicitly opt into pointing the CLI at their own self-hosted NestJS+Mongo instance. The hosted Mongo below exists solely to serve the project-owned, pre-vetted fixture-repo demo data (§11) — it never receives user data by default, which is a simpler privacy story than "we anonymize what we collect."

```
migrationJobs {
  _id, mode: "cli" | "hosted-demo",
  repoRef, status: "queued"|"running"|"complete"|"paused-rate-limit"|"failed",
  createdAt, completedAt,
  summary: {
    totalFiles, mechanical, llmAssisted, rejected, manualReview,
    mechanicalHitRate,
    characterizationEligibleRate: { overall, byControllers, byServices, byFilters, byDirectives },
    testRunnerStatus: "functioning"|"repaired"|"absent"|"broken"
  }
}

fileResults {
  jobId, filePath, artifactType: "controller"|"service"|"filter"|"directive"|"route",
  transformType: "mechanical"|"llm-assisted"|"skipped",
  patternMatched,          // one of the 10, or null
  confidenceTier: "HIGH"|"MEDIUM"|"LOW"|"REJECTED",
  providerUsed,            // "groq"|"gemini"|"openrouter"|null
  originalContent, migratedContent,   // side-by-side render, not a diff algorithm (§6.6)
  compileLog, testLog, characterizationDiff
}

providerUsage {
  jobId, provider, callsUsed, tokensIn, tokensOut,
  windowStart, windowType: "RPM"|"RPD"
}
```

A 150-file repo with roughly 10KB of diff/log content per file record is about 1.5MB per job. Even 20 pre-computed demo jobs — far more than the 3–4 fixture repos actually needed — comes to about 30MB, a small fraction of Atlas's 512MB free-tier cap. The "$0 forever" claim in §2 is backed by this arithmetic, not faith.

## 9. API Surface (NestJS)

- `POST /jobs` — create a job. Hosted mode: fixture repo only, validated against an allowlist. CLI mode: arbitrary local path, not exposed over HTTP.
- `GET /jobs/:id` — status and summary.
- `GET /jobs/:id/files?tier=HIGH|MEDIUM|LOW|REJECTED` — filtered file list.
- `GET /jobs/:id/files/:fileId` — full diff and logs for one file.
- `GET /jobs/:id/report` — downloadable aggregate report.
- `GET /jobs/:id/stream` — SSE stream of live progress.

## 10. Frontend UX (Angular)

- **Job progress view** — live per-stage status. For real (CLI-initiated hosted) jobs, a provider usage meter shows live scheduler activity per §7. For demo jobs specifically, the same meter is labeled as a replay of recorded usage from the original offline pre-compute run — a visibly distinct state, not the same component reused silently, so a visitor can't mistake it for their own click triggering inference.
- **Diff viewer** — side-by-side AngularJS → Angular per file.
- **Confidence-tier filter** — the single most important UX element. It's what turns "an AI migrated my code" into the honest, defensible "here's exactly what's verified and what isn't."

## 11. Security Model

- **v1 hard constraint: no hosted execution of arbitrary user-supplied repositories.** The hosted demo only ever runs against a small, fixed, pre-vetted allowlist, pre-computed offline and served as cached results. This is a deliberate scope boundary: letting the public internet trigger sandboxed builds of arbitrary cloned repositories on your infrastructure is a real remote-code-execution surface that a plain Docker container doesn't adequately close.
- **CLI/local use** — the trust boundary is the user's own machine or CI, no different from running `npm install` on your own code.
- **A future "bring your own private repo" hosted feature, explicitly out of scope for v1**, would need gVisor- or Firecracker-level isolation, locked-down network egress during execution, and the same secrets-redaction pass from Stage 0 applied before any external LLM call. Named here so it doesn't get quietly built later without the isolation bar it needs.

**Fixture repo licensing — checked directly, not assumed:**

| Repo | License | Note |
|---|---|---|
| `angular/angular-phonecat` | MIT, confirmed via GitHub's SPDX detection | Public and readable, though the repo is archived — no further upstream changes, which is fine since it's vendored at a pinned commit anyway |
| `mrholek/CoreUI-AngularJS` | MIT, confirmed via GitHub's SPDX detection | The README separately states the branded template can't be redistributed "as stock" or modified-and-redistributed as CoreUI itself — a restriction that lives in prose, not in the LICENSE file, and is in some tension with the MIT grant it sits next to. This project sidesteps the ambiguity by construction: the output is a migrated, structurally transformed derivative, not a redistribution of the template as stock, so the clause doesn't apply regardless of which text governs |
| `akveo/blur-admin` | MIT text, present and unambiguous in `LICENSE.txt` | GitHub's automated license detector flags this repo as `Other`/`NOASSERTION` rather than MIT, because the LICENSE file appears to be a raw copy-paste of a GitHub license page that includes leftover page furniture ("Status API Training Shop Blog... © 2016 GitHub, Inc.") after the actual license text. That's a parser artifact, not a real ambiguity in the grant — the MIT text itself is intact and unqualified. Flagged here so nobody mistakes GitHub's badge for the actual finding |

Apache-2.0-licensed dependencies (`ng-morph`, from Taiga UI) are consumed as-is, not relicensed — Apache-2.0 is permissive and compatible as a dependency of an MIT project, but it isn't MIT, and its NOTICE requirements apply if any of its source is ever vendored or modified rather than consumed as a package.

Before any fixture repo's migrated output is published on the hosted demo, its LICENSE/NOTICE is verified and carried forward unmodified into the migrated output tree, with clear attribution to the source project on the demo page itself — Apache-2.0 requires preserving a NOTICE file in derivative works, MIT requires retaining the copyright and license text, and neither is satisfied by "we checked the license was permissive" alone.

## 12. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mechanical hit-rate is low on messy real code | High | Medium | Report the rate honestly per repo; don't cherry-pick fixtures to hide it |
| Legacy test runner present but non-functional | High | Medium | Explicit detection, one remediation attempt, documented fallback |
| Characterization-test eligibility low for controllers | High | Medium | Precise eligibility definition, reported ratio, no implied broad coverage |
| LLM rate-limit exhaustion mid-job | Medium | Medium | Job-level scheduler with pause/resume, §7 |
| AST tooling brittle on non-canonical code | Medium | Medium | Fixed 10-pattern scope; anything outside it flags rather than guesses |
| Secrets leaked into an LLM prompt | Low | High | Mandatory redaction pass before any external call, §6.1 |
| Timeline underestimated | High | Low, time only | Recalibrated in §13, flagged directly rather than hidden in a padded estimate |
| Demo fixture repo licensing | Low | Medium | Directly verified per repo, §11, including the two with real caveats |
| Golden-master false positives (serialization vs. logic changes) | Medium | Medium | Structural deep-equality with explicit ordering/Date tolerance, §6.5 |
| Free-tier terms change or are revoked | Low | Medium | OpenRouter already third in the priority chain; local-model fallback designed for, not yet built, §7 |
| Legacy fixture repos fail `npm install` on any current Node version | High | Low, time only | Per-fixture pinned Node version via `.nvmrc`, budgeted time in M0 to patch or vendor anything that still won't install |
| M3 depends on Mongo state before M4 builds the Mongo layer | Medium | Low | M3 ships with a minimal file-backed scheduler, promoted to Mongo-backed in M4, §13 |

## 13. Milestones & Timeline

| Milestone | Scope | Estimate |
|---|---|---|
| M0 | Inventory scanner, report-only | 1–2 weeks |
| M0.5 | Target workspace scaffolding (§6.2a) | 2–3 days |
| M1 | Deterministic codemod library (10 patterns) against 2–3 real repos | 2–3 weeks |
| M2 | Verification harness: sandboxed compile/test, characterization-test generator, input-generation and diff-tolerance logic (§6.5) | 1.5–2.5 weeks |
| M3 | LLM fallback plus file-backed job-level scheduler (Mongo-backed version deferred to M4) | 1–2 weeks |
| M4 | NestJS + Angular + Mongo web layer, scheduler promoted to Mongo-backed | 1–1.5 weeks |
| M5 | Fixture-repo demo runs, license/NOTICE verification, real numbers published | 1 week |

**Total: roughly 9–12.5 weeks for a solid v1.** Treat this as a range with built-in slack, not a committed point estimate — legacy-code edge cases discovered during M1 are the most likely source of overrun, and are allowed to push the estimate rather than something to route around by cutting the verification gate.

**Definition of done for v1:** the full pipeline (§6) has run end-to-end against at least 2 real, previously-unseen AngularJS repositories — not the curated demo fixtures — producing a report with the artifact-type-broken-down confidence tiers from §6.5/§8, with zero manual intervention required to reach that report. Manual review flags in the output are expected and fine. Manual intervention to produce the report itself is not.

## 14. Success Metric

Not the tool itself — the numbers it produces, run against real repos:

> "Migrated a real AngularJS application to Angular: X% of files transformed mechanically with zero AI involvement, Y% AI-assisted and verified by compile and test, Z% flagged for manual review with a stated reason, and W% of previously-untested code got auto-generated characterization tests before migration — with the test-runner-repair and rate-limit-scheduling steps documented as first-class engineering decisions, not afterthoughts."

A low mechanical-hit-rate or a low characterization-eligibility-rate, honestly reported and clearly explained, is a legitimate and defensible outcome, not a failure to fix by re-running against a cleaner repo until the numbers improve. This project's entire positioning is precision and honesty over an impressive-sounding aggregate. Quietly curating for flattering numbers would undercut the one thing that separates it from every "AI migrates your app" claim it's deliberately not making.

## 15. Decisions Made

- **License:** MIT, public repo — standard for a portfolio-facing dev tool.
- **Fully public from day one**, including the hosted demo's migration reports. The honest-numbers positioning in §14 only works if the numbers are actually visible.
- **No hosted arbitrary-repo execution in v1** — see §11. A security-driven scope decision, not a resource one.
- **Provider order:** Groq primary, Gemini fallback, OpenRouter tertiary, based on free-tier reliability and speed at the time of writing — see §7 for why the exact limits aren't pinned here.
- **No Redis or BullMQ for v1.** A file-backed queue in M3, promoted to Mongo-backed once M4 builds that layer (§12), is sufficient at the traffic level a portfolio demo actually sees.

Full rationale for these and every other structural call — package manager, test runner, Node version, fixture selection — is in [docs/decisions.md](decisions.md), kept current as the build progresses rather than frozen at spec-writing time.
