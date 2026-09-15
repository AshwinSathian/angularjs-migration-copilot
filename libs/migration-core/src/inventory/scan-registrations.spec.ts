import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { scanRegistrations } from './scan-registrations.js';

function projectWithSource(content: string): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  project.createSourceFile('/virtual/app.js', content);
  return project;
}

describe('scanRegistrations', () => {
  it('extracts a controller registered with array-style DI', () => {
    const project = projectWithSource(`
      angular.module('app').controller('MainCtrl', ['$scope', '$http', function ($scope, $http) {
        $scope.items = [];
      }]);
    `);
    const [entry] = scanRegistrations(project);
    expect(entry).toMatchObject({
      kind: 'controller',
      name: 'MainCtrl',
      dependencies: ['$scope', '$http'],
    });
  });

  it('extracts a factory registered with bare-function DI', () => {
    const project = projectWithSource(`
      angular.module('app').factory('UserService', function ($http, $q) {
        return {};
      });
    `);
    const [entry] = scanRegistrations(project);
    expect(entry).toMatchObject({
      kind: 'factory',
      name: 'UserService',
      dependencies: ['$http', '$q'],
    });
  });

  it('extracts a component with an array-style controller', () => {
    const project = projectWithSource(`
      angular.module('phoneList').component('phoneList', {
        templateUrl: 'phone-list.template.html',
        controller: ['Phone', function PhoneListController(Phone) {
          this.phones = Phone.query();
        }]
      });
    `);
    const [entry] = scanRegistrations(project);
    expect(entry).toMatchObject({
      kind: 'component',
      name: 'phoneList',
      dependencies: ['Phone'],
    });
  });

  it('extracts a component with a bare-function controller', () => {
    const project = projectWithSource(`
      angular.module('app').component('widget', {
        controller: function ($scope) { $scope.value = 1; }
      });
    `);
    const [entry] = scanRegistrations(project);
    expect(entry?.dependencies).toEqual(['$scope']);
  });

  it('extracts a component with an ES6 shorthand-method controller', () => {
    // { controller($scope) {...} } is a MethodDeclaration, not a
    // PropertyAssignment with a function initializer — a distinct AST
    // shape common in AngularJS 1.5+ code written after ES6 became normal.
    const project = projectWithSource(`
      angular.module('app').component('widget', {
        controller($scope, MyService) { this.x = $scope; }
      });
    `);
    const [entry] = scanRegistrations(project);
    expect(entry?.dependencies).toEqual(['$scope', 'MyService']);
  });

  it('reports no dependencies for a component with a string-named controller', () => {
    const project = projectWithSource(`
      angular.module('app').component('widget', { controller: 'WidgetController' });
    `);
    const [entry] = scanRegistrations(project);
    expect(entry).toMatchObject({ kind: 'component', name: 'widget', dependencies: [] });
  });

  it('reports no dependencies for a component with no controller at all', () => {
    const project = projectWithSource(`
      angular.module('app').component('widget', { template: '<div></div>' });
    `);
    const [entry] = scanRegistrations(project);
    expect(entry?.dependencies).toEqual([]);
  });

  it('finds value, constant, provider, decorator, and animation registrations', () => {
    const project = projectWithSource(`
      angular.module('app')
        .value('AppSettings', { debug: true })
        .constant('CONFIG_KEY', 'x')
        .provider('myThing', function () {})
        .decorator('$log', function ($delegate) { return $delegate; })
        .animation('.fade', function () { return {}; });
    `);
    const kinds = scanRegistrations(project).map((e) => e.kind).sort();
    expect(kinds).toEqual(['animation', 'constant', 'decorator', 'provider', 'value']);
  });

  it('reports no dependencies for a value/constant registration, since the second arg is a plain value', () => {
    const project = projectWithSource(`
      angular.module('app').value('AppSettings', { debug: true });
    `);
    const [entry] = scanRegistrations(project);
    expect(entry?.dependencies).toEqual([]);
  });

  it('finds directives, services, and filters alongside controllers', () => {
    const project = projectWithSource(`
      angular.module('app')
        .directive('myWidget', function () { return {}; })
        .service('LogService', function ($log) { this.log = $log; })
        .filter('capitalize', function () { return function (input) { return input; }; });
    `);
    const kinds = scanRegistrations(project).map((e) => e.kind);
    expect(kinds.sort()).toEqual(['directive', 'filter', 'service']);
  });

  it('reports each registration on its own line when chained across multiple lines', () => {
    // A naive `node.getStartLineNumber()` on the whole call expression
    // would report every entry on line 2, where the chain starts at
    // `angular` — this locks in the fix that reports each `.method(`
    // call's own line instead.
    const project = projectWithSource(
      [
        "angular.module('app')",
        "  .controller('First', function () {})",
        "  .controller('Second', function () {});",
      ].join('\n')
    );
    const lines = scanRegistrations(project).map((e) => e.line);
    expect(lines).toEqual([2, 3]);
  });

  it('reports the correct line number', () => {
    const project = projectWithSource(
      ['// comment', '', "angular.module('app').controller('MainCtrl', function () {});"].join(
        '\n'
      )
    );
    const [entry] = scanRegistrations(project);
    expect(entry?.line).toBe(3);
  });

  it('matches by method name regardless of receiver, by design', () => {
    // `angular.module('app').controller(...)` and a `.controller(...)`
    // chained off a stored module reference are both legal AngularJS, so
    // the receiver isn't checked — only the method name is. That's a
    // deliberate tradeoff (simpler, but not receiver-verified), documented
    // here rather than left as an implicit assumption.
    const project = projectWithSource(`
      someOtherLibrary.controller('not-angular', function () {});
    `);
    expect(scanRegistrations(project)).toHaveLength(1);
  });

  it('returns no dependencies for a registration with no injectable arguments', () => {
    const project = projectWithSource(`
      angular.module('app').filter('trusted', function () {});
    `);
    const [entry] = scanRegistrations(project);
    expect(entry?.dependencies).toEqual([]);
  });
});
