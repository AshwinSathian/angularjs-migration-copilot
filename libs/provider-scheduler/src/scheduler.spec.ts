import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockProvider, type MockReply } from './mock-provider.js';
import { createScheduler, msUntilMidnight } from './scheduler.js';
import type { ProviderRequest } from './types.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// 40 characters of prompt → 10 tokens in, plus 10 out: every request is estimated at 20 tokens.
const REQUEST: ProviderRequest = { system: '', prompt: 'x'.repeat(40), responseSchema: {}, maxOutputTokens: 10 };
const ok = () => 'ok';
const limited: MockReply = { rateLimited: true };

describe('createScheduler', () => {
  let dir: string;
  let stateFile: string;
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scheduler-spec-'));
    stateFile = join(dir, 'state.json');
    now = Date.UTC(2026, 9, 9, 12, 0, 0);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sends to the first provider in priority order while it has budget', async () => {
    const groq = createMockProvider('groq', ok);
    const gemini = createMockProvider('gemini-flash-lite', ok);
    const scheduler = createScheduler({
      providers: [
        { provider: groq, limits: { rpm: 30 } },
        { provider: gemini, limits: { rpm: 30 } },
      ],
      stateFile,
      now: clock,
    });

    const result = await scheduler.call(REQUEST);

    expect(result).toMatchObject({ status: 'ok', providerId: 'groq' });
    expect(gemini.requests).toHaveLength(0);
  });

  it('falls back to the next provider on a 429 at once, and does not retry the one that refused', async () => {
    const groq = createMockProvider('groq', () => limited);
    const gemini = createMockProvider('gemini-flash-lite', ok);
    const scheduler = createScheduler({
      providers: [
        { provider: groq, limits: {} },
        { provider: gemini, limits: {} },
      ],
      stateFile,
      now: clock,
    });

    expect(await scheduler.call(REQUEST)).toMatchObject({ status: 'ok', providerId: 'gemini-flash-lite' });
    expect(await scheduler.call(REQUEST)).toMatchObject({ status: 'ok', providerId: 'gemini-flash-lite' });

    // One refused call, then blocked: the second request never reached it.
    expect(groq.requests).toHaveLength(1);
    expect(scheduler.usage()).toMatchObject({
      groq: { calls: 0, rateLimited: 1 },
      'gemini-flash-lite': { calls: 2, rateLimited: 0, tokensIn: 20 },
    });
  });

  it("honours a 429's retry-after, and uses the provider again once it has passed", async () => {
    const groq = createMockProvider('groq', (_request, index) => (index === 0 ? { rateLimited: true, retryAfterMs: 5 * MINUTE } : 'ok'));
    const gemini = createMockProvider('gemini-flash-lite', ok);
    const scheduler = createScheduler({
      providers: [
        { provider: groq, limits: {} },
        { provider: gemini, limits: {} },
      ],
      stateFile,
      now: clock,
    });

    await scheduler.call(REQUEST);
    now += 4 * MINUTE;
    expect(await scheduler.call(REQUEST)).toMatchObject({ providerId: 'gemini-flash-lite' });
    now += MINUTE;
    expect(await scheduler.call(REQUEST)).toMatchObject({ providerId: 'groq' });
  });

  it('reports exhausted with the earliest resume time when every provider refuses, and sends nothing more', async () => {
    const groq = createMockProvider('groq', () => ({ rateLimited: true, retryAfterMs: 10 * MINUTE }));
    const gemini = createMockProvider('gemini-flash-lite', () => ({ rateLimited: true, retryAfterMs: 3 * MINUTE }));
    const scheduler = createScheduler({
      providers: [
        { provider: groq, limits: {} },
        { provider: gemini, limits: {} },
      ],
      stateFile,
      now: clock,
    });

    expect(await scheduler.call(REQUEST)).toEqual({ status: 'exhausted', resumeAt: now + 3 * MINUTE });
    expect(await scheduler.call(REQUEST)).toEqual({ status: 'exhausted', resumeAt: now + 3 * MINUTE });
    expect(groq.requests).toHaveLength(1);
    expect(gemini.requests).toHaveLength(1);
  });

  it('enforces requests per minute locally: the bucket empties, then refills with time', async () => {
    const groq = createMockProvider('groq', ok);
    const scheduler = createScheduler({ providers: [{ provider: groq, limits: { rpm: 2 } }], stateFile, now: clock });

    expect((await scheduler.call(REQUEST)).status).toBe('ok');
    expect((await scheduler.call(REQUEST)).status).toBe('ok');
    // Third request in the same instant: no call is made, and one request's worth refills in half a minute.
    expect(await scheduler.call(REQUEST)).toEqual({ status: 'exhausted', resumeAt: now + MINUTE / 2 });
    expect(groq.requests).toHaveLength(2);

    now += MINUTE / 2;
    expect((await scheduler.call(REQUEST)).status).toBe('ok');
  });

  it('enforces tokens per minute and moves to the next provider when the first is out', async () => {
    const groq = createMockProvider('groq', ok);
    const gemini = createMockProvider('gemini-flash-lite', ok);
    const scheduler = createScheduler({
      providers: [
        { provider: groq, limits: { tpm: 30 } }, // room for one 20-token request
        { provider: gemini, limits: {} },
      ],
      stateFile,
      now: clock,
    });

    expect(await scheduler.call(REQUEST)).toMatchObject({ providerId: 'groq' });
    expect(await scheduler.call(REQUEST)).toMatchObject({ providerId: 'gemini-flash-lite' });
  });

  it("corrects the estimate with the provider's real token counts", async () => {
    // Estimated at 20 tokens; the reply is 2 characters, so the real cost is 10 in + 1 out.
    const groq = createMockProvider('groq', ok);
    const scheduler = createScheduler({ providers: [{ provider: groq, limits: { tpd: 100 } }], stateFile, now: clock });

    expect((await scheduler.call(REQUEST)).status).toBe('ok');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(state.providers.groq.day.tokens).toBe(11);
  });

  it('enforces the daily request limit and resets it at midnight in the configured time zone', async () => {
    const gemini = createMockProvider('gemini-flash', ok);
    const scheduler = createScheduler({
      providers: [{ provider: gemini, limits: { rpd: 1, dailyResetTimeZone: 'America/Los_Angeles' } }],
      stateFile,
      now: clock,
    });

    expect((await scheduler.call(REQUEST)).status).toBe('ok');
    // 12:00 UTC on 9 October is 05:00 PDT: midnight Pacific is 19 hours away.
    expect(await scheduler.call(REQUEST)).toEqual({ status: 'exhausted', resumeAt: now + 19 * 60 * MINUTE });

    now += 19 * 60 * MINUTE;
    expect((await scheduler.call(REQUEST)).status).toBe('ok');
  });

  it('without a time zone the daily window is 24 hours from its first call', async () => {
    const groq = createMockProvider('groq', ok);
    const scheduler = createScheduler({ providers: [{ provider: groq, limits: { rpd: 1 } }], stateFile, now: clock });

    await scheduler.call(REQUEST);
    expect(await scheduler.call(REQUEST)).toEqual({ status: 'exhausted', resumeAt: now + DAY });
  });

  it('persists budgets and usage: a new scheduler on the same state file resumes where the last one stopped', async () => {
    const limits = { rpd: 2 };
    const first = createScheduler({ providers: [{ provider: createMockProvider('groq', ok), limits }], stateFile, now: clock });
    await first.call(REQUEST);
    await first.call(REQUEST);

    const groq = createMockProvider('groq', ok);
    const resumed = createScheduler({ providers: [{ provider: groq, limits }], stateFile, now: clock });

    expect(resumed.usage().groq).toMatchObject({ calls: 2 });
    expect((await resumed.call(REQUEST)).status).toBe('exhausted');
    expect(groq.requests).toHaveLength(0);

    now += DAY;
    expect((await resumed.call(REQUEST)).status).toBe('ok');
    expect(resumed.usage().groq).toMatchObject({ calls: 3 });
  });

  it('refuses to start on a corrupt state file rather than resetting spent budgets', () => {
    writeFileSync(stateFile, '{ not json');
    expect(() => createScheduler({ providers: [], stateFile, now: clock })).toThrow();
  });

  it('throws when a request is larger than any provider could ever take, instead of pausing forever', async () => {
    const scheduler = createScheduler({
      providers: [{ provider: createMockProvider('groq', ok), limits: { tpm: 10 } }],
      stateFile,
      now: clock,
    });
    await expect(scheduler.call(REQUEST)).rejects.toThrow(/exceeds every provider/);
  });

  it('lets an error that is not a 429 reach the caller, without trying another provider', async () => {
    const gemini = createMockProvider('gemini-flash-lite', ok);
    const scheduler = createScheduler({
      providers: [
        {
          provider: {
            id: 'groq',
            complete: async () => {
              throw new Error('groq: HTTP 401');
            },
          },
          limits: {},
        },
        { provider: gemini, limits: {} },
      ],
      stateFile,
      now: clock,
    });

    await expect(scheduler.call(REQUEST)).rejects.toThrow('groq: HTTP 401');
    expect(gemini.requests).toHaveLength(0);
  });
});

describe('msUntilMidnight', () => {
  it('measures to midnight in the given zone, not in UTC', () => {
    const noonUtc = Date.UTC(2026, 9, 9, 12, 0, 0);
    expect(msUntilMidnight(noonUtc, 'UTC')).toBe(12 * 60 * MINUTE);
    expect(msUntilMidnight(noonUtc, 'America/Los_Angeles')).toBe(19 * 60 * MINUTE);
  });
});
