/**
 * Every codemod is a pure string-in/string-out transform: it parses
 * `sourceText` with its own private ts-morph `Project`, never touches the
 * caller's `Project`, and returns new content rather than mutating
 * anything. This is what keeps the source tree read-only for the whole
 * pipeline (docs/product-spec.md §6.2a) and makes fixture testing a plain
 * before/after string comparison, no filesystem or shared-project setup
 * needed.
 *
 * A discriminated union, not an optional-field bag — `matched: true`
 * without `output`, or `matched: false` without `reason`, isn't
 * representable. A prior optional-field version let `matched: true` pair
 * with `output: undefined`, which `cli.ts` had to band-aid around
 * (`result.output ?? ''`) instead of the type ruling it out.
 */
export type CodemodResult =
  | {
      readonly matched: true;
      readonly output: string;
      /**
       * Reasons any *other* registration in the same file was found but
       * left untouched. A partial success still surfaces every skip — per
       * CLAUDE.md's reporting-honesty rule, a transform that silently
       * drops a sibling registration's skip reason just because a
       * different registration in the same file succeeded is exactly the
       * silent no-op that rule forbids.
       */
      readonly warnings?: readonly string[];
    }
  | {
      readonly matched: false;
      readonly reason: string;
    };
