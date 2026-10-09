import { describe, expect, it } from 'vitest';
import { parsePatch } from './patch.js';

const patch = (files: unknown) => JSON.stringify({ files });

describe('parsePatch', () => {
  it('accepts file path plus full content', () => {
    const result = parsePatch(patch([{ path: 'phone-list.component.ts', content: 'export class A {}' }]));
    expect(result).toEqual({ ok: true, patch: { files: [{ path: 'phone-list.component.ts', content: 'export class A {}' }] } });
  });

  it('accepts an empty files array: nothing to migrate is a valid answer', () => {
    expect(parsePatch(patch([]))).toEqual({ ok: true, patch: { files: [] } });
  });

  it.each([
    ['prose', 'Sure! Here is the file.', /not JSON/],
    ['JSON inside a markdown fence', '```json\n{"files":[]}\n```', /not JSON/],
    ['no files array', '{"file":{}}', /"files" array/],
    ['an extra top-level field', '{"files":[],"explanation":"x"}', /unexpected field/],
    ['a file without content', patch([{ path: 'a.ts' }]), /string "path" and a string "content"/],
    ['empty content', patch([{ path: 'a.ts', content: '  \n' }]), /content is empty/],
    ['the same path twice', patch([{ path: 'a.ts', content: 'x' }, { path: 'a.ts', content: 'y' }]), /repeated/],
  ])('rejects %s', (_name, text, error) => {
    const result = parsePatch(text);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('error', expect.stringMatching(error));
  });

  // The path is written to disk under the workspace: it is untrusted input.
  it.each(['../../../etc/passwd.ts', '/abs/a.ts', 'a/../../b.ts', 'a\\b.ts', './a.ts', 'a.js', 'package.json', 'a b.ts', 'a.ts\0.html'])(
    'rejects the path %j',
    (path) => {
      expect(parsePatch(patch([{ path, content: 'x' }]))).toMatchObject({ ok: false, error: expect.stringMatching(/path must be/) });
    }
  );
});
