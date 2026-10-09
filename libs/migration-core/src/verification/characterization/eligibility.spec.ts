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
    const result = checkEligibility('function touch(msg) { msg.length; }');
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/return/);
  });

  it('rejects unparseable source rather than throwing', () => {
    const result = checkEligibility('function broken( {{{');
    expect(result.eligible).toBe(false);
  });

  // ADR-057: each of these was accepted by the five-name check and then "matched" in the sandbox.
  it.each([
    ['a closed-over helper', 'function f(x) { return helper(x) * 2; }', /helper/],
    ['a closed-over DI parameter', 'function (input) { return layoutPaths.images.root + input; }', /layoutPaths/],
    ['a free variable read through object shorthand', 'function f(x) { return { x, helper }; }', /helper/],
    ['localStorage', 'function f(x) { return localStorage.getItem(x); }', /localStorage/],
    ['fetch', 'function f(x) { return fetch(x); }', /fetch/],
    ['the angular global', 'function f(x) { return angular.copy(x); }', /angular/],
    ['this', 'function f(x) { return this.rate * x; }', /this/],
    ['Math.random', 'function f(x) { return Math.random() * x; }', /Math\.random/],
    ['Date.now', 'function f(x) { return Date.now() + x; }', /Date\.now/],
    ['an argument-less Date', 'function f(x) { return new Date().getTime() + x; }', /Date/],
    ['an async function', 'async function f(x) { return x; }', /async/],
  ])('rejects a function that depends on %s', (_label, source, reason) => {
    const result = checkEligibility(source);
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(reason);
  });

  it('accepts locals, nested functions, destructuring, property names, and pure built-ins', () => {
    const source = `function f(items, { rate }) {
      const scale = (n) => Math.round(n * rate);
      let total = 0;
      for (const item of items) total += scale(item.price);
      return { total, when: new Date(0), label: String(total).length };
    }`;
    expect(checkEligibility(source)).toEqual({ eligible: true });
  });
});
