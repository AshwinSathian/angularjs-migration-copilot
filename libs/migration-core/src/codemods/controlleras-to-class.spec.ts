import { describe, expect, it } from 'vitest';
import { transformControllerAsToClass } from './controlleras-to-class.js';
import type { CodemodResult } from './types.js';

function assertMatched(
  result: CodemodResult
): asserts result is { matched: true; output: string; warnings?: readonly string[] } {
  expect(result.matched).toBe(true);
  if (!result.matched) throw new Error('unreachable');
}

describe('transformControllerAsToClass', () => {
  it('wraps a direct this.x = y controllerAs controller into a class, unchanged internally', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', function ($http) {",
      '  this.items = [];',
      '  this.loading = false;',
      '});',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).toContain('constructor(private $http: any)');
    expect(result.output).toContain('this.items = [];');
    expect(result.output).toContain('this.loading = false;');
    expect(result.output).toContain("angular.module('app').controller('MainCtrl', MainCtrl);");
  });

  it('wraps a var vm = this alias controllerAs controller into a class, unchanged internally', () => {
    const before = [
      "angular.module('app').controller('WizardCtrl', function ($scope) {",
      '  var vm = this;',
      '  vm.personalInfo = {};',
      '  vm.arePasswordsEqual = function () {',
      '    return vm.personalInfo.password === vm.personalInfo.confirmPassword;',
      '  };',
      '});',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    expect(result.output).toContain('class WizardCtrl {');
    expect(result.output).toContain('constructor(private $scope: any)');
    expect(result.output).toContain('var vm = this;');
    expect(result.output).toContain('vm.personalInfo = {};');
    expect(result.output).toContain('return vm.personalInfo.password === vm.personalInfo.confirmPassword;');
  });

  it('recognizes any alias name, not just vm (e.g. self)', () => {
    const before = [
      "angular.module('app').controller('DetailCtrl', function () {",
      '  var self = this;',
      '  self.title = "hi";',
      '});',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    expect(result.output).toContain('class DetailCtrl {');
    expect(result.output).toContain('self.title = "hi";');
  });

  it('reports no match for a controller with no this/alias property assignment', () => {
    const before = "angular.module('app').controller('MainCtrl', function ($http) { $http.get('/x'); });";

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller using the controllerAs (this/vm) idiom found',
    });
  });

  it('skips a controller that also has a $scope property assignment — pattern #1 handles it, not double-counted here', () => {
    const before = [
      "angular.module('app').controller('MixedCtrl', function ($scope) {",
      '  this.title = "hi";',
      '  $scope.legacy = true;',
      '});',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'MixedCtrl: also has a $scope property assignment — handled by pattern #1, not double-counted here',
    });
  });

  it('does not treat this.x = y inside a nested non-arrow function as a controllerAs hit', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', function ($http) {",
      '  $http.get("/x").then(function (res) {',
      '    this.data = res.data;',
      '  });',
      '});',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller using the controllerAs (this/vm) idiom found',
    });
  });

  it('does not treat var vm = this declared inside a nested non-arrow function as a valid alias', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', function ($http) {",
      '  $http.get("/x").then(function (res) {',
      '    var vm = this;',
      '    vm.data = res.data;',
      '  });',
      '});',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller using the controllerAs (this/vm) idiom found',
    });
  });

  it('still fires on an outer alias assignment when a nested function has its own unrelated this.x = y', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', function () {",
      '  var vm = this;',
      '  vm.title = "hi";',
      '  document.addEventListener("click", function () {',
      '    this.ignored = true;',
      '  });',
      '});',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).toContain('vm.title = "hi";');
    expect(result.output).toContain('this.ignored = true;');
  });

  it('reports no match for array-style DI (pattern #3\'s job, not this one\'s)', () => {
    const before = "angular.module('app').controller('MainCtrl', ['$http', function ($http) { this.x = 1; }]);";

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller using the controllerAs (this/vm) idiom found',
    });
  });

  it('skips a duplicate registration name and still transforms the first', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', function () { this.a = 1; });",
      "angular.module('app').controller('MainCtrl', function () { this.b = 2; });",
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    expect(result.output).toContain('this.a = 1;');
    expect(result.warnings).toContain(
      'MainCtrl: duplicate registration name in this file — ambiguous which one to keep, not safely transformable'
    );
  });

  it('skips a controller with a destructured parameter', () => {
    const before = "angular.module('app').controller('MainCtrl', function ({ $http }) { this.x = $http; });";

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'MainCtrl: has a destructured, default-valued, or rest parameter — not safely transformable',
    });
  });

  it('transforms two chained controllerAs registrations in true source order', () => {
    const before = [
      "angular.module('app')",
      "  .controller('FirstCtrl', function () { this.a = 1; })",
      "  .controller('SecondCtrl', function () { this.b = 2; });",
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    const firstIndex = result.output.indexOf('class FirstCtrl');
    const secondIndex = result.output.indexOf('class SecondCtrl');
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it('transforms the .controller("X", X) named-reference idiom — the dominant real-world shape (ADR-030), not just the inline-literal one', () => {
    // Confirmed against real blur-admin fixture files (WizardCtrl,
    // MailTabCtrl, ...): this idiom, not an inline literal, is how every
    // real controllerAs controller in this project's own fixtures is
    // actually registered. The function declaration is replaced in
    // place; the registration line needs no edit.
    const before = [
      "angular.module('app').controller('WizardCtrl', WizardCtrl);",
      '',
      '/** @ngInject */',
      'function WizardCtrl($scope) {',
      '  var vm = this;',
      '  vm.personalInfo = {};',
      '}',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    expect(result.output).toContain("angular.module('app').controller('WizardCtrl', WizardCtrl);");
    expect(result.output).toContain('class WizardCtrl {');
    expect(result.output).toContain('constructor(private $scope: any)');
    expect(result.output).toContain('var vm = this;');
    expect(result.output).toContain('vm.personalInfo = {};');
    expect(result.output).not.toContain('function WizardCtrl');
  });

  it('does not collide with its own pre-existing function declaration when deleting and re-inserting a named reference', () => {
    // hasExistingTopLevelBinding would otherwise find the very
    // FunctionDeclaration this candidate resolved from and reject it as
    // a duplicate of itself — classWrappingSkipReason's ignoreOwnBinding
    // parameter exists specifically to exclude that non-collision.
    const before = "angular.module('app').controller('MainCtrl', MainCtrl);\nfunction MainCtrl() { this.x = 1; }";

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.warnings ?? []).toEqual([]);
  });

  it('declares the class before the .controller(X, X) call, not after, since class declarations do not hoist the way the original function did', () => {
    // A real bug caught by adversarial review, then confirmed by
    // actually typechecking the output with tsc, not assumed from
    // reading the splice logic: replacing the function in its own
    // (later) textual position left the earlier call referencing the
    // class before its declaration — a real TS2449 compile error. The
    // fix inserts the class before the call instead of at the function's
    // original position.
    const before = "angular.module('app').controller('MainCtrl', MainCtrl);\nfunction MainCtrl() { this.x = 1; }";

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    const classIndex = result.output.indexOf('class MainCtrl {');
    const callIndex = result.output.indexOf(".controller('MainCtrl', MainCtrl)");
    expect(classIndex).toBeGreaterThanOrEqual(0);
    expect(classIndex).toBeLessThan(callIndex);
    expect(result.output).not.toContain('function MainCtrl');
  });

  it('deletes a Ctrl.$inject = [...] annotation alongside the named declaration, since it becomes a TypeScript error once the binding is a class', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', MainCtrl);",
      '',
      "MainCtrl.$inject = ['$http'];",
      'function MainCtrl($http) {',
      '  this.x = 1;',
      '}',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).not.toContain('$inject');
  });

  it('skips a controller whose only $scope assignment is inside a this-rebinding boundary, rather than wrongly deferring to pattern #1', () => {
    // A real bug caught by adversarial review: hasScopePropertyAssignment
    // originally reported true for any $scope property assignment
    // anywhere in the function, including one inside a nested non-arrow
    // callback that pattern #1 itself would skip the whole registration
    // for. That made pattern #2 defer a controller with a perfectly safe
    // top-level `this.title = ...` assignment to "pattern #1's
    // territory" even though pattern #1 would never actually transform
    // it either — silently missed by both.
    const before = [
      "angular.module('app').controller('MainCtrl', function ($scope, $http) {",
      "  this.title = 'hi';",
      "  $http.get('/x').then(function (res) {",
      '    $scope.legacy = res.data;',
      '  });',
      '});',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).toContain("this.title = 'hi';");
  });

  it('skips a second registration that resolves to the same already-claimed named function declaration', () => {
    // A real corruption bug caught by adversarial review: two matches
    // referencing the same underlying FunctionDeclaration each scheduled
    // their own deletion of its (identical) source span computed against
    // the *original* text; applying both against the once-shrunk output
    // spliced into unrelated, already-shifted content. The fix dedups by
    // the underlying function node, not just by class name — this case
    // is additionally blocked by requiring the call's own identifier
    // text to match the registration name, so it also never reaches the
    // dedup path in practice; asserting the guard directly here.
    const before = "angular.module('app').controller('MainCtrl', MainCtrl);\nangular.module('app').controller('MainCtrl', MainCtrl);\nfunction MainCtrl() { this.x = 1; }";

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect((result.output.match(/class MainCtrl/g) ?? []).length).toBe(1);
  });
});
