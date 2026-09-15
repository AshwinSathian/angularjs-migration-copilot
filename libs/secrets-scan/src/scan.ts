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
 * Scans `content` for credential-shaped patterns without modifying it.
 * Use this for reporting; use `redact` when the content is about to be
 * sent somewhere external (an LLM prompt, a log line).
 */
export function scanForSecrets(content: string): ScanResult {
  const findings: SecretFinding[] = [];

  for (const pattern of SECRET_PATTERNS) {
    // Each pattern's regex carries its own `lastIndex` state across calls
    // because of the `g` flag — reset it so repeated scans of different
    // content don't skip matches.
    pattern.regex.lastIndex = 0;
    for (const match of content.matchAll(pattern.regex)) {
      const groupIndex = pattern.redactGroup ?? 0;
      const secret = match[groupIndex];
      if (!secret) continue;
      const offset = match[0].indexOf(secret);
      const absoluteIndex = (match.index ?? 0) + Math.max(offset, 0);

      findings.push({
        patternId: pattern.id,
        description: pattern.description,
        line: lineNumberAt(content, absoluteIndex),
        redactedPreview: preview(secret),
      });
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return { findings, hasSecrets: findings.length > 0 };
}

/**
 * Returns `content` with every credential-shaped match blanked out, plus
 * the same findings `scanForSecrets` would report. This is what Stage 0
 * runs before any file content reaches an LLM provider — see
 * docs/product-spec.md §6.1. Applies regardless of CLI vs. hosted mode.
 */
export function redact(content: string): RedactResult {
  let redacted = content;

  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    redacted = redacted.replace(pattern.regex, (fullMatch, ...rest) => {
      const groups = rest.slice(0, -2); // matchAll/replace pass (offset, string) last
      const groupIndex = pattern.redactGroup ?? 0;
      const secret = groupIndex === 0 ? fullMatch : groups[groupIndex - 1];
      if (!secret) return fullMatch;
      return fullMatch.replace(secret, `[REDACTED:${pattern.id}]`);
    });
  }

  const scan = scanForSecrets(content);
  return { ...scan, redacted };
}
