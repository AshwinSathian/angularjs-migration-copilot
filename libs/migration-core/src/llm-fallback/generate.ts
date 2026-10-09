import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderRequest, ScheduleResult, Scheduler } from 'provider-scheduler';
import { redact } from 'secrets-scan';
import { PATCH_SCHEMA, parsePatch, type Patch } from './patch.js';
import { SYSTEM_PROMPT, buildPrompts, type WorkItem } from './prompt.js';

export interface Stage3Options {
  readonly scheduler: Scheduler;
  /** `mock` or `real` — recorded in the report, and part of the cache key so a mock answer is never reused for a real run. */
  readonly mode: string;
  /** Where finished answers are kept, so a paused job resumes without repeating a call. */
  readonly cacheFile: string;
  /** Source tokens per request; a file over it is split (docs/product-spec.md §6.4). */
  readonly capTokens: number;
  readonly maxOutputTokens: number;
  /** When given, an exhausted scheduler is waited out in-process instead of pausing the job. */
  readonly wait?: (resumeAt: number) => Promise<void>;
}

export type Generation =
  | { readonly status: 'patched'; readonly patch: Patch; readonly providers: readonly string[]; readonly redactions: number }
  /** A valid patch with no files: the model says nothing here needs an Angular counterpart. */
  | { readonly status: 'empty'; readonly providers: readonly string[] }
  | { readonly status: 'manual-review'; readonly reason: string; readonly providers: readonly string[] }
  /** Every provider is exhausted. Nothing is lost: answers so far are cached, and a re-run continues from here. */
  | { readonly status: 'paused'; readonly resumeAt: number };

type Answer = { patch: Patch; providers: string[] } | { manualReview: string; providers: string[] };
type Cache = Record<string, Answer>;

function loadCache(cacheFile: string): Cache {
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf8')) as Cache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {};
  }
}

function saveCache(cacheFile: string, cache: Cache): void {
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(`${cacheFile}.tmp`, JSON.stringify(cache));
  renameSync(`${cacheFile}.tmp`, cacheFile);
}

/**
 * The only place a request to a provider is built (docs/product-spec.md
 * §6.1): every byte of it goes through `redact` here, in mock mode too.
 */
function toRequest(prompt: string, maxOutputTokens: number): { request: ProviderRequest; redactions: number } {
  const system = redact(SYSTEM_PROMPT);
  const user = redact(prompt);
  return {
    request: { system: system.redacted, prompt: user.redacted, responseSchema: PATCH_SCHEMA, maxOutputTokens },
    redactions: system.findings.length + user.findings.length,
  };
}

async function callOrWait(options: Stage3Options, request: ProviderRequest): Promise<ScheduleResult> {
  for (;;) {
    const result = await options.scheduler.call(request);
    if (result.status === 'ok' || !options.wait) return result;
    await options.wait(result.resumeAt);
  }
}

/** One prompt → one validated patch: a second call on an invalid response, then manual review. */
async function answer(options: Stage3Options, prompt: string): Promise<Answer | { resumeAt: number }> {
  const providers: string[] = [];
  let attemptPrompt = prompt;
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { request } = toRequest(attemptPrompt, options.maxOutputTokens);
    const result = await callOrWait(options, request);
    // ponytail: a pause between the two attempts forgets the first; the resumed run starts this prompt again.
    if (result.status === 'exhausted') return { resumeAt: result.resumeAt };
    providers.push(result.providerId);

    const parsed = parsePatch(result.response.text);
    if (parsed.ok) return { patch: parsed.patch, providers };
    lastError = parsed.error;
    attemptPrompt = `${prompt}\n\nYour previous response was rejected: ${parsed.error}. Respond with JSON only, matching the required shape.`;
  }
  return { manualReview: `invalid patch schema after one retry: ${lastError}`, providers };
}

/**
 * Stage 3 for one source file (docs/product-spec.md §6.4): build the
 * prompt(s), send each through the job's scheduler, and validate what
 * comes back. Returns a patch, or the reason there is none. It writes
 * nothing to the workspace and assigns no tier — the caller compiles the
 * patch and the gate tiers it.
 */
export async function generatePatch(item: WorkItem, options: Stage3Options): Promise<Generation> {
  const built = buildPrompts(item, options.capTokens);
  if ('tooLarge' in built) {
    return { status: 'manual-review', reason: `not sent, would have to be truncated — ${built.tooLarge}`, providers: [] };
  }

  const cache = loadCache(options.cacheFile);
  const providers = new Set<string>();
  const files: Patch['files'][number][] = [];
  let redactions = 0;

  for (const prompt of built.prompts) {
    const { request, redactions: found } = toRequest(prompt, options.maxOutputTokens);
    redactions += found;
    const key = createHash('sha256').update(JSON.stringify([options.mode, request.system, request.prompt])).digest('hex');

    let cached = cache[key];
    if (!cached) {
      const fresh = await answer(options, prompt);
      if ('resumeAt' in fresh) return { status: 'paused', resumeAt: fresh.resumeAt };
      cached = cache[key] = fresh;
      saveCache(options.cacheFile, cache);
    }
    for (const provider of cached.providers) providers.add(provider);
    if ('manualReview' in cached) {
      return { status: 'manual-review', reason: cached.manualReview, providers: [...providers] };
    }
    for (const file of cached.patch.files) {
      if (files.some((other) => other.path === file.path)) {
        return {
          status: 'manual-review',
          reason: `two parts of the split file both produced ${file.path}`,
          providers: [...providers],
        };
      }
      files.push(file);
    }
  }

  if (files.length === 0) return { status: 'empty', providers: [...providers] };
  return { status: 'patched', patch: { files }, providers: [...providers], redactions };
}
