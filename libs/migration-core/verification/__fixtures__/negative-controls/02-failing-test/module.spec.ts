// ...paired with a spec written to fail regardless of what module.ts does.
import { describe, expect, it } from 'vitest';
import { double } from './module';

describe('double', () => {
  it('is deliberately wrong — this spec exists to prove the gate rejects a real test failure', () => {
    expect(double(2)).toBe(999);
  });
});
