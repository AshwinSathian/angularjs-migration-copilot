/**
 * Every codemod is a pure string-in/string-out transform: it parses
 * `sourceText` with its own private ts-morph `Project`, never touches the
 * caller's `Project`, and returns new content rather than mutating
 * anything. This is what keeps the source tree read-only for the whole
 * pipeline (docs/product-spec.md §6.2a) and makes fixture testing a plain
 * before/after string comparison, no filesystem or shared-project setup
 * needed.
 */
export interface CodemodResult {
  readonly matched: boolean;
  /** The transformed file content. Present only when `matched` is true. */
  readonly output?: string;
  /**
   * Why nothing was transformed — either no instance of the pattern was
   * found, or one was found but skipped for a documented reason (e.g. an
   * ambiguous binding). Present only when `matched` is false.
   */
  readonly reason?: string;
}
