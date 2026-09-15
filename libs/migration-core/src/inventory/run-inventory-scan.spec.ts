import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInventoryScan } from './run-inventory-scan.js';

describe('runInventoryScan', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'migration-core-inventory-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('scans a small on-disk AngularJS app and aggregates every entry kind', async () => {
    await writeFile(
      join(repoRoot, 'app.js'),
      `
        angular.module('app', ['ngRoute']);
        angular.module('app').config(['$routeProvider', function ($routeProvider) {
          $routeProvider.when('/phones', { templateUrl: 'phones.html' });
        }]);
      `
    );
    await writeFile(
      join(repoRoot, 'controller.js'),
      `
        angular.module('app').controller('PhoneListCtrl', ['$scope', 'Phone', function ($scope, Phone) {
          $scope.phones = Phone.query();
          $scope.$watch('phones', function () {});
        }]);
      `
    );

    const report = await runInventoryScan(repoRoot);

    expect(report.filesScanned).toBe(2);
    expect(report.modules).toHaveLength(1);
    expect(report.registrations).toHaveLength(1);
    expect(report.registrations[0]).toMatchObject({
      kind: 'controller',
      name: 'PhoneListCtrl',
      dependencies: ['$scope', 'Phone'],
    });
    expect(report.routes).toHaveLength(1);
    expect(report.watchUsages).toHaveLength(1);
  });

  it('excludes node_modules, bower_components, and spec files from the scan', async () => {
    await mkdir(join(repoRoot, 'node_modules', 'some-dep'), { recursive: true });
    await writeFile(
      join(repoRoot, 'node_modules', 'some-dep', 'index.js'),
      `angular.module('should-not-appear', []);`
    );
    await mkdir(join(repoRoot, 'bower_components', 'angular'), { recursive: true });
    await writeFile(
      join(repoRoot, 'bower_components', 'angular', 'angular.js'),
      `angular.module('should-not-appear-either', []);`
    );
    await writeFile(
      join(repoRoot, 'app.spec.js'),
      `angular.module('should-not-appear-either', []);`
    );
    await writeFile(join(repoRoot, 'app.js'), `angular.module('real-app', []);`);

    const report = await runInventoryScan(repoRoot);

    expect(report.filesScanned).toBe(1);
    expect(report.modules).toEqual([
      expect.objectContaining({ name: 'real-app' }),
    ]);
  });

  it('skips vendored AngularJS framework source, identified by its official license banner', async () => {
    // A real finding from running this scanner against the pinned
    // angular-phonecat fixture after installing its dependencies: its own
    // build step copies angular.js, angular-route.js, etc. into app/lib/,
    // and without this filter their internal $compile/$animate/ngView
    // registrations get reported as if they were the app's own code.
    await mkdir(join(repoRoot, 'lib'));
    await writeFile(
      join(repoRoot, 'lib', 'angular.js'),
      [
        '/**',
        ' * @license AngularJS v1.8.0',
        ' * (c) 2010-2020 Google, Inc. http://angularjs.org',
        ' * License: MIT',
        ' */',
        "angular.module('ngRoute', []).provider('$route', function () {});",
      ].join('\n')
    );
    await writeFile(join(repoRoot, 'app.js'), `angular.module('real-app', []);`);

    const report = await runInventoryScan(repoRoot);

    expect(report.filesScanned).toBe(1);
    expect(report.vendoredFilesSkipped).toBe(1);
    expect(report.modules).toEqual([expect.objectContaining({ name: 'real-app' })]);
  });

  it('returns an empty report for a repo with no matching files', async () => {
    const report = await runInventoryScan(repoRoot);
    expect(report).toMatchObject({
      filesScanned: 0,
      vendoredFilesSkipped: 0,
      modules: [],
      registrations: [],
      routes: [],
      watchUsages: [],
    });
  });
});
