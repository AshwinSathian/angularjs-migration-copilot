# Fixture repos

Three real AngularJS codebases, used for the hosted demo and for reporting honest mechanical-hit-rate numbers across a range of codebase quality. Each is a git submodule pinned to a specific commit SHA, not tracking `main` — a demo run needs to stay reproducible even if the upstream repo changes or disappears.

| Repo | License | Role | Vendored at |
|---|---|---|---|
| [`angular/angular-phonecat`](https://github.com/angular/angular-phonecat) | MIT | Clean baseline | `ef6f6eb` — the tutorial's final step, "step-14 Animations" |
| [`mrholek/CoreUI-AngularJS`](https://github.com/mrholek/CoreUI-AngularJS) | MIT (see caveat below) | Real-world scale, heavy `ui-router` | `ef0c602` |
| [`akveo/blur-admin`](https://github.com/akveo/blur-admin) | MIT (see caveat below) | Messiest fixture, lowest expected hit-rate | `7f2596f` |

Both caveats, and why neither blocks using the repo, are detailed in [docs/product-spec.md §11](../docs/product-spec.md).

`angular-phonecat` at this pinned commit turned out to be written with AngularJS 1.5's `.component()` API rather than classic `.controller()`/`.directive()` — a real finding from actually running the M0 inventory scanner against it, not something anticipated in the original spec. The scanner now recognizes both forms; see [docs/decisions.md ADR-010](../docs/decisions.md).

**Per-fixture Node version.** `angular-phonecat.nvmrc` (a sibling file, not inside the submodule — the submodule's own contents aren't ours to modify, and adding a commit inside it would reference a SHA that doesn't exist on the upstream remote, breaking reproducibility for anyone else's clone) pins Node 24 for this fixture, per [docs/architecture.md §4](../docs/architecture.md)'s "documented per-fixture, not assumed uniform" policy. Actually verified, not assumed: `npm install` succeeds cleanly on Node 24 despite the 2020-era lockfile (npm does a one-time lockfile format upgrade, which is reverted afterward so the submodule's pinned commit stays untouched), and the real Karma suite passes 5/5 specs against a real, current Chrome. Both were run, not inferred from "it should probably work."

**`CoreUI-AngularJS`** has no `dependencies`/`devDependencies` in its `package.json` at all (its vendored assets are committed directly, not installed) — `npm install` is a genuine no-op, confirmed by actually running it, not assumed from reading the file.

**`blur-admin`** is where "confirm it still installs on Node 24" actually caught something, same as ADR-010/ADR-018 did for M0. Plain `npm install` fails, for two separate, confirmed reasons, neither touched by editing the submodule's own committed content (that stays off-limits, same rule as above): (1) `node-sass@4.14.1`, pulled in by `gulp-sass@^4`, needs to compile a native binary via `node-gyp@3.8.0`'s Python 2 toolchain — neither exists in a current environment, and the failure is a real `node-gyp` build error, not a version-range resolution failure; (2) the `postinstall` script (`bower install`) fails on `bootstrap-tagsinput#~0.7.1` — that tag no longer exists on the upstream `TimSchlechter/bootstrap-tagsinput` GitHub repo, unrelated to Node or this project. Both failures are confined to `blur-admin`'s own dev/build tooling (a Sass compiler and a vendored jQuery widget), not to the AngularJS application source `migration-core` actually scans — `bower_components` in particular is exactly the kind of vendored third-party code M0's `@license`-banner filter (ADR-018) already excludes from scanning, install or no install. **Confirmed working alternative:** `npm install --ignore-scripts` succeeds cleanly (1172 packages, exit 0) — this is the command to use against this fixture. See [docs/decisions.md ADR-023](../docs/decisions.md).
