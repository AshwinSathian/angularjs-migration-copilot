import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { collectCallSiteArgLiterals } from './collect-call-site-args.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(path, content);
  }
  return project;
}

describe('collectCallSiteArgLiterals', () => {
  it('collects literal argument tuples from real call sites', () => {
    const project = projectWith({
      '/def.ts': 'function total(a, b) { return a + b; }',
      '/use.ts': 'import {} from "./def"; total(1, 2); total(3, 4);',
    });
    const results = collectCallSiteArgLiterals(project, 'total');
    expect(results).toContainEqual([1, 2]);
    expect(results).toContainEqual([3, 4]);
  });

  it('collects string, boolean, array, and object literal arguments', () => {
    const project = projectWith({
      '/def.ts': 'function f(s, b, arr, obj) { return s; }',
      '/use.ts': 'f("x", true, [1, 2], { k: "v" });',
    });
    const results = collectCallSiteArgLiterals(project, 'f');
    expect(results).toContainEqual(['x', true, [1, 2], { k: 'v' }]);
  });

  it('skips a call whose arguments include a non-literal expression', () => {
    const project = projectWith({
      '/def.ts': 'function f(a) { return a; }',
      '/use.ts': 'const x = compute(); f(x); f(5);',
    });
    const results = collectCallSiteArgLiterals(project, 'f');
    expect(results).toEqual([[5]]);
  });

  it('deduplicates identical argument tuples', () => {
    const project = projectWith({
      '/def.ts': 'function f(a) { return a; }',
      '/use.ts': 'f(1); f(1); f(1);',
    });
    const results = collectCallSiteArgLiterals(project, 'f');
    expect(results).toEqual([[1]]);
  });

  it('returns an empty array when the function has no real call sites', () => {
    const project = projectWith({ '/def.ts': 'function unused(a) { return a; }' });
    expect(collectCallSiteArgLiterals(project, 'unused')).toEqual([]);
  });

  it('returns an empty array when no function of that name exists', () => {
    const project = projectWith({ '/def.ts': 'function other(a) { return a; }' });
    expect(collectCallSiteArgLiterals(project, 'missing')).toEqual([]);
  });
});
