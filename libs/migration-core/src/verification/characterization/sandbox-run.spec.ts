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
    expect(result).toEqual({ type: 'throw', message: 'boom' });
  });

  it('returns objects and arrays intact', () => {
    const result = runInSandbox('function f(x) { return { doubled: x * 2, tag: [x] }; }', [3]);
    expect(result).toEqual({ type: 'return', value: { doubled: 6, tag: [3] } });
  });

  it('kills a function that runs longer than the timeout, reporting it as a throw outcome', () => {
    const result = runInSandbox('function f() { while (true) {} }', [], { timeoutMs: 50 });
    expect(result.type).toBe('throw');
  });
});
