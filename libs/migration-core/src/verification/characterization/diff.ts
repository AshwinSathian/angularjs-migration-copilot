import type { SandboxOutcome } from '../types.js';

/** Thrown by `canonicalize` for a value that has no faithful structural form. */
export class UncomparableValueError extends Error {}

const tagOf = (value: unknown): string => Object.prototype.toString.call(value).slice(8, -1);

/**
 * §6.5's diffing tolerance — "structural deep-equality with explicit
 * tolerance for non-deterministic object-key ordering and Date
 * serialization differences" — and nothing looser than that.
 *
 * Values arrive from a `node:vm` context, i.e. another realm, where
 * `instanceof Date`/`Map`/... is always false; types are identified by
 * `Object.prototype.toString` tag instead (docs/decisions.md ADR-057: an
 * `instanceof` version made any two Dates equal).
 *
 * Every distinct JS value maps to a distinct canonical form:
 * `undefined`, `NaN`, `±Infinity`, `-0`, and bigint are tagged rather
 * than left to `JSON.stringify`, which would fold them into `null`/`0`
 * or drop them. A function, symbol, promise, weak collection, class
 * instance, or cyclic structure has no faithful form and throws
 * `UncomparableValueError` — the caller reports that as "cannot verify",
 * never as a match.
 */
export function canonicalize(value: unknown, seen: ReadonlySet<unknown> = new Set()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === undefined) return { $: 'undefined' };
  if (typeof value === 'number') {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    return { $: 'number', v: Object.is(value, -0) ? '-0' : String(value) };
  }
  if (typeof value === 'bigint') return { $: 'bigint', v: String(value) };
  if (typeof value !== 'object') throw new UncomparableValueError(`a ${typeof value}`);
  if (seen.has(value)) throw new UncomparableValueError('a cyclic structure');
  const inner = new Set(seen).add(value);
  const recur = (v: unknown) => canonicalize(v, inner);

  const tag = tagOf(value);
  if (tag === 'Array') return Array.from(value as unknown[], recur);
  if (tag === 'Date') {
    const time = (value as Date).getTime();
    return { $: 'Date', v: Number.isNaN(time) ? 'Invalid' : new Date(time).toISOString() };
  }
  if (tag === 'RegExp') return { $: 'RegExp', v: String(value) };
  if (tag === 'Map') return { $: 'Map', v: Array.from(value as Map<unknown, unknown>, ([k, v]) => [recur(k), recur(v)]) };
  if (tag === 'Set') return { $: 'Set', v: Array.from(value as Set<unknown>, recur) };
  if (tag === 'String' || tag === 'Number' || tag === 'Boolean') {
    return { $: tag, v: recur((value as { valueOf(): unknown }).valueOf()) };
  }
  if (tag === 'Error') {
    const error = value as { name?: unknown; message?: unknown };
    return { $: 'Error', v: [String(error.name), String(error.message)] };
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  const isPlain = proto === null || Object.getPrototypeOf(proto) === null;
  if (tag !== 'Object' || !isPlain) throw new UncomparableValueError(`a ${tag} instance`);

  const entries = Object.keys(value)
    .sort()
    .map((key) => [key, recur((value as Record<string, unknown>)[key])]);
  return { $: 'Object', v: entries };
}

/** A stable string for one outcome. Throws `UncomparableValueError` for a return value with no faithful form; never call on `unrunnable`. */
export function outcomeKey(outcome: SandboxOutcome): string {
  if (outcome.type === 'return') return JSON.stringify(['return', canonicalize(outcome.value)]);
  if (outcome.type === 'throw') return JSON.stringify(['throw', outcome.name, outcome.message]);
  throw new UncomparableValueError('an outcome that never ran');
}

/** False for anything that cannot be compared faithfully — `unrunnable` on either side included. */
export function outcomesMatch(a: SandboxOutcome, b: SandboxOutcome): boolean {
  try {
    return outcomeKey(a) === outcomeKey(b);
  } catch {
    return false;
  }
}
