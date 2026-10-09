import { estimateTokens } from 'provider-scheduler';
import { describe, expect, it } from 'vitest';
import { splitSource } from './split.js';

const fn = (name: string) => `function ${name}() {\n  return '${'x'.repeat(200)}';\n}\n`;

describe('splitSource', () => {
  it('leaves a file under the cap whole', () => {
    expect(splitSource(fn('a'), 1000)).toEqual({ chunks: [fn('a')] });
  });

  it('splits an oversized file at function and class boundaries, every chunk under the cap, nothing dropped', () => {
    const source = [fn('a'), fn('b'), `class C {\n  m() { return 1; }\n}\n`, fn('d')].join('');
    const result = splitSource(source, 130);

    if (!('chunks' in result)) throw new Error('expected chunks');
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(130);
    // Never silently truncated: the chunks are the source, cut only between statements.
    expect(result.chunks.join('')).toBe(source);
    expect(result.chunks.every((chunk) => /^(function|class) /.test(chunk.trim()))).toBe(true);
  });

  it('splits inside the IIFE wrapper AngularJS files are usually written in', () => {
    const source = `(function () {\n'use strict';\n${fn('a')}${fn('b')}${fn('c')}})();\n`;
    const result = splitSource(source, 70);

    if (!('chunks' in result)) throw new Error('expected chunks');
    expect(result.chunks).toHaveLength(3);
    for (const name of ['a', 'b', 'c']) expect(result.chunks.join('')).toContain(`function ${name}()`);
  });

  it('refuses, rather than cutting, when one function alone is over the cap', () => {
    const result = splitSource(`${fn('small')}function huge() {\n  return '${'x'.repeat(2000)}';\n}\n`, 100);
    expect(result).toHaveProperty('tooLarge', expect.stringMatching(/over the cap of 100: function huge\(\)/));
  });
});
