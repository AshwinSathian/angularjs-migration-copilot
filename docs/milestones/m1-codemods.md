# M1 — Deterministic Codemods

**Status:** not started
**Estimate:** 2–3 weeks
**Depends on:** M0.5

## Scope

The 10 fixed-scope codemod patterns from [product-spec.md §6.3](../product-spec.md), each mechanically transforming one AngularJS pattern to its Angular equivalent:

| # | Pattern | Target |
|---|---|---|
| 1 | `$scope.x = y` | class property assignment |
| 2 | `controllerAs` syntax | normalized to component class |
| 3 | Array-style DI (`['$http', fn]`) | constructor injection |
| 4 | Simple directive (no `transclude`/`compile`) | `@Component`/`@Directive` |
| 5 | Pure filters (no external state) | Angular pipes |
| 6 | `$http` + `.then()` chains, depth ≤ 2 | `HttpClient` + RxJS |
| 7 | `ng-repeat`/`ng-if`/`ng-show` | `@for`/`@if` control flow |
| 8 | Flat `$routeProvider`/`ui-router` states | Angular Router config |
| 9 | One-way `bindings: { x: '<' }` | `@Input()` |
| 10 | `$emit`/`$broadcast`/`$on` within one module | typed RxJS `Subject` service |

This list is fixed scope. If a fixture repo turns up an obvious-looking 11th pattern, it gets flagged in [decisions.md](../decisions.md) as a v2 candidate — not added here. Anything outside these 10 (nested abstract router states, `transclude`, custom `compile` functions, deep-equality `$watch`, cross-module event buses, jQuery-in-controller DOM manipulation) is explicitly out of scope and flags to Stage 3 or manual review instead.

## Definition of done

Each pattern has its own before/after fixture-file test. Mechanical hit-rate is reported against **all three** fixture repos, including `akveo/blur-admin` — the messiest one. A run that only reports the flattering repo fails this milestone's definition of done, full stop. Expect the rate to land somewhere in the 15%–60% range depending on the repo; a low number here is a correct result, not a bug to chase.
