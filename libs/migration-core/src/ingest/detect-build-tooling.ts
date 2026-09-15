import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildTool } from './types.js';

const CANDIDATES: ReadonlyArray<{ files: readonly string[]; tool: BuildTool }> = [
  { files: ['webpack.config.js', 'webpack.config.cjs'], tool: 'webpack' },
  { files: ['gulpfile.js'], tool: 'gulp' },
  { files: ['Gruntfile.js', 'gruntfile.js'], tool: 'grunt' },
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects build tooling by config file presence. Checked in this order —
 * webpack before gulp/grunt — because a repo mid-migration toward a modern
 * bundler can still have a leftover Gulpfile it no longer actually uses.
 */
export async function detectBuildTooling(repoRoot: string): Promise<BuildTool> {
  for (const { files, tool } of CANDIDATES) {
    for (const file of files) {
      if (await exists(join(repoRoot, file))) return tool;
    }
  }
  return 'none';
}
