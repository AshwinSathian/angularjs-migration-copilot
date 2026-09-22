import { describe, expect, it } from 'vitest';
import { checkEligibility } from './eligibility.js';

describe('checkEligibility', () => {
  it('accepts a pure function referencing only its own parameters', () => {
    const result = checkEligibility('function total(items) { return items.reduce((a, b) => a + b, 0); }');
    expect(result.eligible).toBe(true);
  });

  it('accepts a pure arrow function', () => {
    const result = checkEligibility('(price, taxRate) => price * (1 + taxRate)');
    expect(result.eligible).toBe(true);
  });

  it('rejects a function referencing $scope', () => {
    const result = checkEligibility('function greet() { return "hi " + $scope.name; }');
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/\$scope/);
  });

  it('rejects a function referencing $rootScope', () => {
    const result = checkEligibility('function isLoggedIn() { return !!$rootScope.user; }');
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/\$rootScope/);
  });

  it('rejects a function referencing a DOM global not among its own parameters', () => {
    const result = checkEligibility('function title() { return document.title; }');
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/document/);
  });

  it('does not reject a parameter merely named like a DOM global — it is a parameter, not the global', () => {
    const result = checkEligibility('function f(document) { return document.length; }');
    expect(result.eligible).toBe(true);
  });

  it('rejects a function calling $http', () => {
    const result = checkEligibility('function load($http) { return $http.get("/api"); }');
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/\$http/);
  });

  it('rejects a function calling $q', () => {
    const result = checkEligibility('function defer($q) { return $q.defer(); }');
    expect(result.eligible).toBe(false);
  });

  it('rejects a function calling $timeout', () => {
    const result = checkEligibility('function delay($timeout, fn) { return $timeout(fn, 100); }');
    expect(result.eligible).toBe(false);
  });

  it('rejects a function with no return statement — nothing to diff against a golden master', () => {
    const result = checkEligibility('function log(msg) { console.log(msg); }');
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/return/);
  });

  it('rejects unparseable source rather than throwing', () => {
    const result = checkEligibility('function broken( {{{');
    expect(result.eligible).toBe(false);
  });
});
