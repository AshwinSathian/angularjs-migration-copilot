import { describe, expect, it } from 'vitest';
import { assertValidTemplate } from './assert-valid-template.js';
import { transformNgDirectivesToControlFlow } from './ng-control-flow.js';
import type { CodemodResult } from './types.js';

function assertMatched(
  result: CodemodResult
): asserts result is { matched: true; output: string; warnings?: readonly string[] } {
  expect(result.matched).toBe(true);
  if (!result.matched) throw new Error('unreachable');
}

describe('transformNgDirectivesToControlFlow', () => {
  it('wraps an ng-repeat element in @for, tracking by the loop variable when no track by is given', () => {
    const before = '<ul>\n  <li ng-repeat="phone in phones">{{phone.name}}</li>\n</ul>';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.output).toBe(
      '<ul>\n  @for (phone of phones; track phone) {\n<li>{{phone.name}}</li>\n}\n</ul>'
    );
    assertValidTemplate(result.output);
  });

  it('uses an explicit track by expression when present, with :: stripped', () => {
    const before = '<li ng-repeat="msg in ::messages track by msg.id">{{msg.text}}</li>';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.output).toBe('@for (msg of messages; track msg.id) {\n<li>{{msg.text}}</li>\n}');
    assertValidTemplate(result.output);
  });

  it('skips an ng-repeat whose expression pipes through a filter/orderBy, leaving the attribute untouched', () => {
    const before = '<li ng-repeat="phone in phones | filter:query | orderBy:orderProp">{{phone.name}}</li>';

    const result = transformNgDirectivesToControlFlow(before);

    expect(result.matched).toBe(false);
    if (result.matched) throw new Error('unreachable');
    expect(result.reason).toContain('pipe');
  });

  it('wraps an ng-if element in @if, with :: stripped from the condition', () => {
    const before = '<div ng-if="::item.subMenu">child</div>';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.output).toBe('@if (item.subMenu) {\n<div>child</div>\n}');
    assertValidTemplate(result.output);
  });

  it('converts ng-show to a [hidden] binding in place, negating the expression', () => {
    const before = '<div class="preview" ng-show="message.expanded">shown</div>';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.output).toBe('<div class="preview" [hidden]="!(message.expanded)">shown</div>');
    assertValidTemplate(result.output);
  });

  it('nests ng-repeat outside ng-if on the same element, matching AngularJS real directive priority (repeat=1000 > if=600)', () => {
    const before = '<li ng-repeat="item in todoList" ng-if="!item.deleted" ng-init="activeItem=false">{{item.name}}</li>';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.output).toBe(
      '@for (item of todoList; track item) {\n@if (!item.deleted) {\n<li ng-init="activeItem=false">{{item.name}}</li>\n}\n}'
    );
    assertValidTemplate(result.output);
  });

  it('keeps ng-show as an attribute on the element inside an @if wrapper when both are present on one element', () => {
    const before = '<div class="preview" ng-show="message.expanded" ng-if="message.preview">{{message.text}}</div>';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.output).toBe(
      '@if (message.preview) {\n<div class="preview" [hidden]="!(message.expanded)">{{message.text}}</div>\n}'
    );
    assertValidTemplate(result.output);
  });

  it('wraps a self-closing void element correctly', () => {
    const before = '<img ng-repeat="img in $ctrl.phone.images" />';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.output).toBe('@for (img of $ctrl.phone.images; track img) {\n<img />\n}');
    assertValidTemplate(result.output);
  });

  it('handles independently nested ng-repeat elements at different depths without corruption', () => {
    const before =
      '<div ng-repeat="block in blocks"><div ng-repeat="col in block.cols">{{col.name}}</div></div>';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.output).toBe(
      '@for (block of blocks; track block) {\n<div>@for (col of block.cols; track col) {\n<div>{{col.name}}</div>\n}</div>\n}'
    );
    assertValidTemplate(result.output);
  });

  it('removes two adjacent directive attributes cleanly when the last one is also the last attribute before >', () => {
    // Found by self-review, not by any real fixture: unlike the real
    // dashboardTodo.html combo (which has a third attribute, ng-init,
    // after ng-if), here ng-if is both adjacent to ng-repeat *and* the
    // final attribute before the tag closes. Removing each attribute's
    // own adjacent whitespace independently double-claims the single
    // separator between them.
    const before = '<li ng-repeat="x in y" ng-if="z">content</li>';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.output).toBe('@for (x of y; track x) {\n@if (z) {\n<li>content</li>\n}\n}');
    assertValidTemplate(result.output);
  });

  it('wraps two adjacent sibling elements independently without one block swallowing the other', () => {
    // Found by adversarial review (`/code-review high`), confirmed by
    // direct execution: when two sibling elements touch with no
    // whitespace between them, the first element's close-insert and the
    // second element's open-insert land at the identical offset.
    // applyEdits' descending-sort-and-splice reverses same-position
    // edits (the one pushed first ends up rightmost), so the second
    // element's @if opened *after* its own content, leaving an empty
    // @if block and an unwrapped sibling.
    const before = '<li ng-repeat="a in as">1</li><li ng-if="b">2</li>';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.output).toBe(
      '@for (a of as; track a) {\n<li>1</li>\n}@if (b) {\n<li>2</li>\n}'
    );
    assertValidTemplate(result.output);
  });

  it('surfaces an input HTML parse error as a warning even when a real transform elsewhere in the file still succeeds', () => {
    // Found by adversarial review, confirmed by direct execution: errors
    // collected from parsing the input were only ever inspected inside
    // the `!anyMatch` branch, so a genuinely broken sibling element's
    // parse error was silently dropped whenever any match succeeded —
    // CodemodResult's own contract (types.ts) is that a partial success
    // still surfaces every real signal, not just skip reasons.
    const before = '<li ng-repeat="item in items">{{item.name}}</li><div class="x>broken</div>';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.warnings?.some((w) => /parse error/i.test(w))).toBe(true);
  });

  it('does not strip "::" occurrences that fall inside a string literal in the expression', () => {
    // Found by adversarial review, confirmed by direct execution:
    // stripOneTimeBinding did a blind global substring removal, so
    // `vm.check('foo::bar')` silently became `vm.check('foobar')` —
    // corrupting the string literal's actual value, not just removing a
    // one-time-binding marker.
    const before = "<li ng-if=\"vm.check('foo::bar')\">x</li>";

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.output).toBe("@if (vm.check('foo::bar')) {\n<li>x</li>\n}");
  });

  it('does not report a spurious input-parse-error warning for an ordinary "<"/">" inside {{ }} interpolation', () => {
    // Found by adversarial review, confirmed by direct execution: a bare
    // "<" in ordinary text content (e.g. {{ a < b }}, valid and common
    // AngularJS/Angular interpolation syntax) reads to parse5's
    // tokenizer as a possible tag start, producing a real but harmless
    // `invalid-first-character-of-tag-name` error — this was a direct
    // regression from surfacing every input parse error as a warning.
    const before = '<li ng-repeat="item in items">{{ a < b }}</li>';

    const result = transformNgDirectivesToControlFlow(before);

    assertMatched(result);
    expect(result.warnings).toBeUndefined();
  });

  it('skips a valueless ng-if attribute instead of treating the attribute name itself as the condition', () => {
    // Found by adversarial review, confirmed by direct execution:
    // getAttrValue fell back to the raw token text (the bare attribute
    // name) when there's no "=", so `<div ng-if>` silently produced
    // `@if (ng-if) { ... }` — referencing a nonexistent template
    // variable, matched: true, no warning.
    const before = '<div ng-if>x</div>';

    const result = transformNgDirectivesToControlFlow(before);

    expect(result.matched).toBe(false);
    if (result.matched) throw new Error('unreachable');
    expect(result.reason).toContain('no value');
  });

  it('skips an ng-if with an explicitly empty or whitespace-only value the same way as a valueless one', () => {
    // Found by a later adversarial round, confirmed by direct execution:
    // getAttrValue's earlier fix only caught a missing "=" entirely —
    // ng-if="" or ng-if="   " still returned an (empty) string, which
    // planIf happily turned into an invalid `@if () {` — matched: true,
    // no warning, a real syntax error in the emitted template.
    for (const before of ['<div ng-if="">x</div>', '<div ng-if="   ">x</div>']) {
      const result = transformNgDirectivesToControlFlow(before);
      expect(result.matched).toBe(false);
      if (result.matched) throw new Error('unreachable');
      expect(result.reason).toContain('no value');
    }
  });

  it('conservatively skips the whole file when an element has a duplicate directive attribute', () => {
    // Found by adversarial review, confirmed by direct execution: parse5's
    // sourceCodeLocation.attrs is keyed by name and only records the
    // *first* occurrence of a duplicate attribute — a second `ng-if="y"`
    // is completely invisible to processElement, so it was silently left
    // stranded, untransformed, on the wrapped element (matched: true).
    const before = '<li ng-if="x" ng-if="y">z</li>';

    const result = transformNgDirectivesToControlFlow(before);

    expect(result.matched).toBe(false);
    if (result.matched) throw new Error('unreachable');
    expect(result.reason).toContain('duplicate attribute');
  });

  it('reports no match for a file with no ng-repeat/ng-if/ng-show directive', () => {
    const before = '<div class="static">hello</div>';

    const result = transformNgDirectivesToControlFlow(before);

    expect(result.matched).toBe(false);
    if (result.matched) throw new Error('unreachable');
    expect(result.reason).toContain('no ng-repeat');
  });

  it('skips an ng-repeat using the (key, value) destructuring form, zero real fixture evidence', () => {
    const before = '<li ng-repeat="(key, value) in obj">{{key}}: {{value}}</li>';

    const result = transformNgDirectivesToControlFlow(before);

    expect(result.matched).toBe(false);
    if (result.matched) throw new Error('unreachable');
    expect(result.reason).toContain('destructuring');
  });

  it('skips an ng-repeat using the "as" alias clause, zero real fixture evidence', () => {
    const before = '<li ng-repeat="item in items as filtered">{{item.name}}</li>';

    const result = transformNgDirectivesToControlFlow(before);

    expect(result.matched).toBe(false);
    if (result.matched) throw new Error('unreachable');
    expect(result.reason).toContain('as');
  });
});
