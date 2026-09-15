import { describe, expect, it } from 'vitest';
import { transformScopeAssignmentToClassProperty } from './scope-assignment-to-class-property.js';
import type { CodemodResult } from './types.js';

function assertMatched(
  result: CodemodResult
): asserts result is { matched: true; output: string; warnings?: readonly string[] } {
  expect(result.matched).toBe(true);
  if (!result.matched) throw new Error('unreachable');
}

describe('transformScopeAssignmentToClassProperty', () => {
  it('converts $scope.x = y assignments to this.x = y inside a wrapped class', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', function ($scope, $http) {",
      "  $scope.items = [];",
      "  $scope.loading = false;",
      '});',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).toContain('constructor(private $scope: any, private $http: any)');
    expect(result.output).toContain('this.items = [];');
    expect(result.output).toContain('this.loading = false;');
    expect(result.output).not.toContain('$scope.items');
    expect(result.output).not.toContain('$scope.loading');
    expect(result.output).toContain("angular.module('app').controller('MainCtrl', MainCtrl);");
  });

  it('leaves non-assignment $scope usage (method calls) untouched inside the same body', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', function ($scope) {",
      '  $scope.x = 1;',
      "  $scope.$watch('x', function () {});",
      "  $scope.$on('event', function () {});",
      '});',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    expect(result.output).toContain('this.x = 1;');
    expect(result.output).toContain("$scope.$watch('x', function () {});");
    expect(result.output).toContain("$scope.$on('event', function () {});");
  });

  it('reports no match for a controller with no $scope property assignment', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', function ($scope) {",
      "  $scope.$watch('x', function () {});",
      '});',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller with a $scope property assignment found',
    });
  });

  it('reports no match for a controller that does not inject $scope at all', () => {
    const before = "angular.module('app').controller('MainCtrl', function ($http) { $http.get('/x'); });";

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller with a $scope property assignment found',
    });
  });

  it('leaves array-style DI untouched — not this pattern (that is pattern #3)', () => {
    const before = "angular.module('app').controller('MainCtrl', ['$scope', function ($scope) { $scope.x = 1; }]);";

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller with a $scope property assignment found',
    });
  });

  it('leaves .service and .factory untouched — pattern #1 is controller-only', () => {
    const before = "angular.module('app').service('LogService', function ($scope) { $scope.x = 1; });";

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller with a $scope property assignment found',
    });
  });

  it('skips a controller whose $scope is shadowed by a nested function parameter', () => {
    // A real, documented miss: the $scope.x = 1 inside the $watch
    // callback below refers to a *different*, shadowed $scope, not the
    // outer controller's own injected one — rewriting it to `this.x = 1`
    // would silently change which scope gets mutated.
    const before = [
      "angular.module('app').controller('MainCtrl', function ($scope) {",
      "  $scope.$watch('x', function (newVal, oldVal, $scope) {",
      '    $scope.x = 1;',
      '  });',
      '});',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: "MainCtrl: a $scope property assignment is inside a nested function, not safely transformable — this would not refer to the class instance there, and/or $scope may be shadowed",
    });
  });

  it('skips a controller whose $scope assignment is inside a nested plain (non-arrow) function, even without shadowing', () => {
    // A real bug caught by actually running this codemod against a
    // realistic file: a nested `function (res) { $scope.x = ... }`
    // callback (e.g. a $http .then() handler) doesn't redeclare $scope,
    // so it isn't "shadowed" -- but `this` inside a plain function
    // rebinds based on how it's called, not lexically, so `this.x` there
    // would not refer to the class instance the way `$scope.x` correctly
    // refers to the outer scope via closure.
    const before = [
      "angular.module('app').controller('MainCtrl', function ($scope, $http) {",
      "  $http.get('/x').then(function (res) {",
      '    $scope.items = res.data;',
      '  });',
      '});',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: "MainCtrl: a $scope property assignment is inside a nested function, not safely transformable — this would not refer to the class instance there, and/or $scope may be shadowed",
    });
  });

  it('safely transforms a $scope assignment inside a nested arrow function, since arrows do not rebind this', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', function ($scope, $http) {",
      "  $http.get('/x').then((res) => {",
      '    $scope.items = res.data;',
      '  });',
      '});',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    expect(result.output).toContain('this.items = res.data;');
  });

  it('skips a controller whose name is not a valid class identifier', () => {
    const before = "angular.module('app').controller('Main-Ctrl', function ($scope) { $scope.x = 1; });";

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'Main-Ctrl: not a valid class identifier',
    });
  });

  it('skips a controller whose function has a destructured parameter', () => {
    const before = "angular.module('app').controller('MainCtrl', function ($scope, { x }) { $scope.a = x; });";

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'MainCtrl: has a destructured, default-valued, or rest parameter — not safely transformable',
    });
  });

  it('inserts the class inside an enclosing IIFE, not hoisted above it', () => {
    const before = [
      '(function () {',
      "  'use strict';",
      '  var helper = 42;',
      "  angular.module('app').controller('MainCtrl', function ($scope) {",
      '    $scope.x = helper + 1;',
      '  });',
      '})();',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    const iifeOpenIndex = result.output.indexOf('(function () {');
    const classIndex = result.output.indexOf('class MainCtrl {');
    expect(classIndex).toBeGreaterThan(iifeOpenIndex);
    expect(result.output).toContain('this.x = helper + 1;');
  });

  it('transforms one controller and surfaces a sibling skip as a warning', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', function ($scope) {",
      '  $scope.x = 1;',
      '});',
      "angular.module('app').controller('Main-Ctrl', function ($scope) {",
      '  $scope.y = 2;',
      '});',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).not.toContain('class Main-Ctrl');
    expect(result.warnings).toEqual(["Main-Ctrl: not a valid class identifier"]);
  });
});
