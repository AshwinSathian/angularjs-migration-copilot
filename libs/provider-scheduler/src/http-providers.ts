import { RateLimitError, type Provider, type ProviderRequest } from './types.js';

type Fetch = typeof fetch;

async function postJson(
  providerId: string,
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    throw new RateLimitError(providerId, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
  }
  if (!response.ok) {
    // The body is the provider's error message; it never echoes the key, which travels only in a header.
    throw new Error(`${providerId}: HTTP ${response.status} — ${(await response.text()).slice(0, 500)}`);
  }
  return response.json();
}

/**
 * Groq and OpenRouter: the OpenAI chat-completions shape, with
 * `response_format: json_schema` (console.groq.com/docs/structured-outputs).
 * `strict` is off because strict mode is limited to select models; the
 * caller validates the patch either way.
 */
export function createOpenAiCompatibleProvider(options: {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetch?: Fetch;
}): Provider {
  const { id, baseUrl, apiKey, model } = options;
  return {
    id,
    async complete(request: ProviderRequest) {
      const data = (await postJson(
        id,
        options.fetch ?? fetch,
        `${baseUrl}/chat/completions`,
        { authorization: `Bearer ${apiKey}` },
        {
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          max_completion_tokens: request.maxOutputTokens,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'migration_patch', strict: false, schema: request.responseSchema },
          },
        }
      )) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        tokensIn: data.usage?.prompt_tokens ?? 0,
        tokensOut: data.usage?.completion_tokens ?? 0,
      };
    },
  };
}

/** Gemini `generateContent` with a JSON response schema (ai.google.dev/gemini-api/docs/structured-output). */
export function createGeminiProvider(options: {
  readonly id: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetch?: Fetch;
}): Provider {
  const { id, apiKey, model } = options;
  return {
    id,
    async complete(request: ProviderRequest) {
      const data = (await postJson(
        id,
        options.fetch ?? fetch,
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        {
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            responseMimeType: 'application/json',
            responseJsonSchema: request.responseSchema,
          },
        }
      )) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      return {
        text: (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join(''),
        tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
      };
    },
  };
}
