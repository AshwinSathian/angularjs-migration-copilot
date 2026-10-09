# AngularJS → Angular Migration Copilot

**Status: mechanical pipeline works end to end; no LLM stage yet.** Stages 0 through 2 and Stage 4 are built and have been run against three real, pinned AngularJS repos: inventory, workspace scaffold, the 10 codemods, assembly into a real Angular workspace, and the verification gate. Stage 3 (LLM fallback) and the hosted demo don't exist yet. The numbers so far are low and reported as they are — across three fixtures and two previously-unseen repos, between 0% and 19% of files produce something the Angular compiler accepts. Current status, the full tables, and what's next: [docs/PROGRESS.md](docs/PROGRESS.md). Per-milestone scope and definition of done: [docs/milestones](docs/milestones).

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
  Stage 4  Verification gate           — Angular compiler, then a generated characterization test
  Stage 5  Report + PR                  — side-by-side diffs, confidence tiers, honest numbers
        │
        ▼
  a branch + a report, never an auto-merge
```

Full detail on each stage, including exactly which 10 patterns are in scope and why the other patterns aren't, is in [docs/product-spec.md](docs/product-spec.md). The system design — module boundaries, the Nx dependency graph, how the CI pipeline enforces the boundary between the standalone CLI core and the hosted web layer — is in [docs/architecture.md](docs/architecture.md).

## Running it

The mechanical pipeline runs today, without an LLM or an API key:

```bash
git clone https://github.com/AshwinSathian/angularjs-migration-copilot.git
cd angularjs-migration-copilot && npm install
npx tsc -b libs/migration-core/tsconfig.lib.json
CLI=libs/migration-core/dist/cli.js

node $CLI inventory ./path/to/an/angularjs/repo        # Stage 0+1: report only
node $CLI scaffold /abs/path/to/new-workspace          # Stage 1.5: a real Angular workspace
node $CLI migrate ./path/to/an/angularjs/repo /abs/path/to/new-workspace --report report.json
```

`migrate` never writes to the source repo. It applies every codemod, emits standalone Angular files into `src/app/migrated/` in the workspace, compiles them with the Angular compiler, and tiers each one:

- **MEDIUM** — compiles, and a generated characterization test shows the migrated function behaves like the original.
- **LOW** — compiles, behaviour not verified. Needs a human.
- **REJECTED** — failed to compile or failed the characterization diff, with the compiler's own diagnostics in the report.

Add `--provider` and the files the codemods could not migrate go to an LLM. Its answer is a structured patch, written into the same workspace, compiled by the same compiler and tiered by the same rule. The report keeps the two apart: every artifact is marked `mechanical` or `llm-assisted`, and the counts are never summed.

```bash
node $CLI migrate ./repo /abs/path/to/new-workspace --provider mock --report report.json
GROQ_API_KEY=... GEMINI_API_KEY=... node $CLI migrate ./repo /abs/path/to/new-workspace \
  --provider real --providers-config my-providers.json --report report.json
```

- `--provider mock` makes no network call. Its patches are stand-ins that exercise each path, so its numbers describe the plumbing, not a migration.
- `--provider real` needs `--providers-config`: the model and rate limits for each provider, which you fill in from your own provider console ([providers.example.json](libs/migration-core/providers.example.json)). Nothing is assumed, because free-tier limits change. A provider with no key, model or limits is skipped, and the run says so.
- Everything sent to a provider is passed through secret redaction first.
- When every provider is out of budget the run exits with code 75 and tells you when to run the same command again. Finished answers are kept, so nothing is sent twice. `--wait` waits in-process instead.

It runs the workspace's compiler on your machine with no sandbox, so only point it at code you trust.

## Design principles this project holds itself to

- **Every change is verified, not trusted — mechanical ones included.** Stage 4 compiles it with the Angular compiler and, where a function can be isolated, diffs its behaviour against the original. What can't be verified is labelled LOW, never quietly accepted.
- **Honest numbers over flattering numbers.** "A pattern matched" and "the output compiles" are reported as two different numbers, per repo, including the worst one.
- **The verification gate is held to a different standard.** It's the component the whole project's credibility rests on. Its controls are real (a scaffolded workspace, the real compiler) and are themselves tested by mutation: break the gate on purpose and the controls must fail. It has been attacked adversarially by an AI agent and then read line by line by the maintainer; any later change to it needs that human read again before it merges ([docs/decisions.md](docs/decisions.md) ADR-067, ADR-070).
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
