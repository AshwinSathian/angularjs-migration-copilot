import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import { scanForSecrets } from 'secrets-scan';

const SECRET_SCAN_GLOBS = ['**/*.js', '**/*.json', '**/.env*', '**/*.html'];
const SECRET_SCAN_IGNORE = [
  '**/node_modules/**',
  '**/bower_components/**',
  '**/dist/**',
  '**/*.min.js',
  // `dot: true` below (needed to match .env*) also makes fast-glob descend
  // into .git — a real repo's object store can be huge and is never
  // useful to scan here, so it's excluded explicitly rather than relying
  // on the extension filters alone to make that traversal cheap.
  '**/.git/**',
];

/**
 * Runs the Stage 0 redaction scan (docs/product-spec.md §6.1) across every
 * file that could plausibly reach an LLM prompt later in the pipeline.
 * This applies regardless of CLI vs. hosted mode and regardless of whose
 * API key is paying for the call — the point is never sending a secret to
 * a third party by accident.
 */
export async function scanRepoForSecrets(repoRoot: string): Promise<number> {
  const files = await fg(SECRET_SCAN_GLOBS, {
    cwd: repoRoot,
    ignore: SECRET_SCAN_IGNORE,
    absolute: true,
    dot: true,
  });

  const counts = await Promise.all(
    files.map(async (file) => {
      try {
        const content = await readFile(file, 'utf8');
        return scanForSecrets(content).findings.length;
      } catch {
        return 0; // binary file the glob shouldn't have matched, or a race with a deleted file
      }
    })
  );

  return counts.reduce((total, count) => total + count, 0);
}
