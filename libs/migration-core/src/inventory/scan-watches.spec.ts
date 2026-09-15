import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { scanWatchUsages } from './scan-watches.js';

function projectWithSource(content: string): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  project.createSourceFile('/virtual/app.js', content);
  return project;
}

describe('scanWatchUsages', () => {
  it('extracts a $scope.$watch call', () => {
    const project = projectWithSource(`
      $scope.$watch('items', function (newVal, oldVal) { console.log(newVal); });
    `);
    const [usage] = scanWatchUsages(project);
    expect(usage).toMatchObject({ method: '$watch', expressionText: "'items'" });
  });

  it('extracts $rootScope.$watch alongside $scope.$watch', () => {
    const project = projectWithSource(`
      $scope.$watch('a', function () {});
      $rootScope.$watch('b', function () {});
    `);
    expect(scanWatchUsages(project)).toHaveLength(2);
  });

  it('extracts $watchCollection and $watchGroup variants', () => {
    const project = projectWithSource(`
      $scope.$watchCollection('items', function () {});
      $scope.$watchGroup(['a', 'b'], function () {});
    `);
    const methods = scanWatchUsages(project).map((u) => u.method);
    expect(methods.sort()).toEqual(['$watchCollection', '$watchGroup']);
  });

  it('ignores $watch-like calls on unrelated objects', () => {
    const project = projectWithSource(`
      myCustomObserver.$watch('x', function () {});
    `);
    expect(scanWatchUsages(project)).toHaveLength(0);
  });

  it('truncates a very long watch expression rather than storing it in full', () => {
    const longExpr = `'${'a'.repeat(500)}'`;
    const project = projectWithSource(`$scope.$watch(${longExpr}, function () {});`);
    const [usage] = scanWatchUsages(project);
    expect(usage?.expressionText.length).toBeLessThanOrEqual(200);
  });
});
