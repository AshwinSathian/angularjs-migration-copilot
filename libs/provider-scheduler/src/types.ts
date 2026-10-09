/**
 * The provider abstraction (docs/product-spec.md §7). Deliberately small:
 * one prompt in, one text out, with the token counts the scheduler needs.
 * A local llama.cpp/Ollama provider fits this without a redesign.
 */
export interface ProviderRequest {
  readonly system: string;
  readonly prompt: string;
  /** JSON Schema for the response. Providers that support constrained output enforce it; the caller validates regardless. */
  readonly responseSchema: Record<string, unknown>;
  readonly maxOutputTokens: number;
}

export interface ProviderResponse {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface Provider {
  readonly id: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

/** A 429. The only error the scheduler handles; anything else propagates to the caller. */
export class RateLimitError extends Error {
  constructor(
    readonly providerId: string,
    /** From the provider's `retry-after`, when it sent one. */
    readonly retryAfterMs?: number
  ) {
    super(`${providerId}: rate limited (429)`);
    this.name = 'RateLimitError';
  }
}

/**
 * Read from configuration, never hardcoded (docs/decisions.md ADR-008).
 * An absent limit is not enforced locally; the provider's own 429 still is.
 */
export interface ProviderLimits {
  readonly rpm?: number;
  readonly tpm?: number;
  readonly rpd?: number;
  readonly tpd?: number;
  /** IANA zone whose midnight resets the daily window (Gemini: `America/Los_Angeles`). Absent: 24h from the window's first call. */
  readonly dailyResetTimeZone?: string;
}

export interface ProviderUsage {
  readonly calls: number;
  readonly rateLimited: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/** ponytail: 4 characters per token, a rough over-estimate for code. Buckets are corrected with the provider's real counts after each call. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
