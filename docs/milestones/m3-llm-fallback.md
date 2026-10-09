# M3 — LLM Fallback + Scheduler

**Status:** not started
**Estimate:** 1–2 weeks
**Depends on:** M1, M2

## Scope

Schema-constrained patch generation for everything the M1 codemods can't safely touch, plus a job-level provider scheduler. Full detail in [product-spec.md §6.4 and §7](../product-spec.md).

- Structured patch output only — file path plus full content, never freeform prose. One retry on invalid schema, then a hard fail to manual review.
- Per-file token cap; files over it split by function/class, never silently truncated.
- File-backed job-level scheduler for this milestone. The Mongo-backed version is M4's job, once M4 actually builds the Mongo layer — don't build it early just because it seems like the "real" version.
- **Before wiring up provider priority and limits, check current numbers directly** against `console.groq.com/docs/rate-limits` and `ai.google.dev/gemini-api/docs/rate-limits`. The spec deliberately doesn't hardcode RPM/RPD figures — see [product-spec.md §7](../product-spec.md) and [decisions.md ADR-008](../decisions.md) for why: they were already stale against third-party trackers during spec-writing, months before this milestone starts.
- Development and testing default to the local mock provider ([architecture.md §6.5](../architecture.md)) — canned responses including a deliberately-invalid-schema case, so the retry-then-fail path gets exercised without burning real quota.

## What already exists — build on it, don't rebuild it

M3 is a new stage between two that work. Read these before designing anything:

- **Input: the `migrate` report** (`libs/migration-core/src/pipeline/run-pipeline.ts`, `PipelineReport`). Stage 3's work list is every source file whose `outcome` is `REJECTED`, `NO_MATCH` or `NOT_EMITTED`. A `REJECTED` artifact carries the Angular compiler's own diagnostics (`diagnostics`) and the file the assembler emitted — the best prompt context there is. `followUps` lists AngularJS injectables with no Angular provider.
- **Output goes back through the gate, unchanged.** Write the patch into the scaffolded workspace under `src/app/migrated/`, compile with `runCompileCheck`, and tier with `decideTier` (`libs/migration-core/src/verification/`). Do not add a second tiering path. Tiers are MEDIUM / LOW / REJECTED; there is no HIGH in v1. An LLM patch that compiles with no characterization target is LOW, exactly like mechanical output.
- **Compile in rounds**, as `runPipeline` does, so one bad patch cannot reject its neighbours. Prefer extending `runPipeline` with a Stage 3 step over a parallel pipeline.
- **Characterization is where Stage 3 earns MEDIUM.** `pipeCharacterizationTarget` (`pipeline/characterize-pipe.ts`) is the only producer today. For an LLM-migrated function the two sides no longer come from the same text, so a match means something; producers for services and pure helpers belong in this milestone when there is a real target.
- **Redact before any prompt.** `libs/secrets-scan` (`redact`) runs on every byte sent to a provider, including in local mode (product-spec §6.1).
- **`libs/provider-scheduler` is an empty directory with a README.** It becomes a real Nx library here: tags `scope:provider-scheduler`, `type:lib`; add it to `depConstraints` and spread `frameworkFreeLib` into its ESLint config (root `eslint.config.mjs`). `migration-core` may depend on it; it must not depend on `migration-core`.
- **Anything under `libs/migration-core/src/verification/` needs the maintainer's line-by-line read before merge.** Keep M3's changes there as small as possible and in their own PR.

## Definition of done, concretely

- `migrate --provider mock` runs all five repos in `docs/PROGRESS.md` end to end with no manual step, and the report separates mechanical from LLM-assisted artifacts (spec §8 `transformType`).
- The mock provider exercises: a valid patch, an invalid-schema response (one retry, then manual review), a 429 (immediate fallback to the next provider, no same-provider retry), and all providers exhausted (job pauses with progress preserved, resumes on the next window).
- At least one real-provider run against `angular-phonecat`, with the usage it consumed recorded.
- Numbers in `docs/PROGRESS.md` gain an LLM-assisted column, per repo and per artifact type, matched and compiled kept apart.

## Real-provider testing cadence

Don't defer all real-provider testing to one final integration pass at the end of this milestone. Minimum cadence: one real-provider smoke test — a handful of actual Groq/Gemini calls against a small fixture — at the end of each week of M3 work. See [architecture.md §6.4a](../architecture.md).

## Definition of done

Tested primarily against the mock provider, with weekly real-provider smoke tests logged, not deferred to a single end-of-milestone pass.
