import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

function fakeChildProcess(exitCode: number) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => child.emit('close', exitCode));
  return child;
}

const { verifyWorkspaceBuilds } = await import('./verify-workspace-build.js');

describe('verifyWorkspaceBuilds', () => {
  it('runs ng build with cwd set to the workspace directory and reports success on exit 0', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChildProcess(0));

    const result = await verifyWorkspaceBuilds('/scratch/some-workspace');

    expect(spawnMock).toHaveBeenCalledWith('npx', ['ng', 'build'], {
      cwd: '/scratch/some-workspace',
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('reports failure when ng build exits non-zero', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChildProcess(1));

    const result = await verifyWorkspaceBuilds('/scratch/some-workspace');

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
