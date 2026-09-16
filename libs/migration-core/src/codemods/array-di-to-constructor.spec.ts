import { describe, expect, it } from 'vitest';
import { assertCompiles } from './assert-compiles.js';
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

  it('inserts the class inside an enclosing IIFE, not hoisted above it, preserving closure-variable access', () => {
    // The dominant real-world shape (62 of 66 registration-bearing files
    // across this project's own vendored fixtures are IIFE-wrapped).
    // Hoisting the class all the way to the source file's top level would
    // sever any reference the body makes to a variable the IIFE closes
    // over.
    const before = [
      '(function () {',
      "  'use strict';",
      '  var helper = 42;',
      "  angular.module('app').controller('MainCtrl', ['$scope', function ($scope) {",
      '    $scope.x = helper + 1;',
      '  }]);',
      '})();',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    assertMatched(result);
    const iifeOpenIndex = result.output.indexOf('(function () {');
    const classIndex = result.output.indexOf('class MainCtrl {');
    expect(iifeOpenIndex).toBeGreaterThanOrEqual(0);
    expect(classIndex).toBeGreaterThan(iifeOpenIndex);
    expect(result.output).toContain('$scope.x = helper + 1;');
  });

  it('skips a registration whose name collides with an existing top-level function declaration', () => {
    const before = [
      'function MainCtrl() {}',
      "angular.module('app').controller('MainCtrl', ['$scope', function ($scope) {",
      '  $scope.x = 1;',
      '}]);',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason: 'MainCtrl: duplicate registration name in this file — ambiguous which one to keep, not safely transformable',
    });
  });

  it('skips a registration named after a reserved word', () => {
    const before = "angular.module('app').service('default', ['$http', function ($http) { this.x = $http; }]);";

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason: 'default: not a valid class identifier',
    });
  });

  it('resolves a same-name collision inside a chain in true source order, not traversal order', () => {
    // forEachPropertyAccessCall visits a chain's outermost (last-in-
    // source) call first. Without sorting by each call's own position
    // before deciding "which one is the duplicate," the second-in-source
    // registration (the .service call here) would win instead of the
    // first (.controller) — silently, and in reverse of what the earlier
    // non-chained duplicate-name test already locks in.
    const before = [
      "angular.module('app')",
      "  .controller('Foo', ['$scope', function ($scope) { $scope.a = 1; }])",
      "  .service('Foo', ['$http', function ($http) { this.b = $http; }]);",
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    assertMatched(result);
    expect(result.output).toContain('constructor(private $scope: any) { $scope.a = 1; }');
    expect(result.output).toContain(".controller('Foo', Foo)");
    // The losing registration is left untouched, not deleted — same as
    // every other skip case, just still array-style DI.
    expect(result.output).toContain(".service('Foo', ['$http', function ($http) { this.b = $http; }])");
    expect(result.warnings).toEqual([
      'Foo: duplicate registration name in this file — ambiguous which one to keep, not safely transformable',
    ]);
  });

  // Patterns #1/#2 (ADR-030) found their shared `.controller('X', X)`-style
  // named-reference shape was the dominant real-world idiom, and that the
  // inline-literal-only detection that predated it matched zero real
  // controllers in this project's own vendored fixtures. Pattern #3's
  // array-style-DI last-array-element check had the identical gap,
  // flagged but not investigated or fixed when pattern #2 landed — these
  // are that fix, reusing the same `resolveNamedFunctionDeclaration`/
  // `hasOtherReferences` real-symbol-binding checks rather than
  // re-deriving them.
  it('resolves an array-style DI last element that is an identifier referencing a separately-declared function', () => {
    const before = [
      'function ctrlImpl($scope, $http) {',
      '  $scope.items = [];',
      '}',
      "angular.module('app').controller('MainCtrl', ['$scope', '$http', ctrlImpl]);",
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).toContain('constructor(private $scope: any, private $http: any)');
    expect(result.output).toContain('$scope.items = [];');
    expect(result.output).toContain("angular.module('app').controller('MainCtrl', MainCtrl);");
    expect(result.output).not.toContain('function ctrlImpl');
  });

  it('deletes the referenced function\'s $inject annotations alongside its declaration', () => {
    // Redundant with the array's own dependency names once the class is
    // built — left in place it's a real `Property '$inject' does not
    // exist on type 'typeof MainCtrl'` error, same class of bug ADR-031
    // fixed for the bare-function `.controller('X', X)` shape.
    const before = [
      'function ctrlImpl($scope) {',
      '  $scope.x = 1;',
      '}',
      "ctrlImpl.$inject = ['$scope'];",
      "angular.module('app').controller('MainCtrl', ['$scope', ctrlImpl]);",
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).not.toContain('$inject');
  });

  it('skips a named-reference array element whose function is also referenced elsewhere in the file', () => {
    // Deleting the shared function would break the other reference — the
    // same ambiguity ADR-033 guards against for bare-function DI.
    const before = [
      'function ctrlImpl($scope) {',
      '  $scope.x = 1;',
      '}',
      'ctrlImpl.prototype.helper = function () {};',
      "angular.module('app').controller('MainCtrl', ['$scope', ctrlImpl]);",
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason:
        "MainCtrl: array's last element references a function used elsewhere in the file — ambiguous, not safely transformable",
    });
  });

  it('skips a named-reference array element whose identifier does not resolve to a function declaration', () => {
    const before = [
      'var ctrlImpl = function ($scope) {',
      '  $scope.x = 1;',
      '};',
      "angular.module('app').controller('MainCtrl', ['$scope', ctrlImpl]);",
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason: "MainCtrl: array's last element is not a function — not safely transformable",
    });
  });

  it('skips a registration that registers itself from inside its own body', () => {
    // Found by adversarial review: `hasOtherReferences` only rejected an
    // *other* reference, so a registration call nested inside the very
    // function it registers — its only reference — was accepted, but the
    // class-insertion point (the call's own enclosing statement) then
    // fell inside that same function's deleted range, corrupting the
    // output. Confirmed by actually running this exact input before the
    // fix: `matched: true`, visibly truncated and unbalanced output.
    // Fixed at the shared root in class-wrapping.ts's `hasOtherReferences`
    // — the same fix also protects the already-merged bare-function
    // `.controller('X', X)` path (scope-assignment-to-class-property.spec.ts
    // has the mirrored regression test).
    const before = [
      'function ctrlImpl($scope) {',
      "  angular.module('app').controller('MainCtrl', ['$scope', ctrlImpl]);",
      '}',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    expect(result).toEqual({
      matched: false,
      reason:
        "MainCtrl: array's last element references a function used elsewhere in the file — ambiguous, not safely transformable",
    });
  });

  it('skips an outer registration whose body contains a second, unrelated registration nested inside it, but still transforms the inner one', () => {
    // A broader form of the self-registration bug above, found by a
    // second adversarial review round: `hasOtherReferences` only rules
    // out an *other* reference to a candidate's own function, not a
    // sibling candidate's edit positions sitting nested inside this
    // candidate's own deletion range. Deleting ctrlImpl's declaration
    // here would also delete the text OtherCtrl's own insertion/
    // replacement edits are computed against, corrupting output while
    // still reporting `matched: true` — confirmed by actually running
    // this exact input before the fix. Fixed in
    // `findNestedDeletionConflicts` (class-wrapping.ts), shared with the
    // bare-function `.controller('X', X)` path (mirrored regression
    // tests in scope-assignment-to-class-property.spec.ts and
    // controlleras-to-class.spec.ts).
    const before = [
      'function ctrlImpl($scope) {',
      '  $scope.x = 1;',
      "  angular.module('app').controller('OtherCtrl', ['$scope', otherFn]);",
      '}',
      'function otherFn($scope) {',
      '  $scope.y = 2;',
      '}',
      "angular.module('app').controller('MainCtrl', ['$scope', ctrlImpl]);",
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).not.toContain('class MainCtrl');
    expect(result.output).toContain('class OtherCtrl {');
    expect(result.output).toContain('function ctrlImpl($scope)');
    expect(result.warnings).toEqual([
      'MainCtrl: deleting the referenced function would also corrupt another registration nested inside it — not safely transformable',
    ]);
  });

  it('skips an outer registration whose inline function body contains a second registration nested inside it, but still transforms the inner one', () => {
    // A gap in the nesting-conflict fix above, found by a later
    // adversarial review round: `findNestedDeletionConflicts` only
    // treated a *named-declaration* deletion range as something a
    // sibling candidate's edits could be corrupted by nesting inside.
    // But an *inline* function/arrow literal candidate's own replaced
    // span (the whole array, including the entire inline body) is just
    // as much a "this text is gone" edit once it's replaced by the bare
    // class name — confirmed by actually running this exact input before
    // the fix: `matched: true` with visibly garbled, misaligned output
    // (`angular.module('app').controller('Outer', Outerontroller('Inner'`
    // ...). Fixed by making every candidate's own deleted/replaced range
    // — not just a named declaration's — a conflict source in
    // `findNestedDeletionConflicts` (class-wrapping.ts).
    const before = [
      "angular.module('app').controller('Outer', ['$scope', function ($scope) {",
      "  angular.module('app').controller('Inner', ['$http', function ($http) {",
      "    $http.get('/x');",
      '  }]);',
      '}]);',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).not.toContain('class Outer');
    expect(result.output).toContain('class Inner {');
    expect(result.output).toContain("angular.module('app').controller('Outer', ['$scope', function ($scope) {");
  });
});
