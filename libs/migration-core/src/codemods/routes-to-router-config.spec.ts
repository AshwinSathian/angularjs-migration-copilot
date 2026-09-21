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
    // the wildcard redirect must be the LAST array entry — Angular Router
    // matches top-to-bottom, unlike AngularJS's always-evaluated-last otherwise()
    expect(result.output.indexOf("redirectTo: 'phones'")).toBeGreaterThan(result.output.indexOf('PhonesPhoneIdComponent'));
    // insert-only — the original registration is left untouched
    expect(result.output).toContain("when('/phones', {");
  });

  it('forces otherwise() to the end of the emitted array even when it is textually written before a when() call', () => {
    const before = [
      "angular.module('app').config(function ($routeProvider) {",
      "  $routeProvider.otherwise('/home');",
      "  $routeProvider.when('/users', { templateUrl: 'users.html' });",
      '});',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain("{ path: 'users', component: UsersComponent }");
    expect(result.output.indexOf("redirectTo: 'home'")).toBeGreaterThan(result.output.indexOf('UsersComponent'));
  });

  it('uses the last otherwise() call and warns about earlier, superseded ones (AngularJS overwrites, not accumulates)', () => {
    const before = [
      "angular.module('app').config(function ($routeProvider) {",
      "  $routeProvider.otherwise('/first');",
      "  $routeProvider.otherwise('/second');",
      '});',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain("redirectTo: 'second'");
    expect(result.output).not.toContain("redirectTo: 'first'");
    expect(result.warnings?.some((w) => w.includes('multiple otherwise() calls'))).toBe(true);
  });

  it('resolves the provider via an explicit $inject annotation when the local parameter name does not literally match (real, minifier-safe AngularJS idiom)', () => {
    const before = [
      "angular.module('BlurAdmin.pages.dashboard', []).config(routeConfig);",
      '',
      'function routeConfig(sp) {',
      "  sp.state('dashboard', { url: '/dashboard', templateUrl: 'dashboard.html' });",
      '}',
      "routeConfig.$inject = ['$stateProvider'];",
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertMatched(result);
    assertCompiles(result.output);
    expect(result.output).toContain('const DashboardRoutes: Routes = [');
    expect(result.output).toContain("{ path: 'dashboard', component: DashboardComponent }");
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

  it('detects a collision even when the pre-existing binding is declared inside the enclosing IIFE, not the file top level', () => {
    // Found by adversarial review, confirmed by direct execution:
    // hasExistingTopLevelBinding (class-wrapping.ts) originally only
    // checked bindings at the source file's direct-child level, but
    // nearestInsertionPointStart deliberately inserts the new `const
    // <Name>Routes` *inside* the enclosing IIFE — exactly the scope the
    // file-top-level-only check couldn't see into. Before the fix, this
    // constructed input silently emitted `component: DashboardComponent`
    // referencing the unrelated pre-existing `var`, matched: true, no
    // warning — the worst class of bug this project's review culture
    // watches for.
    const before = [
      '(function () {',
      "  'use strict';",
      "  var DashboardComponent = 'not a real component, just a string constant';",
      "  angular.module('app').config(['$routeProvider', function config($routeProvider) {",
      "    $routeProvider.when('/dashboard', { templateUrl: 'dashboard.html' });",
      '  }]);',
      '})();',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toContain('DashboardComponent');
    expect(result.reason).toContain('collides with an existing name');
  });

  it('detects a routes-constant-name collision inside the enclosing IIFE too, not just the file top level', () => {
    // Second half of the same bug: an unrelated `var AppRoutes` inside the
    // same IIFE the codemod inserts into previously went undetected,
    // producing a real TS2451 "cannot redeclare block-scoped variable"
    // once the codemod's own `const AppRoutes` landed right next to it.
    const before = [
      '(function () {',
      "  'use strict';",
      "  var AppRoutes = 'unrelated pre-existing binding inside the IIFE';",
      "  angular.module('app').config(['$routeProvider', function config($routeProvider) {",
      "    $routeProvider.when('/dashboard', { templateUrl: 'dashboard.html' });",
      '  }]);',
      '})();',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toContain('AppRoutes');
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

  it('skips a state() call whose name is not a plain string literal', () => {
    const before = [
      "angular.module('app').config(function ($stateProvider) {",
      "  var stateName = 'dashboard';",
      "  $stateProvider.state(stateName, { url: '/dashboard', templateUrl: 'dashboard.html' });",
      '});',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toContain('name/path is not a plain string literal');
  });

  it('skips an otherwise() call whose argument is not a plain string literal', () => {
    const before = [
      "angular.module('app').config(function ($routeProvider) {",
      '  var fallback = getFallbackPath();',
      "  $routeProvider.when('/x', { templateUrl: 'x.html' });",
      '  $routeProvider.otherwise(fallback);',
      '});',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertMatched(result);
    assertCompiles(result.output);
    // the malformed otherwise() is skipped and reported, not guessed at —
    // the real, well-formed when() route still transforms
    expect(result.output).toContain("{ path: 'x', component: XComponent }");
    expect(result.output).not.toContain('redirectTo');
    expect(result.warnings?.some((w) => w.includes('otherwise() argument is not a plain string literal'))).toBe(true);
  });

  it('skips a state() call whose second argument is not a plain object literal', () => {
    const before = [
      "angular.module('app').config(function ($stateProvider) {",
      '  var config = buildConfig();',
      "  $stateProvider.state('dashboard', config);",
      '});',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toContain('route config is not a plain object literal');
  });

  it('skips a state() call with no plain string url property', () => {
    const before = [
      "angular.module('app').config(function ($stateProvider) {",
      "  $stateProvider.state('dashboard', { templateUrl: 'dashboard.html' });",
      '});',
    ].join('\n');

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toContain('no plain string "url" property');
  });

  it('does not match a file with no .config() calls at all', () => {
    const before = "angular.module('app').service('foo', function () {});";

    const result = transformRoutesToRouterConfig(before);

    assertUnmatched(result);
    expect(result.reason).toBe('no flat $routeProvider/ui-router route registration found');
  });
});
