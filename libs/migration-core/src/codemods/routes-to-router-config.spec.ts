import { describe, expect, it } from 'vitest';
import { assertCompiles } from './assert-compiles.js';
import { transformRoutesToRouterConfig } from './routes-to-router-config.js';
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

describe('transformRoutesToRouterConfig', () => {
  it('converts array-style DI $routeProvider routes plus otherwise (angular-phonecat\'s real shape)', () => {
    const before = [
      "angular.",
      "  module('phonecatApp').",
      "  config(['$routeProvider',",
      "    function config($routeProvider) {",
      "      $routeProvider.",
      "        when('/phones', {",
      "          template: '<phone-list></phone-list>'",
      "        }).",
      "        when('/phones/:phoneId', {",
      "          template: '<phone-detail></phone-detail>'",
      "        }).",
      "        otherwise('/phones');",
      "    }",
      "  ]);",
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('const PhonecatAppRoutes: Routes = [');
    expect(result.output).toContain("{ path: 'phones', component: PhonesComponent }");
    expect(result.output).toContain("{ path: 'phones/:phoneId', component: PhonesPhoneIdComponent }");
    expect(result.output).toContain("{ path: '**', redirectTo: 'phones' }");
    // insert-only — the original registration is left untouched
    expect(result.output).toContain("when('/phones', {");
  });

  it('converts a named-reference ui-router flat state (blur-admin dashboard.module.js\'s real shape)', () => {
    const before = [
      "angular.module('BlurAdmin.pages.dashboard', [])",
      "    .config(routeConfig);",
      '',
      '/** @ngInject */',
      'function routeConfig($stateProvider) {',
      '  $stateProvider',
      "      .state('dashboard', {",
      "        url: '/dashboard',",
      "        templateUrl: 'app/pages/dashboard/dashboard.html',",
      "        title: 'Dashboard',",
      '      });',
      '}',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('const DashboardRoutes: Routes = [');
    expect(result.output).toContain("{ path: 'dashboard', component: DashboardComponent }");
    expect(result.output).toContain('function routeConfig($stateProvider) {');
  });

  it('skips an abstract state with dotted children (blur-admin tables.module.js\'s real shape) — nothing left to route to', () => {
    const before = [
      "angular.module('BlurAdmin.pages.tables', [])",
      '  .config(routeConfig);',
      '',
      '/** @ngInject */',
      'function routeConfig($stateProvider, $urlRouterProvider) {',
      '  $stateProvider',
      "      .state('tables', {",
      "        url: '/tables',",
      "        template : '<ui-view></ui-view>',",
      '        abstract: true,',
      "        controller: 'TablesPageCtrl',",
      '      }).state(\'tables.basic\', {',
      "        url: '/basic',",
      "        templateUrl: 'app/pages/tables/basic/tables.html',",
      '      }).state(\'tables.smart\', {',
      "        url: '/smart',",
      "        templateUrl: 'app/pages/tables/smart/tables.html',",
      '      });',
      "  $urlRouterProvider.when('/tables','/tables/basic');",
      '}',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toContain('abstract state');
    expect(result.reason).toContain('tables.basic');
    expect(result.reason).toContain('nested state');
  });

  it('does not confuse $urlRouterProvider.when(...) with $routeProvider.when(...) (blur-admin mail.module.js\'s real shape)', () => {
    const before = [
      "angular.module('BlurAdmin.pages.components.mail', [])",
      '  .config(routeConfig);',
      '',
      '/** @ngInject */',
      'function routeConfig($stateProvider, $urlRouterProvider) {',
      '  $stateProvider',
      "      .state('components.mail', {",
      "        url: '/mail',",
      '        abstract: true,',
      "        templateUrl: 'app/pages/components/mail/mail.html',",
      '      });',
      "  $urlRouterProvider.when('/components/mail', '/components/mail/inbox');",
      '}',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    // The only real state is abstract+dotted (out of scope) and
    // $urlRouterProvider.when() is a different provider entirely — if it
    // were wrongly treated as a $routeProvider.when() call, this would
    // spuriously match and emit a bogus route.
    assertUnmatched(result);
    expect(result.reason).not.toContain('$urlRouterProvider');
  });

  it('leaves an unrelated, chained second .config() call untouched and unwarned (blur-admin chartJs.module.js\'s real shape)', () => {
    const before = [
      "angular.module('BlurAdmin.pages.charts.chartJs', [])",
      '    .config(routeConfig).config(chartJsConfig);',
      '',
      '/** @ngInject */',
      'function routeConfig($stateProvider) {',
      '  $stateProvider',
      "      .state('chartJs', {",
      "        url: '/chartJs',",
      "        templateUrl: 'app/pages/charts/chartJs/chartJs.html',",
      '      });',
      '}',
      '',
      'function chartJsConfig(ChartJsProvider, baConfigProvider) {',
      '  ChartJsProvider.setOptions({});',
      '}',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('const ChartJsRoutes: Routes = [');
    expect(result.warnings).toBeUndefined();
    expect(result.output).toContain('function chartJsConfig(ChartJsProvider, baConfigProvider) {');
  });

  it('skips an array-style DI dependency/parameter count mismatch as ambiguous', () => {
    const before = [
      "angular.module('app').config(['$routeProvider', '$http', function config($routeProvider) {",
      "  $routeProvider.when('/x', { template: '<x></x>' });",
      '}]);',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toContain('ambiguous binding');
  });

  it('supports a bare inline function literal with no array wrapper', () => {
    const before = [
      "angular.module('app').config(function ($routeProvider) {",
      "  $routeProvider.when('/dashboard', { templateUrl: 'dashboard.html' });",
      '});',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain("{ path: 'dashboard', component: DashboardComponent }");
  });

  it('skips when the derived component name collides with an existing top-level binding', () => {
    const before = [
      'class DashboardComponent {}',
      "angular.module('BlurAdmin.pages.dashboard', []).config(routeConfig);",
      '',
      'function routeConfig($stateProvider) {',
      "  $stateProvider.state('dashboard', { url: '/dashboard', templateUrl: 'dashboard.html' });",
      '}',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toContain('collides with an existing name');
  });

  it('does not treat an unrelated .config() call as a route registration', () => {
    const before = [
      "angular.module('app').config(function (ChartJsProvider, baConfigProvider) {",
      '  ChartJsProvider.setOptions({});',
      '});',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toBe('no flat $routeProvider/ui-router route registration found');
  });

  it('skips when the derived routes constant name is not a valid identifier (digit-leading module name)', () => {
    // Found by self-review, not fixture evidence: `deriveRoutesVarName`
    // pascal-cases the module name but a purely-numeric segment (e.g. a
    // module literally named '404') stays digit-leading — `isValidClassName`
    // must be checked here the same way it already is for every derived
    // component name, or this would emit invalid syntax like
    // `const 404Routes: Routes = [...]`.
    const before = [
      "angular.module('404', []).config(routeConfig);",
      '',
      'function routeConfig($stateProvider) {',
      "  $stateProvider.state('dashboard', { url: '/dashboard', templateUrl: 'dashboard.html' });",
      '}',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertMatched(result);
    assertCompiles(result.output);
    // Falls back to the generic name once the module-derived one is invalid.
    expect(result.output).toContain('const AppRoutes: Routes = [');
  });

  it('skips a flat state whose name cannot derive a valid identifier (digit-only state name)', () => {
    const before = [
      "angular.module('app', []).config(routeConfig);",
      '',
      'function routeConfig($stateProvider) {',
      "  $stateProvider.state('500', { url: '/500', templateUrl: '500.html' });",
      '}',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toContain('could not derive a valid component class name');
  });

  it('skips an empty ngRoute path cleanly rather than deriving a nonsensical component name', () => {
    const before = [
      "angular.module('app').config(function ($routeProvider) {",
      "  $routeProvider.when('', { templateUrl: 'home.html' });",
      '});',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toContain('could not derive a valid component class name');
  });

  it('does not match a file with no .config() calls at all', () => {
    const before = "angular.module('app').service('foo', function () {});";

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toBe('no flat $routeProvider/ui-router route registration found');
  });
});
