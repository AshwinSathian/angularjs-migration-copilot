import { parseFragment } from 'parse5';

/**
 * The HTML-pattern equivalent of `assert-compiles.ts`'s role for the
 * TS/JS patterns: not real Angular template compilation (blocked twice
 * over — `@angular/compiler` can't be imported into `migration-core` per
 * CLAUDE.md's module-boundary rule, and `@for`/`@if` block syntax isn't
 * standard HTML a generic parser could validate as markup anyway), but a
 * mechanical, structural soundness check, same "not a full type-check"
 * scope `assertCompiles` already established for `HttpClient` output.
 *
 * Two checks, both confirmed against real parse5 behavior before being
 * relied on here (not assumed): a brace-balance walk over `@for (...) {`
 * / `@if (...) {` / `}` block delimiters (skipping quoted-string
 * content, so a string literal inside a condition expression can't
 * desync the count), and a `parseFragment` pass with `onParseError`
 * enabled over the *whole* output. `@for`/`@if`/bare braces aren't valid
 * HTML tag syntax, but a lenient HTML5 parser never hard-fails on
 * unrecognized text — it treats them as inert text nodes (confirmed by
 * direct probe, zero parse errors) — so this second check only fires on
 * genuine underlying-markup corruption (e.g. an attribute-splice bug
 * that leaves a tag's quote unterminated), which the lenient parser
 * *does* still flag via `onParseError` (confirmed: an unterminated
 * `class="x` attribute produces a real `eof-in-tag` error).
 *
 * **Known, accepted limitation** (found by adversarial review, zero
 * real fixture evidence, deliberately not fixed): `assertBalancedBlocks`
 * counts every `{`/`}` in the whole output as a codemod block
 * delimiter, with no way to distinguish that from a coincidental,
 * unpaired literal brace sitting in ordinary surrounding text the
 * codemod never touched (e.g. `<li ng-if="a">Use the { symbol
 * literally</li>` — the transform itself is correct, but this checker
 * would still reject it as "unbalanced"). Robustly telling "text
 * content" apart from "codemod-emitted syntax" would need real
 * parse5-tree awareness (which text node an offset falls inside) rather
 * than a flat string scan, a materially bigger change than this
 * checker's role as a lightweight structural check justifies without
 * a real case forcing the issue — same judgment call as
 * `assertCompiles`'s own documented ignore-list gaps. A false positive
 * here (rejecting valid output) is the lower-severity failure mode
 * relative to a false negative (accepting corrupted output), which is
 * what both of `assertValidTemplate`'s checks are actually built to
 * catch.
 */
export function assertValidTemplate(outputHtml: string): void {
  assertBalancedBlocks(outputHtml);
  assertNoHtmlParseErrors(outputHtml);
}

/**
 * Past the closing quote (or past the end, for an unterminated string —
 * the overall brace-balance check below still catches that case).
 * Backslash-escape-aware — found by adversarial review: an escaped
 * quote inside a header condition (`'don\'t'`) was previously read as
 * the string's own terminator, desyncing the paren/brace count for
 * everything after it.
 */
function skipQuoted(html: string, start: number): number {
  const quote = html[start];
  let i = start + 1;
  while (i < html.length && html[i] !== quote) {
    i += html[i] === '\\' ? 2 : 1;
  }
  return i + 1;
}

/** Index of the `)` matching the `(` at `openIndex`, respecting nested parens and quoted-string content (e.g. a `'-date'` literal inside a track expression). */
function findMatchingParen(html: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(html, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error(`assertValidTemplate: unterminated "(" starting at offset ${openIndex}\n\n--- output ---\n${html}`);
}

function assertBalancedBlocks(html: string): void {
  let depth = 0;
  let i = 0;

  while (i < html.length) {
    const ch = html[i];

    if (ch === '"' || ch === "'") {
      i = skipQuoted(html, i);
      continue;
    }

    if (html.startsWith('@for (', i) || html.startsWith('@if (', i)) {
      const openParen = html.indexOf('(', i);
      const closeParen = findMatchingParen(html, openParen);
      let j = closeParen + 1;
      while (j < html.length && /\s/.test(html[j])) j++;
      if (html[j] !== '{') {
        throw new Error(
          `assertValidTemplate: "@for (...)"/"@if (...)" block header at offset ${i} is not followed by its opening brace\n\n--- output ---\n${html}`
        );
      }
      depth++;
      i = j + 1;
      continue;
    }

    if (ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth < 0) {
        throw new Error(`assertValidTemplate: unbalanced/orphan "}" at offset ${i} with no matching "{"\n\n--- output ---\n${html}`);
      }
      i++;
      continue;
    }

    i++;
  }

  if (depth !== 0) {
    throw new Error(`assertValidTemplate: unbalanced/unclosed block — ${depth} "{" left unmatched\n\n--- output ---\n${html}`);
  }
}

/**
 * `@for (...)`/`@if (...)` header expressions aren't HTML — they can
 * freely contain `<`/`>` (a length check, `items.length < 5`, is a
 * common real ng-if/ng-repeat shape). An HTML5 tokenizer reads a bare
 * `<` as the possible start of a tag and reports a real (if harmless —
 * confirmed by direct probe that the tokenizer still recovers and
 * treats it as text either way) `onParseError`, which would make this
 * checker reject perfectly valid codemod output. Found by adversarial
 * review, confirmed by direct execution (`@if (a < b) { ... }` produces
 * `invalid-first-character-of-tag-name`; `@if (a > b) { ... }` does
 * not). Masked out here — replacing only `<`/`>` inside each header's
 * own parenthesized span with a space, same length, everything else
 * (including any genuine markup corruption elsewhere in the string)
 * left untouched for the real check below to still catch.
 */
function maskControlFlowExpressions(html: string): string {
  let result = '';
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('@for (', i) || html.startsWith('@if (', i)) {
      const openParen = html.indexOf('(', i);
      const closeParen = findMatchingParen(html, openParen);
      result += html.slice(i, openParen + 1);
      result += html.slice(openParen + 1, closeParen).replace(/[<>]/g, ' ');
      result += html[closeParen];
      i = closeParen + 1;
      continue;
    }
    result += html[i];
    i++;
  }
  return result;
}

function assertNoHtmlParseErrors(html: string): void {
  const errors: string[] = [];
  parseFragment(maskControlFlowExpressions(html), {
    sourceCodeLocationInfo: true,
    onParseError: (err) => errors.push(err.code),
  });

  if (errors.length > 0) {
    throw new Error(`assertValidTemplate: HTML parse error(s) in output: ${errors.join(', ')}\n\n--- output ---\n${html}`);
  }
}
