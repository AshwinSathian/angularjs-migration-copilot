import { describe, expect, it } from 'vitest';
import { assertCompiles } from './assert-compiles.js';
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

  it('transforms the .controller("X", X) named-reference idiom — the dominant real-world shape, not just the inline-literal one', () => {
    // Found by actually running this codemod against real blur-admin
    // fixture files, not assumed: `.controller('X', X)` referencing a
    // separately-declared `function X (...) {...}` is ~73% of real
    // `.controller` calls across this project's own vendored fixtures
    // (66/91), and 0% use an inline function literal — see ADR-030. The
    // whole function declaration is replaced in place; the registration
    // line, already `.controller('MainCtrl', MainCtrl)`, needs no edit.
    const before = [
      "angular.module('app').controller('MainCtrl', MainCtrl);",
      '',
      '/** @ngInject */',
      'function MainCtrl($scope) {',
      '  $scope.items = [];',
      '}',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    expect(result.output).toContain("angular.module('app').controller('MainCtrl', MainCtrl);");
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).toContain('constructor(private $scope: any)');
    expect(result.output).toContain('this.items = [];');
    expect(result.output).not.toContain('function MainCtrl');
    assertCompiles(result.output);
  });

  it('resolves a named declaration even when a Ctrl.$inject = [...] ng-annotate assignment sits between the call and the declaration', () => {
    // A real bug caught by actually running this codemod against the
    // CoreUI-AngularJS fixture, not assumed: TypeScript's JS binder
    // records `cardChartCtrl1.$inject = ['$scope'];` as a second,
    // non-function "declaration" of the same symbol (an expando-property
    // assignment target), so a resolver requiring exactly one
    // declaration rejected every controller using this equally-common
    // manual-DI idiom as ambiguous — zero matches across the whole
    // fixture before the fix. See ADR-030.
    const before = [
      "angular.module('app').controller('MainCtrl', MainCtrl);",
      '',
      "MainCtrl.$inject = ['$scope'];",
      'function MainCtrl($scope) {',
      '  $scope.labels = [1];',
      '}',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).toContain('this.labels = [1];');
    expect(result.output).not.toContain('function MainCtrl');
    assertCompiles(result.output);
  });

  it('deletes every $inject annotation for the same function, not just the first', () => {
    // A real bug caught by a second adversarial review round: an earlier
    // version of findInjectAssignmentStatements returned the *first*
    // matching statement and stopped, silently leaving a second
    // `Ctrl.$inject = [...]` assignment in the output — a real TS2339
    // once the binding is a class, confirmed by actually running the
    // codemod and typechecking the result before this fix.
    const before = [
      "angular.module('app').controller('MainCtrl', MainCtrl);",
      "MainCtrl.$inject = ['$scope'];",
      "MainCtrl.$inject = ['$scope'];",
      'function MainCtrl($scope) { $scope.x = 1; }',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).not.toContain('$inject');
    assertCompiles(result.output);
  });

  it('leaves a $inject assignment nested inside another expression untouched, and skips the whole candidate rather than delete the wrong range', () => {
    // A critical bug caught by a second adversarial review round:
    // getFirstAncestorByKind walked past the ParenthesizedExpression/
    // VariableDeclaration wrapper and resolved `var deps = (MainCtrl.$inject
    // = [...])` to the *enclosing var statement* — deleting that, rather
    // than refusing to touch it, deleted unrelated surrounding code.
    // Now rejected outright: the assignment's own identifier counts as
    // an unaccounted-for reference to the function, so the whole
    // candidate is safely skipped instead of guessed at.
    const before = [
      '(function () {',
      '  function MainCtrl($scope) { $scope.x = 1; }',
      "  var deps = (MainCtrl.$inject = ['$scope']);",
      "  angular.module('app').controller('MainCtrl', MainCtrl);",
      '  var KEEP = "SHOULD_SURVIVE";',
      '})();',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller with a $scope property assignment found',
    });
  });

  it('skips a candidate whose function is referenced somewhere other than its own .controller(X, X) call', () => {
    // A real bug caught by a second adversarial review round: ADR-031
    // claimed the class is "always declared before its only reference,"
    // but nothing verified it actually was the *only* one. A
    // `.prototype` extension before the registration resurfaces the
    // exact TS2449 bug this named-declaration path exists to avoid.
    const before = [
      'function MainCtrl($scope) { $scope.x = 1; }',
      'MainCtrl.prototype.helper = function () { return 1; };',
      "angular.module('app').controller('MainCtrl', MainCtrl);",
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller with a $scope property assignment found',
    });
  });

  it('replaces a named declaration inside its own IIFE in place, without hoisting it out', () => {
    const before = [
      '(function () {',
      "  'use strict';",
      "  angular.module('app').controller('MainCtrl', MainCtrl);",
      '',
      '  function MainCtrl($scope) {',
      '    $scope.x = 1;',
      '  }',
      '})();',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    const iifeOpenIndex = result.output.indexOf('(function () {');
    const classIndex = result.output.indexOf('class MainCtrl {');
    expect(classIndex).toBeGreaterThan(iifeOpenIndex);
    expect(result.output).toContain('this.x = 1;');
    assertCompiles(result.output);
  });

  it('declares the class before the .controller(X, X) call, not after, since class declarations do not hoist the way the original function did', () => {
    // A real bug caught by adversarial review, then confirmed by
    // actually typechecking the output with tsc, not assumed from
    // reading the splice logic: replacing the function in its own
    // (later) textual position left the earlier call referencing the
    // class before its declaration — a real TS2449 compile error,
    // confirmed against every real hit this fix had claimed. The fix
    // inserts the class before the call instead of at the function's
    // original position.
    const before = "angular.module('app').controller('MainCtrl', MainCtrl);\nfunction MainCtrl($scope) { $scope.x = 1; }";

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    const classIndex = result.output.indexOf('class MainCtrl {');
    const callIndex = result.output.indexOf(".controller('MainCtrl', MainCtrl)");
    expect(classIndex).toBeGreaterThanOrEqual(0);
    expect(classIndex).toBeLessThan(callIndex);
    expect(result.output).not.toContain('function MainCtrl');
    assertCompiles(result.output);
  });

  it('deletes a Ctrl.$inject = [...] annotation alongside the named declaration, since it becomes a TypeScript error once the binding is a class', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', MainCtrl);",
      '',
      "MainCtrl.$inject = ['$scope'];",
      'function MainCtrl($scope) {',
      '  $scope.x = 1;',
      '}',
    ].join('\n');

    const result = transformScopeAssignmentToClassProperty(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).not.toContain('$inject');
    assertCompiles(result.output);
  });

  it('matches neither of two registrations that reference the same named function declaration', () => {
    // A real corruption bug caught by adversarial review: two matches
    // referencing the same underlying FunctionDeclaration each scheduled
    // deletion of its (identical) source span computed against the
    // *original* text; applying both against the once-shrunk output
    // spliced into unrelated, already-shifted content.
    //
    // A second review round found that transforming just one of the two
    // isn't actually safe either — the surviving call's own class
    // insertion doesn't guarantee the class is declared before an
    // untouched sibling call if that sibling sits earlier in the file,
    // resurfacing the TDZ bug this path exists to avoid. `hasOtherReferences`
    // now rejects both candidates upstream instead, before either
    // reaches `collectBareFunctionControllerMatches`' rawMatches array —
    // see controlleras-to-class.spec.ts's identical test for the full
    // reasoning. `claimedNamedDeclarations` remains as defense-in-depth,
    // but this scenario no longer reaches it.
    const before = "angular.module('app').controller('MainCtrl', MainCtrl);\nangular.module('app').controller('MainCtrl', MainCtrl);\nfunction MainCtrl($scope) { $scope.x = 1; }";

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller with a $scope property assignment found',
    });
  });

  it('skips a controller that registers itself from inside its own body', () => {
    // Found by adversarial review of pattern #3's own reuse of
    // `hasOtherReferences`: a registration call nested inside the very
    // function it registers is the *only* reference to that function, so
    // the "any other reference" check alone accepted it — but the class
    // insertion point (the call's own enclosing statement) then falls
    // inside the function's own deleted range, and `applyEdits` spliced
    // the two overlapping edits as if disjoint. Confirmed by actually
    // running this exact input before the fix: `matched: true` with
    // visibly truncated, duplicated, and unbalanced output. Fixed at the
    // shared root (`hasOtherReferences` in class-wrapping.ts), not
    // pattern-locally, since this path predates pattern #3.
    const before = 'function MainCtrl($scope) {\n  $scope.x = 1;\n  angular.module(\'app\').controller(\'MainCtrl\', MainCtrl);\n}';

    const result = transformScopeAssignmentToClassProperty(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller with a $scope property assignment found',
    });
  });
});
