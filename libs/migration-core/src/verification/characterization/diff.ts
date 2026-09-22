import type { SandboxOutcome } from '../types.js';

/**
 * §6.5's diffing tolerance: "structural deep-equality with explicit
 * tolerance for non-deterministic object-key ordering and Date
 * serialization differences." Canonicalizes both sides (sorted object
 * keys, `Date` instances normalized to their ISO string) before
 * comparing, rather than a library-based deep-equal — this project's own
 * ladder precedent (no new dependency for something this small) and it
 * keeps the exact tolerance rules explicit and auditable in one place,
 * which matters more than usual here given this file lives under the
 * heavy-scrutiny verification/ directory.
 */
function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function outcomesMatch(a: SandboxOutcome, b: SandboxOutcome): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'throw' && b.type === 'throw') return a.message === b.message;
  if (a.type === 'return' && b.type === 'return') {
    return JSON.stringify(canonicalize(a.value)) === JSON.stringify(canonicalize(b.value));
  }
  return false;
}
