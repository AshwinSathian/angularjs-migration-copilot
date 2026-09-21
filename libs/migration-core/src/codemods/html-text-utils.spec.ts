import { describe, expect, it } from 'vitest';
import { findMatchingParen, maskControlFlowHeaders, maskInterpolations, skipQuoted } from './html-text-utils.js';

describe('skipQuoted', () => {
  it('returns the index past a simple quoted string', () => {
    expect(skipQuoted("'abc' rest", 0)).toBe(5);
  });

  it('does not stop at a backslash-escaped quote', () => {
    expect(skipQuoted("'don\\'t' rest", 0)).toBe(8);
  });

  it('handles an unterminated string by returning past the end', () => {
    expect(skipQuoted("'abc", 0)).toBe(5);
  });
});

describe('findMatchingParen', () => {
  it('finds the matching close paren, respecting nesting', () => {
    const text = 'a(b(c)d)e';
    expect(findMatchingParen(text, 1)).toBe(7);
  });

  it('ignores parens inside a quoted string', () => {
    const text = "f('(', ')')";
    expect(findMatchingParen(text, 1)).toBe(10);
  });

  it('throws on an unterminated paren', () => {
    expect(() => findMatchingParen('a(b', 1)).toThrow(/unterminated/);
  });
});

describe('maskInterpolations', () => {
  it('masks < and > inside {{ }} interpolation, same length', () => {
    const text = '<li>{{ a < b }}</li>';
    const masked = maskInterpolations(text);
    expect(masked).toBe('<li>{{ a   b }}</li>');
    expect(masked.length).toBe(text.length);
  });

  it('leaves < and > outside interpolation untouched', () => {
    expect(maskInterpolations('<li>x</li>')).toBe('<li>x</li>');
  });

  it('handles multiple interpolations independently', () => {
    expect(maskInterpolations('{{ a < b }} and {{ c > d }}')).toBe('{{ a   b }} and {{ c   d }}');
  });
});

describe('maskControlFlowHeaders', () => {
  it('masks < and > inside an @if header, same length', () => {
    const text = '@if (a < b) {\n<li>x</li>\n}';
    const masked = maskControlFlowHeaders(text);
    expect(masked).toBe('@if (a   b) {\n<li>x</li>\n}');
    expect(masked.length).toBe(text.length);
  });

  it('leaves body content, including its own < / >, untouched', () => {
    expect(maskControlFlowHeaders('@if (a < b) {\n{{ c < d }}\n}')).toBe('@if (a   b) {\n{{ c < d }}\n}');
  });
});
