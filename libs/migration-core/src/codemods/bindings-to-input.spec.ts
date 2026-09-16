import { describe, expect, it } from 'vitest';
import { assertCompiles } from './assert-compiles.js';
import { transformBindingsToInput } from './bindings-to-input.js';
import type { CodemodResult } from './types.js';

function assertMatched(
  result: CodemodResult
): asserts result is { matched: true; output: string; warnings?: readonly string[] } {
  expect(result.matched).toBe(true);
  if (!result.matched) throw new Error('unreachable');
}

function assertUnmatched(result: CodemodResult): asserts result is { matched: false; reason: string } {
  expect(result.matched).toBe(false);
  if (result.matched) throw new Error('unreachable');
}

describe('transformBindingsToInput', () => {
  it('converts a one-way binding with an inline controller to @Input() fields', () => {
    const before = [
      "angular.module('app').component('phoneDetail', {",
      "  templateUrl: 'phone-detail.html',",
      '  bindings: {',
      "    phone: '<'",
      '  },',
      '  controller: function (Phone) {',
      '    this.loaded = true;',
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('@Component({');
    expect(result.output).toContain("selector: 'phone-detail'");
    expect(result.output).toContain("templateUrl: 'phone-detail.html'");
    expect(result.output).toContain('@Input() phone: any;');
    expect(result.output).toContain('constructor(private Phone: any) {');
    expect(result.output).toContain('this.loaded = true;');
    // insert-only — the original registration is left untouched
    expect(result.output).toContain("component('phoneDetail', {");
  });

  it('converts the named-reference controller shape', () => {
    const before = [
      "angular.module('app').component('phoneDetail', {",
      '  bindings: {',
      "    phone: '<'",
      '  },',
      '  controller: PhoneDetailController',
      '});',
      'function PhoneDetailController(Phone) {',
      '  this.loaded = true;',
      '}',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('@Input() phone: any;');
    expect(result.output).toContain('constructor(private Phone: any)');
  });

  it('emits an aliased @Input() for a binding with a custom attribute name', () => {
    const before = [
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    value: '<myAttr'",
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain("@Input('myAttr') value: any;");
  });

  it('treats an optional one-way binding (<?) the same as a required one', () => {
    const before = [
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    value: '<?'",
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('@Input() value: any;');
  });

  it('has no constructor when there is no controller', () => {
    const before = [
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    value: '<'",
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('class WidgetComponent {');
    expect(result.output).not.toContain('constructor');
  });

  it('skips a registration with a two-way (=) binding', () => {
    const before = [
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    value: '<',",
      "    model: '='",
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertUnmatched(result);
    expect(result.reason).toContain('model');
    expect(result.reason).toContain('not one-way');
  });

  it('skips a registration with an interpolated (@) binding', () => {
    const before = [
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    label: '@'",
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertUnmatched(result);
    expect(result.reason).toContain('label');
  });

  it('skips a bindings object with a duplicate key', () => {
    // A JS object literal permits duplicate keys — syntactically legal,
    // so this can't just be assumed impossible.
    const before = [
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    value: '<',",
      "    value: '<'",
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertUnmatched(result);
    expect(result.reason).toContain('value');
    expect(result.reason).toContain('more than once');
  });

  it('skips a method-shorthand binding entry', () => {
    const before = [
      "angular.module('app').component('widget', {",
      '  bindings: {',
      '    value() { return 1; }',
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertUnmatched(result);
    expect(result.reason).toContain('not safely transformable');
  });

  it('does not match a .component() call with no bindings property at all', () => {
    const before = [
      "angular.module('app').component('phoneList', {",
      "  templateUrl: 'phone-list.html',",
      '  controller: function (Phone) { this.phones = Phone.query(); }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertUnmatched(result);
    expect(result.reason).toBe('no .component() registration with one-way bindings found');
  });

  it('skips when a binding name collides with a controller dependency name', () => {
    const before = [
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    Phone: '<'",
      '  },',
      '  controller: function (Phone) {}',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertUnmatched(result);
    expect(result.reason).toContain('same name as a controller dependency');
  });

  it('skips a binding whose key is not a valid identifier', () => {
    // Legal AngularJS (a quoted object-literal key), but the property name
    // is emitted verbatim as the class field name and "my-attr" doesn't
    // parse as one.
    const before = [
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    'my-attr': '<'",
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertUnmatched(result);
    expect(result.reason).toContain('my-attr');
    expect(result.reason).toContain('not a valid identifier');
  });

  it('does not let a skipped registration permanently claim its class name for a later, valid one sharing it', () => {
    // The first `widget` fails on its unsupported (function-valued)
    // template; the second is otherwise identical but has no template at
    // all, and must still succeed rather than being rejected as a false
    // "duplicate name" collision against the first's already-abandoned
    // attempt.
    const before = [
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    value: '<'",
      '  },',
      '  template: function () {}',
      '});',
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    value: '<'",
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('@Input() value: any;');
    expect(result.warnings?.some((w) => w.includes('template is not a plain string literal'))).toBe(true);
  });

  it('surfaces a warning for a sibling registration that is skipped, without dropping the successful one', () => {
    const before = [
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    value: '<'",
      '  }',
      '});',
      "angular.module('app').component('other', {",
      '  bindings: {',
      "    model: '='",
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('@Input() value: any;');
    expect(result.warnings?.join(';')).toContain('other');
  });

  it('skips when the derived class name collides with an existing top-level binding', () => {
    const before = [
      'class WidgetComponent {}',
      "angular.module('app').component('widget', {",
      '  bindings: {',
      "    value: '<'",
      '  }',
      '});',
    ].join('\n');

    const result = transformBindingsToInput(before);

    assertUnmatched(result);
    expect(result.reason).toContain('collides with an existing name');
  });
});
