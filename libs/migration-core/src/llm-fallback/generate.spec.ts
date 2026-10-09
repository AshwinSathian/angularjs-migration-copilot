import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockProvider, createScheduler, type MockReply, type ProviderLimits, type ProviderRequest } from 'provider-scheduler';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePatch, type Stage3Options } from './generate.js';
import type { WorkItem } from './prompt.js';

const VALID = JSON.stringify({ files: [{ path: 'main.component.ts', content: 'export class Main {}' }] });
const PROSE = 'Here you go!';
const item = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  sourceFile: 'app/main.js',
  sourceText: `angular.module('app').controller('MainCtrl', function ($scope) { $scope.title = 'x'; });`,
  outcome: 'NO_MATCH',
  rejected: [],
  templates: [],
  siblings: [],
  ...overrides,
});

describe('generatePatch', () => {
  let dir: string;
  let now: number;

  /** A chain of scripted providers behind a real scheduler on a fake clock. */
  const stage3 = (
    chain: readonly [string, (request: ProviderRequest, index: number) => MockReply, ProviderLimits?][],
    overrides: Partial<Stage3Options> = {}
  ) => {
    const providers = chain.map(([id, reply]) => createMockProvider(id, reply));
    const options: Stage3Options = {
      scheduler: createScheduler({
        providers: providers.map((provider, index) => ({ provider, limits: chain[index][2] ?? {} })),
        stateFile: join(dir, 'scheduler.json'),
        now: () => now,
      }),
      mode: 'mock',
      cacheFile: join(dir, 'answers.json'),
      capTokens: 2000,
      maxOutputTokens: 100,
      ...overrides,
    };
    return { options, providers };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'generate-spec-'));
    now = Date.UTC(2026, 9, 9, 12);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns a valid patch from one call', async () => {
    const { options, providers } = stage3([['groq', () => VALID]]);

    const result = await generatePatch(item(), options);

    expect(result).toEqual({
      status: 'patched',
      patch: { files: [{ path: 'main.component.ts', content: 'export class Main {}' }] },
      providers: ['groq'],
      redactions: 0,
    });
    expect(providers[0].requests).toHaveLength(1);
    expect(providers[0].requests[0].prompt).toContain('Source file: app/main.js');
    expect(providers[0].requests[0].responseSchema).toHaveProperty('required', ['files']);
  });

  it('retries once on an invalid schema, telling the provider what was wrong', async () => {
    const { options, providers } = stage3([['groq', (_request, index) => (index === 0 ? PROSE : VALID)]]);

    const result = await generatePatch(item(), options);

    expect(result.status).toBe('patched');
    expect(providers[0].requests).toHaveLength(2);
    expect(providers[0].requests[1].prompt).toContain('Your previous response was rejected: response is not JSON');
  });

  it('goes to manual review after the one retry, and never calls a third time', async () => {
    const { options, providers } = stage3([['groq', () => PROSE]]);

    const result = await generatePatch(item(), options);

    expect(result).toEqual({
      status: 'manual-review',
      reason: 'invalid patch schema after one retry: response is not JSON',
      providers: ['groq'],
    });
    expect(providers[0].requests).toHaveLength(2);

    // The verdict is kept: asking again does not spend another call.
    expect((await generatePatch(item(), options)).status).toBe('manual-review');
    expect(providers[0].requests).toHaveLength(2);
  });

  it('a patch whose path escapes the workspace is an invalid schema, not a write', async () => {
    const escape = JSON.stringify({ files: [{ path: '../../../../etc/cron.d/x.ts', content: 'x' }] });
    const { options } = stage3([['groq', () => escape]]);
    expect(await generatePatch(item(), options)).toMatchObject({ status: 'manual-review', reason: expect.stringMatching(/path must be/) });
  });

  it('on a 429 the same request goes to the next provider, with no retry against the first', async () => {
    const { options, providers } = stage3([
      ['groq', () => ({ rateLimited: true })],
      ['gemini-flash-lite', () => VALID],
    ]);

    const result = await generatePatch(item(), options);

    expect(result).toMatchObject({ status: 'patched', providers: ['gemini-flash-lite'] });
    expect(providers[0].requests).toHaveLength(1);
    expect(providers[1].requests[0]).toEqual(providers[0].requests[0]);
  });

  it('pauses when every provider is exhausted, keeps finished answers, and resumes at the next window without repeating them', async () => {
    const chain: Parameters<typeof stage3>[0] = [
      ['groq', () => VALID, { rpd: 1 }],
      ['gemini-flash-lite', () => VALID, { rpd: 1 }],
    ];
    const first = stage3(chain);
    const files = ['app/a.js', 'app/b.js', 'app/c.js'].map((sourceFile) => item({ sourceFile }));

    expect((await generatePatch(files[0], first.options)).status).toBe('patched');
    expect((await generatePatch(files[1], first.options)).status).toBe('patched');
    const paused = await generatePatch(files[2], first.options);
    expect(paused).toEqual({ status: 'paused', resumeAt: now + 24 * 3600_000 });
    expect(first.providers.map((p) => p.requests.length)).toEqual([1, 1]);

    // A new process, the next day: same state directory, fresh providers.
    now += 24 * 3600_000;
    const resumed = stage3(chain);
    for (const file of files) expect((await generatePatch(file, resumed.options)).status).toBe('patched');
    // Only the file that was pending was sent; a.js and b.js came from the kept answers.
    expect(resumed.providers.flatMap((p) => p.requests).map((r) => /Source file: (\S+)/.exec(r.prompt)?.[1])).toEqual(['app/c.js']);
  });

  it('with wait, sits out the exhausted window in-process and carries on', async () => {
    const waits: number[] = [];
    const { options } = stage3([['groq', () => VALID, { rpd: 1 }]], {
      wait: async (resumeAt) => {
        waits.push(resumeAt);
        now = resumeAt;
      },
    });

    expect((await generatePatch(item({ sourceFile: 'app/a.js' }), options)).status).toBe('patched');
    expect((await generatePatch(item({ sourceFile: 'app/b.js' }), options)).status).toBe('patched');
    expect(waits).toHaveLength(1);
  });

  it('redacts secrets from every byte sent, in mock mode too, on the retry as well', async () => {
    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const { options, providers } = stage3([['mock:groq', (_request, index) => (index === 0 ? PROSE : VALID)]]);

    const result = await generatePatch(
      item({
        sourceText: `angular.module('app').constant('KEY', '${awsKey}');`,
        rejected: [{ content: `export const KEY = '${awsKey}';`, diagnostics: [], followUps: [] }],
        templates: [{ path: 'app/main.html', text: `<p data-key="${awsKey}">{{ x }}</p>` }],
        siblings: [{ path: 'src/app/migrated/app/key.service.ts', content: `export const K = '${awsKey}';` }],
      }),
      options
    );

    expect(providers[0].requests).toHaveLength(2);
    for (const request of providers[0].requests) {
      expect(request.system + request.prompt).not.toContain(awsKey);
      expect(request.prompt).toContain('[REDACTED:aws-access-key-id]');
    }
    expect(result).toMatchObject({ status: 'patched', redactions: 4 });
  });

  it('splits a file over the token cap into one request per part and joins the patches', async () => {
    const fn = (name: string) => `function ${name}() {\n  return '${'x'.repeat(200)}';\n}\n`;
    const { options, providers } = stage3(
      [
        [
          'groq',
          (request) => {
            const part = /This is part (\d) of 3/.exec(request.prompt)?.[1];
            return JSON.stringify({ files: [{ path: `part${part}.ts`, content: `export const p${part} = 1;` }] });
          },
        ],
      ],
      { capTokens: 70 }
    );

    const result = await generatePatch(item({ sourceText: fn('a') + fn('b') + fn('c') }), options);

    expect(providers[0].requests).toHaveLength(3);
    expect(result).toMatchObject({ status: 'patched' });
    expect(result.status === 'patched' && result.patch.files.map((f) => f.path)).toEqual(['part1.ts', 'part2.ts', 'part3.ts']);
  });

  it('sends nothing when one function alone is over the cap: manual review, not truncation', async () => {
    const { options, providers } = stage3([['groq', () => VALID]], { capTokens: 10 });

    const result = await generatePatch(item(), options);

    expect(result).toMatchObject({ status: 'manual-review', reason: expect.stringMatching(/would have to be truncated/) });
    expect(providers[0].requests).toHaveLength(0);
  });

  it('reports an empty patch as empty, not as a migration', async () => {
    const { options } = stage3([['groq', () => '{"files":[]}']]);
    expect(await generatePatch(item(), options)).toEqual({ status: 'empty', providers: ['groq'] });
  });

  it('never reuses a mock answer for a real run', async () => {
    const mock = stage3([['groq', () => VALID]]);
    await generatePatch(item(), mock.options);

    const real = stage3([['groq', () => '{"files":[]}']], { mode: 'real' });
    expect((await generatePatch(item(), real.options)).status).toBe('empty');
    expect(real.providers[0].requests).toHaveLength(1);
  });
});
