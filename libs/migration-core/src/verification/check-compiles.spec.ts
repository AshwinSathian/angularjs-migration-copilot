import { describe, expect, it, vi } from 'vitest';

const runCommandMock = vi.fn();
vi.mock('../scaffold/index.js', () => ({ runCommand: (...args: unknown[]) => runCommandMock(...args) }));

const { runCompileCheck } = await import('./check-compiles.js');

describe('runCompileCheck', () => {
  it('runs tsc --noEmit against the app tsconfig, cwd set to the workspace', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await runCompileCheck('/ws');

    expect(runCommandMock).toHaveBeenCalledWith(
      'npx',
      ['tsc', '-p', 'tsconfig.app.json', '--noEmit'],
      { cwd: '/ws' }
    );
  });

  it('accepts a non-default app tsconfig path', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await runCompileCheck('/ws', 'tsconfig.custom.json');

    expect(runCommandMock).toHaveBeenCalledWith(
      'npx',
      ['tsc', '-p', 'tsconfig.custom.json', '--noEmit'],
      { cwd: '/ws' }
    );
  });

  it('passed is true on a zero exit code', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const result = await runCompileCheck('/ws');
    expect(result.passed).toBe(true);
  });

  it('passed is false and log carries stderr on a non-zero exit code', async () => {
    runCommandMock.mockResolvedValue({
      exitCode: 2,
      stdout: '',
      stderr: `src/app/broken.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
    });
    const result = await runCompileCheck('/ws');
    expect(result.passed).toBe(false);
    expect(result.log).toContain('TS2322');
  });

  it('log includes both stdout and stderr — tsc puts diagnostics on stdout, not stderr', async () => {
    runCommandMock.mockResolvedValue({
      exitCode: 2,
      stdout: `src/app/broken.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
      stderr: '',
    });
    const result = await runCompileCheck('/ws');
    expect(result.log).toContain('TS2322');
  });
});
