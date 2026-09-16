import { describe, expect, it } from 'vitest';
import { assertCompiles } from './assert-compiles.js';

describe('assertCompiles', () => {
  it('ignores the known Input/oninput near-miss', () => {
    expect(() => assertCompiles('class Foo {\n  @Input() bar: any;\n}\n')).not.toThrow();
  });

  it('does not ignore an unrelated near-miss-spelling error — the 2552 ignore is message-scoped, not a blanket code ignore', () => {
    // A genuine codemod typo (e.g. referencing `consol` instead of
    // `console`) also produces TS2552 — confirmed this is NOT silently
    // absorbed just because it shares a code with the one known, ignored
    // Input/oninput message. A blanket code-level ignore (the same shape
    // as every other entry in IGNORED_DIAGNOSTIC_CODES) would have masked
    // this too.
    expect(() => assertCompiles('function f() { return consol; }\n')).toThrow(/consol/);
  });
});
