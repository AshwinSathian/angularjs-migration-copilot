import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMockProvider, createScheduler, type MockReply, type ProviderLimits } from 'provider-scheduler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stage3Options } from '../llm-fallback/index.js';
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

  describe('Stage 3', () => {
    const MIGRATED = 'src/app/migrated';
    const patch = (...files: [string, string][]) => JSON.stringify({ files: files.map(([path, content]) => ({ path, content })) });
    const pipe = (body: string) =>
      `import { Pipe } from '@angular/core';\n@Pipe({ name: 'plainText' })\nexport class PlainTextPipe {\n  transform(text: any) { ${body} }\n}\n`;
    const SAME = `return text ? String(text).replace(/<[^>]+>/gm, '') : '';`;

    /** Scripted replies by source file, behind a real scheduler; `calls` records which files were sent. */
    const stage3 = (replies: Record<string, MockReply>, limits: ProviderLimits = {}, now = 0) => {
      const calls: string[] = [];
      const provider = createMockProvider('mock:groq', (request) => {
        const sourceFile = /^Source file: (.+)$/m.exec(request.prompt)?.[1] as string;
        calls.push(sourceFile);
        return replies[sourceFile] ?? patch();
      });
      const llm: Stage3Options = {
        scheduler: createScheduler({ providers: [{ provider, limits }], stateFile: join(root, 'state/scheduler.json'), now: () => now }),
        mode: 'mock',
        cacheFile: join(root, 'state/answers.json'),
        capTokens: 2000,
        maxOutputTokens: 100,
      };
      return { llm, calls, provider };
    };
    /** Baseline passes, then the mechanical pipe and controller are rejected, leaving them for Stage 3. */
    const rejectMechanical = () =>
      compileMock
        .mockResolvedValueOnce(PASS)
        .mockResolvedValueOnce(fail(`${MIGRATED}/app/filters/plain-text.pipe.ts`, `${MIGRATED}/app/main.controller.ts`));

    it('sends exactly the scripts the mechanical stage left without a compiled file, with the compiler evidence', async () => {
      rejectMechanical().mockResolvedValue(PASS);
      const { llm, calls, provider } = stage3({});

      const report = await runPipeline({ repoDir, workspaceDir, llm });

      // REJECTED (pipe, controller) and NO_MATCH (module); not the LOW directive, and no template on its own.
      expect(calls).toEqual(['app/app.module.js', 'app/filters/plainText.js', 'app/main.js']);
      const controllerPrompt = provider.requests[2].prompt;
      expect(controllerPrompt).toContain('TS2304: m');
      expect(controllerPrompt).toContain('export class MainCtrl');
      // The sibling that did compile is offered as idiom context.
      expect(controllerPrompt).toContain(`// ${MIGRATED}/app/card/card.component.ts`);
      expect(report.files.find((f) => f.sourceFile === 'app/orphan.html')?.llm).toMatchObject({ status: 'NOT_SENT' });
      expect(report.files.find((f) => f.sourceFile === 'app/card/card.directive.js')?.llm).toBeUndefined();
    });

    it('tiers a patch through the same gate: compiled is LOW, a matching characterization is MEDIUM', async () => {
      rejectMechanical().mockResolvedValue(PASS);
      const { llm } = stage3({
        'app/main.js': patch(['main.component.ts', `export class MainComponent {\n  title = 'x';\n}\n`]),
        'app/filters/plainText.js': patch(['plain-text.pipe.ts', pipe(SAME)]),
      });

      const report = await runPipeline({ repoDir, workspaceDir, llm });

      const llmArtifacts = report.artifacts.filter((a) => a.transformType === 'llm-assisted');
      expect(llmArtifacts.map((a) => [a.name, a.artifactType, a.tier, a.providerUsed])).toEqual([
        ['PlainTextPipe', 'filter', 'MEDIUM', 'mock:groq'],
        ['MainComponent', 'controller', 'LOW', 'mock:groq'],
      ]);
      expect(await readFile(join(workspaceDir, MIGRATED, 'app/main.component.ts'), 'utf8')).toContain('MainComponent');

      // Mechanical and llm-assisted are separate figures; Stage 3 does not move the mechanical ones.
      expect(report.mechanical).toMatchObject({ matched: 5, compiled: 2 });
      expect(report.byArtifactType.filter).toEqual({ total: 1, medium: 0, low: 0, rejected: 1 });
      expect(report.llmAssisted).toMatchObject({
        provider: 'mock',
        status: 'complete',
        workList: 3,
        patched: 2,
        compiled: 2,
        emptyPatch: 1,
        manualReview: 0,
        pending: 0,
      });
      expect(report.llmAssisted?.byArtifactType.filter).toEqual({ total: 1, medium: 1, low: 0, rejected: 0 });
      expect(report.llmAssisted?.usage['mock:groq']).toMatchObject({ calls: 3 });
      expect(report.files.find((f) => f.sourceFile === 'app/main.js')).toMatchObject({ outcome: 'REJECTED', llm: { status: 'LOW' } });
      expect(report.files.find((f) => f.sourceFile === 'app/app.module.js')?.llm).toMatchObject({ status: 'EMPTY_PATCH' });
    });

    it('rejects a patch that compiles but changes behaviour: the characterization diff is the check that fails', async () => {
      rejectMechanical().mockResolvedValue(PASS);
      const { llm } = stage3({ 'app/filters/plainText.js': patch(['plain-text.pipe.ts', pipe(`return text ? String(text).trim() : '';`)]) });

      const report = await runPipeline({ repoDir, workspaceDir, llm });

      expect(report.artifacts.find((a) => a.transformType === 'llm-assisted')).toMatchObject({
        tier: 'REJECTED',
        reason: 'characterization diff mismatch',
      });
      expect(report.llmAssisted).toMatchObject({ patched: 1, compiled: 0 });
    });

    it('rejects only the patch the compiler names, removes its files, and keeps its neighbour', async () => {
      rejectMechanical()
        .mockResolvedValueOnce(PASS) // mechanical round 2
        .mockResolvedValueOnce(fail(`${MIGRATED}/app/main.component.html`))
        .mockResolvedValue(PASS);
      const { llm } = stage3({
        'app/main.js': patch(
          ['main.component.ts', `export class MainComponent {}\n`],
          ['main.component.html', `<p>{{ missing }}</p>`]
        ),
        'app/filters/plainText.js': patch(['plain-text.pipe.ts', pipe(SAME)]),
      });

      const report = await runPipeline({ repoDir, workspaceDir, llm });

      expect(report.files.find((f) => f.sourceFile === 'app/main.js')?.llm).toMatchObject({ status: 'REJECTED' });
      expect(report.files.find((f) => f.sourceFile === 'app/filters/plainText.js')?.llm).toMatchObject({ status: 'MEDIUM' });
      // A template error is charged to the patch that owns the template; both of its files are removed.
      await expect(readFile(join(workspaceDir, MIGRATED, 'app/main.component.ts'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(workspaceDir, MIGRATED, 'app/main.component.html'), 'utf8')).rejects.toThrow();
      expect(report.llmAssisted).toMatchObject({ patched: 2, compiled: 1, compileRounds: 2 });
    });

    it('sends a patch to manual review rather than let it overwrite a file that already compiled', async () => {
      rejectMechanical().mockResolvedValue(PASS);
      const { llm } = stage3({ 'app/main.js': patch(['card/card.component.ts', `export class Hijack {}\n`]) });

      const report = await runPipeline({ repoDir, workspaceDir, llm });

      expect(report.files.find((f) => f.sourceFile === 'app/main.js')?.llm).toMatchObject({
        status: 'MANUAL_REVIEW',
        reason: expect.stringMatching(/would overwrite src\/app\/migrated\/app\/card\/card.component.ts/),
      });
      expect(await readFile(join(workspaceDir, MIGRATED, 'app/card/card.component.ts'), 'utf8')).toContain('CardComponent');
    });

    it('pauses with progress kept when providers are exhausted, and a second run finishes the rest', async () => {
      const replies = {
        'app/filters/plainText.js': patch(['plain-text.pipe.ts', pipe(SAME)]),
        'app/main.js': patch(['main.component.ts', `export class MainComponent {}\n`]),
      };
      rejectMechanical().mockResolvedValue(PASS);
      const first = stage3(replies, { rpd: 2 });

      const paused = await runPipeline({ repoDir, workspaceDir, llm: first.llm });

      expect(paused.llmAssisted).toMatchObject({ status: 'paused-rate-limit', patched: 1, compiled: 1, pending: 1, emptyPatch: 1 });
      expect(paused.llmAssisted?.resumeAt).toBe(new Date(24 * 3600_000).toISOString());
      expect(paused.files.find((f) => f.sourceFile === 'app/main.js')?.llm).toMatchObject({ status: 'PENDING' });
      // What was answered before the pause is compiled and tiered, not thrown away.
      expect(paused.files.find((f) => f.sourceFile === 'app/filters/plainText.js')?.llm).toMatchObject({ status: 'MEDIUM' });

      // The next window: a new run on the same state sends only the file that was pending.
      vi.clearAllMocks();
      rejectMechanical().mockResolvedValue(PASS);
      const second = stage3(replies, { rpd: 2 }, 24 * 3600_000);

      const resumed = await runPipeline({ repoDir, workspaceDir, llm: second.llm });

      expect(second.calls).toEqual(['app/main.js']);
      expect(resumed.llmAssisted).toMatchObject({ status: 'complete', patched: 2, compiled: 2, pending: 0 });
      // Two full pipeline runs: over the 5s default on a CI runner.
    }, 30_000);
  });
});
