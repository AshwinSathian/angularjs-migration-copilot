import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  RateLimitError,
  estimateTokens,
  type Provider,
  type ProviderLimits,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderUsage,
} from './types.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A token bucket: `tokens` available as of `at`, refilling to capacity over one minute. */
interface Bucket {
  tokens: number;
  at: number;
}

interface ProviderState {
  requests?: Bucket;
  tokens?: Bucket;
  day: { requests: number; tokens: number; resetAt: number };
  /** Set by a 429: the provider is skipped until then. */
  blockedUntil: number;
  usage: { calls: number; rateLimited: number; tokensIn: number; tokensOut: number };
}

export interface SchedulerState {
  readonly providers: Record<string, ProviderState>;
}

export type ScheduleResult =
  | { readonly status: 'ok'; readonly providerId: string; readonly response: ProviderResponse }
  /** Every provider is out of budget or blocked. Nothing was sent; call again at `resumeAt`. */
  | { readonly status: 'exhausted'; readonly resumeAt: number };

export interface ScheduledProvider {
  readonly provider: Provider;
  readonly limits: ProviderLimits;
}

export interface Scheduler {
  call(request: ProviderRequest): Promise<ScheduleResult>;
  usage(): Record<string, ProviderUsage>;
}

/** Milliseconds from `now` to the next midnight in `timeZone`. ponytail: assumes a 24h day, so it is up to an hour off on the two DST-change days. */
export function msUntilMidnight(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(now));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return DAY - (part('hour') * 3600 + part('minute') * 60 + part('second')) * 1000;
}

function refill(bucket: Bucket, capacity: number, now: number): void {
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.at) / MINUTE) * capacity);
  bucket.at = now;
}

/** When `cost` can be taken from a minute bucket; `Infinity` when it exceeds the bucket's capacity and never can. */
function bucketReadyAt(bucket: Bucket, capacity: number, cost: number, now: number): number {
  if (cost > capacity) return Infinity;
  refill(bucket, capacity, now);
  return bucket.tokens >= cost ? now : now + ((cost - bucket.tokens) / capacity) * MINUTE;
}

/**
 * A job-level scheduler (docs/product-spec.md §7): one instance paces every
 * call of a job across providers, in the priority order given.
 *
 * - Per provider: a token bucket for requests per minute and one for tokens
 *   per minute, and a daily window for requests and tokens.
 * - A request goes to the first provider with budget for it right now.
 * - A 429 blocks that provider (for its `retry-after`, else a minute) and the
 *   same request goes straight to the next one — never a retry in place.
 * - When no provider can take the request, nothing is sent and the earliest
 *   time one can is returned; the caller pauses and resumes.
 *
 * State is one JSON file, written after every call, so a resumed process
 * carries the same budgets. ponytail: single-process only, no file lock;
 * the Mongo-backed version (M4) is where concurrent jobs get handled.
 */
export function createScheduler(options: {
  readonly providers: readonly ScheduledProvider[];
  readonly stateFile: string;
  readonly now?: () => number;
}): Scheduler {
  const { providers, stateFile } = options;
  const clock = options.now ?? Date.now;

  let state: SchedulerState = { providers: {} };
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8')) as SchedulerState;
  } catch (error) {
    // A missing file is a fresh job. Anything else (unreadable, corrupt) must not silently reset spent budgets.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const save = () => {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${stateFile}.tmp`, stateFile);
  };

  const stateOf = ({ provider, limits }: ScheduledProvider, now: number): ProviderState => {
    const existing = state.providers[provider.id];
    const current: ProviderState = existing ?? {
      day: { requests: 0, tokens: 0, resetAt: 0 },
      blockedUntil: 0,
      usage: { calls: 0, rateLimited: 0, tokensIn: 0, tokensOut: 0 },
    };
    state.providers[provider.id] = current;
    if (limits.rpm !== undefined) current.requests ??= { tokens: limits.rpm, at: now };
    if (limits.tpm !== undefined) current.tokens ??= { tokens: limits.tpm, at: now };
    if (now >= current.day.resetAt) {
      const untilReset = limits.dailyResetTimeZone ? msUntilMidnight(now, limits.dailyResetTimeZone) : DAY;
      current.day = { requests: 0, tokens: 0, resetAt: now + untilReset };
    }
    return current;
  };

  const readyAt = (entry: ScheduledProvider, cost: number, now: number): number => {
    const { limits } = entry;
    const current = stateOf(entry, now);
    if ((limits.tpd !== undefined && cost > limits.tpd) || (limits.rpd !== undefined && limits.rpd < 1)) return Infinity;
    const dayFull =
      (limits.rpd !== undefined && current.day.requests + 1 > limits.rpd) ||
      (limits.tpd !== undefined && current.day.tokens + cost > limits.tpd);
    return Math.max(
      current.blockedUntil,
      dayFull ? current.day.resetAt : now,
      current.requests && limits.rpm !== undefined ? bucketReadyAt(current.requests, limits.rpm, 1, now) : now,
      current.tokens && limits.tpm !== undefined ? bucketReadyAt(current.tokens, limits.tpm, cost, now) : now
    );
  };

  return {
    async call(request) {
      const estimate = estimateTokens(request.system + request.prompt) + request.maxOutputTokens;
      const now = clock();
      for (const entry of providers) {
        if (readyAt(entry, estimate, now) > now) continue;
        const current = stateOf(entry, now);

        // Spend the estimate before the call, so a crash mid-call cannot leave the budget looking unspent.
        if (current.requests) current.requests.tokens -= 1;
        if (current.tokens) current.tokens.tokens -= estimate;
        current.day.requests += 1;
        current.day.tokens += estimate;
        save();

        try {
          const response = await entry.provider.complete(request);
          const correction = estimate - (response.tokensIn + response.tokensOut);
          if (current.tokens) current.tokens.tokens += correction;
          current.day.tokens -= correction;
          current.usage.calls += 1;
          current.usage.tokensIn += response.tokensIn;
          current.usage.tokensOut += response.tokensOut;
          save();
          return { status: 'ok', providerId: entry.provider.id, response };
        } catch (error) {
          if (!(error instanceof RateLimitError)) {
            save();
            throw error;
          }
          // The provider's own count is the truth and it disagrees with ours: stop using it until it says otherwise.
          current.blockedUntil = clock() + (error.retryAfterMs ?? MINUTE);
          current.usage.rateLimited += 1;
          save();
        }
      }

      const after = clock();
      const resumeAt = Math.min(...providers.map((entry) => readyAt(entry, estimate, after)));
      save();
      if (resumeAt === Infinity) {
        throw new Error(
          `request of ~${estimate} tokens exceeds every provider's per-minute or per-day token limit — split the input or raise the limits`
        );
      }
      return { status: 'exhausted', resumeAt };
    },

    usage() {
      return Object.fromEntries(
        providers.map(({ provider }) => [
          provider.id,
          { ...(state.providers[provider.id]?.usage ?? { calls: 0, rateLimited: 0, tokensIn: 0, tokensOut: 0 }) },
        ])
      );
    },
  };
}
