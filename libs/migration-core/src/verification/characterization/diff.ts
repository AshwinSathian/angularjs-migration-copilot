import { types } from 'node:util';
import type { SandboxOutcome } from '../types.js';

const REGEXP_SOURCE = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')?.get as (this: unknown) => string;
const REGEXP_FLAGS = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags')?.get as (this: unknown) => string;

/** Thrown by `canonicalize` for a value that has no faithful structural form. */
export class UncomparableValueError extends Error {}

const tagOf = (value: unknown): string => Object.prototype.toString.call(value).slice(8, -1);

/**
 * Reads `key` without running any code the value brought with it: own
 * or inherited *data* properties only, never a getter, never through a
 * Proxy. `undefined` when there is no such data property.
 */
export function safeDataProperty(value: unknown, key: string): unknown {
  let current: unknown = value;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth++) {
    if (types.isProxy(current)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return 'value' in descriptor ? (descriptor.value as unknown) : undefined;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/** Own properties as plain data, or a refusal. Symbol keys, accessors and hidden properties all make two "equal-looking" objects differ invisibly. */
function ownDataEntries(value: object, ignore: (key: string) => boolean = () => false): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new UncomparableValueError('an object with symbol-keyed properties');
    if (ignore(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor;
    if (!('value' in descriptor)) throw new UncomparableValueError('an object with accessor properties');
    if (!descriptor.enumerable) throw new UncomparableValueError('an object with non-enumerable properties');
    entries.push([key, descriptor.value]);
  }
  return entries;
}

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
 * instance, Proxy, cyclic structure, or an object carrying accessors,
 * symbol keys or non-enumerable properties has no faithful form and
 * throws `UncomparableValueError` — the caller reports that as "cannot
 * verify", never as a match.
 *
 * This runs in the host, outside the sandbox's timeout, on values the
 * function under test built. It therefore never runs their code: no
 * getter is invoked, no iterator or `toString` they could override is
 * called (built-in prototype methods are applied directly), and a Proxy
 * is refused before any trap can fire (ADR-067).
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
  if (types.isProxy(value)) throw new UncomparableValueError('a Proxy');
  if (seen.has(value)) throw new UncomparableValueError('a cyclic structure');
  const inner = new Set(seen).add(value);
  const recur = (v: unknown) => canonicalize(v, inner);

  const tag = tagOf(value);
  if (tag === 'Array') {
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as number;
    const items = new Map(ownDataEntries(value, (key) => key === 'length'));
    const result: unknown[] = [];
    for (let i = 0; i < length; i++) {
      result.push(recur(items.get(String(i))));
      items.delete(String(i));
    }
    if (items.size > 0) throw new UncomparableValueError('an array with extra properties');
    return result;
  }
  if ((tag === 'Date' || tag === 'Map' || tag === 'Set') && Reflect.ownKeys(value).length > 0) {
    throw new UncomparableValueError(`a ${tag} with extra properties`);
  }
  if (tag === 'Date') {
    const time = Date.prototype.getTime.call(value);
    return { $: 'Date', v: Number.isNaN(time) ? 'Invalid' : new Date(time).toISOString() };
  }
  if (tag === 'RegExp') {
    return { $: 'RegExp', v: [REGEXP_SOURCE.call(value), REGEXP_FLAGS.call(value)] };
  }
  if (tag === 'Map') {
    const entries: unknown[] = [];
    Map.prototype.forEach.call(value, (v: unknown, k: unknown) => entries.push([recur(k), recur(v)]));
    return { $: 'Map', v: entries };
  }
  if (tag === 'Set') {
    const items: unknown[] = [];
    Set.prototype.forEach.call(value, (v: unknown) => items.push(recur(v)));
    return { $: 'Set', v: items };
  }
  if (tag === 'String') return { $: tag, v: String.prototype.valueOf.call(value) };
  if (tag === 'Number') return { $: tag, v: recur(Number.prototype.valueOf.call(value)) };
  if (tag === 'Boolean') return { $: tag, v: Boolean.prototype.valueOf.call(value) };
  if (tag === 'Error') {
    return { $: 'Error', v: [String(safeDataProperty(value, 'name')), String(safeDataProperty(value, 'message'))] };
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  const isPlain = proto === null || Object.getPrototypeOf(proto) === null;
  if (tag !== 'Object' || !isPlain) throw new UncomparableValueError(`a ${tag} instance`);

  const entries = ownDataEntries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => [key, recur(v)]);
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
