import { Node, type ArrowFunction, type FunctionExpression, type SourceFile } from 'ts-morph';

/**
 * Shared plumbing for every codemod pattern that wraps an AngularJS
 * function-based registration into an ES6/TS class — pattern #3 (array-
 * style DI → constructor injection) was the first to need this, pattern
 * #1 ($scope.x = y → class property) reuses it rather than re-deriving
 * it, and any future pattern that produces a class should too.
 */

export type WrappableFunction = FunctionExpression | ArrowFunction;

export const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** ECMA-262 reserved words — `VALID_IDENTIFIER` alone accepts these (they're syntactically identifier-shaped) but none is legal as a class name. */
export const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await',
  'implements', 'package', 'protected', 'interface', 'private', 'public',
]);

export function isValidClassName(name: string): boolean {
  return VALID_IDENTIFIER.test(name) && !RESERVED_WORDS.has(name);
}

/**
 * The nearest point a class declaration can be inserted without being
 * hoisted out of an enclosing scope it needs to stay inside — stops at
 * the first ancestor whose parent is the `SourceFile` itself *or* a
 * `Block`. Without the `Block` case, a registration inside the extremely
 * common `(function () { ... })()` IIFE wrapper (62 of 66
 * registration-bearing files across this project's own vendored
 * fixtures use it) would have its class hoisted above the IIFE entirely,
 * severing any reference the body makes to a closure variable declared
 * inside that wrapper.
 */
export function nearestInsertionPointStart(node: Node): number {
  let current = node;
  for (;;) {
    const parent = current.getParent();
    if (!parent || Node.isSourceFile(parent) || Node.isBlock(parent)) return current.getStart();
    current = parent;
  }
}

export function hasExistingTopLevelBinding(sourceFile: SourceFile, name: string): boolean {
  return (
    sourceFile.getFunction(name) !== undefined ||
    sourceFile.getClass(name) !== undefined ||
    sourceFile.getVariableDeclaration(name) !== undefined
  );
}

/**
 * A parameter that can safely carry into a constructor signature as
 * `private <name>: any` — a plain identifier, no default value, no rest.
 * A destructured (`{ $scope }`) or default-valued (`$scope = null`)
 * parameter can't be represented that way without either producing
 * invalid TypeScript (a binding pattern can't be a parameter property) or
 * silently dropping the default — so a function with any such parameter
 * is skipped rather than mistranslated.
 */
export function isSimpleParameter(param: { getNameNode: () => Node; hasInitializer: () => boolean; isRestParameter: () => boolean }): boolean {
  return Node.isIdentifier(param.getNameNode()) && !param.hasInitializer() && !param.isRestParameter();
}

export function constructorParamsText(fn: WrappableFunction): string {
  return fn.getParameters().map((p) => `private ${p.getName()}: any`).join(', ');
}

/**
 * An arrow function's concise (non-block) body is wrapped in
 * `{ return ...; }` since a constructor body must be a block.
 * `internalEdits` (positions in the *full source file*'s coordinates, as
 * every other position this module deals in) let a caller rewrite text
 * inside the body — e.g. pattern #1 replacing a `$scope` reference with
 * `this` — without having to separately account for the concise-body
 * wrapper prefix shifting every offset.
 */
export function functionBodyText(fn: WrappableFunction, internalEdits: readonly PositionEdit[] = []): string {
  const body = fn.getBody();
  const bodyStart = body.getStart();
  const rawText = body.getText();
  const editedText = internalEdits.length === 0
    ? rawText
    : applyEdits(
        rawText,
        internalEdits.map((e) => ({ pos: e.pos - bodyStart, end: e.end - bodyStart, replacement: e.replacement }))
      );

  return Node.isBlock(body) ? editedText : `{ return ${editedText}; }`;
}

export function buildClassText(className: string, params: string, bodyText: string): string {
  return `class ${className} {\n  constructor(${params}) ${bodyText}\n}`;
}

export interface PositionEdit {
  readonly pos: number;
  readonly end: number;
  readonly replacement: string;
}

/** Sorts by position descending and splices — safe to call with edits computed against the *original*, unmodified text, regardless of how many there are or whether any share a position. */
export function applyEdits(sourceText: string, edits: readonly PositionEdit[]): string {
  let output = sourceText;
  for (const edit of [...edits].sort((a, b) => b.pos - a.pos)) {
    output = output.slice(0, edit.pos) + edit.replacement + output.slice(edit.end);
  }
  return output;
}

/**
 * Groups class insertions that land at the same position — e.g. three
 * chained `.controller(...).controller(...).controller(...)` calls all
 * living in one enclosing statement — and joins them in the order given,
 * which callers must already have sorted into true source order.
 * Splicing them in one at a time at an identical offset would otherwise
 * reverse their visual order.
 */
export function groupInsertionsByPosition(items: readonly { pos: number; text: string }[]): PositionEdit[] {
  const byPos = new Map<number, string[]>();
  for (const { pos, text } of items) {
    const texts = byPos.get(pos) ?? [];
    texts.push(text);
    byPos.set(pos, texts);
  }
  return [...byPos.entries()].map(([pos, texts]) => ({
    pos,
    end: pos,
    replacement: `${texts.join('\n\n')}\n\n`,
  }));
}
