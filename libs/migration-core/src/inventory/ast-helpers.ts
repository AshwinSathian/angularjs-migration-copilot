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
