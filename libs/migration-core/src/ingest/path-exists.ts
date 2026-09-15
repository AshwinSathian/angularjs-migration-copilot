import { access } from 'node:fs/promises';

/** Whether `path` exists, without distinguishing "not found" from any other `fs.access` failure. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
