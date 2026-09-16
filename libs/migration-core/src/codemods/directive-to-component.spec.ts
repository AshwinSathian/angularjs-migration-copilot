import { describe, expect, it } from 'vitest';
import { assertCompiles } from './assert-compiles.js';
import { transformDirectiveToComponent } from './directive-to-component.js';
import type { CodemodResult } from './types.js';

function assertMatched(
  result: CodemodResult
): asserts result is { matched: true; output: string; warnings?: readonly string[] } {
  expect(result.matched).toBe(true);
  if (!result.matched) throw new Error('unreachable');
}

describe('transformDirectiveToComponent', () => {
  it('converts a named-reference directive with templateUrl and no controller to @Component', () => {
    // The dominant real-world shape (100% of this project's own vendored
    // fixtures): `.directive('name', name)` referencing a separately-
    // declared factory function, itself just `return {...};`.
    const before = [
      "angular.module('app').directive('backTop', backTop);",
      'function backTop() {',
      '  return {',
      "    restrict: 'E',",
      "    templateUrl: 'app/backTop/backTop.html'",
      '  };',
      '}',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('@Component({');
    expect(result.output).toContain("selector: 'back-top'");
    expect(result.output).toContain("templateUrl: 'app/backTop/backTop.html'");
    expect(result.output).toContain('class BackTopComponent {}');
    // The original registration and factory are left untouched — a
    // @Component-decorated class isn't valid AngularJS directive-factory
    // output, so there's no in-place swap the way patterns #1-#3 do.
    expect(result.output).toContain("angular.module('app').directive('backTop', backTop);");
    expect(result.output).toContain('function backTop() {');
  });

  it('supports the var-then-return factory body shape, the dominant idiom in one of this project\'s own vendored fixtures', () => {
    const before = [
      "angular.module('app').directive('includeReplace', includeReplace);",
      'function includeReplace() {',
      '  var directive = {',
      "    restrict: 'A',",
      "    templateUrl: 'app/include.html'",
      '  };',
      '  return directive;',
      '}',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain("selector: '[include-replace]'");
  });

  it('wraps an inline controller function into the emitted class constructor', () => {
    const before = [
      "angular.module('app').directive('widget', function ($http) {",
      '  return {',
      "    restrict: 'E',",
      "    template: '<div></div>',",
      '    controller: function ($scope) {',
      '      $scope.x = 1;',
      '    }',
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('class WidgetComponent {');
    expect(result.output).toContain('constructor(private $scope: any)');
    expect(result.output).toContain('$scope.x = 1;');
  });

  it('emits @Directive, not @Component, when neither template nor templateUrl is present', () => {
    const before = [
      "angular.module('app').directive('zoomIn', function () {",
      '  return {',
      "    restrict: 'A'",
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('@Directive({');
    expect(result.output).toContain("selector: '[zoom-in]'");
    expect(result.output).toContain('class ZoomInDirective {}');
  });

  it('reports no match for a file with no directive registrations', () => {
    const before = "angular.module('app').controller('MainCtrl', function () {});";

    const result = transformDirectiveToComponent(before);

    expect(result).toEqual({ matched: false, reason: 'no simple directive registration found' });
  });

  it('skips a directive with a link function — the dominant shape in this project\'s own vendored fixtures, uniformly raw DOM manipulation with no safe mapping', () => {
    const before = [
      "angular.module('app').directive('zoomIn', function () {",
      '  return {',
      "    restrict: 'A',",
      '    link: function ($scope, elem) {',
      "      elem.addClass('animated');",
      '    }',
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    expect(result).toEqual({
      matched: false,
      reason: 'zoomIn: has a link function — no safe syntactic mapping to Angular, out of scope for this pattern',
    });
  });

  it('skips a directive with a truthy transclude', () => {
    const before = [
      "angular.module('app').directive('baWizard', function () {",
      '  return {',
      "    restrict: 'E',",
      '    transclude: true,',
      "    templateUrl: 'wizard.html'",
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    expect(result).toEqual({
      matched: false,
      reason: 'baWizard: uses transclude — out of scope for this pattern',
    });
  });

  it('skips a directive with a compile function', () => {
    const before = [
      "angular.module('app').directive('foo', function () {",
      '  return {',
      '    compile: function () {}',
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    expect(result).toEqual({
      matched: false,
      reason: 'foo: has a compile function — out of scope for this pattern',
    });
  });

  it('skips a directive with an isolate scope — deferred to pattern #9', () => {
    const before = [
      "angular.module('app').directive('widgets', function () {",
      '  return {',
      "    restrict: 'EA',",
      "    scope: { ngModel: '=' },",
      "    templateUrl: 'widgets.html'",
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    expect(result).toEqual({
      matched: false,
      reason: "widgets: has an isolate scope — binding translation is pattern #9's job, not this one's",
    });
  });

  it('does not skip for scope: false or transclude: false — the AngularJS default, not an opt-in', () => {
    const before = [
      "angular.module('app').directive('foo', function () {",
      '  return {',
      "    restrict: 'E',",
      '    scope: false,',
      '    transclude: false,',
      "    templateUrl: 'foo.html'",
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    assertMatched(result);
  });

  it('skips a directive whose controller is a string reference to another registration — not resolvable within a single file', () => {
    // The dominant real-world shape for `controller` in this project's
    // own vendored fixtures: a string naming a separately-registered
    // `.controller(...)`, often in a different file entirely.
    const before = [
      "angular.module('app').directive('notifications', function () {",
      '  return {',
      "    restrict: 'E',",
      "    templateUrl: 'notifications.html',",
      "    controller: 'NotificationsPageCtrl'",
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    expect(result).toEqual({
      matched: false,
      reason: 'notifications: controller is a string, external reference, or an unsupported shape (e.g. method shorthand) — not resolvable within a single file',
    });
  });

  it('skips a directive whose factory body does more than return a single DDO literal', () => {
    const before = [
      "angular.module('app').directive('foo', function ($location) {",
      "  var isHome = $location.path() === '/';",
      '  return {',
      "    templateUrl: isHome ? 'home.html' : 'other.html'",
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    expect(result).toEqual({
      matched: false,
      reason: 'foo: factory function body is more than a single directive-definition-object literal — not safely transformable',
    });
  });

  it('reports no match for a directive whose second argument does not resolve to a function', () => {
    const before = "angular.module('app').directive('foo', 'not-a-function');";

    const result = transformDirectiveToComponent(before);

    expect(result).toEqual({
      matched: false,
      reason: 'foo: second argument is not a function or a resolvable named reference — not safely transformable',
    });
  });

  it('transforms a valid directive and surfaces a sibling skip as a warning, not silently', () => {
    const before = [
      "angular.module('app').directive('foo', function () {",
      "  return { restrict: 'E', templateUrl: 'foo.html' };",
      '});',
      "angular.module('app').directive('bar', function () {",
      '  return { transclude: true };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    assertMatched(result);
    expect(result.output).toContain('class FooComponent {}');
    expect(result.output).not.toContain('BarComponent');
    expect(result.warnings).toEqual(['bar: uses transclude — out of scope for this pattern']);
  });

  it('skips a directive whose derived class name collides with an existing top-level binding', () => {
    const before = [
      'function FooComponent() {}',
      "angular.module('app').directive('foo', function () {",
      "  return { restrict: 'E', templateUrl: 'foo.html' };",
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    expect(result).toEqual({
      matched: false,
      reason: 'foo: derived class name "FooComponent" collides with an existing name in this file — ambiguous, not safely transformable',
    });
  });

  it('derives an attribute selector for a restrict value combining A with a non-E letter, not just a pure "A" string', () => {
    // A one-letter regex (`/^A+$/`) previously misclassified a
    // multi-letter `restrict` naming 'A' but not 'E' (e.g. 'AC') as
    // element-style, since it wasn't a *pure* run of 'A' characters —
    // even though it just as clearly excludes 'E'.
    const before = [
      "angular.module('app').directive('foo', function () {",
      '  return {',
      "    restrict: 'AC',",
      "    templateUrl: 'foo.html'",
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    assertMatched(result);
    expect(result.output).toContain("selector: '[foo]'");
  });

  it('skips (does not silently drop) a controller written as ES6 method shorthand', () => {
    // Found by adversarial review: `getObjectLiteralPropertyValue` only
    // recognized a plain `key: value` property assignment, so a
    // method-shorthand `controller() {...}` (ordinary, valid JS) wasn't
    // even detected as *present* — the codemod silently treated the
    // directive as if it had no controller at all, emitting an empty
    // class with the controller's real logic dropped entirely, still
    // reporting `matched: true`. Confirmed by actually running this
    // exact input before the fix. Fixed by distinguishing "property
    // absent" from "property present but not a recognized shape" —
    // the latter is now a documented skip, not a silent no-op.
    const before = [
      "angular.module('app').directive('widget', function () {",
      '  return {',
      "    restrict: 'E',",
      "    template: '<div></div>',",
      '    controller() {',
      '      this.x = 1;',
      '    }',
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    expect(result).toEqual({
      matched: false,
      reason: 'widget: controller is a string, external reference, or an unsupported shape (e.g. method shorthand) — not resolvable within a single file',
    });
  });

  it('skips (does not silently drop) a template written as ES6 method shorthand', () => {
    // Same class of bug as the method-shorthand controller case, for
    // `template`: a method-shorthand `template(el, attrs) {...}` wasn't
    // detected as present, so the codemod silently downgraded the
    // directive to @Directive (no view) instead of skipping it —
    // dropping the entire view, not just failing to transform it.
    const before = [
      "angular.module('app').directive('widget', function () {",
      '  return {',
      "    restrict: 'E',",
      '    template(el, attrs) { return el; }',
      '  };',
      '});',
    ].join('\n');

    const result = transformDirectiveToComponent(before);

    expect(result).toEqual({
      matched: false,
      reason: 'widget: template is not a plain string literal — not safely transformable',
    });
  });
});
