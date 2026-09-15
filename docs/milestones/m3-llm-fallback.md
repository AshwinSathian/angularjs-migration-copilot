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

## Real-provider testing cadence

Don't defer all real-provider testing to one final integration pass at the end of this milestone. Minimum cadence: one real-provider smoke test — a handful of actual Groq/Gemini calls against a small fixture — at the end of each week of M3 work. See [architecture.md §6.4a](../architecture.md).

## Definition of done

Tested primarily against the mock provider, with weekly real-provider smoke tests logged, not deferred to a single end-of-milestone pass.
