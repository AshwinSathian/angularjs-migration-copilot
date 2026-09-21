/**
 * Small string-scanning utilities shared between `ng-control-flow.ts`
 * (production) and `assert-valid-template.ts` (its test helper) — both
 * need the identical "walk this JS/Angular-expression-flavored text,
 * respecting quoted-string content" primitive, and having each
 * reimplement it independently already caused a real bug once: a
 * backslash-escape-awareness fix (docs/decisions.md ADR-048) was found
 * and applied in one file, then found and fixed *again*, separately, in
 * the other, confirmed by adversarial review tracing the exact
 * duplicated logic between them.
 */

/**
 * Past the closing quote (or past the end, for an unterminated string —
 * callers that care about balance/termination catch that case
 * themselves). Backslash-escape-aware: an escaped quote (`'don\'t'`)
 * doesn't terminate the string early.
 */
export function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote) {
    i += text[i] === '\\' ? 2 : 1;
  }
  return i + 1;
}

/** Index of the `)` matching the `(` at `openIndex`, respecting nested parens and quoted-string content (e.g. a `'-date'` literal inside a track expression). */
export function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error(`unterminated "(" starting at offset ${openIndex}`);
}

/**
 * Replaces `<`/`>` with a space wherever they fall inside a `{{ ... }}`
 * interpolation span, same length, everything else untouched.
 * AngularJS/Angular interpolation expressions can freely contain
 * comparison operators (`{{ a < b }}`, a common real idiom), which an
 * HTML5 tokenizer misreads as the possible start of a tag — confirmed
 * by direct probe against parse5 (`invalid-first-character-of-tag-name`
 * on `<`, no error on `>` alone).
 */
export function maskInterpolations(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('{{', i)) {
      const close = text.indexOf('}}', i + 2);
      const contentEnd = close === -1 ? text.length : close;
      result += '{{';
      result += text.slice(i + 2, contentEnd).replace(/[<>]/g, ' ');
      result += text.slice(contentEnd, close === -1 ? text.length : close + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}

/**
 * Replaces `<`/`>` with a space wherever they fall inside a
 * `@for (...)`/`@if (...)` header's own parenthesized span, same
 * length, everything else — including any genuine markup corruption
 * elsewhere in the string — untouched.
 */
export function maskControlFlowHeaders(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('@for (', i) || text.startsWith('@if (', i)) {
      const openParen = text.indexOf('(', i);
      const closeParen = findMatchingParen(text, openParen);
      result += text.slice(i, openParen + 1);
      result += text.slice(openParen + 1, closeParen).replace(/[<>]/g, ' ');
      result += text[closeParen];
      i = closeParen + 1;
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}
