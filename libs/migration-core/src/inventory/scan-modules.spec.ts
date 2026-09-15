import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { scanModuleDeclarations } from './scan-modules.js';

function projectWithSource(content: string): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  project.createSourceFile('/virtual/app.js', content);
  return project;
}

describe('scanModuleDeclarations', () => {
  it('extracts a module declaration and its dependency modules', () => {
    const project = projectWithSource(`angular.module('app', ['ngRoute', 'ui.bootstrap']);`);
    const [entry] = scanModuleDeclarations(project);
    expect(entry).toMatchObject({
      name: 'app',
      dependsOnModules: ['ngRoute', 'ui.bootstrap'],
    });
  });

  it('extracts a module declared with no dependencies', () => {
    const project = projectWithSource(`angular.module('app', []);`);
    const [entry] = scanModuleDeclarations(project);
    expect(entry?.dependsOnModules).toEqual([]);
  });

  it('does not treat a module retrieval as a declaration', () => {
    const project = projectWithSource(`angular.module('app').controller('C', function () {});`);
    expect(scanModuleDeclarations(project)).toHaveLength(0);
  });

  it('finds every module declared across a file', () => {
    const project = projectWithSource(`
      angular.module('app', ['app.core']);
      angular.module('app.core', []);
    `);
    const names = scanModuleDeclarations(project).map((m) => m.name);
    expect(names.sort()).toEqual(['app', 'app.core']);
  });
});
