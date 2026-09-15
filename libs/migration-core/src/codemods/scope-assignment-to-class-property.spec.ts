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

  it('reports no match for a $scope.x = y that only exists inside a nested function shadowing $scope as its own parameter', () => {
    // Not a skip -- there genuinely is nothing for this pattern to do.
    // Binding resolution (not text/ancestor matching) correctly
    // recognizes the inner $scope.x = 1 refers to the $watch callback's
    // own shadowed `$scope` parameter, a completely different variable
    // than the controller's injected one, so it's excluded from the
    // candidate set entirely rather than transformed or flagged.
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
      reason: 'no bare-function controller with a $scope property assignment found',
    });
  });

  it('leaves a $scope.x = y shadowed by a nested var declaration untouched, while still transforming an unshadowed sibling', () => {
    // A real bug caught by actually running this codemod, before it even
    // reached adversarial review: a hand-rolled ancestor walk that only
    // checked nested-function *parameters* missed this entirely and
    // silently rewrote the inner (shadowed) assignment to `this.loaded`,
    // which would have set a property on the class instance instead of
    // on the local `fetchSnapshot()` result the original code actually
    // targeted. Real symbol resolution correctly tells the two `$scope`s
    // apart: the outer assignment (which does resolve to the injected
    // $scope) gets transformed, the inner one (a completely different
    // binding) is left exactly as written.
    const before = [
      "angular.module('app').controller('MainCtrl', function ($scope) {",
      '  $scope.refresh = function () {',
      '    var $scope = fetchSnapshot();',
      '    $scope.loaded = true;',
      '  };',
      '});',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    expect(result.output).toContain('this.refresh = function () {');
    expect(result.output).toContain('var $scope = fetchSnapshot();');
    expect(result.output).toContain('$scope.loaded = true;');
    expect(result.output).not.toContain('this.loaded');
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
      reason: "MainCtrl: a $scope property assignment is inside a nested function or accessor, not safely transformable — this would not refer to the class instance there",
    });
  });

  it('skips a controller whose $scope assignment is inside a getter, since accessors rebind this too', () => {
    // The nested-function boundary check originally enumerated only
    // FunctionExpression/ArrowFunction/FunctionDeclaration/
    // MethodDeclaration and missed accessor declarations -- a getter's
    // `this` is bound by how it's accessed, exactly like a plain
    // function, not lexically.
    const before = [
      "angular.module('app').controller('MainCtrl', function ($scope) {",
      "  Object.defineProperty($scope, 'computed', { get foo() { $scope.x = 1; } });",
      '});',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: "MainCtrl: a $scope property assignment is inside a nested function or accessor, not safely transformable — this would not refer to the class instance there",
    });
  });

  it('skips a controller whose $scope is reassigned as a bare identifier', () => {
    // A real, documented miss: $scope = $scope.$new() doesn't change
    // which declaration `$scope` resolves to (still the same parameter),
    // so symbol resolution alone wouldn't catch this -- but the runtime
    // value has changed, so a later `$scope.x = 1` would silently mutate
    // whatever $scope now holds, not the originally-injected value the
    // class constructor captures.
    const before = [
      "angular.module('app').controller('MainCtrl', function ($scope) {",
      '  $scope = $scope.$new();',
      '  $scope.x = 1;',
      '});',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'MainCtrl: $scope is reassigned within the function, not safely transformable',
    });
  });

  it('transforms the LHS of $scope.x = $scope.y + 1 but leaves the RHS reference as-is', () => {
    // Documented, intentional, correct behavior, not a bug: $scope stays
    // a constructor parameter regardless, so the untouched RHS $scope.y
    // continues to work exactly as before -- an incomplete migration of
    // that one reference, not a wrong one.
    const before = "angular.module('app').controller('MainCtrl', function ($scope) { $scope.x = $scope.y + 1; });";

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    expect(result.output).toContain('this.x = $scope.y + 1;');
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

  it('reports no match for a computed-property $scope assignment, not this pattern\'s shape', () => {
    const before = "angular.module('app').controller('MainCtrl', function ($scope) { $scope['x'] = 1; });";

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller with a $scope property assignment found',
    });
  });

  it('preserves source order when two controllers are chained in one statement', () => {
    const before = [
      "angular.module('app')",
      "  .controller('A', function ($scope) { $scope.a = 1; })",
      "  .controller('B', function ($scope) { $scope.b = 2; });",
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    const indexA = result.output.indexOf('class A {');
    const indexB = result.output.indexOf('class B {');
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexA).toBeLessThan(indexB);
    expect(result.output).toContain(".controller('A', A)");
    expect(result.output).toContain(".controller('B', B)");
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
