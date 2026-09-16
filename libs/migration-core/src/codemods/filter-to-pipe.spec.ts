import { describe, expect, it } from 'vitest';
import { assertCompiles } from './assert-compiles.js';
import { transformFilterToPipe } from './filter-to-pipe.js';
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

describe('transformFilterToPipe', () => {
  it('converts a named-reference filter with no injected deps (removeHtml.js\'s real shape)', () => {
    const before = [
      "angular.module('app').filter('plainText', plainText);",
      '',
      'function plainText() {',
      '  return function (text) {',
      "    return text ? String(text).replace(/<[^>]+>/gm, '') : '';",
      '  };',
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('@Pipe({');
    expect(result.output).toContain("name: 'plainText'");
    expect(result.output).toContain('class PlainTextPipe {');
    expect(result.output).toContain('transform(text: any)');
    expect(result.output).not.toContain('constructor');
    // insert-only — the original registration and factory are left untouched
    expect(result.output).toContain("filter('plainText', plainText);");
    expect(result.output).toContain('function plainText() {');
  });

  it('rewrites a closure reference to an injected dependency to this.<name> (appImage.js\'s real shape)', () => {
    const before = [
      "angular.module('app').filter('appImage', appImage);",
      '',
      'function appImage(layoutPaths) {',
      '  return function (input) {',
      '    return layoutPaths.images.root + input;',
      '  };',
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain("name: 'appImage'");
    expect(result.output).toContain('class AppImagePipe {');
    expect(result.output).toContain('constructor(private layoutPaths: any) {}');
    expect(result.output).toContain('transform(input: any)');
    expect(result.output).toContain('return this.layoutPaths.images.root + input;');
  });

  it('supports a filter argument beyond input (profilePicture.js\'s real shape)', () => {
    const before = [
      "angular.module('app').filter('profilePicture', profilePicture);",
      '',
      'function profilePicture(layoutPaths) {',
      '  return function (input, ext) {',
      "    ext = ext || 'png';",
      "    return layoutPaths.images.profile + input + '.' + ext;",
      '  };',
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('transform(input: any, ext: any)');
    expect(result.output).toContain('this.layoutPaths.images.profile');
  });

  it('converts an inline factory literal', () => {
    const before = [
      "angular.module('app').filter('shout', function () {",
      '  return function (input) {',
      "    return String(input).toUpperCase() + '!';",
      '  };',
      '});',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('class ShoutPipe {');
    expect(result.output).not.toContain('constructor');
  });

  it('skips a factory whose body does more than return a function literal', () => {
    const before = [
      "angular.module('app').filter('weird', weird);",
      '',
      'function weird(cfg) {',
      '  if (cfg.upper) {',
      '    return function (input) { return String(input).toUpperCase(); };',
      '  }',
      '  return function (input) { return input; };',
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertUnmatched(result);
    expect(result.reason).toContain('weird');
    expect(result.reason).toContain('not safely transformable as a pure pipe');
  });

  it('skips a factory returning something other than a function', () => {
    const before = [
      "angular.module('app').filter('notAFilter', notAFilter);",
      '',
      'function notAFilter() {',
      "  return 'not a function';",
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertUnmatched(result);
    expect(result.reason).toContain('notAFilter');
  });

  it('skips when the returned function references an injected dependency from inside a nested non-arrow function', () => {
    const before = [
      "angular.module('app').filter('appImage', appImage);",
      '',
      'function appImage(layoutPaths) {',
      '  return function (input) {',
      '    return [input].map(function (x) { return layoutPaths.images.root + x; })[0];',
      '  };',
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertUnmatched(result);
    expect(result.reason).toContain('appImage');
    expect(result.reason).toContain('nested function or accessor');
  });

  it('does not rewrite a returned-function parameter that shadows an injected dependency name', () => {
    const before = [
      "angular.module('app').filter('shadow', shadow);",
      '',
      'function shadow(input) {',
      '  return function (input) {',
      '    return input;',
      '  };',
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('constructor(private input: any) {}');
    expect(result.output).toContain('return input;');
    expect(result.output).not.toContain('return this.input;');
  });

  it('skips a factory with a destructured parameter', () => {
    const before = [
      "angular.module('app').filter('destructured', destructured);",
      '',
      'function destructured({ layoutPaths }) {',
      '  return function (input) { return layoutPaths.images.root + input; };',
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertUnmatched(result);
    expect(result.reason).toContain('destructured');
    expect(result.reason).toContain('not safely transformable');
  });

  it('skips a returned function with a default-valued parameter', () => {
    const before = [
      "angular.module('app').filter('defaulted', defaulted);",
      '',
      "function defaulted() {",
      "  return function (input, ext = 'png') { return input + ext; };",
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertUnmatched(result);
    expect(result.reason).toContain('defaulted');
  });

  it('skips when the derived class name collides with an existing top-level binding', () => {
    const before = [
      'class PlainTextPipe {}',
      "angular.module('app').filter('plainText', plainText);",
      '',
      'function plainText() {',
      '  return function (text) { return text; };',
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertUnmatched(result);
    expect(result.reason).toContain('collides with an existing name');
  });

  it('surfaces a warning for a sibling registration that is skipped, without dropping the successful one', () => {
    const before = [
      "angular.module('app').filter('plainText', plainText);",
      "angular.module('app').filter('notAFilter', notAFilter);",
      '',
      'function plainText() {',
      '  return function (text) { return text; };',
      '}',
      'function notAFilter() {',
      "  return 'nope';",
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('class PlainTextPipe {');
    expect(result.warnings?.some((w) => w.includes('notAFilter'))).toBe(true);
  });

  it('rewrites an injected dependency referenced via ES6 object-literal shorthand', () => {
    // `{ layoutPaths, input }` is sugar for `{ layoutPaths: layoutPaths, ...
    // }` — a plain identifier-text replacement would produce the invalid
    // `{ this.layoutPaths, input }`; it must expand to the full key:value
    // form instead.
    const before = [
      "angular.module('app').filter('appImage', appImage);",
      '',
      'function appImage(layoutPaths) {',
      '  return function (input) {',
      '    return { layoutPaths, input };',
      '  };',
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('return { layoutPaths: this.layoutPaths, input };');
  });

  it('skips a self-recursive named function expression returned by the factory', () => {
    // A named function expression's own name is only visible inside its
    // own body (ES scoping, not a this-rebinding hazard) — copying just
    // the body into `transform(...) {...}` loses that binding, so a
    // self-reference resolves to nothing at both compile time and runtime.
    const before = [
      "angular.module('app').filter('countdown', countdown);",
      '',
      'function countdown() {',
      '  return function step(input) {',
      '    return input <= 1 ? input : input + step(input - 1);',
      '  };',
      '}',
    ].join('\n');

    const result = transformFilterToPipe(before);

    assertUnmatched(result);
    expect(result.reason).toContain('countdown');
    expect(result.reason).toContain('own name');
  });

  it('does not match a file with no .filter() registrations', () => {
    const before = "angular.module('app').service('foo', function () {});";

    const result = transformFilterToPipe(before);

    assertUnmatched(result);
    expect(result.reason).toBe('no pure filter registration found');
  });
});
