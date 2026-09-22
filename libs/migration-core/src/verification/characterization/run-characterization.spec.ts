import { describe, expect, it } from 'vitest';
import { runCharacterization } from './run-characterization.js';
import type { CharacterizationTarget } from '../types.js';

const baseTarget: CharacterizationTarget = {
  artifactType: 'service',
  originalFunctionSource: 'function double(x) { return x * 2; }',
  migratedFunctionSource: 'function double(x) { return x * 2; }',
  parameterNames: ['x'],
  parameterTypes: ['number'],
  callSiteArgLiterals: [[3], [4]],
};

describe('runCharacterization', () => {
  it('is ineligible when the original function fails the §6.5 static checks', () => {
    const target: CharacterizationTarget = {
      ...baseTarget,
      originalFunctionSource: 'function double(x) { return $scope.x * 2; }',
    };
    const result = runCharacterization(target);
    expect(result.eligible).toBe(false);
  });

  it('is ineligible when there are fewer than two call-site examples and no inferable parameter types', () => {
    const target: CharacterizationTarget = {
      ...baseTarget,
      parameterTypes: undefined,
      callSiteArgLiterals: [[3]],
    };
    const result = runCharacterization(target);
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/fewer than two/);
  });

  it('matches when original and migrated behave identically across every generated input', () => {
    const result = runCharacterization(baseTarget);
    expect(result).toMatchObject({ eligible: true, matched: true });
  });

  it('reports a mismatch, with the exact offending input and both outcomes, when behavior diverges', () => {
    const target: CharacterizationTarget = {
      ...baseTarget,
      migratedFunctionSource: 'function double(x) { return x * 3; }', // engineered bug
    };
    const result = runCharacterization(target);
    expect(result.eligible).toBe(true);
    if (result.eligible && !result.matched) {
      expect(result.mismatch.original).toEqual({ type: 'return', value: 6 });
      expect(result.mismatch.migrated).toEqual({ type: 'return', value: 9 });
    } else {
      throw new Error('expected a mismatch');
    }
  });

  it('two distinct call-site examples alone (no inferable types) are enough to be eligible', () => {
    const target: CharacterizationTarget = {
      ...baseTarget,
      parameterTypes: undefined,
      callSiteArgLiterals: [[3], [4]],
    };
    const result = runCharacterization(target);
    expect(result.eligible).toBe(true);
  });

  it('two IDENTICAL call-site tuples (no inferable types) do not satisfy the two-distinct-example threshold (ADR-053)', () => {
    const target: CharacterizationTarget = {
      ...baseTarget,
      parameterTypes: undefined,
      callSiteArgLiterals: [[3], [3]],
    };
    const result = runCharacterization(target);
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/distinct/);
  });
});
