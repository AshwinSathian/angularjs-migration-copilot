# apps/api

NestJS orchestration layer for the hosted demo. Thin by design — invokes `libs/migration-core` as a library call or a sandboxed subprocess, persists what it returns, exposes it over HTTP/SSE. See [docs/architecture.md §3](../../docs/architecture.md).

Not built yet. Scaffolded in [M4](../../docs/milestones/m4-web-layer.md).
