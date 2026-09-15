export type RegistrationKind =
  | 'controller'
  | 'directive'
  | 'service'
  | 'factory'
  | 'filter'
  | 'component';

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

export interface WatchUsage {
  readonly method: '$watch' | '$watchCollection' | '$watchGroup';
  readonly expressionText: string;
  readonly filePath: string;
  readonly line: number;
}

export interface InventoryReport {
  readonly filesScanned: number;
  readonly modules: readonly ModuleDeclaration[];
  readonly registrations: readonly RegistrationEntry[];
  readonly routes: readonly RouteEntry[];
  readonly watchUsages: readonly WatchUsage[];
}
