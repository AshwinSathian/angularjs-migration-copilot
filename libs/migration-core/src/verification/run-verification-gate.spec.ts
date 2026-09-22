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

  it('REJECTED when clause 1 (compile) fails, never running clause 2 or 3', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: false, log: 'TS2322' });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'service' });

    expect(result.tier).toBe('REJECTED');
    expect(runExistingTestSuiteMock).not.toHaveBeenCalled();
    expect(runCharacterizationMock).not.toHaveBeenCalled();
  });

  it('HIGH when clause 1 passes and a migrated spec is given and it passes', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runExistingTestSuiteMock.mockResolvedValue({ passed: true, log: '2 passed' });

    const result = await runVerificationGate({
      workspaceDir: '/ws',
      artifactType: 'service',
      migratedSpecPath: 'src/app/foo.spec.ts',
    });

    expect(result.tier).toBe('HIGH');
    expect(runCharacterizationMock).not.toHaveBeenCalled();
  });

  it('REJECTED when clause 1 passes but the given migrated spec fails — never falls through to clause 3', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runExistingTestSuiteMock.mockResolvedValue({ passed: false, log: 'expected 1 to be 2' });

    const result = await runVerificationGate({
      workspaceDir: '/ws',
      artifactType: 'service',
      migratedSpecPath: 'src/app/foo.spec.ts',
    });

    expect(result.tier).toBe('REJECTED');
    expect(runCharacterizationMock).not.toHaveBeenCalled();
  });

  it('MEDIUM when clause 1 passes, no spec is given, and characterization matches', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runCharacterizationMock.mockReturnValue({ eligible: true, matched: true, casesRun: 4 });

    const result = await runVerificationGate({
      workspaceDir: '/ws',
      artifactType: 'service',
      characterization: {
        artifactType: 'service',
        originalFunctionSource: 'function f(x) { return x; }',
        migratedFunctionSource: 'function f(x) { return x; }',
        parameterNames: ['x'],
        callSiteArgLiterals: [[1], [2]],
      },
    });

    expect(result.tier).toBe('MEDIUM');
    expect(runExistingTestSuiteMock).not.toHaveBeenCalled();
  });

  it('REJECTED when characterization finds a mismatch', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runCharacterizationMock.mockReturnValue({
      eligible: true,
      matched: false,
      mismatch: { input: [1], original: { type: 'return', value: 1 }, migrated: { type: 'return', value: 2 } },
    });

    const result = await runVerificationGate({
      workspaceDir: '/ws',
      artifactType: 'service',
      characterization: {
        artifactType: 'service',
        originalFunctionSource: 'function f(x) { return x; }',
        migratedFunctionSource: 'function f(x) { return x + 1; }',
        parameterNames: ['x'],
        callSiteArgLiterals: [[1], [2]],
      },
    });

    expect(result.tier).toBe('REJECTED');
  });

  it('REJECTED when characterization is ineligible — an unverifiable patch is never silently accepted', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });
    runCharacterizationMock.mockReturnValue({ eligible: false, reason: 'references $scope' });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'controller' });

    expect(result.tier).toBe('REJECTED');
  });

  it('REJECTED when no spec and no characterization target are given at all', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: true, log: '' });

    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'controller' });

    expect(result.tier).toBe('REJECTED');
    expect(runCharacterizationMock).not.toHaveBeenCalled();
  });

  it('every result carries the input artifactType through unchanged', async () => {
    runCompileCheckMock.mockResolvedValue({ passed: false, log: '' });
    const result = await runVerificationGate({ workspaceDir: '/ws', artifactType: 'directive' });
    expect(result.artifactType).toBe('directive');
  });
});
