import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  createGeminiProvider,
  createMockProvider,
  createOpenAiCompatibleProvider,
  type MockReply,
  type Provider,
  type ProviderLimits,
  type ProviderRequest,
  type ScheduledProvider,
} from 'provider-scheduler';

/** Fixed priority order (docs/decisions.md ADR-008): fastest free tier first, lowest-reliability pool last. */
export const PROVIDER_SLOTS = ['groq', 'gemini-flash-lite', 'gemini-flash', 'openrouter'] as const;
export type ProviderSlot = (typeof PROVIDER_SLOTS)[number];

/**
 * Per-slot model and limits, read from a file the operator fills in from
 * their own provider consoles. Nothing here has a compiled-in default:
 * free-tier models and limits change on the providers' timeline
 * (docs/decisions.md ADR-008, ADR-074).
 */
export type ProvidersConfig = Partial<Record<ProviderSlot, { readonly model?: string; readonly limits?: ProviderLimits }>>;

const KEY_VARIABLES: Record<ProviderSlot, string> = {
  groq: 'GROQ_API_KEY',
  'gemini-flash-lite': 'GEMINI_API_KEY',
  'gemini-flash': 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const LIMIT_KEYS = ['rpm', 'tpm', 'rpd', 'tpd'] as const;

export function parseProvidersConfig(text: string): ProvidersConfig {
  const parsed = JSON.parse(text) as Record<string, { model?: unknown; limits?: Record<string, unknown> }>;
  for (const [slot, entry] of Object.entries(parsed)) {
    if (!(PROVIDER_SLOTS as readonly string[]).includes(slot)) {
      throw new Error(`providers config: unknown provider "${slot}" (expected ${PROVIDER_SLOTS.join(', ')})`);
    }
    for (const key of LIMIT_KEYS) {
      const value = entry.limits?.[key];
      if (value !== undefined && (typeof value !== 'number' || !(value > 0))) {
        throw new Error(`providers config: ${slot}.limits.${key} must be a positive number`);
      }
    }
  }
  return parsed as ProvidersConfig;
}

/**
 * The real chain. A slot is used only when the config names a model for
 * it and its key is in the environment; the rest are returned as
 * `skipped` with the reason, so a run never quietly uses fewer providers
 * than the operator thinks.
 */
export function createRealProviders(
  config: ProvidersConfig,
  env: Record<string, string | undefined>
): { readonly providers: readonly ScheduledProvider[]; readonly skipped: readonly string[] } {
  const providers: ScheduledProvider[] = [];
  const skipped: string[] = [];
  for (const slot of PROVIDER_SLOTS) {
    const entry = config[slot];
    const apiKey = env[KEY_VARIABLES[slot]];
    if (!entry?.model) {
      skipped.push(`${slot}: no model in the providers config`);
      continue;
    }
    if (!entry.limits || LIMIT_KEYS.every((key) => entry.limits?.[key] === undefined)) {
      skipped.push(`${slot}: no limits in the providers config`);
      continue;
    }
    if (!apiKey) {
      skipped.push(`${slot}: ${KEY_VARIABLES[slot]} is not set`);
      continue;
    }
    const provider: Provider =
      slot === 'groq'
        ? createOpenAiCompatibleProvider({ id: slot, baseUrl: 'https://api.groq.com/openai/v1', apiKey, model: entry.model })
        : slot === 'openrouter'
          ? createOpenAiCompatibleProvider({ id: slot, baseUrl: 'https://openrouter.ai/api/v1', apiKey, model: entry.model })
          : createGeminiProvider({ id: slot, apiKey, model: entry.model });
    providers.push({ provider, limits: entry.limits });
  }
  return { providers, skipped };
}

const RETRY_MARKER = 'Your previous response was rejected';

/** What the mock does with a given source file — decided by a hash of its path, so a run is repeatable. */
export type MockBehaviour = 'valid' | 'rate-limit-first-provider' | 'invalid-then-valid' | 'invalid-twice' | 'does-not-compile' | 'empty';
const BEHAVIOURS: readonly MockBehaviour[] = [
  'rate-limit-first-provider',
  'invalid-then-valid',
  'invalid-twice',
  'does-not-compile',
  'empty',
  'valid',
  'valid',
  'valid',
  'valid',
  'valid',
];

export function mockBehaviourFor(sourceFile: string): MockBehaviour {
  return BEHAVIOURS[createHash('sha256').update(sourceFile).digest()[0] % BEHAVIOURS.length];
}

function mockReply(slot: ProviderSlot, request: ProviderRequest): MockReply {
  const sourceFile = /^Source file: (.+)$/m.exec(request.prompt)?.[1] ?? 'unknown';
  const part = /^This is part (\d+) of/m.exec(request.prompt)?.[1];
  const behaviour = mockBehaviourFor(sourceFile);
  const isRetry = request.prompt.includes(RETRY_MARKER);

  if (behaviour === 'rate-limit-first-provider' && slot === 'groq') return { rateLimited: true, retryAfterMs: 1000 };
  if (behaviour === 'invalid-twice' || (behaviour === 'invalid-then-valid' && !isRetry)) {
    return 'Sure! Here is the migrated file you asked for.';
  }
  if (behaviour === 'empty') return JSON.stringify({ files: [] });

  const id = createHash('sha256').update(`${sourceFile}#${part ?? ''}`).digest('hex').slice(0, 8);
  const path = `${posix.basename(sourceFile).replace(/\.[a-z]+$/, '')}${part ? `.part${part}` : ''}.mock.ts`;
  const body =
    behaviour === 'does-not-compile'
      ? `export const mock${id}: number = 'not a number';`
      : `export class Mock${id} {\n  readonly source = ${JSON.stringify(sourceFile)};\n}`;
  return JSON.stringify({ files: [{ path, content: `// Mock provider output. A stand-in, not a migration.\n${body}\n` }] });
}

/**
 * The mock chain `migrate --provider mock` runs against (docs/architecture.md
 * §6.5): four scripted providers in the real priority order, no network.
 * Its patches are stand-ins that exercise every path — valid, invalid
 * schema once and twice, a 429 on the first provider, a patch the
 * compiler rejects, an empty patch. Numbers from a mock run measure the
 * plumbing, never a migration rate.
 */
export function createMockProviders(config: ProvidersConfig = {}): readonly ScheduledProvider[] {
  return PROVIDER_SLOTS.map((slot) => ({
    provider: createMockProvider(`mock:${slot}`, (request) => mockReply(slot, request)),
    limits: config[slot]?.limits ?? {},
  }));
}
