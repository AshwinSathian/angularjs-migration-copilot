import { Node, Project, SyntaxKind } from 'ts-morph';

/**
 * §6.5's characterization-eligibility definition: a function qualifies
 * only if it (a) doesn't reference `$scope`/`$rootScope`/a DOM global
 * beyond its own parameters, (b) doesn't call an async/side-effecting
 * Angular service, (c) returns a value derived only from its inputs.
 *
 * (a) and (c) are enforced as one stricter, checkable rule: every
 * identifier the function reads must be declared inside the function,
 * or be one of a short list of pure built-ins. That rejects `$scope`,
 * `document`, `localStorage`, `fetch`, `angular`, and any closed-over
 * helper or DI parameter alike — none can be supplied in the sandbox,
 * and none is "derived only from its inputs". `this`, `Math.random`,
 * `Date.now`, and argument-less `Date` are rejected for the same reason.
 *
 * An earlier version checked five names only and relied on the diff to
 * catch the rest; it did not (docs/decisions.md ADR-049, ADR-057) — both
 * sides threw the same `ReferenceError` and were reported as matching.
 *
 * Real-fixture shapes this was checked against (`blur-admin`):
 * `baUtil.js`'s `hexToRGB(hex, alpha)` is parameter-only and eligible;
 * `theme.service.js` reads `navigator.userAgent`; `preloader.js` calls
 * `$q.defer()`; `appImage.js`'s returned filter function closes over the
 * factory's `layoutPaths` parameter — all three ineligible.
 */
const PURE_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'arguments',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Date', 'Map', 'Set',
  'Error', 'TypeError', 'RangeError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
]);
const NON_DETERMINISTIC_MEMBERS = new Set(['Math.random', 'Date.now']);
const DISALLOWED_SERVICE_CALLS = ['$http', '$q', '$timeout', '$interval', '$animate'];

/** True when `identifier` names a property, key, or label rather than reading a variable. */
function isNameOnlyPosition(identifier: Node): boolean {
  const parent = identifier.getParentOrThrow();
  if (Node.isPropertyAccessExpression(parent)) return parent.getNameNode() === identifier;
  if (Node.isBindingElement(parent)) return parent.getPropertyNameNode() === identifier;
  if (
    Node.isPropertyAssignment(parent) ||
    Node.isMethodDeclaration(parent) ||
    Node.isGetAccessorDeclaration(parent) ||
    Node.isSetAccessorDeclaration(parent)
  ) {
    return parent.getNameNode() === identifier;
  }
  return Node.isLabeledStatement(parent) || Node.isBreakStatement(parent) || Node.isContinueStatement(parent);
}

function impurityReason(fn: Node): string | undefined {
  if (fn.getDescendantsOfKind(SyntaxKind.ThisKeyword).length > 0) {
    return 'references `this`, which a standalone call cannot supply';
  }
  if (
    fn.getFirstDescendantByKind(SyntaxKind.AwaitExpression) ||
    fn.getFirstDescendantByKind(SyntaxKind.YieldExpression) ||
    (Node.isModifierable(fn) && fn.hasModifier(SyntaxKind.AsyncKeyword))
  ) {
    return 'is async or a generator — no synchronous return value to diff';
  }
  for (const access of fn.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (NON_DETERMINISTIC_MEMBERS.has(access.getText())) return `calls ${access.getText()}, which is non-deterministic`;
  }
  for (const node of [
    ...fn.getDescendantsOfKind(SyntaxKind.NewExpression),
    ...fn.getDescendantsOfKind(SyntaxKind.CallExpression),
  ]) {
    if (node.getExpression().getText() === 'Date' && node.getArguments().length === 0) {
      return 'reads the current time via an argument-less Date';
    }
  }
  for (const identifier of fn.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (isNameOnlyPosition(identifier)) continue;
    // A shorthand `{ x }` resolves to the property it creates; the variable it reads is the value symbol.
    const parent = identifier.getParentOrThrow();
    const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : identifier.getSymbol();
    const declaredInside = (symbol?.getDeclarations() ?? []).some(
      (d) => d === fn || d.getFirstAncestor((a) => a === fn) !== undefined
    );
    if (declaredInside || PURE_GLOBALS.has(identifier.getText())) continue;
    return `references ${identifier.getText()}, which is neither one of its own parameters/locals nor a pure built-in (§6.5 criteria (a)/(c))`;
  }
  return undefined;
}

function parseAsFunction(functionSource: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('/virtual/target.ts', `const __target = ${functionSource};`, {
    overwrite: true,
  });
  const declaration = sourceFile.getVariableDeclarationOrThrow('__target');
  const initializer = declaration.getInitializer();
  if (!initializer || !(Node.isFunctionExpression(initializer) || Node.isArrowFunction(initializer))) {
    return undefined;
  }
  return initializer;
}

export function checkEligibility(
  functionSource: string
): { readonly eligible: true } | { readonly eligible: false; readonly reason: string } {
  let fn;
  try {
    fn = parseAsFunction(functionSource);
  } catch {
    fn = undefined;
  }
  if (!fn) return { eligible: false, reason: 'not a parseable standalone function or arrow expression' };

  const impurity = impurityReason(fn);
  if (impurity) return { eligible: false, reason: impurity };

  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const calleeText = Node.isPropertyAccessExpression(expr) ? expr.getExpression().getText() : expr.getText();
    if (DISALLOWED_SERVICE_CALLS.includes(calleeText) || DISALLOWED_SERVICE_CALLS.includes(expr.getText())) {
      return {
        eligible: false,
        reason: `calls ${expr.getText()}, disallowed by §6.5 eligibility criterion (b)`,
      };
    }
  }

  const hasReturnWithValue = fn.getDescendantsOfKind(SyntaxKind.ReturnStatement).some((r) => r.getExpression())
    || (Node.isArrowFunction(fn) && !Node.isBlock(fn.getBody()));
  if (!hasReturnWithValue) {
    return { eligible: false, reason: 'no return statement with a value — nothing to diff against a golden master' };
  }

  return { eligible: true };
}
