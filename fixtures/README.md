# Fixture repos

Three real AngularJS codebases, used for the hosted demo and for reporting honest mechanical-hit-rate numbers across a range of codebase quality. Each is a git submodule pinned to a specific commit SHA, not tracking `main` — a demo run needs to stay reproducible even if the upstream repo changes or disappears.

| Repo | License | Role | Vendored at |
|---|---|---|---|
| [`angular/angular-phonecat`](https://github.com/angular/angular-phonecat) | MIT | Clean baseline | `ef6f6eb` — the tutorial's final step, "step-14 Animations" |
| [`mrholek/CoreUI-AngularJS`](https://github.com/mrholek/CoreUI-AngularJS) | MIT (see caveat below) | Real-world scale, heavy `ui-router` | not yet — M1 |
| [`akveo/blur-admin`](https://github.com/akveo/blur-admin) | MIT (see caveat below) | Messiest fixture, lowest expected hit-rate | not yet — M1 |

Both caveats, and why neither blocks using the repo, are detailed in [docs/product-spec.md §11](../docs/product-spec.md).

`angular-phonecat` at this pinned commit turned out to be written with AngularJS 1.5's `.component()` API rather than classic `.controller()`/`.directive()` — a real finding from actually running the M0 inventory scanner against it, not something anticipated in the original spec. The scanner now recognizes both forms; see [docs/decisions.md ADR-010](../docs/decisions.md).
