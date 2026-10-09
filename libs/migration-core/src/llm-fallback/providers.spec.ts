import { describe, expect, it } from 'vitest';
import { createMockProviders, createRealProviders, mockBehaviourFor, parseProvidersConfig } from './providers.js';

const LIMITS = { rpm: 30 };

describe('parseProvidersConfig', () => {
  it('reads model and limits per provider', () => {
    expect(parseProvidersConfig('{"groq":{"model":"m","limits":{"rpm":30,"tpm":8000}}}')).toEqual({
      groq: { model: 'm', limits: { rpm: 30, tpm: 8000 } },
    });
  });

  it('rejects a provider it does not know and a limit that is not a positive number', () => {
    expect(() => parseProvidersConfig('{"openai":{}}')).toThrow(/unknown provider "openai"/);
    expect(() => parseProvidersConfig('{"groq":{"limits":{"rpm":"30"}}}')).toThrow(/groq.limits.rpm/);
    expect(() => parseProvidersConfig('{"groq":{"limits":{"rpd":0}}}')).toThrow(/groq.limits.rpd/);
  });
});

describe('createRealProviders', () => {
  const config = {
    openrouter: { model: 'o:free', limits: LIMITS },
    'gemini-flash': { model: 'gf', limits: LIMITS },
    groq: { model: 'g', limits: LIMITS },
    'gemini-flash-lite': { model: 'gfl', limits: LIMITS },
  };

  it('builds the chain in the fixed priority order, whatever order the config is written in', () => {
    const { providers, skipped } = createRealProviders(config, { GROQ_API_KEY: 'a', GEMINI_API_KEY: 'b', OPENROUTER_API_KEY: 'c' });
    expect(providers.map((entry) => entry.provider.id)).toEqual(['groq', 'gemini-flash-lite', 'gemini-flash', 'openrouter']);
    expect(skipped).toEqual([]);
  });

  it('skips, and says why, a provider with no key, no model or no limits — never a default', () => {
    const { providers, skipped } = createRealProviders(
      { groq: { model: 'g', limits: LIMITS }, 'gemini-flash-lite': { limits: LIMITS }, 'gemini-flash': { model: 'gf' } },
      { GEMINI_API_KEY: 'b' }
    );
    expect(providers).toEqual([]);
    expect(skipped).toEqual([
      'groq: GROQ_API_KEY is not set',
      'gemini-flash-lite: no model in the providers config',
      'gemini-flash: no limits in the providers config',
      'openrouter: no model in the providers config',
    ]);
  });
});

describe('createMockProviders', () => {
  const request = (sourceFile: string, retry = false) => ({
    system: '',
    prompt: `Source file: ${sourceFile}\n...${retry ? '\n\nYour previous response was rejected: x.' : ''}`,
    responseSchema: {},
    maxOutputTokens: 100,
  });
  // Paths found by hash, one per behaviour, so the test pins the behaviours rather than the hash.
  const fileFor = (behaviour: string) => {
    for (let i = 0; ; i++) if (mockBehaviourFor(`f${i}.js`) === behaviour) return `f${i}.js`;
  };

  it('is the real chain in order, with no limits unless configured', () => {
    const chain = createMockProviders({ groq: { limits: { rpm: 2 } } });
    expect(chain.map((entry) => entry.provider.id)).toEqual(['mock:groq', 'mock:gemini-flash-lite', 'mock:gemini-flash', 'mock:openrouter']);
    expect(chain.map((entry) => entry.limits)).toEqual([{ rpm: 2 }, {}, {}, {}]);
  });

  it('scripts each path the same way on every run', async () => {
    const [groq, flashLite] = createMockProviders().map((entry) => entry.provider);

    await expect(groq.complete(request(fileFor('rate-limit-first-provider')))).rejects.toThrow(/429/);
    expect(JSON.parse((await flashLite.complete(request(fileFor('rate-limit-first-provider')))).text).files).toHaveLength(1);

    const flaky = fileFor('invalid-then-valid');
    expect(() => JSON.parse('') as unknown).toThrow();
    expect((await groq.complete(request(flaky))).text).not.toMatch(/^\{/);
    expect(JSON.parse((await groq.complete(request(flaky, true))).text).files).toHaveLength(1);

    expect((await groq.complete(request(fileFor('invalid-twice'), true))).text).not.toMatch(/^\{/);
    expect(JSON.parse((await groq.complete(request(fileFor('empty')))).text)).toEqual({ files: [] });
    expect((await groq.complete(request(fileFor('does-not-compile')))).text).toContain("number = 'not a number'");
    expect((await groq.complete(request(fileFor('valid')))).text).toContain('export class Mock');
  });
});
