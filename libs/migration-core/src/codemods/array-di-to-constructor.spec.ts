import { describe, expect, it } from 'vitest';
import { transformArrayStyleDiToConstructor } from './array-di-to-constructor.js';

describe('transformArrayStyleDiToConstructor', () => {
  it('converts an array-style DI controller to a class with constructor injection', () => {
    const before = [
      "angular.module('app').controller('MainCtrl', ['$scope', '$http', function ($scope, $http) {",
      '  $scope.items = [];',
      '}]);',
    ].join('\n');

    const result = transformArrayStyleDiToConstructor(before);

    expect(result.matched).toBe(true);
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

    expect(result.matched).toBe(true);
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
});
