import { spawn, type ChildProcess } from 'node:child_process';
import type { CommandResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const KILL_GRACE_MS = 5_000;

/**
 * Sends `signal` to the whole process tree rooted at `child`, not just
 * `child` itself. `npx ng new`'s real work happens in grandchildren (`npm
 * install`, `ng`'s own child processes) that a plain `child.kill()` never
 * reaches — on POSIX, spawning detached makes `child` a process-group
 * leader, so `-child.pid` targets the whole group. Falls back to a direct
 * kill if that fails (not a group leader) or on Windows (no process
 * groups; `detached` there just means "no console").
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // not a process-group leader (or already dead) — fall through
    }
  }
  child.kill(signal);
}

/**
 * Runs `command` to completion and reports its outcome — never throws on a
 * non-zero exit, a spawn failure, or a timeout; all three come back as a
 * `CommandResult` with a non-zero `exitCode` and the reason in `stderr`
 * (and `reason` for the first two). A timeout escalates from SIGTERM to
 * SIGKILL after a grace period, and targets the whole process tree, so a
 * child that ignores SIGTERM (or a grandchild `npm install`) doesn't leave
 * the promise hanging forever.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      stderr += `\n[timed out after ${timeoutMs}ms, sending SIGTERM]`;
      killProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (settled) return;
        stderr += `\n[still running ${KILL_GRACE_MS}ms after SIGTERM, sending SIGKILL]`;
        killProcessTree(child, 'SIGKILL');
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settle({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}`, reason: 'spawn-error' });
    });

    child.on('close', (exitCode) => {
      settle({
        exitCode: exitCode ?? -1,
        stdout,
        stderr,
        ...(timedOut ? { reason: 'timeout' as const } : {}),
      });
    });
  });
}
