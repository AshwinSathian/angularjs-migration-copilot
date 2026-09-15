# M0 — Inventory Scanner

**Status:** not started
**Estimate:** 1–2 weeks
**Depends on:** nothing — this is the first milestone

## Scope

A full AST scan of a target AngularJS repo, producing a dependency graph. Report-only — no transforms happen here.

- Detect AngularJS version, build tooling (Gulp/Grunt/Webpack/none), and test runner, per [product-spec.md §6.1](../product-spec.md).
- If a test runner is detected but non-functional in the current environment, attempt the one documented remediation (dead PhantomJS launcher → headless Chrome in the existing Karma config) before falling back to "untested."
- Scan controllers, directives, services/factories, filters, route definitions, and `$scope.$watch` usage with ts-morph/ng-morph, per [product-spec.md §6.2](../product-spec.md).
- Secrets scan (`libs/secrets-scan`) runs here too, ahead of anything that could reach an external call later in the pipeline — even though nothing in M0 makes an external call yet, the scan needs to exist and be wired in from the start.
- Due-diligence pass on the three fixture repos: confirm each one's `npm`/`bower install` actually works on a period-appropriate Node version (pinned via a per-fixture `.nvmrc`), and budget time to patch or vendor anything that doesn't. See [architecture.md §4](../architecture.md) for why this is expected work, not a surprise.

## Definition of done

Produces a correct report against `angular/angular-phonecat`, checked by a human against the repo's actual structure — not "the JSON output looks reasonable." If the scanner says a controller uses `controllerAs` syntax, someone opened that controller and confirmed it.
