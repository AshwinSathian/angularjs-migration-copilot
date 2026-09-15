# Contributing

Thanks for taking a look. A few things worth knowing before you dive in.

## Where to start

Check [docs/milestones](docs/milestones) for what's currently in progress and what's not built yet. Each milestone doc has a scope and a definition of done — if you want to work on something, an open issue tagged with the relevant milestone is the place to coordinate, so two people don't end up building the same thing.

The 10 codemod patterns in [docs/product-spec.md §6.3](docs/product-spec.md) are fixed scope for v1. If you've found a repo with an obvious 11th pattern, open an issue describing it rather than sending a PR that adds it — see [docs/decisions.md](docs/decisions.md) for why scope creep here gets flagged instead of merged.

## Workflow

1. Fork, branch, make your change.
2. Every module has its own tests — `nx affected:test` runs what your change touches.
3. Open a PR against `main`. CI runs lint, typecheck, unit tests, and a secrets scan on every PR.
4. No direct commits to `main`, including from maintainers — everything goes through a PR, even a one-line fix.

## The one place review is stricter

Changes to `libs/migration-core/verification/` — the compile/test/characterization gate — require a human review before merge, no matter how clean the CI run looks. That component is what the entire project's credibility rests on, and an agent (human or AI) that makes a subtle mistake writing a verification harness can plausibly make tests that don't catch its own mistake, for the same reason. See [docs/product-spec.md §6.5](docs/product-spec.md) and the "guard the guards" section of [CLAUDE.md](CLAUDE.md) if you're curious why this rule exists instead of just trusting the test suite.

## Fixture-repo integration tests

`fixture-integration` in CI needs Groq/Gemini API keys to actually exercise the LLM stage, and those keys are repository secrets. GitHub doesn't expose repo secrets to workflows triggered from a fork's PR, and that's staying that way — we're not switching to `pull_request_target` to work around it. If your change touches Stage 3 logic, run the fixture integration suite locally with your own free-tier key and paste the results in your PR description.

## Trust boundary, stated plainly

This tool runs the target repo's own build and test scripts locally — the same thing `npm install` does. If you're testing against a repo you found on GitHub, that's the same trust decision as running any unfamiliar build tool against it. Don't point the sandboxed test runner at code you wouldn't otherwise run.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Report violations per the instructions there.
