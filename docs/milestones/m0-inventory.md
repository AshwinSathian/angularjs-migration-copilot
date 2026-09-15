# M0 — Inventory Scanner

**Status:** implementation complete, awaiting human review of the definition-of-done check below
**Estimate:** 1–2 weeks
**Depends on:** nothing — this is the first milestone

## Scope

A full AST scan of a target AngularJS repo, producing a dependency graph. Report-only — no transforms happen here.

- Detect AngularJS version, build tooling (Gulp/Grunt/Webpack/none), and test runner, per [product-spec.md §6.1](../product-spec.md). **Shipped:** `libs/migration-core/src/ingest/`.
- If a test runner is detected, flag whether it references PhantomJS (the expected default failure mode for legacy Karma configs) and generate a remediated config swapping it for ChromeHeadless. **Scope note:** this milestone builds detection and a pure text-transform remediation generator, not execution — actually running the repaired suite and checking its exit code needs Stage 4's sandbox, which doesn't exist until M2. See [decisions.md ADR-013](../decisions.md).
- Scan controllers, directives, services/factories, filters, `.component()` registrations, route definitions, and `$scope.$watch` usage with ts-morph, per [product-spec.md §6.2](../product-spec.md). **Shipped:** `libs/migration-core/src/inventory/`. (ng-morph isn't used yet — ts-morph alone was sufficient for this milestone's AST queries; revisit if a later milestone's transforms need ng-morph's Angular-specific helpers.)
- Secrets scan (`libs/secrets-scan`) runs here too, wired into ingest. **Shipped**, with 67 passing unit tests across both libraries.
- Due-diligence pass on the three fixture repos: `angular/angular-phonecat` is vendored as a pinned git submodule (`fixtures/angular-phonecat`, commit `ef6f6eb`) and confirmed to run on Node 24 with no install issues. `mrholek/CoreUI-AngularJS` and `akveo/blur-admin` are **not vendored yet** — deferred to M1, since that's the milestone that actually needs their (messier, more period-specific) tooling exercised.

## What actually shipped

- `libs/secrets-scan` — pattern-based secret detection and redaction (`scanForSecrets`, `redact`), 13 tests.
- `libs/migration-core/src/ingest/` — AngularJS version detection, build-tool detection, Karma/PhantomJS detection, the config remediation generator, and the repo-wide secrets scan. 27 tests.
- `libs/migration-core/src/inventory/` — module declarations, controller/directive/service/factory/filter/**component** registrations with DI dependency extraction, ngRoute/ui-router route definitions, and `$watch`/`$watchCollection`/`$watchGroup` usage. 27 tests.
- 67 tests total, all passing; lint and typecheck clean across both libraries.
- `libs/migration-core/src/cli.ts` — an `inventory <repoPath>` CLI command wiring ingest + inventory together into one JSON report.
- Ran against the real, pinned `angular-phonecat` fixture. Findings: 5 modules, 2 `.component()` registrations (with correct DI), 1 factory, 1 filter, 2 ngRoute routes, 0 `$watch` usages, 0 secrets, AngularJS 1.8.x detected from `package.json`, Karma detected with no PhantomJS (already using Chrome/Firefox). Cross-checked by hand against the actual source (`grep` for `.controller(`/`.directive(` confirmed there genuinely are none at this commit — the fixture uses `.component()` exclusively, which the scanner didn't originally recognize; that gap is now closed, see [decisions.md ADR-010](../decisions.md)).

## Definition of done

Produces a correct report against `angular/angular-phonecat`, checked by a human against the repo's actual structure — not "the JSON output looks reasonable." The report above has been cross-checked once (by grepping the fixture directly), but per this milestone's own standard, it still needs a second, independent look from you before this milestone is actually called done — self-certification is exactly what this project's philosophy argues against.
