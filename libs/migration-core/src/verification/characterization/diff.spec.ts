import { describe, expect, it } from 'vitest';
import { outcomesMatch } from './diff.js';

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
    expect(outcomesMatch({ type: 'return', value: 5 }, { type: 'throw', message: 'boom' })).toBe(false);
  });

  it('matches identical throw messages', () => {
    expect(outcomesMatch({ type: 'throw', message: 'boom' }, { type: 'throw', message: 'boom' })).toBe(true);
  });

  it('does not match different throw messages — a genuine behavioral difference', () => {
    expect(outcomesMatch({ type: 'throw', message: 'boom' }, { type: 'throw', message: 'bang' })).toBe(false);
  });

  it('matches nested arrays of objects regardless of inner key order', () => {
    const a = { type: 'return' as const, value: [{ a: 1, b: 2 }] };
    const b = { type: 'return' as const, value: [{ b: 2, a: 1 }] };
    expect(outcomesMatch(a, b)).toBe(true);
  });
});
