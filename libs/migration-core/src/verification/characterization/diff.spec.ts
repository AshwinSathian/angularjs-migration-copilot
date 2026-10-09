import { describe, expect, it } from 'vitest';
import { outcomesMatch } from './diff.js';
import { runInSandbox } from './sandbox-run.js';

describe('outcomesMatch', () => {
  it('matches identical return values', () => {
    expect(outcomesMatch({ type: 'return', value: 5 }, { type: 'return', value: 5 })).toBe(true);
  });

  it('does not match different return values', () => {
    expect(outcomesMatch({ type: 'return', value: 5 }, { type: 'return', value: 6 })).toBe(false);
  });

  it('tolerates object key ordering differences', () => {
    const a = { type: 'return' as const, value: { x: 1, y: 2 } };
    const b = { type: 'return' as const, value: { y: 2, x: 1 } };
    expect(outcomesMatch(a, b)).toBe(true);
  });

  it('tolerates Date-serialization differences between equivalent instants', () => {
    const a = { type: 'return' as const, value: new Date('2026-01-01T00:00:00.000Z') };
    const b = { type: 'return' as const, value: new Date('2026-01-01T00:00:00.000Z') };
    expect(outcomesMatch(a, b)).toBe(true);
  });

  it('does not match a return outcome against a throw outcome', () => {
    expect(outcomesMatch({ type: 'return', value: 5 }, { type: 'throw', name: 'Error', message: 'boom' })).toBe(false);
  });

  it('matches identical throw messages', () => {
    expect(outcomesMatch({ type: 'throw', name: 'Error', message: 'boom' }, { type: 'throw', name: 'Error', message: 'boom' })).toBe(true);
  });

  it('does not match different throw messages — a genuine behavioral difference', () => {
    expect(outcomesMatch({ type: 'throw', name: 'Error', message: 'boom' }, { type: 'throw', name: 'Error', message: 'bang' })).toBe(false);
  });

  it('matches nested arrays of objects regardless of inner key order', () => {
    const a = { type: 'return' as const, value: [{ a: 1, b: 2 }] };
    const b = { type: 'return' as const, value: [{ b: 2, a: 1 }] };
    expect(outcomesMatch(a, b)).toBe(true);
  });

  // ADR-057 regressions. Values come out of a vm context, as they do in production.
  const ret = (source: string) => runInSandbox(`function () { return ${source}; }`, []);

  it.each([
    ['two different Dates', 'new Date(0)', 'new Date(86400000)'],
    ['two different Maps', 'new Map([[1, 1]])', 'new Map([[2, 2]])'],
    ['two different Sets', 'new Set([1])', 'new Set([2])'],
    ['NaN and null', 'NaN', 'null'],
    ['undefined and null', 'undefined', 'null'],
    ['a missing key and an undefined-valued key', '{}', '{ a: undefined }'],
    ['0 and -0', '0', '-0'],
    ['Infinity and null', 'Infinity', 'null'],
    ['an array and an array-shaped object', '[1]', '{ 0: 1 }'],
    ['a string and a String object', '"a"', 'new String("a")'],
    ['two different RegExps', '/a/', '/b/'],
  ])('does not match %s', (_label, a, b) => {
    expect(outcomesMatch(ret(a), ret(b))).toBe(false);
  });

  it.each([
    ['equal Dates', 'new Date(5)'],
    ['an invalid Date', 'new Date(NaN)'],
    ['NaN', 'NaN'],
    ['undefined', 'undefined'],
    ['a nested Map', '({ m: new Map([["k", [1, { z: 1, a: 2 }]]]) })'],
  ])('matches %s against itself across two runs', (_label, source) => {
    expect(outcomesMatch(ret(source), ret(source))).toBe(true);
  });

  it.each([
    ['functions', 'function () { return 1; }'],
    ['promises', 'Promise.resolve(1)'],
    ['class instances', 'new (class Money { constructor() { this.v = 1; } })()'],
    ['symbols', 'Symbol("s")'],
    ['cyclic structures', '(() => { const o = {}; o.self = o; return o; })()'],
  ])('never matches %s, even against an identical run — no faithful structural form', (_label, source) => {
    expect(outcomesMatch(ret(source), ret(source))).toBe(false);
  });

  it('never matches two unrunnable outcomes', () => {
    const a = { type: 'unrunnable' as const, message: 'ReferenceError: helper is not defined' };
    expect(outcomesMatch(a, a)).toBe(false);
  });

  it('does not match throws that differ only by error type', () => {
    expect(
      outcomesMatch({ type: 'throw', name: 'TypeError', message: 'x' }, { type: 'throw', name: 'RangeError', message: 'x' })
    ).toBe(false);
  });
});
