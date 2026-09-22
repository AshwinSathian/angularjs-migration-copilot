import { Node, Project, SyntaxKind } from 'ts-morph';

function literalValue(node: Node): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return { ok: true, value: node.getLiteralText() };
  if (Node.isNumericLiteral(node)) return { ok: true, value: Number(node.getText()) };
  if (node.getKind() === SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (node.getKind() === SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (node.getKind() === SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (Node.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const el of node.getElements()) {
      const r = literalValue(el);
      if (!r.ok) return { ok: false };
      values.push(r.value);
    }
    return { ok: true, value: values };
  }
  if (Node.isObjectLiteralExpression(node)) {
    const obj: Record<string, unknown> = {};
    for (const prop of node.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) return { ok: false };
      const name = prop.getName();
      const valueNode = prop.getInitializer();
      if (!valueNode) return { ok: false };
      const r = literalValue(valueNode);
      if (!r.ok) return { ok: false };
      obj[name] = r.value;
    }
    return { ok: true, value: obj };
  }
  return { ok: false };
}

function tupleKey(tuple: readonly unknown[]): string {
  return JSON.stringify(tuple);
}

/**
 * Every literal argument tuple found at a real call site of a
 * function/method named `functionName`, anywhere in `project`, deduped.
 * §6.5: "seed inputs are drawn from... literal argument values found at
 * every existing call-site of the function across the codebase." A call
 * with any non-literal argument (a variable, a computed expression) is
 * skipped whole, not partially substituted — no evidence in this
 * project's own vendored fixtures yet justifies guessing at a partial
 * tuple, and a wrong guessed input would produce false confidence in
 * exactly the way §6.5 explicitly warns against for the single-input
 * degenerate case.
 *
 * Known limitations (not fixed, documented as accepted because this function
 * is never wired into this milestone's tiering logic — Tasks 6–14 do not import
 * or call it; it's exported only for future external use via the Task 12 barrel):
 * (1) Callee matching is name-text-based, not symbol-resolution-based. If the
 * codebase defines both a free function `total()` and an unrelated object/class
 * method also named `total`, calls to both will be folded into a single
 * collection — e.g., `total(1, 2)` and `someObj.total(100, 200)` both appear
 * in results as tuples `[1, 2]` and `[100, 200]`. Real symbol resolution (via
 * `findReferencesAsNodes()`, the discipline `class-wrapping.ts` already
 * established) would distinguish them, but that's larger scope. (2) Negative
 * numeric literals like `-5` are parsed as `PrefixUnaryExpression` (not
 * `NumericLiteral`), so a call like `f(-5)` contributes no tuple. However,
 * Task 6's `generateBoundaryValueRows` already seeds the `number` boundary
 * set with `-1`, so negative-input coverage for eligible functions is not
 * actually lost overall, just not sourced from real call sites.
 */
export function collectCallSiteArgLiterals(
  project: Project,
  functionName: string
): readonly (readonly unknown[])[] {
  const seen = new Map<string, readonly unknown[]>();

  for (const sourceFile of project.getSourceFiles()) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      const calleeName = Node.isPropertyAccessExpression(expr) ? expr.getNameNode().getText() : expr.getText();
      if (calleeName !== functionName) continue;

      const args = call.getArguments();
      const tuple: unknown[] = [];
      let allLiteral = true;
      for (const arg of args) {
        const r = literalValue(arg);
        if (!r.ok) {
          allLiteral = false;
          break;
        }
        tuple.push(r.value);
      }
      if (!allLiteral) continue;
      seen.set(tupleKey(tuple), tuple);
    }
  }

  return [...seen.values()];
}
