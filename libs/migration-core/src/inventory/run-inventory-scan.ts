import { readFile } from 'node:fs/promises';
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

/**
 * AngularJS's own build stamps this exact banner into every official
 * release file — angular.js, angular-route.js, angular-animate.js,
 * angular-resource.js, angular-mocks.js, and so on. Directory-name
 * conventions for vendored code vary too much to filter on reliably
 * (`bower_components` and `node_modules` are the only two standardized
 * enough to ignore by path), but this banner is a precise, low-false-
 * positive signal that a file is the framework itself, not application
 * code — found by actually running this scanner against a real repo that
 * copies its own dependencies into `app/lib/` via a build step. Without
 * this, Angular's internal `$compile`/`$animate`/`ngView` registrations
 * get reported as if they were the app's own code — exactly the kind of
 * inflated, wrong number this project's whole premise argues against.
 */
const ANGULAR_LIBRARY_BANNER = /@license AngularJS v/;

function isVendoredAngularSource(content: string): boolean {
  // The banner is always in the first few lines of a real Angular release
  // file; checking only a small prefix avoids paying for a regex scan
  // across a multi-thousand-line framework file just to reject it.
  return ANGULAR_LIBRARY_BANNER.test(content.slice(0, 200));
}

/**
 * Stage 1 — full AST scan producing a dependency graph, report-only. No
 * transforms happen here. See docs/product-spec.md §6.2 and
 * docs/milestones/m0-inventory.md.
 */
export async function runInventoryScan(repoRoot: string): Promise<InventoryReport> {
  const files = await fg('**/*.js', {
    cwd: repoRoot,
    ignore: DEFAULT_IGNORE,
    absolute: true,
  });

  const project = new Project({
    compilerOptions: { allowJs: true, checkJs: false },
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
  });

  // Read every file concurrently and hand ts-morph the content directly —
  // `addSourceFileAtPath` would do this same read internally, but one file
  // at a time in a loop, serializing disk I/O that has no reason not to
  // overlap.
  const contents = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, content: await readFile(file, 'utf8') };
      } catch {
        // A handful of legacy files can be genuinely unreadable (stray
        // encoding issues, a build artifact the glob shouldn't have
        // matched). This is inventory, not a build — one bad file skips,
        // it doesn't fail the whole scan.
        return undefined;
      }
    })
  );

  let vendoredFilesSkipped = 0;

  for (const entry of contents) {
    if (!entry) continue;
    if (isVendoredAngularSource(entry.content)) {
      vendoredFilesSkipped++;
      continue;
    }
    try {
      // `overwrite: true` because `useInMemoryFileSystem: false` means
      // ts-morph knows this path already exists on real disk — without it,
      // createSourceFile refuses to proceed at all (a real regression this
      // caught: an earlier version of this loop swallowed that exact error
      // in this same catch block, silently scanning zero files).
      project.createSourceFile(entry.file, entry.content, { overwrite: true });
    } catch {
      // Genuinely unparseable content (not just unreadable) — same
      // skip-and-continue policy as above.
    }
  }

  return {
    filesScanned: project.getSourceFiles().length,
    vendoredFilesSkipped,
    modules: scanModuleDeclarations(project),
    registrations: scanRegistrations(project),
    routes: scanRoutes(project),
    watchUsages: scanWatchUsages(project),
  };
}
