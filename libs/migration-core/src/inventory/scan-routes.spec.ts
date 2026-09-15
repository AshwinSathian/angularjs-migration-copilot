import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { scanRoutes } from './scan-routes.js';

function projectWithSource(content: string): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  project.createSourceFile('/virtual/app.js', content);
  return project;
}

describe('scanRoutes', () => {
  it('extracts an ngRoute $routeProvider.when() route', () => {
    const project = projectWithSource(`
      angular.module('app').config(['$routeProvider', function ($routeProvider) {
        $routeProvider.when('/phones', { templateUrl: 'phones.html' });
      }]);
    `);
    const [route] = scanRoutes(project);
    expect(route).toMatchObject({ provider: 'ngRoute', pathOrStateName: '/phones' });
  });

  it('extracts a ui-router $stateProvider.state() route', () => {
    const project = projectWithSource(`
      angular.module('app').config(['$stateProvider', function ($stateProvider) {
        $stateProvider.state('phones', { url: '/phones' });
      }]);
    `);
    const [route] = scanRoutes(project);
    expect(route).toMatchObject({ provider: 'ui-router', pathOrStateName: 'phones' });
  });

  it('extracts every route in a chained $routeProvider definition', () => {
    const project = projectWithSource(`
      $routeProvider
        .when('/phones', { templateUrl: 'phones.html' })
        .when('/phones/:id', { templateUrl: 'detail.html' })
        .otherwise({ redirectTo: '/phones' });
    `);
    const paths = scanRoutes(project).map((r) => r.pathOrStateName);
    expect(paths).toEqual(['/phones', '/phones/:id']);
  });

  it('ignores .when()/.state() calls unrelated to routing', () => {
    const project = projectWithSource(`
      somePromiseLibrary.when(function () {});
      someStateMachine.state('idle');
    `);
    expect(scanRoutes(project)).toHaveLength(0);
  });
});
