# libs/provider-scheduler

Job-level, rate-limit-aware scheduling across LLM providers. See [docs/product-spec.md §7](../../docs/product-spec.md).

- `Provider` — one prompt in, one text out, with token counts. `createMockProvider` is the scripted local one; `createOpenAiCompatibleProvider` (Groq, OpenRouter) and `createGeminiProvider` call the real APIs with `fetch`.
- `createScheduler` — providers in priority order, a token bucket per provider for requests and tokens per minute, a daily window for requests and tokens. A 429 moves the request to the next provider at once. When none can take it, nothing is sent and the caller gets the time to resume at.
- State is one JSON file. Limits are passed in from configuration, never hardcoded here (ADR-008).

Framework-free, no dependency on `migration-core`. File-backed only; the Mongo-backed version is M4's.
