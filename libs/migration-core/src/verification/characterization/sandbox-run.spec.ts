import { describe, expect, it } from 'vitest';
import { runInSandbox } from './sandbox-run.js';

describe('runInSandbox', () => {
  it('returns the function result for a normal call', () => {
    const result = runInSandbox('function add(a, b) { return a + b; }', [2, 3]);
    expect(result).toEqual({ type: 'return', value: 5 });
  });

  it('supports arrow function source', () => {
    const result = runInSandbox('(a, b) => a * b', [4, 5]);
    expect(result).toEqual({ type: 'return', value: 20 });
  });

  it('captures a thrown error as a throw outcome, not a JS exception out of this function', () => {
    const result = runInSandbox('function f() { throw new Error("boom"); }', []);
    expect(result).toEqual({ type: 'throw', name: 'Error', message: 'boom' });
  });

  it('returns objects and arrays intact', () => {
    const result = runInSandbox('function f(x) { return { doubled: x * 2, tag: [x] }; }', [3]);
    expect(result).toEqual({ type: 'return', value: { doubled: 6, tag: [3] } });
  });

  it('kills a function that runs longer than the timeout, reporting it as unrunnable', () => {
    const result = runInSandbox('function f() { while (true) {} }', [], { timeoutMs: 50 });
    expect(result.type).toBe('unrunnable');
  });

  it('preserves error messages that themselves start with "Error: " — regression for unsafe prefix-strip', () => {
    const result = runInSandbox('function f() { throw new Error("Error: something specific"); }', []);
    expect(result).toEqual({ type: 'throw', name: 'Error', message: 'Error: something specific' });
  });

  it('runs TypeScript source by stripping its types (ADR-054)', () => {
    expect(runInSandbox('function f(x: number): number { return x + 1; }', [1])).toEqual({ type: 'return', value: 2 });
  });

  it('reports a syntax error as unrunnable instead of throwing out of this function', () => {
    expect(runInSandbox('function broken( {{{', []).type).toBe('unrunnable');
  });

  it('reports an unresolved free variable as unrunnable, not as a throw the other side could "match"', () => {
    expect(runInSandbox('function f(x) { return helper(x); }', [1]).type).toBe('unrunnable');
  });

  it('keeps a real runtime error as a throw, with its name', () => {
    expect(runInSandbox('function f(x) { return x.length; }', [null])).toMatchObject({ type: 'throw', name: 'TypeError' });
  });

  it('gives each run its own copy of the arguments', () => {
    const args = [[3, 1, 2]];
    runInSandbox('function f(a) { a.sort(); return a; }', args);
    expect(args).toEqual([[3, 1, 2]]);
  });
});
