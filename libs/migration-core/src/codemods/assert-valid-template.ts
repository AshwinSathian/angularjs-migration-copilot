import { parseFragment } from 'parse5';
import { findMatchingParen, maskControlFlowHeaders, maskInterpolations, skipQuoted } from './html-text-utils.js';

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
 * enabled over the *whole* output — after masking `<`/`>` inside both
 * codemod-emitted headers and `{{ }}` interpolation (found by
 * adversarial review: the first version only masked headers, so a
 * completely ordinary, untouched `{{ a < b }}` left in the codemod's
 * *body* output still tripped a false positive). `@for`/`@if`/bare
 * braces aren't valid HTML tag syntax, but a lenient HTML5 parser never
 * hard-fails on unrecognized text — it treats them as inert text nodes
 * (confirmed by direct probe, zero parse errors) — so this second check
 * only fires on genuine underlying-markup corruption (e.g. an
 * attribute-splice bug that leaves a tag's quote unterminated), which
 * the lenient parser *does* still flag via `onParseError` (confirmed: an
 * unterminated `class="x` attribute produces a real `eof-in-tag` error).
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

function assertNoHtmlParseErrors(html: string): void {
  const errors: string[] = [];
  const masked = maskInterpolations(maskControlFlowHeaders(html));
  parseFragment(masked, {
    sourceCodeLocationInfo: true,
    onParseError: (err) => errors.push(err.code),
  });

  if (errors.length > 0) {
    throw new Error(`assertValidTemplate: HTML parse error(s) in output: ${errors.join(', ')}\n\n--- output ---\n${html}`);
  }
}
