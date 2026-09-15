import { SECRET_PATTERNS } from './patterns.js';

export interface SecretFinding {
  readonly patternId: string;
  readonly description: string;
  /** 1-indexed line the match starts on. */
  readonly line: number;
  /** The matched secret itself — callers log/report this, never the raw value. */
  readonly redactedPreview: string;
}

export interface ScanResult {
  readonly findings: readonly SecretFinding[];
  /** True if any pattern matched — the fast path callers actually branch on. */
  readonly hasSecrets: boolean;
}

export interface RedactResult extends ScanResult {
  /** `content` with every matched secret replaced by a `[REDACTED:<id>]` marker. */
  readonly redacted: string;
}

interface Match {
  readonly patternId: string;
  readonly description: string;
  readonly start: number;
  readonly end: number;
  readonly secret: string;
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

function preview(secret: string): string {
  if (secret.length <= 8) return '*'.repeat(secret.length);
  return `${secret.slice(0, 4)}${'*'.repeat(secret.length - 8)}${secret.slice(-4)}`;
}

/**
 * Finds every credential-shaped match across all patterns in one pass,
 * keeping only the first (by `SECRET_PATTERNS` order) match for any given
 * character range. Some patterns legitimately overlap on the same input —
 * `API_KEY="..."` matches both `generic-api-key-assignment` (the quoted
 * value) and `env-style-secret-line` (the whole `KEY=value` line, which
 * for a quoted value also spans the value) — and without this, one real
 * secret gets reported and redacted twice under two different pattern IDs,
 * with the second pass re-redacting the first's already-redacted marker.
 */
function findMatches(content: string): Match[] {
  const matches: Match[] = [];

  function overlapsExisting(start: number, end: number): boolean {
    return matches.some((m) => start < m.end && end > m.start);
  }

  for (const pattern of SECRET_PATTERNS) {
    // Each pattern's regex carries its own `lastIndex` state across calls
    // because of the `g` flag — reset it so repeated scans of different
    // content don't skip matches.
    pattern.regex.lastIndex = 0;
    for (const match of content.matchAll(pattern.regex)) {
      const groupIndex = pattern.redactGroup ?? 0;
      const secret = match[groupIndex];
      if (!secret) continue;
      const offsetInMatch = match[0].indexOf(secret);
      const start = (match.index ?? 0) + Math.max(offsetInMatch, 0);
      const end = start + secret.length;
      if (overlapsExisting(start, end)) continue;

      matches.push({ patternId: pattern.id, description: pattern.description, start, end, secret });
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Scans `content` for credential-shaped patterns without modifying it.
 * Use this for reporting; use `redact` when the content is about to be
 * sent somewhere external (an LLM prompt, a log line).
 */
export function scanForSecrets(content: string): ScanResult {
  const findings = findMatches(content).map((m) => ({
    patternId: m.patternId,
    description: m.description,
    line: lineNumberAt(content, m.start),
    redactedPreview: preview(m.secret),
  }));

  return { findings, hasSecrets: findings.length > 0 };
}

/**
 * Returns `content` with every credential-shaped match blanked out, plus
 * the same findings `scanForSecrets` would report. This is what Stage 0
 * runs before any file content reaches an LLM provider — see
 * docs/product-spec.md §6.1. Applies regardless of CLI vs. hosted mode.
 */
export function redact(content: string): RedactResult {
  const matches = findMatches(content); // sorted by start, non-overlapping

  let redacted = '';
  let cursor = 0;
  for (const match of matches) {
    redacted += content.slice(cursor, match.start);
    redacted += `[REDACTED:${match.patternId}]`;
    cursor = match.end;
  }
  redacted += content.slice(cursor);

  const findings = matches.map((m) => ({
    patternId: m.patternId,
    description: m.description,
    line: lineNumberAt(content, m.start),
    redactedPreview: preview(m.secret),
  }));

  return { findings, hasSecrets: findings.length > 0, redacted };
}
