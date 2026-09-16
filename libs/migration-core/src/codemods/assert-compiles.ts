import { Project } from 'ts-morph';

/**
 * Every real bug found in this project's class-wrapping codemods so far
 * (a class-used-before-declaration TDZ error, a dangling `$inject`
 * annotation, a stale-offset corruption, an ancestor-walk bug that
 * deleted an entire IIFE) was caught by manually running `tsc` against a
 * codemod's actual output — never by the test suite itself, which only
 * ever asserted output *substrings*. A regression that inserts a class
 * at the wrong position but still contains the right substrings
 * somewhere in the file passes every `.toContain` assertion. This
 * closes that gap: it feeds a codemod's real output through ts-morph's
 * own diagnostics (no subprocess, no real `tsc` install needed) and
 * fails the test if anything beyond the known, already-accepted classes
 * of error shows up.
 *
 * Ignored diagnostic codes are pre-existing, already-accepted
 * characteristics of every class-wrapping pattern (#1/#2/#3 alike), not
 * something this helper exists to police — that's the verification
 * gate's job (M2, docs/product-spec.md §6.5), same precedent as the
 * `.factory`-return-type case in docs/decisions.md ADR-025:
 * - 2339 (`Property 'x' does not exist on type 'Y'`) — every
 *   `this.x = y`/`vm.x = y` body assignment is undeclared as a class
 *   field, since these codemods only ever emit `constructor(...) {...}`,
 *   never field declarations.
 * - 2304 (`Cannot find name 'angular'`, `'$http'`, ...) — AngularJS's
 *   own globals and injected service names are untyped in this
 *   deliberately minimal compile context; real projects have `@types/
 *   angular` or equivalent.
 * - 2683 (`'this' implicitly has type 'any'`) — two distinct sources, both
 *   pre-existing characteristics of the *original* AngularJS source, not
 *   something a codemod's own added code (the class wrapper, the
 *   constructor signature) ever introduces itself: (1) a plain,
 *   untransformed function left untouched by a nesting-conflict skip
 *   (`findNestedDeletionConflicts`, class-wrapping.ts) still using
 *   `this.x = y`; (2) a nested plain function/IIFE using `this` (e.g. an
 *   `angular.forEach(items, function (item) { this.foo(item); })`
 *   callback) that a class-wrapping pattern copies verbatim into the
 *   emitted class's constructor body — confirmed by direct ts-morph
 *   probe that this genuinely fires *inside* codemod-emitted class output,
 *   not just inside an untouched original, correcting an earlier version
 *   of this comment that claimed otherwise. Not fixed here: none of these
 *   codemods rewrite a nested function's own `this` usage (out of scope —
 *   the same reason `isInsideThisRebindingBoundary` treats it as a
 *   boundary rather than something to transform), so it's exactly as
 *   inherent to this pattern family's current scope as 2339 above.
 */
const IGNORED_DIAGNOSTIC_CODES = new Set([2339, 2304, 2571, 2683, 7006, 7034]);

/**
 * 2552 (`Cannot find name 'X'. Did you mean 'Y'?`) is TypeScript's
 * alternate code for an undefined identifier, chosen instead of the
 * already-ignored 2304 specifically when an unrelated global is a close
 * spelling match to suggest — `Input` vs. `GlobalEventHandlers.oninput`
 * is the one real case this project's codemods hit (pattern #9's
 * `@Input()`, left undefined same as `@Component`/`@Directive`'s own
 * 2304). Deliberately *not* added to `IGNORED_DIAGNOSTIC_CODES` as a bare
 * code, unlike every other entry there: this code specifically covers
 * near-miss-spelling errors, which is exactly the class of real codemod
 * bug (e.g. emitting a typo'd reference to an existing name) this helper
 * exists to catch — a blanket ignore would silently pass that too.
 * Scoped to the exact known messages instead, so a future near-miss
 * diagnostic this project hasn't already identified as safe still fails
 * the check rather than being silently absorbed by an overly broad
 * code-level ignore.
 */
const IGNORED_2552_MESSAGES = new Set([
  `Cannot find name 'Input'. Did you mean 'oninput'?`,
]);

export function assertCompiles(outputSource: string): void {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: false, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/output.ts', outputSource);

  const realDiagnostics = sourceFile
    .getPreEmitDiagnostics()
    .filter((d) => {
      if (IGNORED_DIAGNOSTIC_CODES.has(d.getCode())) return false;
      if (d.getCode() === 2552 && IGNORED_2552_MESSAGES.has(d.getMessageText().toString())) return false;
      return true;
    });

  if (realDiagnostics.length > 0) {
    const messages = realDiagnostics
      .map((d) => `  TS${d.getCode()} at ${d.getLineNumber()}: ${d.getMessageText()}`)
      .join('\n');
    throw new Error(`Codemod output does not compile:\n${messages}\n\n--- output ---\n${outputSource}`);
  }
}
