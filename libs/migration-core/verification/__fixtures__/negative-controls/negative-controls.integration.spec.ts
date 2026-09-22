/**
 * Real, unmocked: scaffolds one real Angular workspace and actually runs
 * `tsc`/`ng test` against it for fixtures #1 and #2. This is the
 * milestone's own definition of done (m2-verification.md) — "the code
 * looks correct" is explicitly not sufficient. Deliberately excluded
 * from the default fast `vitest` suite (see vitest.config.mts's
 * `*.integration.spec.ts` exclude) — slow (a real `ng new`/npm install).
 *
 * Run explicitly via `vitest.integration.config.mts`, a separate config
 * dedicated to this file: Vitest's `exclude` applies even to a file named
 * explicitly on the CLI, so the same config can't both keep the default
 * suite fast and make this one file explicitly runnable — see that
 * config's own docstring. Intended to run via its own CI job
 * (`verification-negative-controls`, .github/workflows/ci.yml, not yet
 * wired up) gated to changes under the verification module, per
 * CLAUDE.md's requirement that this fixture directory runs in CI on every
 * such change, permanently.
 */
import { readFile, mkdir, mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scaffoldTargetWorkspace } from '../../../src/scaffold/index.js';
import { runVerificationGate } from '../../../src/verification/run-verification-gate.js';

const FIXTURES_DIR = join(import.meta.dirname);

describe('verification gate — negative controls', () => {
  let workspaceDir: string;

  beforeAll(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'm2-negative-controls-'));
    workspaceDir = join(parent, 'workspace');
    const result = await scaffoldTargetWorkspace({ outputDir: workspaceDir, appName: 'm2negctrl' });
    if (!result.success) throw new Error(`fixture setup: scaffold failed: ${result.stderr}`);
  }, 300_000);

  afterAll(async () => {
    if (workspaceDir) await rm(join(workspaceDir, '..'), { recursive: true, force: true });
  });

  it('#1 — a genuine tsc compile error is REJECTED', async () => {
    const targetDir = join(workspaceDir, 'src/app/negative-control-01');
    await mkdir(targetDir, { recursive: true });
    await cp(join(FIXTURES_DIR, '01-compile-error/broken.ts'), join(targetDir, 'broken.ts'));

    const result = await runVerificationGate({ workspaceDir, artifactType: 'service' });

    expect(result.tier).toBe('REJECTED');
    await rm(targetDir, { recursive: true, force: true });
  }, 120_000);

  it('#2 — a test written to fail is REJECTED', async () => {
    const targetDir = join(workspaceDir, 'src/app/negative-control-02');
    await mkdir(targetDir, { recursive: true });
    await cp(join(FIXTURES_DIR, '02-failing-test/module.ts'), join(targetDir, 'module.ts'));
    await cp(join(FIXTURES_DIR, '02-failing-test/module.spec.ts'), join(targetDir, 'module.spec.ts'));

    const result = await runVerificationGate({
      workspaceDir,
      artifactType: 'service',
      migratedSpecPath: 'src/app/negative-control-02/module.spec.ts',
    });

    expect(result.tier).toBe('REJECTED');
    await rm(targetDir, { recursive: true, force: true });
  }, 120_000);

  it('#3 — an engineered characterization mismatch is REJECTED', async () => {
    const originalSource = await readFile(join(FIXTURES_DIR, '03-characterization-mismatch/original.js'), 'utf8');
    const migratedSource = await readFile(join(FIXTURES_DIR, '03-characterization-mismatch/migrated.ts'), 'utf8');

    // Strip the fixture's leading `// ...` comment line, leaving a bare
    // function expression usable as `runCharacterization`'s function source.
    const extractFunction = (source: string) => source.replace(/^\/\/.*\n/, '').trim();

    // `runInSandbox` (sandbox-run.ts) runs function source through plain
    // Node `vm.Script`, never through `tsc` — it needs executable JS, not
    // TypeScript. `original.js` already is JS; `migrated.ts` deliberately
    // isn't (it's the "migrated" side of a real characterization target),
    // so its type annotations are stripped via the TypeScript compiler's
    // own transpiler rather than a hand-rolled regex.
    const stripTypes = (source: string) =>
      ts
        .transpileModule(source, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020 } })
        .outputText.replace(/^"use strict";\s*/, '')
        .trim();

    const result = await runVerificationGate({
      workspaceDir,
      artifactType: 'service',
      characterization: {
        artifactType: 'service',
        originalFunctionSource: extractFunction(originalSource),
        migratedFunctionSource: stripTypes(extractFunction(migratedSource)),
        parameterNames: ['price', 'taxRate'],
        parameterTypes: ['number', 'number'],
        callSiteArgLiterals: [[100, 0.2], [50, 0.1]],
      },
    });

    expect(result.tier).toBe('REJECTED');
  }, 60_000);
});
