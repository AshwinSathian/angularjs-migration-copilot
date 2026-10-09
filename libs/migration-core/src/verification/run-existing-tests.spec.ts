import { describe, expect, it, vi } from 'vitest';

const runCommandMock = vi.fn();
vi.mock('../scaffold/index.js', () => ({ runCommand: (...args: unknown[]) => runCommandMock(...args) }));

const { runExistingTestSuite } = await import('./run-existing-tests.js');

describe('runExistingTestSuite', () => {
  it('runs ng test scoped to the one migrated spec, watch disabled', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await runExistingTestSuite('/ws', 'src/app/foo.spec.ts');

    expect(runCommandMock).toHaveBeenCalledWith(
      'npx',
      ['ng', 'test', '--watch=false', '--include', 'src/app/foo.spec.ts'],
      { cwd: '/ws' }
    );
  });

  it('passed is true on a zero exit code', async () => {
    runCommandMock.mockResolvedValue({ exitCode: 0, stdout: 'Tests  2 passed (2)', stderr: '' });
    const result = await runExistingTestSuite('/ws', 'src/app/foo.spec.ts');
    expect(result.passed).toBe(true);
  });

  it('passed is false on a non-zero exit code, and log carries the failure output', async () => {
    runCommandMock.mockResolvedValue({
      exitCode: 1,
      stdout: 'FAIL src/app/foo.spec.ts\nexpected 1 to be 2',
      stderr: '',
    });
    const result = await runExistingTestSuite('/ws', 'src/app/foo.spec.ts');
    expect(result.passed).toBe(false);
    expect(result.log).toContain('expected 1 to be 2');
  });
});
