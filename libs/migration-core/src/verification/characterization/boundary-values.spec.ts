import { describe, expect, it } from 'vitest';
import { generateBoundaryValueRows } from './boundary-values.js';

describe('generateBoundaryValueRows', () => {
  it('returns no rows when every parameter type is unknown', () => {
    expect(generateBoundaryValueRows([undefined, undefined])).toEqual([]);
  });

  it('varies one string parameter through its boundary set, holding a second unknown-typed parameter at a placeholder', () => {
    const rows = generateBoundaryValueRows(['string', undefined]);
    expect(rows).toContainEqual(['', undefined]);
    expect(rows.some((r) => typeof r[0] === 'string' && r[0].length > 0)).toBe(true);
  });

  it('covers number boundaries: zero, a positive, a negative', () => {
    const rows = generateBoundaryValueRows(['number']);
    const values = rows.map((r) => r[0]);
    expect(values).toContain(0);
    expect(values.some((v) => typeof v === 'number' && v > 0)).toBe(true);
    expect(values.some((v) => typeof v === 'number' && v < 0)).toBe(true);
  });

  it('covers boolean boundaries: both values', () => {
    const rows = generateBoundaryValueRows(['boolean']);
    expect(rows.map((r) => r[0])).toEqual(expect.arrayContaining([true, false]));
  });

  it('covers array boundaries: empty and one populated', () => {
    const rows = generateBoundaryValueRows(['array']);
    const values = rows.map((r) => r[0]);
    expect(values).toContainEqual([]);
    expect(values.some((v) => Array.isArray(v) && v.length > 0)).toBe(true);
  });

  it('covers object boundaries: empty and one populated', () => {
    const rows = generateBoundaryValueRows(['object']);
    const values = rows.map((r) => r[0]);
    expect(values).toContainEqual({});
    expect(values.some((v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0)).toBe(true);
  });

  it('holds sibling typed parameters at a populated default while varying the target parameter', () => {
    const rows = generateBoundaryValueRows(['number', 'string']);
    // every row's second (string) slot is a real string, not undefined, since it has a known type
    for (const row of rows) {
      expect(typeof row[1]).toBe('string');
    }
  });
});
