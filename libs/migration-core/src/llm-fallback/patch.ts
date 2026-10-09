import { posix } from 'node:path';

/** A structured patch (docs/product-spec.md §6.4): file path plus full content, never prose. */
export interface Patch {
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

/** Sent to every provider as the output contract. All fields required and no extras, the form strict modes accept. */
export const PATCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['files'],
  additionalProperties: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates a provider's raw text against the patch contract. A provider's
 * constrained-output mode is not trusted to have done this: the mock and
 * best-effort modes both produce text that must be checked here.
 *
 * The path is model-chosen and ends up in a filesystem write, so it is
 * checked as untrusted input: relative, no `..`, `.ts` or `.html` only.
 * An empty `files` array is valid — it says the source needs no Angular
 * counterpart.
 */
export function parsePatch(text: string): { ok: true; patch: Patch } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'response is not JSON' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['files'])) {
    return { ok: false, error: 'response must be an object with a "files" array' };
  }
  const extra = Object.keys(parsed).filter((key) => key !== 'files');
  if (extra.length > 0) return { ok: false, error: `unexpected field(s): ${extra.join(', ')}` };

  const files: { path: string; content: string }[] = [];
  for (const [index, file] of parsed['files'].entries()) {
    const at = `files[${index}]`;
    if (!isRecord(file) || typeof file['path'] !== 'string' || typeof file['content'] !== 'string') {
      return { ok: false, error: `${at} must have a string "path" and a string "content"` };
    }
    const path = file['path'];
    if (
      path.includes('\\') ||
      path.includes('\0') ||
      posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      path.split('/').includes('..') ||
      !/^[\w@.-]+(\/[\w@.-]+)*\.(ts|html)$/.test(path)
    ) {
      return { ok: false, error: `${at}.path must be a relative .ts or .html path with no ".." segment` };
    }
    if (file['content'].trim() === '') return { ok: false, error: `${at}.content is empty` };
    if (files.some((other) => other.path === path)) return { ok: false, error: `${at}.path is repeated` };
    files.push({ path, content: file['content'] });
  }
  return { ok: true, patch: { files } };
}
