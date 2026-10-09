/**
 * Real, unmocked: scaffolds one Angular workspace and runs the real
 * Angular compiler and test runner against it. See README.md for what
 * each control proves. Excluded from the default fast suite; run via
 * `vitest.integration.config.mts` and the `verification-negative-controls`
 * CI job.
 */
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCommand, scaffoldTargetWorkspace } from '../../../src/scaffold/index.js';
import { runVerificationGate } from '../../../src/verification/run-verification-gate.js';
import type { CharacterizationTarget } from '../../../src/verification/types.js';

const FIXTURES_DIR = import.meta.dirname;
/** Strips the fixture's leading `// ...` comment line, leaving a bare function expression. */
const functionSource = async (relativePath: string) =>
  (await readFile(join(FIXTURES_DIR, relativePath), 'utf8')).replace(/^\/\/.*\n/, '').trim();

describe('verification gate — real controls', () => {
  let workspaceDir: string;
  let plantedDir: string;

  const plant = async (...fixturePaths: string[]) => {
    await mkdir(plantedDir, { recursive: true });
    for (const path of fixturePaths) {
      await cp(join(FIXTURES_DIR, path), join(plantedDir, path.split('/').pop() as string));
    }
  };

  beforeAll(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'm2-controls-'));
    workspaceDir = join(parent, 'workspace');
    plantedDir = join(workspaceDir, 'src/app/planted');
    const result = await scaffoldTargetWorkspace({ outputDir: workspaceDir, appName: 'm2controls' });
    if (!result.success) throw new Error(`fixture setup: scaffold failed: ${result.stderr}`);
  }, 300_000);

  afterEach(async () => {
    await rm(plantedDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (workspaceDir) await rm(join(workspaceDir, '..'), { recursive: true, force: true });
  });

  const matchingTarget = async (): Promise<CharacterizationTarget> => ({
    artifactType: 'service',
    originalFunctionSource: await functionSource('03-characterization-mismatch/original.js'),
    migratedFunctionSource: 'function priceWithTax(price: number, taxRate: number): number { return price * (1 + taxRate); }',
    parameterNames: ['price', 'taxRate'],
    parameterTypes: ['number', 'number'],
    callSiteArgLiterals: [[100, 0.2], [50, 0.1]],
  });

  describe('positive controls', () => {
    it('an untouched workspace compiles: LOW, nothing to verify behaviour with', async () => {
      const result = await runVerificationGate({ workspaceDir, artifactType: 'service' });
      expect(result).toMatchObject({ tier: 'LOW', reason: 'no characterization target' });
    }, 120_000);

    it('compiles and characterization matches: MEDIUM', async () => {
      const result = await runVerificationGate({ workspaceDir, artifactType: 'service', characterization: await matchingTarget() });
      expect(result.tier).toBe('MEDIUM');
      if (result.tier === 'MEDIUM') expect(result.characterization.casesRun).toBeGreaterThanOrEqual(2);
    }, 120_000);

    it('a passing supplied spec really ran, and does not raise the tier', async () => {
      const result = await runVerificationGate({ workspaceDir, artifactType: 'service', migratedSpecPath: 'src/app/app.spec.ts' });
      expect(result.tier).toBe('LOW');
      expect(result.testLog).toMatch(/\d+ passed/);
    }, 120_000);
  });

  describe('negative controls', () => {
    it('#1 — a genuine compile error is REJECTED by the compile check, naming the file and TS2322', async () => {
      await plant('01-compile-error/broken.ts');

      const result = await runVerificationGate({ workspaceDir, artifactType: 'service', characterization: await matchingTarget() });

      expect(result).toMatchObject({ tier: 'REJECTED', failedCheck: 'compile' });
      expect(result.compileLog).toMatch(/planted\/broken\.ts/);
      expect(result.compileLog).toMatch(/TS2322/);
    }, 120_000);

    it('#2 — a test written to fail is REJECTED by the test check, with the assertion in the log', async () => {
      await plant('02-failing-test/module.ts', '02-failing-test/module.spec.ts');

      const result = await runVerificationGate({
        workspaceDir,
        artifactType: 'service',
        migratedSpecPath: 'src/app/planted/module.spec.ts',
        characterization: await matchingTarget(),
      });

      expect(result).toMatchObject({ tier: 'REJECTED', failedCheck: 'tests' });
      expect(result.testLog).toMatch(/expected 4 to be 999/);
    }, 120_000);

    it('#3 — an engineered characterization mismatch is REJECTED by the diff, with both outcomes', async () => {
      const result = await runVerificationGate({
        workspaceDir,
        artifactType: 'service',
        characterization: {
          ...(await matchingTarget()),
          migratedFunctionSource: await functionSource('03-characterization-mismatch/migrated.ts'),
        },
      });

      expect(result).toMatchObject({
        tier: 'REJECTED',
        failedCheck: 'characterization',
        characterization: {
          mismatch: { input: [100, 0.2], original: { type: 'return', value: 120 }, migrated: { type: 'return', value: 100.2 } },
        },
      });
    }, 120_000);

    it('#4 — an Angular-only error bare tsc accepts is REJECTED by the compile check, naming NG2003', async () => {
      await plant('04-angular-only-error/untyped-di.pipe.ts');

      // The premise of this control, checked rather than assumed: plain tsc is happy with the file.
      const tsc = await runCommand('npx', ['--no-install', 'tsc', '-p', 'tsconfig.app.json', '--noEmit'], { cwd: workspaceDir });
      expect(tsc.exitCode).toBe(0);

      const result = await runVerificationGate({ workspaceDir, artifactType: 'filter', characterization: await matchingTarget() });

      expect(result).toMatchObject({ tier: 'REJECTED', failedCheck: 'compile' });
      expect(result.compileLog).toMatch(/NG2003/);
    }, 120_000);
  });

  describe('false-accept regressions (ADR-057) — LOW, never MEDIUM', () => {
    it.each([
      [
        'a filter factory returning a closure (blur-admin appImage.js), migrated to return something else',
        'function appImage(layoutPaths) { return function (input) { return layoutPaths.images.root + input; }; }',
        'function appImage(layoutPaths) { return function (input) { return "WRONG" + input; }; }',
        ['object'] as const,
      ],
      [
        'both sides calling a helper neither can reach',
        'function f(x) { return x * 2; }',
        'function f(x) { return helper(x) * 999; }',
        ['number'] as const,
      ],
    ])('%s', async (_label, originalFunctionSource, migratedFunctionSource, parameterTypes) => {
      const result = await runVerificationGate({
        workspaceDir,
        artifactType: 'filter',
        characterization: {
          artifactType: 'filter',
          originalFunctionSource,
          migratedFunctionSource,
          parameterNames: ['p'],
          parameterTypes,
          callSiteArgLiterals: [],
        },
      });
      expect(result.tier).toBe('LOW');
    }, 120_000);
  });
});
