# M4 — Web Layer

**Status:** not started
**Estimate:** 1–1.5 weeks
**Depends on:** M3

## Scope

NestJS API, Angular frontend, and MongoDB Atlas, per [product-spec.md §5, §8, §9, §10](../product-spec.md). Standard Nx generator scaffolding — the lowest-risk milestone in the build, normal Claude Code workflow applies without the extra scrutiny M2 needs.

- `POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/files`, `GET /jobs/:id/files/:fileId`, `GET /jobs/:id/report`, `GET /jobs/:id/stream` — the API surface from §9.
- `migrationJobs`, `fileResults`, `providerUsage` collections per the §8 schema.
- Promote M3's file-backed scheduler to Mongo-backed, now that the Mongo layer exists.
- Frontend: job progress view, side-by-side diff viewer, and the confidence-tier filter — described in §10 as the single most important UX element in the product.
- The demo-job provider-usage meter must be visibly, not just internally, distinct from the live-job one — it's a replay of a pre-computed run, and a visitor shouldn't be able to mistake it for their own click triggering inference.
- Storage boundary: CLI-mode runs never write to this Mongo instance by default. It exists solely to serve the project-owned fixture-repo demo data.

## Definition of done

Standard: the API surface works end-to-end against a real job, the frontend renders it, and the storage boundary (no user data reaches this Mongo instance unless explicitly opted into) is actually true, not just documented.
