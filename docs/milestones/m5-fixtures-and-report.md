# M5 — Fixtures, Licensing, and the Published Report

**Status:** not started
**Estimate:** 1 week
**Depends on:** everything else

## Scope

The final fixture-repo runs, license verification, and the numbers that actually go on the demo and the portfolio. Per [product-spec.md §13, §14](../product-spec.md).

- Full pipeline run against all three fixture repos, offline, pre-computed, cached for the hosted demo (never live per visitor traffic — [product-spec.md §7](../product-spec.md)).
- The `fixture-integration` CI job runs in full and unfiltered as a required check before this milestone ships — no possibly-stale integration result gets published. See [architecture.md §5](../architecture.md).
- License/NOTICE verification for all three fixtures gets a final human confirmation before publishing, particularly the `CoreUI-AngularJS` README caveat and the `blur-admin` GitHub-badge-vs-actual-license discrepancy documented in [product-spec.md §11](../product-spec.md). This is not something to delegate to the agent's own judgment — a human explicitly signs off.
- Published numbers include all three repos, broken down by artifact type for characterization-eligibility, with no smoothing or cherry-picking. A low number, honestly explained, is a legitimate published outcome per [product-spec.md §14](../product-spec.md) — not something to iterate against until it looks better.

## Definition of done

The full pipeline has run end-to-end against at least 2 real, previously-unseen AngularJS repos — not just the curated fixtures — with zero manual intervention required to produce the report. Manual review flags inside the report are fine and expected; manual intervention to generate the report itself is not.
