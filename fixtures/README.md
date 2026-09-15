# Fixture repos

Three real AngularJS codebases, used for the hosted demo and for reporting honest mechanical-hit-rate numbers across a range of codebase quality. Not vendored yet — that's M0's job, once the due-diligence pass (per-fixture Node version, confirming `npm`/`bower install` still works) is done. See [docs/milestones/m0-inventory.md](../docs/milestones/m0-inventory.md).

| Repo | License | Role |
|---|---|---|
| [`angular/angular-phonecat`](https://github.com/angular/angular-phonecat) | MIT | Clean baseline |
| [`mrholek/CoreUI-AngularJS`](https://github.com/mrholek/CoreUI-AngularJS) | MIT (see caveat below) | Real-world scale, heavy `ui-router` |
| [`akveo/blur-admin`](https://github.com/akveo/blur-admin) | MIT (see caveat below) | Messiest fixture, lowest expected hit-rate |

Both caveats, and why neither blocks using the repo, are detailed in [docs/product-spec.md §11](../docs/product-spec.md).

Once vendored, each will be a git submodule pinned to a specific commit SHA, not tracking `main` — a demo run needs to stay reproducible even if the upstream repo changes or disappears.
