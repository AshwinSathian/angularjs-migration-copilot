import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { applyEdits, type PositionEdit } from './class-wrapping.js';
import type { CodemodResult } from './types.js';

type Element = DefaultTreeAdapterMap['element'];

/**
 * Pattern #7 (docs/product-spec.md §6.3) — `ng-repeat`/`ng-if`/`ng-show` →
 * `@for`/`@if` control flow + a `[hidden]` binding. The only M1 pattern
 * operating on HTML templates rather than TS/JS: parse5 (not ts-morph)
 * provides source-location offsets, and the transform is a plain
 * position-based splice against the original text, same discipline as
 * every ts-morph pattern — nothing is reformatted or reserialized.
 *
 * **Architecture departs from every prior pattern**: replace-in-place,
 * not insert-only. A `@for`/`@if` block isn't valid AngularJS template
 * syntax any more than a `@Component` class is valid AngularJS
 * registration syntax, but unlike JS, HTML has no way for old and new
 * syntax to coexist side by side on the same element — there's nowhere
 * to "insert alongside." See docs/decisions.md for the ADR.
 *
 * **Nesting order** (when 2+ of the three appear on one element) is
 * taken directly from AngularJS's own real directive priorities,
 * verified against the actual published `angular` package source
 * (1.8.3), not assumed: `ngRepeat` (`priority: 1000`, `transclude:
 * 'element'`, `terminal: true`, `$$tlb: true`) always wraps outermost as
 * `@for`; `ngIf` (`priority: 600`, same transclude/terminal/`$$tlb`
 * flags — the actual mechanism AngularJS uses to let two structural
 * directives combine on one element) nests immediately inside as `@if`;
 * `ngShow` (no `priority`/`transclude` key at all in its real directive
 * definition — just a `$watch` plus a class toggle) is never a wrapping
 * block, always a `[hidden]` attribute merged onto the element itself
 * regardless of what else wraps it.
 *
 * Each of the three directives on an element is evaluated independently
 * — an unsafe/unsupported shape for one (e.g. a piped `ng-repeat`
 * expression) is skipped and left untouched, with a warning, while a
 * safely-transformable sibling directive on the *same* element still
 * gets converted. Same "transform what's safe, flag what isn't, never
 * silently drop a warning" precedent every JS pattern already follows
 * for sibling registrations in one file.
 *
 * Real-fixture evidence checked before writing any detection code
 * (standing practice since ADR-030 onward): `ng-repeat` real hits are
 * overwhelmingly the plain `item in collection` form with no `track by`
 * — the one real occurrence of `track by` is immediately followed by a
 * `| orderBy` pipe and gets skipped for that reason anyway, so nearly
 * every real hit exercises the *default* track path. AngularJS's own
 * default tracking strategy (verified against real source) is identity-
 * based (`$$hashKey`), which `track <loopVar>` approximates far more
 * closely than `track $index` (position-based) would — the loop
 * variable itself is the default track expression here, not an index.
 * Zero real occurrences of an `... as alias` clause (present in
 * AngularJS's own real `ngRepeat` grammar, confirmed from source, but
 * unbuilt here) or a `(key, value) in` destructuring form exist in any
 * of the three vendored fixtures — both are detected and skipped,
 * documented, not guessed at. `$index`/`$first`/`$last`/`$even`/`$odd`
 * are referenced nowhere in any fixture's repeated markup either —
 * unbuilt, flagged in docs/decisions.md.
 */

const NG_REPEAT_GRAMMAR =
  /^\s*([\s\S]+?)\s+in\s+([\s\S]+?)(?:\s+as\s+([\s\S]+?))?(?:\s+track\s+by\s+([\s\S]+?))?\s*$/;
const SIMPLE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Removes AngularJS's one-time-binding `::` marker, but only outside
 * quoted string content — found by adversarial review, confirmed by
 * direct execution: a blind global substring removal corrupted a
 * string literal that happens to contain `::` (e.g.
 * `vm.check('foo::bar')` → `vm.check('foobar')`), silently changing the
 * expression's actual value rather than just stripping a binding-mode
 * marker.
 */
function stripOneTimeBinding(expr: string): string {
  let result = '';
  let i = 0;
  let inQuote: string | undefined;
  while (i < expr.length) {
    const ch = expr[i];
    if (inQuote) {
      result += ch;
      if (ch === '\\') {
        result += expr[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === inQuote) inQuote = undefined;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      result += ch;
      i++;
      continue;
    }
    if (expr.startsWith('::', i)) {
      i += 2;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/** Removes an attribute token plus exactly one adjacent run of whitespace (trailing if any exists, else leading) — verified against real multi-line, multi-attribute fixture markup so no double space or dangling indentation is left behind. */
function attributeRemovalEdit(fullText: string, start: number, end: number): PositionEdit {
  let e = end;
  while (e < fullText.length && /\s/.test(fullText[e])) e++;
  if (e > end) return { pos: start, end: e, replacement: '' };

  let s = start;
  while (s > 0 && /\s/.test(fullText[s - 1])) s--;
  return { pos: s, end, replacement: '' };
}

/**
 * When two or more attributes being removed from the same element are
 * only whitespace apart (`ng-repeat="x" ng-if="y"`), computing each
 * one's own "consume one adjacent whitespace run" edit independently can
 * double-claim the single separator between them — found by self-review
 * against a case no real fixture or earlier test happened to cover
 * (ng-if adjacent to ng-repeat *and* the last attribute before `>`,
 * so its own whitespace consumption falls back to the *leading* side,
 * directly overlapping ng-repeat's *trailing* consumption of that same
 * gap), confirmed by direct execution to corrupt output (ate the `>`).
 * Fixed by merging spans separated only by whitespace into one
 * contiguous span first, then applying the single-adjacent-run rule
 * once to each merged group's own outer boundary — the shared internal
 * gap is never claimed twice because it's already inside the merged
 * span, not treated as "adjacent" to either original span anymore.
 */
function attributeRemovalEdits(fullText: string, spans: readonly { start: number; end: number }[]): PositionEdit[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && /^\s*$/.test(fullText.slice(last.end, span.start))) {
      merged[merged.length - 1] = { start: last.start, end: span.end };
    } else {
      merged.push({ ...span });
    }
  }
  return merged.map(({ start, end }) => attributeRemovalEdit(fullText, start, end));
}

/**
 * When two sibling elements touch with no whitespace between them, the
 * first element's close-insert (`}` at its own `endOffset`) and the
 * second element's open-insert (`@for (...) {`/`@if (...) {` at its own
 * `startOffset`) land at the identical offset — found by adversarial
 * review, confirmed by direct execution: `applyEdits`' descending-sort-
 * and-sequential-splice reverses the visual order of same-position
 * edits (whichever was pushed first in the array ends up rightmost in
 * the spliced output), so the second element's block opened *after* its
 * own content instead of before it, leaving an empty block and an
 * unwrapped sibling. Every insert this module produces is pushed in
 * true document-traversal order, so grouping same-position, zero-width
 * inserts and concatenating their replacement text in push order — same
 * "combine, don't let the generic splice arbitrate order" fix
 * class-wrapping.ts's own `groupInsertionsByPosition` applies to an
 * analogous same-position collision for chained JS registrations —
 * fixes this correctly. Not reusing `groupInsertionsByPosition` itself:
 * its `\n\n`-joined, `\n\n`-suffixed formatting is specific to
 * blank-line-separated top-level class declarations and doesn't fit
 * this pattern's tight block-adjacent text.
 */
function combineCoincidentInserts(edits: readonly PositionEdit[]): PositionEdit[] {
  const insertsByPos = new Map<number, string[]>();
  const others: PositionEdit[] = [];
  for (const edit of edits) {
    if (edit.pos === edit.end && edit.replacement !== '') {
      const texts = insertsByPos.get(edit.pos) ?? [];
      texts.push(edit.replacement);
      insertsByPos.set(edit.pos, texts);
    } else {
      others.push(edit);
    }
  }
  const combined = [...insertsByPos.entries()].map(([pos, texts]) => ({
    pos,
    end: pos,
    replacement: texts.join(''),
  }));
  return [...others, ...combined];
}

/** `undefined` for a valueless attribute (`<div ng-if>`, syntactically legal HTML) — found by adversarial review: without this check, the fallback read the bare attribute name itself as if it were the expression. */
function getAttrValue(rawToken: string): string | undefined {
  const eq = rawToken.indexOf('=');
  if (eq === -1) return undefined;
  const raw = rawToken.slice(eq + 1).trim();
  const quote = raw[0];
  return quote === '"' || quote === "'" ? raw.slice(1, -1) : raw;
}

interface BlockPlan {
  readonly kind: 'ok';
  readonly header: string;
}
interface SkipPlan {
  readonly kind: 'skip';
  readonly reason: string;
}

function planRepeat(rawValue: string): BlockPlan | SkipPlan {
  if (rawValue.includes('|')) {
    return { kind: 'skip', reason: 'contains a filter/orderBy pipe — no Angular equivalent, not safely transformable' };
  }

  const match = rawValue.match(NG_REPEAT_GRAMMAR);
  if (!match) {
    return { kind: 'skip', reason: 'does not match the "item in collection [track by expr]" grammar — not safely transformable' };
  }
  const [, lhsRaw, rhsRaw, asAlias, trackByRaw] = match;
  const lhs = lhsRaw.trim();

  if (asAlias !== undefined) {
    return { kind: 'skip', reason: 'uses an "as" alias clause — no Angular equivalent built, zero real fixture evidence' };
  }
  if (/^\(.*,.*\)$/.test(lhs)) {
    return { kind: 'skip', reason: '(key, value) destructuring form is not supported — zero real fixture evidence' };
  }
  if (!SIMPLE_IDENTIFIER.test(lhs)) {
    return { kind: 'skip', reason: `loop variable "${lhs}" is not a simple identifier — not safely transformable` };
  }

  const collection = stripOneTimeBinding(rhsRaw.trim());
  const trackExpr = trackByRaw !== undefined ? stripOneTimeBinding(trackByRaw.trim()) : lhs;

  return { kind: 'ok', header: `@for (${lhs} of ${collection}; track ${trackExpr}) {` };
}

function planIf(rawValue: string): BlockPlan {
  return { kind: 'ok', header: `@if (${stripOneTimeBinding(rawValue.trim())}) {` };
}

function planShow(rawValue: string): string {
  return `[hidden]="!(${stripOneTimeBinding(rawValue.trim())})"`;
}

/**
 * `invalid-first-character-of-tag-name` fires whenever ordinary text
 * content contains a bare `<` not immediately followed by a valid tag
 * name — a harmless, extremely common shape in real AngularJS/Angular
 * templates (`{{ a < b }}` interpolation, a length/comparison check),
 * not a signal of genuine structural corruption. Found by adversarial
 * review, confirmed by direct execution: surfacing every input parse
 * error as a warning (added to catch a genuinely broken sibling
 * element, e.g. an unterminated attribute) produced a spurious warning
 * on this completely ordinary, valid shape — a direct regression from
 * that same fix. Excluded here the same way `assertCompiles`
 * (assert-compiles.ts) scopes its own ignored-diagnostic list: a
 * specific, understood-to-be-safe code, not a blanket suppression —
 * genuine corruption (an unterminated attribute, a malformed tag) shows
 * up as a different error code (`eof-in-tag`, `missing-attribute-value`,
 * etc.) and is still caught.
 */
const HARMLESS_INPUT_PARSE_ERROR_CODES = new Set(['invalid-first-character-of-tag-name']);

export function transformNgDirectivesToControlFlow(sourceText: string): CodemodResult {
  const errors: string[] = [];
  const doc = parseFragment(sourceText, {
    sourceCodeLocationInfo: true,
    onParseError: (err) => {
      if (!HARMLESS_INPUT_PARSE_ERROR_CODES.has(err.code)) errors.push(err.code);
    },
  });

  const edits: PositionEdit[] = [];
  const warnings: string[] = [];
  let anyMatch = false;

  function visit(node: DefaultTreeAdapterMap['node']): void {
    const el = node as Partial<Element> & { childNodes?: DefaultTreeAdapterMap['node'][] };
    if (el.tagName && el.attrs && el.sourceCodeLocation?.attrs) {
      processElement(el as Element);
    }
    for (const child of el.childNodes ?? []) visit(child);
  }

  function processElement(el: Element): void {
    const loc = el.sourceCodeLocation;
    if (!loc?.attrs) return;

    const repeatToken = loc.attrs['ng-repeat'];
    const ifToken = loc.attrs['ng-if'];
    const showToken = loc.attrs['ng-show'];
    if (!repeatToken && !ifToken && !showToken) return;

    let repeatPlan: BlockPlan | SkipPlan | undefined;
    let ifPlan: BlockPlan | undefined;
    const removalSpans: { start: number; end: number }[] = [];

    if (repeatToken) {
      const rawValue = getAttrValue(sourceText.slice(repeatToken.startOffset, repeatToken.endOffset));
      if (rawValue === undefined) {
        warnings.push('ng-repeat: no value — not safely transformable');
      } else {
        repeatPlan = planRepeat(rawValue);
        if (repeatPlan.kind === 'ok') {
          anyMatch = true;
          removalSpans.push({ start: repeatToken.startOffset, end: repeatToken.endOffset });
        } else {
          warnings.push(`ng-repeat="${rawValue}": ${repeatPlan.reason}`);
        }
      }
    }

    if (ifToken) {
      const rawValue = getAttrValue(sourceText.slice(ifToken.startOffset, ifToken.endOffset));
      if (rawValue === undefined) {
        warnings.push('ng-if: no value — not safely transformable');
      } else {
        ifPlan = planIf(rawValue);
        anyMatch = true;
        removalSpans.push({ start: ifToken.startOffset, end: ifToken.endOffset });
      }
    }

    edits.push(...attributeRemovalEdits(sourceText, removalSpans));

    if (showToken) {
      const rawValue = getAttrValue(sourceText.slice(showToken.startOffset, showToken.endOffset));
      if (rawValue === undefined) {
        warnings.push('ng-show: no value — not safely transformable');
      } else {
        anyMatch = true;
        edits.push({ pos: showToken.startOffset, end: showToken.endOffset, replacement: planShow(rawValue) });
      }
    }

    const openParts: string[] = [];
    const closeParts: string[] = [];
    if (repeatPlan?.kind === 'ok') {
      openParts.push(`${repeatPlan.header}\n`);
      closeParts.unshift('\n}');
    }
    if (ifPlan) {
      openParts.push(`${ifPlan.header}\n`);
      closeParts.unshift('\n}');
    }

    if (openParts.length > 0) {
      edits.push({ pos: loc.startOffset, end: loc.startOffset, replacement: openParts.join('') });
      edits.push({ pos: loc.endOffset, end: loc.endOffset, replacement: closeParts.join('') });
    }
  }

  visit(doc);

  if (errors.length > 0) {
    warnings.unshift(`input HTML has parse error(s): ${errors.join(', ')}`);
  }

  if (!anyMatch) {
    return {
      matched: false,
      reason: warnings.length > 0 ? warnings.join('; ') : 'no ng-repeat/ng-if/ng-show directive found',
    };
  }

  const output = applyEdits(sourceText, combineCoincidentInserts(edits));
  return warnings.length > 0 ? { matched: true, output, warnings } : { matched: true, output };
}
