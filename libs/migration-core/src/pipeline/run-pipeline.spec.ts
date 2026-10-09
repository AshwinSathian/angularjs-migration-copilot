import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompileCheckResult } from '../verification/index.js';

// Only the subprocess is replaced; tiering, characterization and assembly are the real ones.
const compileMock = vi.fn<(workspaceDir: string) => Promise<CompileCheckResult>>();
vi.mock('../verification/check-compiles.js', async (original) => ({
  ...(await original<typeof import('../verification/check-compiles.js')>()),
  runCompileCheck: (workspaceDir: string) => compileMock(workspaceDir),
}));
const { runPipeline } = await import('./run-pipeline.js');

const PASS: CompileCheckResult = { passed: true, log: '' };
const fail = (...files: string[]): CompileCheckResult => ({
  passed: false,
  log: 'errors',
  failure: 'diagnostics',
  diagnostics: files.map((file) => ({ file, code: 'TS2304', message: 'm' })),
});

const REPO: Record<string, string> = {
  'app/filters/plainText.js': `angular.module('app').filter('plainText', function () {
    return function (text) { return text ? String(text).replace(/<[^>]+>/gm, '') : ''; };
  });`,
  'app/main.js': `angular.module('app').controller('MainCtrl', MainCtrl);
    function MainCtrl($scope) { $scope.title = 'x'; }`,
  'app/card/card.directive.js': `angular.module('app').directive('card', card);
    function card() { return { restrict: 'E', templateUrl: 'app/card/card.html' }; }`,
  'app/card/card.html': `<li ng-repeat="item in items">{{ item }}</li>`,
  'app/orphan.html': `<p ng-if="show">x</p>`,
  'app/app.module.js': `angular.module('app', []);`,
  'gulpfile.js': `module.exports = {};`,
  'node_modules/angular/angular.js': `angular.module('ng');`,
};

describe('runPipeline', () => {
  let root: string;
  let repoDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'pipeline-spec-'));
    repoDir = join(root, 'repo');
    workspaceDir = join(root, 'ws');
    for (const [path, content] of Object.entries(REPO)) {
      await mkdir(dirname(join(repoDir, path)), { recursive: true });
      await writeFile(join(repoDir, path), content);
    }
    await mkdir(workspaceDir, { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('refuses to run against a workspace that does not compile to begin with', async () => {
    compileMock.mockResolvedValue({ passed: false, log: 'npx canceled', failure: 'could-not-run', diagnostics: [] });
    await expect(runPipeline({ repoDir, workspaceDir })).rejects.toThrow(/does not compile before migration/);
  });

  it('scopes to AngularJS files, emits standalone files, and tiers each through the real gate policy', async () => {
    compileMock.mockResolvedValue(PASS);

    const report = await runPipeline({ repoDir, workspaceDir });

    // gulpfile.js and node_modules are not AngularJS source; everything else is the denominator.
    expect(report.sourceFiles).toMatchObject({ inScope: 6, scripts: 4, templates: 2 });
    expect(report.artifacts.map((a) => [a.name, a.tier])).toEqual([
      ['CardComponent', 'LOW'],
      ['PlainTextPipe', 'MEDIUM'],
      ['MainCtrl', 'LOW'],
    ]);
    expect(report.byArtifactType.filter).toEqual({ total: 1, medium: 1, low: 0, rejected: 0 });
    // matched ≠ compiled: orphan.html matched pattern #7 but nothing compiled it.
    expect(report.mechanical).toEqual({ matched: 5, compiled: 4, matchRate: 0.833, compiledRate: 0.667 });
    expect(report.files.find((f) => f.sourceFile === 'app/orphan.html')).toMatchObject({ outcome: 'NOT_EMITTED' });
    expect(report.files.find((f) => f.sourceFile === 'app/app.module.js')).toMatchObject({ outcome: 'NO_MATCH' });

    // The component's template travelled with it, transformed, and the URL was rewritten.
    const emitted = join(workspaceDir, 'src/app/migrated/app/card');
    expect(await readFile(join(emitted, 'card.component.ts'), 'utf8')).toContain(`templateUrl: './card.component.html'`);
    expect(await readFile(join(emitted, 'card.component.html'), 'utf8')).toContain('@for (item of items');
    // The source repo was only read.
    expect(await readFile(join(repoDir, 'app/main.js'), 'utf8')).toBe(REPO['app/main.js']);
  });

  it('rejects only the files the compiler names, removes them, and recompiles the rest', async () => {
    compileMock
      .mockResolvedValueOnce(PASS) // baseline
      .mockResolvedValueOnce(fail('src/app/migrated/app/main.controller.ts'))
      .mockResolvedValueOnce(fail('src/app/migrated/app/card/card.component.html'))
      .mockResolvedValueOnce(PASS);

    const report = await runPipeline({ repoDir, workspaceDir });

    expect(report.compileRounds).toBe(3);
    expect(Object.fromEntries(report.artifacts.map((a) => [a.name, a.tier]))).toEqual({
      MainCtrl: 'REJECTED',
      CardComponent: 'REJECTED', // a template error is charged to the component that owns the template
      PlainTextPipe: 'MEDIUM',
    });
    expect(report.artifacts.find((a) => a.name === 'MainCtrl')?.diagnostics).toHaveLength(1);
    await expect(readFile(join(workspaceDir, 'src/app/migrated/app/main.controller.ts'), 'utf8')).rejects.toThrow();
    expect(report.mechanical.compiled).toBe(1);
  });

  it('fails everything left, closed, when the compiler stops running mid-run', async () => {
    compileMock
      .mockResolvedValueOnce(PASS)
      .mockResolvedValue({ passed: false, log: 'timed out', failure: 'could-not-run', diagnostics: [] });

    const report = await runPipeline({ repoDir, workspaceDir });

    expect(report.artifacts.every((a) => a.tier === 'REJECTED' && /could not run/.test(a.reason))).toBe(true);
    expect(report.mechanical.compiled).toBe(0);
  });
});
