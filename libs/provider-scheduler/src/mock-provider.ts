import { RateLimitError, estimateTokens, type Provider, type ProviderRequest } from './types.js';

/** What one mock call does: return this text, or answer 429. */
export type MockReply = string | { readonly rateLimited: true; readonly retryAfterMs?: number };

/**
 * The local, deterministic provider development and tests run against
 * (docs/architecture.md §6.5). `reply` decides each call from the request
 * and the 0-based call index, so a test scripts exactly the sequence it
 * needs — a valid patch, an invalid one, a 429 — with no network.
 */
export function createMockProvider(
  id: string,
  reply: (request: ProviderRequest, callIndex: number) => MockReply
): Provider & { readonly requests: readonly ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    id,
    requests,
    async complete(request) {
      const result = reply(request, requests.length);
      requests.push(request);
      if (typeof result !== 'string') throw new RateLimitError(id, result.retryAfterMs);
      return {
        text: result,
        tokensIn: estimateTokens(request.system + request.prompt),
        tokensOut: estimateTokens(result),
      };
    },
  };
}
