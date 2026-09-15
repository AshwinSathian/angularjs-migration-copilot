import { spawn } from 'node:child_process';
import type { CommandResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs `command` to completion and reports its outcome — never throws on a
 * non-zero exit, a spawn failure, or a timeout; all three come back as a
 * `CommandResult` with a non-zero `exitCode` and the reason in `stderr`, so
 * a hung `ng new` fails loudly instead of hanging the whole scaffold step
 * forever (docs/decisions.md — risk noted in PLAN-m0.5-scaffold.md).
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: options.cwd });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(
      () => {
        if (settled) return;
        stderr += `\n[timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms, process killed]`;
        child.kill();
      },
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ exitCode: exitCode ?? -1, stdout, stderr });
    });
  });
}
