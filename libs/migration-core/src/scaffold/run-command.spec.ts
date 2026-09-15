import { describe, expect, it } from 'vitest';
import { runCommand } from './run-command.js';

describe('runCommand', () => {
  it('resolves with exit code 0 and captured stdout on success', async () => {
    const result = await runCommand('node', ['-e', "process.stdout.write('hi')"]);
    expect(result).toEqual({ exitCode: 0, stdout: 'hi', stderr: '' });
  });

  it('resolves with a non-zero exit code and captured stderr on failure, without throwing', async () => {
    const result = await runCommand('node', [
      '-e',
      "process.stderr.write('boom'); process.exit(2)",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('boom');
  });

  it('resolves rather than rejects when the command does not exist', async () => {
    const result = await runCommand('this-command-does-not-exist', []);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('ENOENT');
  });

  it('kills the process and resolves on timeout instead of hanging forever', async () => {
    const result = await runCommand('node', ['-e', 'setTimeout(() => {}, 60_000)'], {
      timeoutMs: 50,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('timed out');
  }, 5000);
});
