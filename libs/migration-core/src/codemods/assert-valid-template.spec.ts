import { describe, expect, it } from 'vitest';
import { assertValidTemplate } from './assert-valid-template.js';

describe('assertValidTemplate', () => {
  it('accepts a well-formed @for block', () => {
    expect(() => assertValidTemplate('@for (item of items; track item.id) {\n<li>{{item.name}}</li>\n}')).not.toThrow();
  });

  it('accepts nested @for/@if blocks', () => {
    expect(() =>
      assertValidTemplate('@for (item of items; track item) {\n@if (item.visible) {\n<li>{{item.name}}</li>\n}\n}')
    ).not.toThrow();
  });

  it('rejects an unclosed block (missing trailing })', () => {
    expect(() => assertValidTemplate('@for (item of items; track item) {\n<li>{{item.name}}</li>')).toThrow(/unbalanced|unclosed/i);
  });

  it('rejects an orphan closing brace with no matching opener', () => {
    expect(() => assertValidTemplate('<li>{{item.name}}</li>\n}')).toThrow(/unbalanced|orphan/i);
  });

  it('rejects a block header missing its opening brace', () => {
    expect(() => assertValidTemplate('@for (item of items; track item)\n<li>{{item.name}}</li>')).toThrow(/brace|block/i);
  });

  it('rejects markup corrupted by a bad edit (unterminated attribute)', () => {
    expect(() => assertValidTemplate('<li class="x>{{item.name}}</li>')).toThrow(/parse error|html/i);
  });

  it('does not confuse interpolation braces ({{ }}) with block braces', () => {
    expect(() => assertValidTemplate('<div>{{a}} and {{b}}</div>')).not.toThrow();
  });

  it('accepts a "<" comparison inside a block condition (a common real ng-if/ng-repeat shape)', () => {
    // Found by adversarial review, confirmed by direct execution against
    // parse5: a bare "<" reads to an HTML5 tokenizer as the possible
    // start of a tag, producing a real (if harmless, since the tokenizer
    // recovers and treats it as text either way) `onParseError` —
    // masked out of the header's own expression text before the
    // underlying-markup check runs, so genuine markup corruption
    // elsewhere in the output is still caught.
    expect(() => assertValidTemplate('@if (items.length < 5) {\n<li>x</li>\n}')).not.toThrow();
  });

  it('does not desync on a backslash-escaped quote inside a header condition', () => {
    // Found by adversarial review: skipQuoted stopped at the first
    // matching quote character regardless of a preceding backslash, so
    // `'don\'t'` was read as ending at the escaped quote — desyncing the
    // paren/brace count for everything after it in the header.
    expect(() => assertValidTemplate("@if (name === 'don\\'t') {\n<li>x</li>\n}")).not.toThrow();
  });

  it('still catches genuine markup corruption elsewhere in the file even when a block header contains "<"', () => {
    expect(() =>
      assertValidTemplate('@if (a < b) {\n<li>ok</li>\n}\n<div class="y>bad')
    ).toThrow(/parse error|html/i);
  });

  it('accepts a "<" comparison inside {{ }} interpolation in ordinary body content, outside any header', () => {
    // Found by adversarial review, confirmed by direct execution: the
    // first version of the header-masking fix only masked "<"/">"
    // inside @for/@if's own paren span, so a completely ordinary,
    // untouched {{ a < b }} interpolation sitting in the codemod's
    // *body* output (the exact real shape ng-control-flow.ts's own
    // input-side check already handles) still tripped a false positive
    // here on the *output* side.
    expect(() =>
      assertValidTemplate('@for (item of items; track item) {\n<li>{{ a < b }}</li>\n}')
    ).not.toThrow();
  });
});
