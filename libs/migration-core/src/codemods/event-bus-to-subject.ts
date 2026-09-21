import { Node, Project, type SourceFile } from 'ts-morph';
import { forEachPropertyAccessCall } from '../inventory/ast-helpers.js';
import { applyEdits, hasExistingTopLevelBinding, VALID_IDENTIFIER } from './class-wrapping.js';
import type { CodemodResult } from './types.js';

/**
 * Pattern #10 (docs/product-spec.md §6.3) — `$emit`/`$broadcast`/`$on`
 * within one module → a typed RxJS `Subject` service.
 *
 * Real-fixture evidence checked before writing any detection code
 * (standing practice since ADR-030/034/039/041/043/044): every real
 * `$emit`/`$broadcast`/`$on` call across all three vendored fixtures (2 in
 * `CoreUI-AngularJS`, 7 in `blur-admin`, 0 in `angular-phonecat`) is either
 * `$scope.$on('$destroy', ...)` (a lifecycle cleanup hook Angular's own
 * `ngOnDestroy` replaces directly — nothing to scaffold a `Subject` for),
 * `$on('$stateChangeSuccess'|'$stateChangeStart', ...)` (ui-router's own
 * internal broadcasts — nothing in any fixture's app code ever `$emit`s or
 * `$broadcast`s those event names itself), or one orphaned
 * `scope.$broadcast('fileProgress', ...)` with no `$on` listener anywhere
 * in the same fixture. Zero real occurrences of this pattern's actual
 * target shape — an event name both sent (`$emit`/`$broadcast`) and
 * received (`$on`) by app code within one module — exist in any of the
 * three fixtures. This is expected to report an honest 0/0/0 real hit
 * count, same precedent as pattern #9 (ADR-041): still fixed v1 scope
 * (docs/milestones/m1-codemods.md), built and tested against its own
 * literal definition with hand-written fixtures, not skipped for lack of
 * real-fixture signal.
 *
 * Detection is therefore keyed on *pairing*, not on the method name alone:
 * only an event name with at least one `$emit`/`$broadcast` call and at
 * least one `$on` call, both with a plain string-literal name and both
 * anywhere in the same file, counts as a real intra-module event bus. This
 * is also what excludes `$destroy`/`$stateChangeSuccess`/`$stateChangeStart`
 * without a hand-maintained denylist of framework-internal event names —
 * none of them is ever both sent and received by app code in these
 * fixtures, so the pairing requirement filters them out by construction.
 *
 * `$emit` (up the scope tree) and `$broadcast` (down the scope tree) are
 * deliberately treated as the same "sends this event" case: a singleton
 * `Subject`-backed service delivers to every subscriber regardless of
 * where they sit, so AngularJS's scope-tree direction has no equivalent to
 * preserve — a deliberate semantic simplification, not an oversight.
 *
 * Same insert-only architecture as patterns #4/#9/#5/#8, confirmed rather
 * than assumed before committing to it here: a `@Injectable`-decorated
 * class exposing `Subject`-backed members isn't valid AngularJS
 * registration output any more than `@Component`/`@Pipe` were for those
 * patterns, and — unlike them — there's no single registration call this
 * pattern is even attached to (the source calls are scattered
 * `$scope`/`$rootScope` method calls, not one `.filter(...)`/
 * `.directive(...)` site). The generated service is inserted alongside the
 * untouched original file; every original `$emit`/`$broadcast`/`$on` call
 * site is left exactly as written. This is a deliberate scope choice
 * (confirmed with the user given the total absence of real-fixture
 * evidence to validate a call-site rewrite against): a full migration
 * would also rewrite each call site to use the new service, but that's a
 * different, riskier class of edit (replacing/deleting at arbitrary points
 * inside existing function bodies, not registration-adjacent insertion)
 * this pattern doesn't attempt. The scaffolded service is meant to be
 * wired up by hand, one call site at a time.
 *
 * **Insertion point deliberately does not reuse `nearestInsertionPointStart`
 * (class-wrapping.ts)**, unlike every other insert-only pattern — found by
 * adversarial review, confirmed by direct execution, not assumed safe by
 * analogy. That helper's contract assumes its input node is a registration
 * call sitting directly as a statement inside the file or its enclosing
 * IIFE block (true for `.filter(...)`/`.directive(...)`/etc., which are
 * always written at module top level), so walking up to the *first*
 * enclosing block correctly lands at module scope. An `$emit`/`$broadcast`/
 * `$on` call has no such guarantee — the real fixture shapes above all sit
 * several closures deep (inside a controller function, inside a `link`
 * callback, inside a nested handler). Reusing that helper on such a call
 * landed the generated class *inside* the nearest enclosing function body
 * instead, e.g. inside a `$scope.notify = function () {...}` closure —
 * redeclared on every invocation and unreachable from the rest of the
 * module, defeating the entire point of scaffolding a module-level
 * service. Unlike every prior insert-only pattern's class, `EventBusService`
 * has no constructor parameters and closes over nothing from the
 * surrounding file, so — unlike them — it has no need to stay inside the
 * enclosing IIFE at all: it's always inserted at the true top of the file,
 * after any leading `'use strict'` directive-prologue statement (a common
 * first line in these fixtures) so that directive isn't silently demoted
 * out of prologue position by a statement landing before it.
 *
 * One derived service class per file, named the fixed `EventBusService`
 * (skipped, not guessed at, if that collides with an existing binding) —
 * unlike every other insert-only pattern, there's no per-registration name
 * to derive a class name from here, so unlike those patterns a whole-file
 * skip is the failure mode for a name collision, not a per-registration
 * one. Each paired event name gets its own `Subject<unknown>`-backed
 * member trio (`<name>Subject`, `<name>$`, `emit<Name>(payload)`) — see
 * `toIdentifierWords`/`toIdentifier` below for why the payload type is
 * `unknown` rather than something inferred from a real call site: "typed"
 * here means each event gets its own strongly-named channel, distinct
 * from every other event at compile time, not that this codemod infers a
 * payload's structural shape from how it happens to be called.
 */

interface RawUsage {
  readonly eventName: string;
  readonly kind: 'emit' | 'on';
  readonly sortKey: number;
}

/**
 * The true module-top-level position to insert the generated class at —
 * the start of the first statement that isn't part of a leading directive
 * prologue (`'use strict';`, a common first line in these fixtures).
 * Inserting at position 0 unconditionally would land a class statement
 * *before* such a directive, silently demoting it out of prologue position
 * (a directive is only recognized as one when it's the first statement in
 * the file) and disabling strict mode for the whole file — a real hazard
 * worth a two-line guard against, not a hypothetical.
 */
function moduleTopLevelInsertPos(sourceFile: SourceFile): number {
  const firstNonDirective = sourceFile
    .getStatements()
    .find((s) => !(Node.isExpressionStatement(s) && Node.isStringLiteral(s.getExpression())));
  return firstNonDirective ? firstNonDirective.getStart() : sourceFile.getEnd();
}

/**
 * Splits an arbitrary AngularJS event name (`'user:updated'`,
 * `'file-progress'`, `'userUpdated'`, ...) into word segments — on any
 * non-alphanumeric run, and on an existing camelCase boundary, so both
 * delimiter styles seen in real AngularJS codebases produce the same
 * result.
 */
function toIdentifierWords(eventName: string): string[] {
  return eventName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0);
}

function toIdentifier(eventName: string, casing: 'camel' | 'pascal'): string {
  return toIdentifierWords(eventName)
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (casing === 'camel' && i === 0) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

const SERVICE_CLASS_NAME = 'EventBusService';

export function transformEventBusToSubject(sourceText: string): CodemodResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/app.js', sourceText);

  const usages: RawUsage[] = [];

  forEachPropertyAccessCall(project, (call, expression) => {
    const method = expression.getName();
    if (method !== '$emit' && method !== '$broadcast' && method !== '$on') return;

    const [nameArg] = call.getArguments();
    if (!nameArg || !Node.isStringLiteral(nameArg)) return;

    usages.push({
      eventName: nameArg.getLiteralText(),
      kind: method === '$on' ? 'on' : 'emit',
      sortKey: expression.getNameNode().getStart(),
    });
  });

  if (usages.length === 0) {
    return { matched: false, reason: 'no $emit/$broadcast/$on call with a string-literal event name found' };
  }

  usages.sort((a, b) => a.sortKey - b.sortKey);

  const byEvent = new Map<string, RawUsage[]>();
  for (const usage of usages) {
    const group = byEvent.get(usage.eventName);
    if (group) group.push(usage);
    else byEvent.set(usage.eventName, [usage]);
  }

  const pairedEventNames = [...byEvent.entries()]
    .filter(([, group]) => group.some((u) => u.kind === 'emit') && group.some((u) => u.kind === 'on'))
    .map(([eventName]) => eventName);

  if (pairedEventNames.length === 0) {
    return {
      matched: false,
      reason: 'no event name is both sent ($emit/$broadcast) and received ($on) within this file — not a real intra-module event bus',
    };
  }

  // Also checks the two names the generated class body itself references
  // (`new Subject<unknown>()`, `@Injectable(...)`), not just the class's
  // own name — a pre-existing top-level `var Subject = ...;`/`function
  // Injectable(){}` in the source file would otherwise silently shadow the
  // real rxjs/`@angular/core` names the emitted code depends on, producing
  // wrong behavior `assertCompiles` can't catch (both names' "undefined"
  // diagnostic is already ignored for every codemod's output, see
  // assert-compiles.ts — this file just never reaches that diagnostic in
  // the collision case, since the name *does* resolve, just to the wrong
  // thing).
  const collidingName = [SERVICE_CLASS_NAME, 'Subject', 'Injectable'].find((name) => hasExistingTopLevelBinding(sourceFile, name));
  if (collidingName) {
    return {
      matched: false,
      reason: `derived/referenced name "${collidingName}" collides with an existing binding in this file — not safely transformable`,
    };
  }

  // `pairedEventNames` is already in true source order: `byEvent`'s Map
  // preserves first-seen (insertion) order per key, and `usages` was
  // sorted by position before it was built — no re-sort needed here.

  const skipReasons: string[] = [];
  const usedMemberNames = new Set<string>();
  const memberBlocks: string[] = [];

  for (const eventName of pairedEventNames) {
    const memberBase = toIdentifier(eventName, 'camel');
    const pascalBase = toIdentifier(eventName, 'pascal');

    // A bare reserved word (`isValidClassName`'s stricter check, built for a
    // *whole* emitted identifier standing alone) is fine here: `memberBase`
    // is never emitted bare, always suffixed (`<name>Subject`, `<name>$`) or
    // embedded after `emit` — `deleteSubject`/`emitDelete` are both
    // perfectly valid identifiers even though `delete` alone is reserved.
    // Found by adversarial review, confirmed by direct execution: an
    // earlier version used `isValidClassName` here and wrongly rejected
    // every paired event name that happened to be a JS reserved word
    // (`'delete'`, `'new'`, `'in'`, `'do'`, ...).
    if (!VALID_IDENTIFIER.test(memberBase)) {
      skipReasons.push(`${eventName}: does not sanitize to a valid identifier — not safely transformable`);
      continue;
    }
    if (usedMemberNames.has(memberBase)) {
      skipReasons.push(`${eventName}: sanitizes to the same member name as another event in this file — ambiguous, not safely transformable`);
      continue;
    }
    usedMemberNames.add(memberBase);

    memberBlocks.push(
      [
        `  private readonly ${memberBase}Subject = new Subject<unknown>();`,
        `  readonly ${memberBase}$ = this.${memberBase}Subject.asObservable();`,
        '',
        `  emit${pascalBase}(payload?: unknown): void {`,
        `    this.${memberBase}Subject.next(payload);`,
        '  }',
      ].join('\n')
    );
  }

  if (memberBlocks.length === 0) {
    return { matched: false, reason: skipReasons.join('; ') };
  }

  const insertPos = moduleTopLevelInsertPos(sourceFile);

  const classText = `@Injectable({ providedIn: 'root' })\nclass ${SERVICE_CLASS_NAME} {\n${memberBlocks.join('\n\n')}\n}`;
  const output = applyEdits(sourceFile.getFullText(), [{ pos: insertPos, end: insertPos, replacement: `${classText}\n\n` }]);

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
