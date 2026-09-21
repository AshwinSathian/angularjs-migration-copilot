import { Node, type PropertyAccessExpression, type SourceFile, type CallExpression, type Project } from 'ts-morph';

/**
 * Pulls dependency-injection names out of an AngularJS definition argument,
 * whichever style it's written in:
 *
 *   ['$http', 'MyService', function ($http, MyService) { ... }]   // array-style
 *   function ($http, MyService) { ... }                            // bare function
 *
 * Both forms show up across real codebases — codemod pattern #3 in
 * docs/product-spec.md §6.3 exists specifically to convert the former to
 * constructor injection, which means inventory has to recognize both.
 */
export function extractDependencyNames(definitionArg: Node | undefined): string[] {
  if (!definitionArg) return [];

  if (Node.isArrayLiteralExpression(definitionArg)) {
    return definitionArg
      .getElements()
      .filter((element) => Node.isStringLiteral(element))
      .map((element) => element.getLiteralText());
  }

  if (
    Node.isFunctionExpression(definitionArg) ||
    Node.isArrowFunction(definitionArg) ||
    Node.isMethodDeclaration(definitionArg)
  ) {
    return definitionArg.getParameters().map((param) => param.getName());
  }

  return [];
}

/**
 * The chain root of a (possibly chained) call's receiver — `$stateProvider`
 * for both `$stateProvider.state(a)` and the second link of
 * `$stateProvider.state(a).state(b)`, whose own receiver is the first
 * call, not a plain identifier. General call-chain-walking plumbing (no
 * dependency on what the chain is *for*), alongside `forEachPropertyAccessCall`/
 * `methodCallLine` — pattern #8 (`routes-to-router-config.ts`) is the
 * first caller (needed to confirm a `.state(...)`/`.when(...)` call's
 * receiver actually resolves to the injected route provider, not just
 * share its method name with an unrelated provider), but the walk itself
 * has nothing routing-specific about it.
 */
export function resolveChainRoot(node: Node): Node | undefined {
  if (Node.isIdentifier(node)) return node;
  if (Node.isCallExpression(node)) {
    const callee = node.getExpression();
    if (Node.isPropertyAccessExpression(callee)) return resolveChainRoot(callee.getExpression());
  }
  return undefined;
}

/**
 * `undefined` when `depNames.length` (an array-style DI dependency list)
 * matches `paramCount` (the wrapped function's own parameter count) —
 * otherwise the ambiguous-binding skip-reason fragment, shared verbatim
 * between `array-di-to-constructor.ts` (pattern #3) and
 * `routes-to-router-config.ts` (pattern #8), which independently arrived
 * at the identical check and message for the identical reason: a
 * mismatched array-style DI list has no safe positional mapping to the
 * function's parameters, full stop, regardless of which registration kind
 * is being transformed.
 */
export function arrayDiArityMismatchReason(depNames: readonly string[], paramCount: number): string | undefined {
  return depNames.length === paramCount
    ? undefined
    : `dependency array has ${depNames.length} names but the function declares ${paramCount} parameter(s) — ambiguous binding, not safely transformable`;
}

/**
 * Walks every source file in `project` looking for `x.method(...)` call
 * expressions, invoking `callback` for each one. This is the traversal
 * skeleton every scan-*.ts file needs (module declarations, registrations,
 * routes, watch usage all key off a property-access call) — sharing it
 * means a future fix to *how* such calls are found (a new node shape, a
 * guard against non-JS source kinds) only has to happen once, not once per
 * scanner with four chances to fall out of sync.
 */
export function forEachPropertyAccessCall(
  project: Project,
  callback: (call: CallExpression, expression: PropertyAccessExpression, sourceFile: SourceFile) => void
): void {
  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expression = node.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) return;
      callback(node, expression, sourceFile);
    });
  }
}

/**
 * The method-name token's own line — not the whole call expression's.
 * `forEachDescendant` visits outer call expressions before inner ones, so
 * a chained `angular.module('app').controller(a).controller(b)` (or
 * `$routeProvider.when(a).when(b)`) has every link in the chain sharing
 * the same expression start, back at `angular`/`$routeProvider` on
 * whichever line the chain begins. Reading the property-access name
 * node's own line instead reports each call where it actually is.
 */
export function methodCallLine(expression: PropertyAccessExpression): number {
  return expression.getNameNode().getStartLineNumber();
}

/**
 * Restores source order after the chained-call traversal quirk described
 * on `methodCallLine` — without this, entries from a multi-line chain come
 * back last-to-first. Sorts *within* each file only, preserving the
 * project's file order rather than sorting by line globally: a global sort
 * would interleave unrelated files by absolute line number (e.g. a short
 * file's line 3 landing before a different file's line 40), which is a
 * meaningless ordering across files and inconsistent with the other
 * inventory arrays (modules, watch usages), which are never chained this
 * way and so keep plain file-traversal order.
 */
export function sortByFileThenLine<T extends { filePath: string; line: number }>(
  entries: T[]
): T[] {
  const fileOrder: string[] = [];
  const groups = new Map<string, T[]>();

  for (const entry of entries) {
    let group = groups.get(entry.filePath);
    if (!group) {
      group = [];
      groups.set(entry.filePath, group);
      fileOrder.push(entry.filePath);
    }
    group.push(entry);
  }

  return fileOrder.flatMap((filePath) => {
    const group = groups.get(filePath) as T[];
    return group.sort((a, b) => a.line - b.line);
  });
}
