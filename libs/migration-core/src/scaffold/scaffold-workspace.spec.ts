import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { readdirMock } = vi.hoisted(() => ({ readdirMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  readdirMock.mockImplementation(actual.readdir as (...args: unknown[]) => unknown);
  return { ...actual, readdir: (...args: Parameters<typeof actual.readdir>) => readdirMock(...args) };
});

function fakeChildProcess(exitCode: number) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => child.emit('close', exitCode));
  return child;
}

const { scaffoldTargetWorkspace } = await import('./scaffold-workspace.js');

describe('scaffoldTargetWorkspace', () => {
  let outputDir: string;

  beforeEach(async () => {
    spawnMock.mockReset();
    outputDir = await mkdtemp(join(tmpdir(), 'migration-core-scaffold-'));
    await rm(outputDir, { recursive: true, force: true }); // exists-but-empty and missing are both valid starting states
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('invokes the pinned Angular CLI version via npx with the given app name and output directory', async () => {
    spawnMock.mockImplementation(() => fakeChildProcess(0));

    const result = await scaffoldTargetWorkspace({ outputDir, appName: 'demo-app' });

    const parentDir = dirname(outputDir);
    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      [
        '--yes',
        '@angular/cli@22.1.8',
        'new',
        'demo-app',
        '--directory',
        basename(outputDir),
        '--skip-git',
        '--package-manager',
        'npm',
        '--defaults',
      ],
      expect.objectContaining({ cwd: parentDir })
    );
    expect(result.success).toBe(true);
    expect(result.angularCliVersion).toBe('22.1.8');
  });

  it('honors an explicit angularCliVersion override', async () => {
    spawnMock.mockImplementation(() => fakeChildProcess(0));

    const result = await scaffoldTargetWorkspace({
      outputDir,
      appName: 'demo-app',
      angularCliVersion: '21.2.0',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['@angular/cli@21.2.0']),
      expect.objectContaining({ cwd: dirname(outputDir) })
    );
    expect(result.angularCliVersion).toBe('21.2.0');
  });

  it('reports failure when the Angular CLI exits non-zero', async () => {
    spawnMock.mockImplementation(() => fakeChildProcess(1));

    const result = await scaffoldTargetWorkspace({ outputDir, appName: 'demo-app' });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('refuses to scaffold into a non-empty directory, without spawning anything', async () => {
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'existing-file.txt'), 'do not overwrite me');

    const result = await scaffoldTargetWorkspace({ outputDir, appName: 'demo-app' });

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('non-empty directory');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a relative outputDir before touching the filesystem or spawning anything', async () => {
    const result = await scaffoldTargetWorkspace({ outputDir: 'relative/path', appName: 'demo-app' });

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('absolute path');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects an appName starting with "-", closing the ng-new flag-injection vector', async () => {
    const result = await scaffoldTargetWorkspace({ outputDir, appName: '--malicious-flag' });

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('appName');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a non-exact-semver angularCliVersion, closing the npm alias-injection vector', async () => {
    const result = await scaffoldTargetWorkspace({
      outputDir,
      appName: 'demo-app',
      angularCliVersion: 'npm:cowsay@1.6.0',
    });

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('angularCliVersion');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports failure instead of throwing when the output directory cannot be inspected', async () => {
    readdirMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    });

    const result = await scaffoldTargetWorkspace({ outputDir, appName: 'demo-app' });

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('cannot prepare output directory');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
