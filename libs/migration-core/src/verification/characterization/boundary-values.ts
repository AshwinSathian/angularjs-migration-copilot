import type { ParameterType } from '../types.js';

const BOUNDARY_SETS: Record<ParameterType, readonly unknown[]> = {
  string: ['', 'x'],
  number: [0, 1, -1],
  boolean: [true, false],
  array: [[], [1], null],
  object: [{}, { k: 'v' }, null],
};

const POPULATED_DEFAULT: Record<ParameterType, unknown> = {
  string: 'x',
  number: 1,
  boolean: true,
  array: [1],
  object: { k: 'v' },
};

/**
 * §6.5's type-based boundary values, one parameter varied at a time
 * (siblings held at a populated default) rather than a full cartesian
 * product across every parameter — a deliberate v1 scope decision to
 * avoid combinatorial explosion on a function with several parameters,
 * documented here rather than silently assumed. A parameter with no
 * inferable type contributes `undefined` to every row it isn't the one
 * being varied, and no rows at all if it's the only parameter (no type
 * to generate boundaries from).
 *
 * For `array` and `object` parameter types (reference/nullable shapes),
 * boundary values include `null` to cover optional parameters defaulting
 * to null or receiving null at call sites.
 */
export function generateBoundaryValueRows(
  parameterTypes: readonly (ParameterType | undefined)[]
): readonly (readonly unknown[])[] {
  const rows: unknown[][] = [];

  parameterTypes.forEach((targetType, targetIndex) => {
    if (!targetType) return;
    for (const boundaryValue of BOUNDARY_SETS[targetType]) {
      const row = parameterTypes.map((siblingType, i) => {
        if (i === targetIndex) return boundaryValue;
        return siblingType ? POPULATED_DEFAULT[siblingType] : undefined;
      });
      rows.push(row);
    }
  });

  return rows;
}
