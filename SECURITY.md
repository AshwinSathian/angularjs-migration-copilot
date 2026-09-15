# Security Policy

## Reporting a vulnerability

Email ashwinsathyan19@gmail.com with a description and, if you have one, a
reproduction. Please don't open a public issue for anything that could be
exploited before a fix ships.

You should get a response within a few days. If the report is confirmed,
we'll work out a disclosure timeline with you before anything is made public.

## What's in scope

- The migration pipeline itself, especially anything in `libs/secrets-scan`
  or `libs/migration-core/verification` — those two are the components most
  likely to leak something they shouldn't or accept something they shouldn't.
- The hosted API and its handling of provider API keys.
- Anything that would let the sandboxed build/test execution (Stage 4) escape
  its container.

## What's explicitly out of scope

- Vulnerabilities in the AngularJS code a user points the tool at. That's
  their code, not ours — this tool migrates it, it doesn't audit it.
- The fixture repos themselves (`fixtures/`). Those are pinned, third-party,
  and vendored as-is for the demo; report issues in them upstream.

## Why this matters more than usual for this project

This repo has real API keys (Groq, Gemini) in its CI environment to run
integration tests, and the whole first stage of the pipeline exists
specifically to stop secrets from leaking into an LLM prompt. A security bug
here isn't hypothetical in the way it is for a lot of side projects — see
[docs/product-spec.md §6.1 and §11](docs/product-spec.md) for the redaction
and sandboxing guarantees this policy exists to back up.
