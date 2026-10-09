import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCompileCheckMock = vi.fn();
const runExistingTestSuiteMock = vi.fn();
const runCharacterizationMock = vi.fn();
vi.mock('./check-compiles.js', () => ({ runCompileCheck: (...a: unknown[]) => runCompileCheckMock(...a) }));
vi.mock('./run-existing-tests.js', () => ({ runExistingTestSuite: (...a: unknown[]) => runExistingTestSuiteMock(...a) }));
vi.mock('./characterization/run-characterization.js', () => ({
  runCharacterization: (...a: unknown[]) => runCharacterizationMock(...a),
}));

const { runVerificationGate } = await import('./run-verification-gate.js');

describe('runVerificationGate', () => {
  // Each test's `.not.toHaveBeenCalled()` assertions only hold if these
  // mocks' call histories don't leak in from earlier tests in this file —
  // there's no global clearMocks/resetMocks in vitest.config.mts.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const target = {
    artifactType: 'service' as const,
    originalFunctionSource: 'function f(x) { return x; }',
    migratedFunctionSource: 'function f(x) { return x; }',
    parameterNames: ['x'],
    callSiteArgLiterals: [[1], [2]],
  };
  const compileFailed = { passed: false, log: 'error TS2322', failure: 'diagnostics', diagnostics: [{ file: 'a.ts', code: 'TS2322', message: 'm' }] };

  it('REJECTED with failedCheck "compile" when the compiler reports errors, never running the later checks', async () => {
    runCompileCheckMock.mockResolvedValue(compileFailed);

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'service', migratedSpecPath: 's.spec.ts', characterization: target });

    expect(result).toMatchObject({ tier: 'REJECTED', failedCheck: 'compile', compileLog: 'error TS2322' });
    expect(runExistingTestSuiteMock).not.toHaveBeenCalled();
    expect(runCharacterizationMock).not.toHaveBeenCalled();
  });

  it('REJECTED, with a reason that says so, when the compiler never ran', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: false, log: 'timed out', failure: 'could-not-run', diagnostics: [] });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'service' });

    expect(result).toMatchObject({ tier: 'REJECTED', failedCheck: 'compile' });
    if (result.tier === 'REJECTED') expect(result.reason).toMatch(/could not run/);
  });

  it('REJECTED with failedCheck "tests" when the supplied spec fails, never falling through to characterization', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runExistingTestSuiteMock.mockResolvedValue({ passed: false, log: 'expected 1 to be 2' });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'service', migratedSpecPath: 's.spec.ts', characterization: target });

    expect(result).toMatchObject({ tier: 'REJECTED', failedCheck: 'tests', testLog: 'expected 1 to be 2' });
    expect(runCharacterizationMock).not.toHaveBeenCalled();
  });

  it('a passing supplied spec does not raise the tier: LOW without characterization (ADR-060)', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runExistingTestSuiteMock.mockResolvedValue({ passed: true, log: '2 passed' });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'service', migratedSpecPath: 's.spec.ts' });

    expect(result).toMatchObject({ tier: 'LOW', testLog: '2 passed' });
  });

  it('MEDIUM only when it compiles and characterization matched', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runCharacterizationMock.mockReturnValue({ eligible: true, matched: true, casesRun: 4 });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'service', characterization: target });

    expect(result).toMatchObject({ tier: 'MEDIUM', characterization: { casesRun: 4 } });
    expect(runCharacterizationMock).toHaveBeenCalledWith(target);
  });

  it('REJECTED with failedCheck "characterization" on a diff mismatch, carrying the mismatch', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    const mismatch = { input: [1], original: { type: 'return', value: 1 }, migrated: { type: 'return', value: 2 } };
    runCharacterizationMock.mockReturnValue({ eligible: true, matched: false, mismatch });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'service', characterization: target });

    expect(result).toMatchObject({ tier: 'REJECTED', failedCheck: 'characterization', characterization: { mismatch } });
  });

  it('LOW, with the ineligibility reason, when characterization cannot verify the pair (ADR-059)', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runCharacterizationMock.mockReturnValue({ eligible: false, reason: 'references $scope' });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'controller', characterization: target });

    expect(result.tier).toBe('LOW');
    if (result.tier === 'LOW') expect(result.reason).toMatch(/references \$scope/);
  });

  it('LOW when it compiles and there is nothing to verify behaviour with — never MEDIUM by default', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'controller' });

    expect(result).toMatchObject({ tier: 'LOW', reason: 'no characterization target' });
    expect(runCharacterizationMock).not.toHaveBeenCalled();
  });

  it('every result carries the input artifactType through unchanged', async () => {
    runCompileCheckMock.mockResolvedValue(compileFailed);
    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'directive' });
    expect(result.artifactType).toBe('directive');
  });
});
