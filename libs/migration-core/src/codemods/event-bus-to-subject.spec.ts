import { describe, expect, it } from 'vitest';
import { assertCompiles } from './assert-compiles.js';
import { transformEventBusToSubject } from './event-bus-to-subject.js';
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

describe('transformEventBusToSubject', () => {
  it('scaffolds a Subject-backed service for a plain-identifier event name sent and received in one file', () => {
    const before = [
      "angular.module('app').controller('SenderCtrl', function ($scope) {",
      "  $scope.notify = function () { $scope.$emit('userUpdated', { id: 1 }); };",
      '});',
      '',
      "angular.module('app').controller('ReceiverCtrl', function ($scope) {",
      "  $scope.$on('userUpdated', function (event, payload) { console.log(payload); });",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain("@Injectable({ providedIn: 'root' })");
    expect(result.output).toContain('class EventBusService {');
    expect(result.output).toContain('private readonly userUpdatedSubject = new Subject<unknown>();');
    expect(result.output).toContain('readonly userUpdated$ = this.userUpdatedSubject.asObservable();');
    expect(result.output).toContain('emitUserUpdated(payload?: unknown): void {');
    expect(result.output).toContain('this.userUpdatedSubject.next(payload);');
    // insert-only — every original call site is left exactly as written
    expect(result.output).toContain("$scope.$emit('userUpdated', { id: 1 });");
    expect(result.output).toContain("$scope.$on('userUpdated', function (event, payload)");
  });

  it('treats $broadcast the same as $emit — both count as "sends this event"', () => {
    const before = [
      "angular.module('app').controller('SenderCtrl', function ($scope) {",
      "  $scope.$broadcast('fileProgress', 50);",
      '});',
      "angular.module('app').controller('ReceiverCtrl', function ($scope) {",
      "  $scope.$on('fileProgress', function () {});",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('emitFileProgress(payload?: unknown): void {');
  });

  it('sanitizes a colon/dash-namespaced event name into a valid camelCase identifier', () => {
    const before = [
      "angular.module('app').controller('A', function ($rootScope) {",
      "  $rootScope.$emit('auth:login-success', {});",
      '});',
      "angular.module('app').controller('B', function ($rootScope) {",
      "  $rootScope.$on('auth:login-success', function () {});",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('authLoginSuccessSubject');
    expect(result.output).toContain('readonly authLoginSuccess$');
    expect(result.output).toContain('emitAuthLoginSuccess(');
  });

  it('does not match an $on with no corresponding $emit/$broadcast for the same event name (real fixture shape: $destroy cleanup)', () => {
    const before = [
      "angular.module('app').directive('baPanelBlur', function () {",
      '  return {',
      '    link: function (scope) {',
      "      scope.$on('$destroy', function () {});",
      '    },',
      '  };',
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertUnmatched(result);
    expect(result.reason).toContain('not a real intra-module event bus');
  });

  it('does not match a lone $on for a ui-router internal broadcast (real fixture shape: $stateChangeSuccess)', () => {
    const before = [
      "angular.module('app').run(function ($rootScope) {",
      "  $rootScope.$on('$stateChangeSuccess', function () {});",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertUnmatched(result);
    expect(result.reason).toContain('not a real intra-module event bus');
  });

  it('does not match a $broadcast with no listener anywhere in the file (real fixture shape: fileReader.js)', () => {
    const before = [
      "angular.module('app').service('fileReader', function ($rootScope) {",
      "  return function (scope) { scope.$broadcast('fileProgress', 10); };",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertUnmatched(result);
    expect(result.reason).toContain('not a real intra-module event bus');
  });

  it('does not match a file with no $emit/$broadcast/$on calls at all', () => {
    const before = "angular.module('app').service('foo', function () {});";

    const result = transformEventBusToSubject(before);

    assertUnmatched(result);
    expect(result.reason).toBe('no $emit/$broadcast/$on call with a string-literal event name found');
  });

  it('ignores a non-string-literal event name argument', () => {
    const before = [
      "angular.module('app').controller('A', function ($scope, eventName) {",
      '  $scope.$emit(eventName, {});',
      "  $scope.$on(eventName, function () {});",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertUnmatched(result);
    expect(result.reason).toBe('no $emit/$broadcast/$on call with a string-literal event name found');
  });

  it('scaffolds one member trio per distinct paired event name, in source order', () => {
    const before = [
      "angular.module('app').controller('A', function ($scope) {",
      "  $scope.$emit('first', {});",
      "  $scope.$emit('second', {});",
      '});',
      "angular.module('app').controller('B', function ($scope) {",
      "  $scope.$on('first', function () {});",
      "  $scope.$on('second', function () {});",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertMatched(result);
    assertCompiles(result.output);
    const firstIdx = result.output.indexOf('emitFirst(');
    const secondIdx = result.output.indexOf('emitSecond(');
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it('skips an event name that sanitizes to the same member name as another paired event, without dropping the other', () => {
    const before = [
      "angular.module('app').controller('A', function ($scope) {",
      "  $scope.$emit('user-updated', {});",
      "  $scope.$emit('userUpdated', {});",
      "  $scope.$emit('ready', {});",
      '});',
      "angular.module('app').controller('B', function ($scope) {",
      "  $scope.$on('user-updated', function () {});",
      "  $scope.$on('userUpdated', function () {});",
      "  $scope.$on('ready', function () {});",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('emitReady(');
    expect(result.output.match(/userUpdatedSubject/g)?.length).toBe(3); // declaration, asObservable() getter, next() call — all for the surviving 'user-updated' member only
    expect(result.warnings?.some((w) => w.includes('same member name'))).toBe(true);
  });

  it('inserts before the enclosing IIFE, at true module top level, not nested inside it', () => {
    // Unlike every other insert-only pattern's class, EventBusService has
    // no constructor parameters and closes over nothing from the file, so
    // it has no need to stay inside an enclosing IIFE the way those
    // patterns' classes do.
    const before = [
      '(function () {',
      "  angular.module('app').controller('A', function ($scope) {",
      "    $scope.$emit('ready', {});",
      '  });',
      "  angular.module('app').controller('B', function ($scope) {",
      "    $scope.$on('ready', function () {});",
      '  });',
      '})();',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertMatched(result);
    assertCompiles(result.output);
    const iifeStart = result.output.indexOf('(function () {');
    const classStart = result.output.indexOf('class EventBusService');
    expect(classStart).toBeGreaterThanOrEqual(0);
    expect(classStart).toBeLessThan(iifeStart);
  });

  it('inserts after a leading \'use strict\' directive-prologue statement, not before it', () => {
    const before = [
      "'use strict';",
      '',
      "angular.module('app').controller('A', function ($scope) {",
      "  $scope.$emit('ready', {});",
      '});',
      "angular.module('app').controller('B', function ($scope) {",
      "  $scope.$on('ready', function () {});",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output.indexOf("'use strict';")).toBe(0);
    expect(result.output.indexOf('class EventBusService')).toBeGreaterThan(result.output.indexOf("'use strict';"));
  });

  it('lands the class at module top level, not inside an arbitrarily nested closure containing the matched call', () => {
    // The real bug this test guards against: reusing class-wrapping.ts's
    // nearestInsertionPointStart (built for a registration call always
    // written directly at module top level) on an $emit/$on call nested
    // several closures deep landed the generated class *inside* that
    // closure — redeclared on every invocation, unreachable from the rest
    // of the file. Confirmed by adversarial review, reproduced directly.
    const before = [
      "angular.module('app').controller('SenderCtrl', function ($scope) {",
      "  $scope.notify = function () { $scope.$emit('userUpdated', { id: 1 }); };",
      '});',
      '',
      "angular.module('app').controller('ReceiverCtrl', function ($scope) {",
      "  $scope.$on('userUpdated', function (event, payload) { console.log(payload); });",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertMatched(result);
    assertCompiles(result.output);
    const classStart = result.output.indexOf('class EventBusService');
    const notifyStart = result.output.indexOf('$scope.notify');
    expect(classStart).toBeGreaterThanOrEqual(0);
    expect(classStart).toBeLessThan(notifyStart);
  });

  it('skips when the derived service class name collides with an existing top-level binding', () => {
    const before = [
      'class EventBusService {}',
      "angular.module('app').controller('A', function ($scope) {",
      "  $scope.$emit('ready', {});",
      '});',
      "angular.module('app').controller('B', function ($scope) {",
      "  $scope.$on('ready', function () {});",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertUnmatched(result);
    expect(result.reason).toContain('collides with an existing binding');
  });

  it('skips when a pre-existing top-level binding inside the enclosing IIFE collides with the service class name', () => {
    // hasExistingTopLevelBinding (class-wrapping.ts) searches every
    // declaration in the file, not just the direct-child level (ADR-045) —
    // this is the exact IIFE-scope blind spot that fix closed, regression
    // tested here too so a future narrowing of that shared check is caught
    // by this pattern's own suite, not just its original one.
    const before = [
      '(function () {',
      '  var EventBusService = 1;',
      "  angular.module('app').controller('A', function ($scope) {",
      "    $scope.$emit('ready', {});",
      '  });',
      "  angular.module('app').controller('B', function ($scope) {",
      "    $scope.$on('ready', function () {});",
      '  });',
      '})();',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertUnmatched(result);
    expect(result.reason).toContain('collides with an existing binding');
  });

  it('skips when a pre-existing top-level binding collides with a name the generated class body itself references (Subject/Injectable)', () => {
    const before = [
      'function Subject() {}',
      "angular.module('app').controller('A', function ($scope) {",
      "  $scope.$emit('ready', {});",
      '});',
      "angular.module('app').controller('B', function ($scope) {",
      "  $scope.$on('ready', function () {});",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertUnmatched(result);
    expect(result.reason).toContain('"Subject"');
  });

  it('does not reject a paired event name that sanitizes to a JS reserved word — it is never emitted bare', () => {
    const before = [
      "angular.module('app').controller('A', function ($scope) {",
      "  $scope.$emit('delete', {});",
      '});',
      "angular.module('app').controller('B', function ($scope) {",
      "  $scope.$on('delete', function () {});",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('deleteSubject');
    expect(result.output).toContain('emitDelete(');
  });

  it('skips a paired event name that sanitizes to an identifier with a leading digit', () => {
    const before = [
      "angular.module('app').controller('A', function ($scope) {",
      "  $scope.$emit('2fa-required', {});",
      '});',
      "angular.module('app').controller('B', function ($scope) {",
      "  $scope.$on('2fa-required', function () {});",
      '});',
    ].join('\n');

    const result = transformEventBusToSubject(before);

    assertUnmatched(result);
    expect(result.reason).toContain('2fa-required');
    expect(result.reason).toContain('does not sanitize to a valid identifier');
  });
});
