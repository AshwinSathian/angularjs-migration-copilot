import fg from 'fast-glob';
import { Project } from 'ts-morph';
import { scanModuleDeclarations } from './scan-modules.js';
import { scanRegistrations } from './scan-registrations.js';
import { scanRoutes } from './scan-routes.js';
import { scanWatchUsages } from './scan-watches.js';
import type { InventoryReport } from './types.js';

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/bower_components/**',
  '**/dist/**',
  '**/build/**',
  '**/*.min.js',
  '**/*.spec.js',
  '**/*.test.js',
];

export interface RunInventoryScanOptions {
  /** Extra glob-ignore patterns, appended to the built-in defaults. */
  readonly ignore?: readonly string[];
}

/**
 * Stage 1 — full AST scan producing a dependency graph, report-only. No
 * transforms happen here. See docs/product-spec.md §6.2 and
 * docs/milestones/m0-inventory.md.
 */
export async function runInventoryScan(
  repoRoot: string,
  options: RunInventoryScanOptions = {}
): Promise<InventoryReport> {
  const files = await fg('**/*.js', {
    cwd: repoRoot,
    ignore: [...DEFAULT_IGNORE, ...(options.ignore ?? [])],
    absolute: true,
  });

  const project = new Project({
    compilerOptions: { allowJs: true, checkJs: false },
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
  });

  for (const file of files) {
    try {
      project.addSourceFileAtPath(file);
    } catch {
      // A handful of legacy files can be genuinely unparseable (stray
      // encoding issues, a build artifact the glob shouldn't have matched).
      // This is inventory, not a build — one bad file skips, it doesn't
      // fail the whole scan.
    }
  }

  return {
    filesScanned: files.length,
    modules: scanModuleDeclarations(project),
    registrations: scanRegistrations(project),
    routes: scanRoutes(project),
    watchUsages: scanWatchUsages(project),
  };
}
