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
 * - 2552 (`Cannot find name 'Input'. Did you mean 'oninput'?`) — the same
 *   undefined-decorator-identifier case as 2304 above (pattern #9's
 *   `@Input()`, added alongside `@Component`/`@Directive`'s own 2304),
 *   just a different code TypeScript happens to choose when an unrelated
 *   global (`GlobalEventHandlers.oninput`) is a close-enough spelling
 *   match to suggest — confirmed by direct execution, not assumed from
 *   the diagnostic message alone.
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
const IGNORED_DIAGNOSTIC_CODES = new Set([2339, 2304, 2552, 2571, 2683, 7006, 7034]);

export function assertCompiles(outputSource: string): void {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: false, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/output.ts', outputSource);

  const realDiagnostics = sourceFile
    .getPreEmitDiagnostics()
    .filter((d) => !IGNORED_DIAGNOSTIC_CODES.has(d.getCode()));

  if (realDiagnostics.length > 0) {
    const messages = realDiagnostics
      .map((d) => `  TS${d.getCode()} at ${d.getLineNumber()}: ${d.getMessageText()}`)
      .join('\n');
    throw new Error(`Codemod output does not compile:\n${messages}\n\n--- output ---\n${outputSource}`);
  }
}
