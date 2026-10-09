import { estimateTokens } from 'provider-scheduler';
import { Node, Project, type Statement } from 'ts-morph';

/**
 * The per-file token cap (docs/product-spec.md §6.4): a file over the cap
 * is split by function or class, never truncated.
 *
 * Units are the file's top-level statements, or those of its single IIFE
 * module wrapper. Consecutive units are packed into chunks under the cap.
 * A single unit over the cap cannot be split here and is returned as
 * `tooLarge`, for manual review — the alternative would be cutting a
 * function in half.
 *
 * ponytail: one long `angular.module(...).controller(...).service(...)`
 * chain is a single statement and so a single unit; splitting a chain per
 * registration is the upgrade if real repos show it mattering.
 */
export function splitSource(
  sourceText: string,
  capTokens: number
): { readonly chunks: readonly string[] } | { readonly tooLarge: string } {
  if (estimateTokens(sourceText) <= capTokens) return { chunks: [sourceText] };

  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile('/source.ts', sourceText);
  let statements: Statement[] = file.getStatements();
  if (statements.length === 1 && Node.isExpressionStatement(statements[0])) {
    // `(function () { ... })();` — the units are inside the wrapper.
    let callee: Node = statements[0].getExpression();
    while (Node.isParenthesizedExpression(callee) || Node.isCallExpression(callee)) callee = callee.getExpression();
    const body = Node.isFunctionExpression(callee) || Node.isArrowFunction(callee) ? callee.getBody() : undefined;
    if (Node.isBlock(body)) statements = body.getStatements();
  }

  const chunks: string[] = [];
  let current = '';
  for (const statement of statements) {
    const unit = statement.getFullText();
    if (estimateTokens(unit) > capTokens) {
      const firstLine = statement.getText().split('\n')[0].slice(0, 80);
      return { tooLarge: `one function, class or statement is ~${estimateTokens(unit)} tokens, over the cap of ${capTokens}: ${firstLine}` };
    }
    if (current !== '' && estimateTokens(current + unit) > capTokens) {
      chunks.push(current);
      current = '';
    }
    current += unit;
  }
  // Whatever follows the last top-level statement (a closing comment, the final newline) stays with the last chunk.
  if (statements.length > 0 && statements[0].getParent() === file) current += sourceText.slice(statements[statements.length - 1].getEnd());
  if (current.trim() !== '') chunks.push(current);
  return { chunks };
}
