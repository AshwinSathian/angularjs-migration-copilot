/**
 * Every `angular.Module` method that registers a named artifact.
 * `.config()` and `.run()` are deliberately excluded — they take only a
 * function, no name, so they don't fit this shape; `.config()` blocks are
 * scanned separately for their *contents* by scan-routes.ts. This list
 * previously covered only `controller`/`directive`/`service`/`factory`/
 * `filter` and missed `.component()` entirely — closed in ADR-010 after
 * that gap was found by actually running the scanner against a real
 * fixture. `.provider()`/`.value()`/`.constant()`/`.decorator()`/
 * `.animation()` are added here for the same root-cause reason: a
 * hardcoded list of "the registration methods I've personally seen" will
 * keep missing real AngularJS API surface until it matches the actual API
 * instead. Single source of truth: REGISTRATION_KINDS is also what
 * scan-registrations.ts builds its runtime matcher `Set` from.
 */
export const REGISTRATION_KINDS = [
  'controller',
  'directive',
  'component',
  'service',
  'factory',
  'provider',
  'value',
  'constant',
  'filter',
  'decorator',
  'animation',
] as const;

export type RegistrationKind = (typeof REGISTRATION_KINDS)[number];

export interface RegistrationEntry {
  readonly kind: RegistrationKind;
  readonly name: string;
  readonly filePath: string;
  readonly line: number;
  /** DI-injected names, from either array-style or bare-function-style injection. */
  readonly dependencies: readonly string[];
}

export interface ModuleDeclaration {
  readonly name: string;
  readonly dependsOnModules: readonly string[];
  readonly filePath: string;
  readonly line: number;
}

export interface RouteEntry {
  readonly provider: 'ngRoute' | 'ui-router';
  readonly pathOrStateName: string;
  readonly filePath: string;
  readonly line: number;
}

export const WATCH_METHODS = ['$watch', '$watchCollection', '$watchGroup'] as const;

export interface WatchUsage {
  readonly method: (typeof WATCH_METHODS)[number];
  readonly expressionText: string;
  readonly filePath: string;
  readonly line: number;
}

export interface InventoryReport {
  readonly filesScanned: number;
  /**
   * Files recognized as vendored AngularJS framework source (by its
   * official `@license AngularJS` build banner) and excluded from
   * `filesScanned` and every array below. Surfaced rather than silently
   * dropped, so a report reader can tell "this repo has fewer app files
   * than I expected" from "the scanner is ignoring some of them on purpose."
   */
  readonly vendoredFilesSkipped: number;
  readonly modules: readonly ModuleDeclaration[];
  readonly registrations: readonly RegistrationEntry[];
  readonly routes: readonly RouteEntry[];
  readonly watchUsages: readonly WatchUsage[];
}
