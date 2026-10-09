import { describe, expect, it } from 'vitest';
import { assembleScript } from './assemble.js';
import { pipeCharacterizationTarget } from './characterize-pipe.js';

const FILTER = `(function () {
  'use strict';
  angular.module('app').filter('plainText', plainText);
  function plainText() {
    return function (text) {
      return text ? String(text).replace(/<[^>]+>/gm, '') : '';
    };
  }
})();`;

describe('assembleScript', () => {
  it('lifts a pipe out of the IIFE as a standalone module: import, export, no AngularJS registration left', () => {
    const { declarations, matchedPatterns } = assembleScript('app/filters/plainText.js', FILTER);

    expect(matchedPatterns).toEqual(['#5 filter-to-pipe']);
    expect(declarations).toHaveLength(1);
    const [pipe] = declarations;
    expect(pipe).toMatchObject({
      name: 'PlainTextPipe',
      artifactType: 'filter',
      emittedPath: 'src/app/migrated/app/filters/plain-text.pipe.ts',
    });
    expect(pipe.content).toContain("import { Pipe } from '@angular/core';");
    expect(pipe.content).toMatch(/@Pipe\(\{[^}]*\}\)\s*export class PlainTextPipe/);
    expect(pipe.content).not.toContain('angular.module');
    expect(pipe.content).not.toContain('function plainText');
  });

  it('declares the fields a wrapped controller assigns, through `this` and through a `vm` alias', () => {
    const viaScope = assembleScript(
      'js/main.js',
      `angular.module('app').controller('MainCtrl', MainCtrl);
       function MainCtrl($scope) { $scope.title = 'x'; $scope.items = []; }`
    ).declarations[0];
    expect(viaScope).toMatchObject({ name: 'MainCtrl', artifactType: 'controller', emittedPath: 'src/app/migrated/js/main.controller.ts' });
    expect(viaScope.content).toMatch(/export class MainCtrl \{\s*title: any;\s*items: any;/);

    const viaAlias = assembleScript(
      'js/tab.js',
      `angular.module('app').controller('TabCtrl', TabCtrl);
       function TabCtrl(svc) { var vm = this; vm.open = function () { vm.last = svc.open(); }; }`
    ).declarations[0];
    expect(viaAlias.content).toMatch(/open: any;\s*last: any;/);
  });

  it('does not declare a field for `this.x` inside a nested non-arrow function — a different `this`', () => {
    const { content } = assembleScript(
      'js/c.js',
      `angular.module('app').controller('CCtrl', CCtrl);
       function CCtrl() { this.a = 1; [1].forEach(function () { this.b = 2; }); }`
    ).declarations[0];
    expect(content).toContain('a: any;');
    expect(content).not.toContain('b: any;');
  });

  it('records a templateUrl for the runner and classifies a component as a directive artifact', () => {
    const [component] = assembleScript(
      'app/popular/popularApp.directive.js',
      `angular.module('app').directive('popularApp', popularApp);
       function popularApp() { return { restrict: 'E', templateUrl: 'app/popular/popularApp.html' }; }`
    ).declarations;
    expect(component).toMatchObject({
      artifactType: 'directive',
      templateUrl: 'app/popular/popularApp.html',
      emittedPath: 'src/app/migrated/app/popular/popular-app.component.ts',
    });
  });

  it('emits a Routes constant with its import, leaving the unresolved component references for the gate', () => {
    const [routes] = assembleScript(
      'app/app.config.js',
      `angular.module('phonecatApp').config(['$routeProvider', function config($routeProvider) {
         $routeProvider.when('/phones', { template: '<phone-list></phone-list>' }).otherwise('/phones');
       }]);`
    ).declarations;
    expect(routes.artifactType).toBe('route');
    expect(routes.content).toContain("import { Routes } from '@angular/router';");
    expect(routes.content).toMatch(/export const \w+: Routes = \[/);
  });

  it('reports every non-matching pattern with its reason, and emits nothing, for a file no pattern applies to', () => {
    const result = assembleScript('app/app.module.js', `angular.module('app', ['ngRoute']);`);
    expect(result.declarations).toEqual([]);
    expect(result.matchedPatterns).toEqual([]);
    expect(result.notes).toHaveLength(9);
  });
});

describe('pipeCharacterizationTarget', () => {
  it('pairs the factory\'s returned function with the pipe\'s transform method, with inferred types', () => {
    const [pipe] = assembleScript('f.js', FILTER).declarations;
    const target = pipeCharacterizationTarget(FILTER, pipe.content);
    expect(target).toMatchObject({ artifactType: 'filter', parameterNames: ['text'], parameterTypes: ['string'], callSiteArgLiterals: [] });
    expect(target?.originalFunctionSource).toMatch(/^function \(text\)/);
    expect(target?.migratedFunctionSource).toMatch(/^function transform\(text: any\)/);
  });

  it('returns undefined when the original filter cannot be found', () => {
    const [pipe] = assembleScript('f.js', FILTER).declarations;
    expect(pipeCharacterizationTarget(`angular.module('app');`, pipe.content)).toBeUndefined();
  });
});
