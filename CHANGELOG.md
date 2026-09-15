# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/) once the first release ships.

## [Unreleased]

### Added

- Project spec, architecture document, and milestone breakdown.
- Repository scaffold: Nx workspace (npm, TypeScript, Vitest, ESLint), CI
  skeleton, community health files, `CLAUDE.md` guardrails.
- M0 (inventory scanner): `libs/secrets-scan` (pattern-based secret
  detection and redaction) and `libs/migration-core` (AngularJS
  version/tooling/test-runner detection, an AST-based inventory scanner
  covering controllers, directives, services, factories, filters,
  `.component()` registrations, routes, and `$watch` usage, plus a CLI
  `inventory` command). 67 unit tests. Run against the real, pinned
  `angular/angular-phonecat` fixture and cross-checked by hand — see
  [docs/milestones/m0-inventory.md](docs/milestones/m0-inventory.md).

The web layer, codemods, LLM fallback, and verification gate are still
unbuilt — see [docs/milestones](docs/milestones) for what's next.
