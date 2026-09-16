import { describe, expect, it } from 'vitest';
import { assertCompiles } from './assert-compiles.js';
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
    assertCompiles(result.output);
  });

  it('reports no match for a .controller("A", X) mismatched-name reference, the one idiom this codemod deliberately does not support', () => {
    // The name-match guard (ADR-032) exists specifically to reject this:
    // `namedFn.getName() === className` must hold before a candidate is
    // even collected. Without it, a surviving candidate's call site
    // would still read the original identifier (`X`) after `X`'s own
    // declaration is deleted — an undefined-identifier bug, confirmed
    // before this guard existed. Asserted directly here, independent of
    // the dedup-by-function-node safety net (which this scenario used to
    // exercise before the guard made it unreachable in practice).
    const before = "angular.module('app').controller('OtherName', WizardCtrl);\nfunction WizardCtrl() { this.a = 1; }";

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller using the controllerAs (this/vm) idiom found',
    });
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
    assertCompiles(result.output);
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
    assertCompiles(result.output);
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
      "MainCtrl.$inject = ['$http'];",
      "MainCtrl.$inject = ['$http', '$log'];",
      'function MainCtrl($http, $log) { this.a = 1; }',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    expect(result.output).toContain('class MainCtrl {');
    expect(result.output).not.toContain('$inject');
    assertCompiles(result.output);
  });

  it('leaves a $inject assignment nested inside another expression untouched, and skips the whole candidate rather than delete the wrong range', () => {
    // A critical bug caught by a second adversarial review round:
    // getFirstAncestorByKind walked past the ParenthesizedExpression/
    // VariableDeclaration wrapper and resolved `var deps = (MyCtrl.$inject
    // = [...])` to the *enclosing var statement* — deleting that, rather
    // than refusing to touch it, deleted unrelated surrounding code
    // (confirmed with a constructed marker string that visibly got
    // corrupted when this sat inside an IIFE). Now rejected outright:
    // the assignment's own identifier counts as an unaccounted-for
    // reference to the function, so the whole candidate is safely
    // skipped instead of guessed at.
    const before = [
      '(function () {',
      '  function MyCtrl($scope) { this.a = 1; }',
      "  var deps = (MyCtrl.$inject = ['$scope']);",
      "  angular.module('app').controller('MyCtrl', MyCtrl);",
      '  var KEEP = "SHOULD_SURVIVE";',
      '})();',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller using the controllerAs (this/vm) idiom found',
    });
  });

  it('leaves a braceless if-body $inject assignment untouched, and skips the whole candidate rather than leave a dangling if', () => {
    // A real bug from the same review round, the opposite direction:
    // `if (x) MyCtrl.$inject = [...];` -- the assignment's *direct*
    // parent really is an ExpressionStatement, but deleting it left a
    // dangling `if (window.NG)` with no body. Rejected the same way:
    // the statement's own parent (the IfStatement) isn't a Block or
    // SourceFile, so it's left alone and the candidate is skipped.
    const before = [
      "if (window.NG) MyCtrl.$inject = ['$scope'];",
      "angular.module('app').controller('MyCtrl', MyCtrl);",
      'function MyCtrl($scope) { this.a = 1; }',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller using the controllerAs (this/vm) idiom found',
    });
  });

  it('skips a candidate whose function is referenced somewhere other than its own .controller(X, X) call, since declaring the class before just that one call is not enough', () => {
    // A real bug caught by a second adversarial review round: ADR-031
    // claimed the class is "always declared before its only reference,"
    // but nothing verified it actually was the *only* one. A
    // `.prototype` extension (or any other reference) before the
    // registration resurfaces the exact TS2449 bug this whole
    // named-declaration path exists to avoid, confirmed by actually
    // typechecking the pre-fix output. Rather than compute a correct
    // insertion point for every possible reference shape, an
    // unaccounted-for reference is simply grounds to skip.
    const before = [
      'function MyCtrl($scope) { this.a = 1; }',
      'MyCtrl.prototype.helper = function () { return 1; };',
      "angular.module('app').controller('MyCtrl', MyCtrl);",
    ].join('\n');

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller using the controllerAs (this/vm) idiom found',
    });
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

  it('matches neither of two registrations that reference the same named function declaration', () => {
    // A real corruption bug caught by adversarial review: two matches
    // referencing the same underlying FunctionDeclaration each scheduled
    // their own deletion of its (identical) source span computed against
    // the *original* text; applying both against the once-shrunk output
    // spliced into unrelated, already-shifted content.
    //
    // A second review round found that transforming just one of the two
    // (with `claimedNamedDeclarations` skipping the other as ambiguous)
    // isn't actually safe either: the surviving call's own class
    // insertion only guarantees the class is declared before *that*
    // call, not before the untouched sibling call — if the sibling sits
    // earlier in the file, the exact TDZ bug this whole named-
    // declaration path exists to avoid resurfaces for it. `fn`'s own
    // name node correctly resolves two references (one per call), so
    // `hasOtherReferences` now rejects *both* candidates upstream,
    // before either ever reaches `collectBareFunctionControllerMatches`'
    // rawMatches array — a stricter, actually-safe outcome, not merely a
    // dedup. `claimedNamedDeclarations` is kept as defense-in-depth for
    // any case that might someday slip past `hasOtherReferences`, but
    // this specific scenario no longer reaches it.
    const before = "angular.module('app').controller('MainCtrl', MainCtrl);\nangular.module('app').controller('MainCtrl', MainCtrl);\nfunction MainCtrl() { this.x = 1; }";

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'no bare-function controller using the controllerAs (this/vm) idiom found',
    });
  });

  it('skips an outer registration whose body contains a second, unrelated registration nested inside it, but still transforms the inner one', () => {
    // Found by adversarial review of pattern #3's own reuse of
    // `hasOtherReferences`, and confirmed to reproduce here too since
    // `collectBareFunctionControllerMatches` shares the same mechanism:
    // `hasOtherReferences` only rules out an *other* reference to a
    // candidate's own function, not a sibling candidate's edit positions
    // sitting nested inside this candidate's deletion range. Deleting
    // MainCtrl's declaration would also delete the text OtherCtrl's own
    // insertion/deletion edits are computed against, corrupting output
    // while still reporting `matched: true` — confirmed by actually
    // running this exact input before the fix. Fixed in
    // `findNestedDeletionConflicts` (class-wrapping.ts), shared with
    // pattern #3's array-style-DI path.
    const before = [
      'function MainCtrl() {',
      '  this.x = 1;',
      "  angular.module('app').controller('OtherCtrl', OtherCtrl);",
      '}',
      'function OtherCtrl() {',
      '  this.y = 2;',
      '}',
      "angular.module('app').controller('MainCtrl', MainCtrl);",
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).not.toContain('class MainCtrl');
    expect(result.output).toContain('class OtherCtrl {');
    expect(result.output).toContain('function MainCtrl()');
  });

  it('skips an outer registration whose inline function body contains a second registration nested inside it, but still transforms the inner one', () => {
    // `findNestedDeletionConflicts` originally only treated a *named-
    // declaration* deletion range as a conflict source, missing that an
    // inline function literal's own replaced span (the whole literal,
    // body included) is corrupted by a sibling's nested edits exactly
    // the same way. Confirmed by actually running this exact input
    // before the fix — same gap, mirrored across all three patterns that
    // share this machinery.
    const before = [
      "angular.module('app').controller('Outer', function () {",
      '  this.x = 1;',
      "  angular.module('app').controller('Inner', function () {",
      '    this.y = 2;',
      '  });',
      '});',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).not.toContain('class Outer');
    expect(result.output).toContain('class Inner {');
    expect(result.output).toContain("angular.module('app').controller('Outer', function () {");
  });

  it('reports an accurate reason when the only real candidate was rejected for a nesting conflict', () => {
    // `collectBareFunctionControllerMatches` silently drops a nesting-
    // conflicted match before returning (same silent-exclusion precedent
    // as every other ambiguous-shape rejection there), which used to
    // leave callers with no way to tell "the idiom wasn't found" apart
    // from "the idiom was found but rejected for an unrelated reason" —
    // a misleading-reason gap found by adversarial review. Here `Inner`
    // isn't a controllerAs candidate at all (no this/vm assignment), so
    // `Outer` — which *does* have one — was the only real candidate, and
    // it's rejected purely because `Inner`'s registration call sits
    // nested inside its body. The fallback reason must say so, not fall
    // back to the generic "not found" message.
    const before = [
      "angular.module('app').controller('Outer', function () {",
      '  this.x = 1;',
      "  angular.module('app').controller('Inner', function () { });",
      '});',
    ].join('\n');

    const result = transformControllerAsToClass(before);

    expect(result).toEqual({
      matched: false,
      reason: 'Outer: deleting/replacing it would also corrupt another registration nested inside it — not safely transformable',
    });
  });
});
