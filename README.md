# AngularJS → Angular Migration Copilot

**Status: early build.** Stages 0 and 1 (ingest + inventory, M0) are implemented, tested, and have been run against a real pinned fixture repo. Stages 1.5 through 5 — the workspace scaffold, the codemods, the LLM fallback, and above all the verification gate — don't exist yet. If you're picturing a working migration tool, you're picturing where this is going, not where it is. Progress lives in [docs/milestones](docs/milestones).

## What this is

A CLI that migrates AngularJS 1.x codebases to modern Angular. Most migration tools stop at "here's a heuristic recommendation" or "here's a codemod for one pattern." This one chains three things together: deterministic AST codemods for the patterns that are mechanically safe to transform, an LLM for the patterns that aren't, and a real compile-and-test verification gate that has to pass before any AI-generated change is accepted. Nothing gets applied on the strength of "the diff looks plausible."

The output isn't a claim that AI migrated your app. It's a report: this fraction of the codebase was transformed mechanically with zero AI involvement, this fraction was AI-assisted and independently verified, this fraction got flagged for a human to look at and why. A hosted demo runs the full pipeline against a few real, pre-vetted open-source AngularJS apps so you can see the report before running it on your own code.

## Why this exists

AngularJS hit end-of-life in January 2022. A lot of production apps built on it are still running, because a full rewrite is expensive and nobody wants to be the one who breaks the app trying. The tools that exist either analyze and recommend without touching code, or transform a narrow slice of patterns without verifying the result actually behaves the same way. This project's bet is that the verification step — not the transformation step — is the part worth getting right, because a migration tool nobody trusts is a migration tool nobody runs against production code.

## How it works

```
your AngularJS repo
        │
        ▼
  Stage 0  Ingest & secrets scan       — detect tooling, redact anything credential-shaped
  Stage 1  Inventory                    — AST scan, dependency graph, no transforms yet
  Stage 1.5 Workspace scaffold          — a real Angular workspace, generated fresh, never in-place
  Stage 2  Deterministic codemods       — the 10 patterns fixed in this project's scope
  Stage 3  LLM-assisted fallback        — everything the codemods can't safely touch
  Stage 4  Verification gate           — tsc, existing tests, or a generated characterization test
  Stage 5  Report + PR                  — side-by-side diffs, confidence tiers, honest numbers
        │
        ▼
  a branch + a report, never an auto-merge
```

Full detail on each stage, including exactly which 10 patterns are in scope and why the other patterns aren't, is in [docs/product-spec.md](docs/product-spec.md). The system design — module boundaries, the Nx dependency graph, how the CI pipeline enforces the boundary between the standalone CLI core and the hosted web layer — is in [docs/architecture.md](docs/architecture.md).

## Running it

The full `migrate` command doesn't exist yet — that needs the codemods (M1), the verification gate (M2), and the LLM fallback (M3), none of which are built. What does exist today is Stage 0 + 1 on their own:

```bash
git clone https://github.com/AshwinSathian/angularjs-migration-copilot.git
cd angularjs-migration-copilot && npm install
npx nx run migration-core:build
node libs/migration-core/dist/cli.js inventory ./path/to/an/angularjs/repo
```

which detects the AngularJS version, build tooling, and test runner, runs the Stage 0 secrets scan, and prints a JSON dependency graph of every controller, directive, component, service, factory, provider, value, constant, filter, decorator, animation, route, and `$watch` usage it finds — while excluding any vendored AngularJS framework source it comes across, so the framework's own internals never get reported as if they were your app. No transforms happen yet — it's report-only, by design (see [docs/milestones/m0-inventory.md](docs/milestones/m0-inventory.md)).

Once M1 lands, the eventual local CLI usage will look like:

```bash
npx angularjs-migration-copilot migrate ./path/to/your/repo --provider groq
```

against your own AngularJS repo, with your own free-tier API key, producing a local branch and a report. No code leaves your machine unless you explicitly opt into the hosted mode.

## Design principles this project holds itself to

- **Every AI-generated change is verified, not trusted.** Stage 4 either passes a real test suite, passes a generated characterization test against the original behavior, or the change is rejected. There's no tier below that.
- **Honest numbers over flattering numbers.** Mechanical hit-rate on messy real code is expected to be as low as 15%. That's reported, not smoothed over by cherry-picking clean fixtures.
- **The verification gate is the one piece of this project that gets held to a different standard.** It's the component an AI-assisted migration tool's whole credibility rests on, so it's human-reviewed line by line rather than taken on faith just because the tests passed. See [CLAUDE.md](CLAUDE.md) and [docs/product-spec.md §6.5](docs/product-spec.md).
- **$0 to run, regardless of demo traffic.** The hosted demo replays pre-computed results against a fixed set of fixture repos; it never triggers a live LLM call from visitor traffic.

## Repo layout

```
apps/api/           NestJS orchestration layer (hosted demo only)
apps/web/           Angular frontend for the hosted demo
libs/migration-core/  The actual pipeline. Zero framework dependencies — runs standalone as a CLI.
libs/provider-scheduler/  Rate-limit-aware scheduling across Groq / Gemini / OpenRouter
libs/secrets-scan/   Stage 0's redaction pass, unit-testable in isolation
fixtures/            Pinned-commit vendored copies of the demo repos
docs/                Product spec, architecture, decision log, milestone tracking
```

`migration-core` never imports from `apps/api` or `apps/web`. That boundary is enforced in CI, not just documented — see [docs/architecture.md §1](docs/architecture.md).

## Contributing

Contributions are welcome once there's code to contribute to. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, and [docs/decisions.md](docs/decisions.md) for the running log of architectural decisions and why they were made — read that before proposing a change that touches one of them.

## License

MIT — see [LICENSE](LICENSE). Fixture repos used by the hosted demo carry their own licenses (all MIT), preserved and attributed per [docs/product-spec.md §11](docs/product-spec.md).
