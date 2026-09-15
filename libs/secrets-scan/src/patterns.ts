/**
 * Credential-shaped patterns to redact before any file content reaches an
 * LLM provider. Deliberately conservative: a false positive costs one
 * unnecessary redaction, a false negative leaks a secret. See
 * docs/product-spec.md §6.1.
 */
export interface SecretPattern {
  readonly id: string;
  readonly description: string;
  readonly regex: RegExp;
  /**
   * Which capture group holds the actual secret, so redaction can blank
   * just that span and leave surrounding code readable. 0 (the default)
   * means redact the whole match.
   */
  readonly redactGroup?: number;
}

// Every regex is global so `matchAll` finds every occurrence in a file, not
// just the first.
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'aws-access-key-id',
    description: 'AWS access key ID',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'private-key-block',
    description: 'PEM-encoded private key block',
    regex:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g,
  },
  {
    id: 'github-token',
    description: 'GitHub personal access / app / refresh token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack bot/user/app token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  {
    id: 'connection-string',
    description: 'database/queue connection string with embedded credentials',
    regex:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"<>]*:[^\s'"<>@]*@[^\s'"<>]+/g,
  },
  {
    id: 'generic-api-key-assignment',
    description: 'variable assignment that looks like an API key or secret',
    regex:
      /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"]([A-Za-z0-9_\-./+=]{16,})['"]/gi,
    redactGroup: 1,
  },
  {
    id: 'env-style-secret-line',
    description: '.env-style KEY=VALUE line whose key name implies a secret',
    regex:
      /^([ \t]*(?:[A-Z][A-Z0-9]*_)*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)(?:_[A-Z0-9]+)*[ \t]*=[ \t]*)(\S+)/gm,
    redactGroup: 2,
  },
];
