# Project guardrails

**Start every session by reading [docs/PROGRESS.md](docs/PROGRESS.md).** It's
the single source of truth for what's actually built, verified, and next —
not this file, not the milestone docs in isolation, not memory of a past
session. If anything below ever conflicts with what PROGRESS.md says is
currently true, PROGRESS.md wins; update this file instead of trusting a
stale assumption baked into it.

Read [docs/decisions.md](docs/decisions.md) next, before starting work on any
milestone. It's short — a running log of *why* specific technical decisions
were made, the log PROGRESS.md's "what's true now" summary is built on top
of. Append to it when you make a new architectural call mid-milestone; never
rewrite past entries, even superseded ones.

**Before you finish a session:** update `docs/PROGRESS.md` — rewrite the
status table and "Where things stand" section to match reality, and append
one line to the session log. A session that ships real work but leaves
PROGRESS.md describing the previous state has left the next session to
re-discover what you already know.

## Module boundaries

- `libs/migration-core` has zero dependencies on `@nestjs/*` or `@angular/*`
  packages, framework-wise. If a task in there seems to need one, that's a
  signal the task belongs in `apps/api` or `apps/web` instead, not a reason
  to add the dependency.
- `migration-core` never imports from `apps/api` or `apps/web`. The reverse
  is fine. This is enforced by Nx lint rules and by a CI step that builds
  `migration-core` standalone and diffs its dependency tree against an
  allowlist — a stray import gets caught by lint, but a framework dependency
  that sneaks in through a bundler/executor wouldn't, which is why both
  checks exist.

## Verification is the product

- Never mark a Stage 4 (verification gate) task complete because "the code
  looks correct." It's complete only when `tsc --noEmit` and the target
  repo's actual test suite have been run and their exit codes checked —
  not inferred from reading the generated code. Concretely: the gate isn't
  done until it correctly returns REJECTED on all three planted fixtures in
  `libs/migration-core/verification/__fixtures__/negative-controls/`.
- Any change to `libs/migration-core/verification/` requires a human review
  before merge, regardless of how confident the CI run looks. This is the
  one component this entire project's credibility rests on — see
  [docs/product-spec.md §6.5](docs/product-spec.md). An agent that makes a
  subtle mistake in a verification harness (a wrapper that swallows a
  non-zero exit code, say) can plausibly write tests that don't catch its
  own mistake, for the same reason. Don't be the only judge of your own
  verification code.

## Scope discipline

- The 10 codemod patterns in
  [docs/milestones/m1-codemods.md](docs/milestones/m1-codemods.md) are fixed
  v1 scope. Don't add an 11th pattern opportunistically because a fixture
  repo has an obvious-looking case for it — flag it in
  [docs/decisions.md](docs/decisions.md) as a v2 candidate instead.
- Don't build the Mongo-backed provider scheduler in M3. M3 ships a
  file-backed one; the Mongo-backed version is M4's job, once that milestone
  actually builds the Mongo layer it needs. Building it early isn't getting
  ahead — it's coupling M3 to infrastructure M3 doesn't have yet.

## Reporting has to stay honest

- Never report a mechanical-hit-rate or characterization-eligibility number
  averaged across only the fixture repos that make the number look good. All
  three fixture repos get reported, including the messiest one
  (`akveo/blur-admin`), every time. A run that quietly reports only the
  flattering repo fails that milestone's definition of done.
- Characterization-eligibility numbers get reported broken down by artifact
  type (controller/service/filter/directive), never as one aggregate figure.
  See [docs/product-spec.md §6.5](docs/product-spec.md) for why an aggregate
  can hide the exact imbalance the number exists to surface.

## Workflow

- Every milestone ends in a PR, never a direct commit to `main` — regardless
  of how the session's own tests looked. See
  [docs/milestones](docs/milestones) for what's in scope for the milestone
  you're on and what "done" means for it.
- Package manager is npm, Node 24 (see `.nvmrc`). Test runner is Vitest
  across the whole workspace, including `apps/web` — that's now Angular
  CLI's own default for new workspaces, not a project-specific choice to
  argue with later.
- `gitleaks` runs as a pre-commit hook and a CI gate from the very first
  commit, including on this project's own development traffic (real Groq/
  Gemini keys will be in the local dev environment to run integration
  tests). Don't wait for Stage 0's own redaction feature to exist before
  applying the same hygiene to the build process building it.
- Before scaffolding the Nx workspace (M0.5) or wiring the provider
  scheduler (M3), check current compatibility/rate-limit info rather than
  assuming what's in the spec docs still holds — Nx's Angular-version
  support and provider free-tier terms both change on a timeline this repo
  doesn't control. If something in `docs/product-spec.md` or
  `docs/architecture.md` looks stale against what you find, flag it in
  `docs/decisions.md` rather than silently building against the old number.

## What "done" means here

A task is done when it's been run and its output checked, not when the code
that should produce the right output has been written. This applies
everywhere but matters most in Stage 4: a verification gate that was never
actually executed against the negative-control fixtures hasn't been built
yet, no matter how complete the code looks.
