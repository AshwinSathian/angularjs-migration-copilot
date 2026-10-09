import { describe, expect, it, vi } from 'vitest';

const runCommandMock = vi.fn();
vi.mock('../scaffold/index.js', () => ({ runCommand: (...args: unknown[]) => runCommandMock(...args) }));

const { runCompileCheck } = await import('./check-compiles.js');

describe('runCompileCheck', () => {
  it('runs ngc --noEmit against the app tsconfig, cwd set to the workspace', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await runCompileCheck('/ws');

    expect(runCommandMock).toHaveBeenCalledWith(
      'npx',
      ['--no-install', 'ngc', '-p', 'tsconfig.app.json', '--noEmit'],
      { cwd: '/ws' }
    );
  });

  it('accepts a non-default app tsconfig path', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await runCompileCheck('/ws', 'tsconfig.custom.json');

    expect(runCommandMock).toHaveBeenCalledWith(
      'npx',
      ['--no-install', 'ngc', '-p', 'tsconfig.custom.json', '--noEmit'],
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

  it('parses ngc\'s coloured diagnostics into file/code/message and labels the failure "diagnostics"', async () => {
    runCommandMock.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        "\u001b[96msrc/app/p.ts\u001b[0m:\u001b[93m5\u001b[0m:\u001b[93m23\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m NG2003: \u001b[0mNo suitable injection token for parameter 'a' of class 'P'.\n",
    });
    const result = await runCompileCheck('/ws');
    expect(result).toMatchObject({
      passed: false,
      failure: 'diagnostics',
      diagnostics: [{ file: 'src/app/p.ts', code: 'NG2003' }],
    });
  });

  it('parses tsc\'s plain diagnostic form too', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 2, stdout: "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", stderr: '' });
    const result = await runCompileCheck('/ws');
    expect(result).toMatchObject({ failure: 'diagnostics', diagnostics: [{ file: 'src/a.ts', code: 'TS2322' }] });
  });

  it.each([
    ['a timeout', { exitCode: -1, stdout: '', stderr: 'error TS1: x', reason: 'timeout' }],
    ['a spawn failure', { exitCode: -1, stdout: '', stderr: 'spawn npx ENOENT', reason: 'spawn-error' }],
    ['a non-zero exit with no diagnostic (ngc not installed)', { exitCode: 1, stdout: '', stderr: 'npm error could not determine executable to run' }],
  ])('labels %s "could-not-run", never "diagnostics" — still failed', async (_label, commandResult) => {
    runCommandMock.mockResolvedValue(commandResult);
    const result = await runCompileCheck('/ws');
    expect(result).toMatchObject({ passed: false, failure: 'could-not-run', diagnostics: [] });
  });
});
