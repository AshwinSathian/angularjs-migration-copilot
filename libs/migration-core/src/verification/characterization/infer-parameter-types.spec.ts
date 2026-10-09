import { describe, expect, it } from 'vitest';
import { inferParameterTypes } from './infer-parameter-types.js';

describe('inferParameterTypes', () => {
  it.each([
    ['a string-only method', 'function (s) { return s.toUpperCase(); }', ['string']],
    ['String(p), with a truthiness test alongside (blur-admin plainText)', "function (text) { return text ? String(text).replace(/<[^>]+>/gm, '') : ''; }", ['string']],
    ['an array-only method', 'function (xs) { return xs.map(function (x) { return x; }); }', ['array']],
    ['arithmetic', 'function (a, b) { return a * b; }', ['number', 'number']],
    ['a Math call', 'function (n) { return Math.round(n); }', ['number']],
    ['a bare truthiness test (angular-phonecat checkmark)', "function (input) { return input ? '\\u2713' : '\\u2718'; }", ['boolean']],
  ])('infers from %s', (_label, source, expected) => {
    expect(inferParameterTypes(source)).toEqual(expected);
  });

  it.each([
    ['+ (string or number)', 'function (a) { return a + 1; }'],
    ['.length (string or array)', 'function (a) { return a.length; }'],
    ['.slice / .indexOf / .concat (shared)', 'function (a) { return a.slice(1).indexOf(2) + a.concat(a); }'],
    ['conflicting evidence', 'function (a) { return a.toUpperCase() + a.map(String); }'],
    ['no usage at all', 'function (a) { return 1; }'],
    ['a destructured parameter', 'function ({ a }) { return a * 2; }'],
  ])('refuses to guess from %s', (_label, source) => {
    expect(inferParameterTypes(source)).toEqual([undefined]);
  });

  it('does not count a shadowing inner variable as a use of the parameter', () => {
    expect(inferParameterTypes('function (a) { return [1].map(function (a) { return a * 2; }); }')).toEqual([undefined]);
  });

  it('returns no types for source that is not a function', () => {
    expect(inferParameterTypes('42')).toEqual([]);
  });
});
