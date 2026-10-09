import { describe, expect, it, vi } from 'vitest';
import { createGeminiProvider, createOpenAiCompatibleProvider } from './http-providers.js';
import { RateLimitError, type ProviderRequest } from './types.js';

const REQUEST: ProviderRequest = {
  system: 'sys',
  prompt: 'user',
  responseSchema: { type: 'object' },
  maxOutputTokens: 100,
};
const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn<typeof fetch>(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));
const sent = (fetchMock: ReturnType<typeof respond>) => {
  const [url, init] = fetchMock.mock.calls[0];
  return { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
};

describe('createOpenAiCompatibleProvider', () => {
  const options = { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'test-key', model: 'm' };

  it('sends the schema as response_format and reads text and usage back', async () => {
    const fetchMock = respond(200, {
      choices: [{ message: { content: '{"files":[]}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    });

    const response = await createOpenAiCompatibleProvider({ ...options, fetch: fetchMock }).complete(REQUEST);

    expect(response).toEqual({ text: '{"files":[]}', tokensIn: 12, tokensOut: 5 });
    const request = sent(fetchMock);
    expect(request.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(request.headers.authorization).toBe('Bearer test-key');
    expect(request.body).toMatchObject({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user' },
      ],
      response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } },
    });
  });

  it('turns a 429 into a RateLimitError carrying retry-after in milliseconds', async () => {
    const provider = createOpenAiCompatibleProvider({ ...options, fetch: respond(429, 'slow down', { 'retry-after': '7' }) });
    const error = await provider.complete(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(7000);
  });

  it('a 429 without retry-after carries no delay, leaving the default to the scheduler', async () => {
    const error = await createOpenAiCompatibleProvider({ ...options, fetch: respond(429, '') })
      .complete(REQUEST)
      .catch((e: unknown) => e);
    expect((error as RateLimitError).retryAfterMs).toBeUndefined();
  });

  it('any other failure is a plain error, not a rate limit', async () => {
    const error = await createOpenAiCompatibleProvider({ ...options, fetch: respond(401, 'invalid api key') })
      .complete(REQUEST)
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect((error as Error).message).toBe('groq: HTTP 401 — invalid api key');
  });
});

describe('createGeminiProvider', () => {
  const options = { id: 'gemini-flash', apiKey: 'test-key', model: 'gemini-x-flash' };

  it('sends the schema in generationConfig, the key in a header, and reads text and usage back', async () => {
    const fetchMock = respond(200, {
      candidates: [{ content: { parts: [{ text: '{"files":' }, { text: '[]}' }] } }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
    });

    const response = await createGeminiProvider({ ...options, fetch: fetchMock }).complete(REQUEST);

    expect(response).toEqual({ text: '{"files":[]}', tokensIn: 9, tokensOut: 4 });
    const request = sent(fetchMock);
    expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x-flash:generateContent');
    expect(request.url).not.toContain('test-key');
    expect(request.headers['x-goog-api-key']).toBe('test-key');
    expect(request.body.generationConfig).toEqual({
      maxOutputTokens: 100,
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
    });
  });

  it('turns a 429 into a RateLimitError', async () => {
    await expect(createGeminiProvider({ ...options, fetch: respond(429, {}) }).complete(REQUEST)).rejects.toBeInstanceOf(
      RateLimitError
    );
  });
});
