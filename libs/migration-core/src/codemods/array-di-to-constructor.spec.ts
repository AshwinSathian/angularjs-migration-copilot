import { describe, expect, it } from 'vitest';
import { transformArrayStyleDiToConstructor } from './array-di-to-constructor.js';
import type { CodemodResult } from './types.js';

function assertMatched(
  result: CodemodResult
): asserts result is { matched: true; output: string; warnings?: readonly string[] } {
  expect(result.matched).toBe(true);
  if (!result.matched) throw new Error('unreachable');
}

describe('transformArrayStyleDiToConstructor', () => {
  it('converts an array-style DI controller to a class with constructor injection', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', ['$scope', '$http', function ($scope, $http) {",
      '  $scope.items = [];',
      '}]);',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).toContain('constructor(private $scope: any, private $http: any)');
    expect(result.output).toContain('$scope.items = [];');
    expect(result.output).toContain("angular.module('app').controller('MainCtrl', MainCtrl);");
  });

  it('converts an array-style DI service and an array-style DI factory in the same file', () => {
    const before = [
      "angular.module('app').service('LogService', ['$log', function ($log) {",
      '  this.log = $log;',
      '}]);',
      "angular.module('app').factory('UserFactory', ['$http', function ($http) {",
      '  return {};',
      '}]);',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    assertMatched(result);
    expect(result.output).toContain('class LogService {');
    expect(result.output).toContain('class UserFactory {');
    expect(result.output).toContain("angular.module('app').service('LogService', LogService);");
    expect(result.output).toContain("angular.module('app').factory('UserFactory', UserFactory);");
  });

  it('reports no match for a file with no array-style DI registrations', () => {
    const before = "angular.module('app').controller('MainCtrl', function ($scope) {});";

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no array-style DI controller/service/factory registration found',
    });
  });

  it('skips a registration whose dependency-name count does not match its function parameter count', () => {
    // A real, documented miss, not just the happy path: minified or
    // hand-edited code can leave the array's string tokens out of sync
    // with the function's actual parameter list. Binding them positionally
    // anyway would silently produce a wrong constructor, so this is
    // flagged rather than guessed at.
    const before = [
      "angular.module('app').controller('MainCtrl', ['$scope', '$http', function ($scope) {",
      '  $scope.items = [];',
      '}]);',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason:
        "MainCtrl: dependency array has 2 names but the function declares 1 parameter(s) — ambiguous binding, not safely transformable",
    });
  });

  it('skips a registration whose name is not a valid class identifier', () => {
    const before = [
      "angular.module('app').controller('Main-Ctrl', ['$scope', function ($scope) {",
      '  $scope.items = [];',
      '}]);',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason: "Main-Ctrl: not a valid class identifier",
    });
  });

  it('leaves bare-function-style DI (no array) untouched — not this pattern', () => {
    const before = "angular.module('app').directive('myWidget', ['$log', function ($log) { return {}; }]);";

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no array-style DI controller/service/factory registration found',
    });
  });

  it('transforms a valid registration and surfaces a sibling skip as a warning, not silently', () => {
    // The skip must not vanish just because a different registration in
    // the same file succeeded — that would be exactly the silent no-op
    // CLAUDE.md's reporting-honesty rule forbids.
    const before = [
      "angular.module('app').controller('MainCtrl', ['$scope', function ($scope) {",
      '  $scope.x = 1;',
      '}]);',
      "angular.module('app').controller('Main-Ctrl', ['$scope', function ($scope) {",
      '  $scope.y = 2;',
      '}]);',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).not.toContain('class Main-Ctrl');
    expect(result.warnings).toEqual(["Main-Ctrl: not a valid class identifier"]);
  });

  it('skips the second of two registrations sharing a duplicate name in one file', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', ['$scope', function ($scope) {",
      '  $scope.x = 1;',
      '}]);',
      "angular.module('admin').controller('MainCtrl', ['$scope', function ($scope) {",
      '  $scope.y = 2;',
      '}]);',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    assertMatched(result);
    expect(result.output.match(/class MainCtrl {/g)).toHaveLength(1);
    expect(result.warnings).toEqual([
      'MainCtrl: duplicate registration name in this file — ambiguous which one to keep, not safely transformable',
    ]);
  });

  it('preserves source order when three registrations are chained in one statement', () => {
    // All three calls share the same top-level statement, so their class
    // insertions land at an identical position — a naive one-edit-at-a-
    // time splice would reverse their order.
    const before = [
      "angular.module('app')",
      "  .controller('A', ['$scope', function ($scope) { $scope.a = 1; }])",
      "  .controller('B', ['$http', function ($http) { $http.get('/x'); }])",
      "  .controller('C', ['$log', function ($log) { $log.info('c'); }]);",
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    assertMatched(result);
    const { output } = result;
    const [indexA, indexB, indexC] = ['class A {', 'class B {', 'class C {'].map((needle) =>
      output.indexOf(needle)
    );
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexA).toBeLessThan(indexB);
    expect(indexB).toBeLessThan(indexC);
  });

  it('skips a registration whose function has a destructured parameter', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', ['x', function ({ $scope }) {",
      '  $scope.a = 1;',
      '}]);',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason: 'MainCtrl: has a destructured, default-valued, or rest parameter — not safely transformable',
    });
  });

  it('skips a registration whose function has a default-valued parameter', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', ['$scope', function ($scope = null) {",
      '  $scope.a = 1;',
      '}]);',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason: 'MainCtrl: has a destructured, default-valued, or rest parameter — not safely transformable',
    });
  });

  it('skips a registration whose array-style DI last element is not a function', () => {
    const before = "angular.module('app').controller('MainCtrl', ['$scope', '$scope']);";

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason: "MainCtrl: array's last element is not a function — not safely transformable",
    });
  });
});
