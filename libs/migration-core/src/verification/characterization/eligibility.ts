import { Node, Project, SyntaxKind } from 'ts-morph';

/**
 * §6.5's exact characterization-eligibility definition, implemented
 * exactly rather than approximated (docs/milestones/m2-verification.md's
 * own scope note): a function qualifies only if it (a) doesn't reference
 * `$scope`/`$rootScope`/a DOM global beyond its own parameters, (b)
 * doesn't call one of the known async/side-effecting Angular services,
 * (c) returns a value derived only from its inputs.
 *
 * (c) is enforced heuristically, not proven: "has at least one `return`
 * with an expression" is a necessary, not sufficient, condition for
 * input-only derivation — a function could still close over external
 * state through some path (a) and (b) don't catch. Documented as an
 * accepted limitation, same precedent as assert-compiles.ts's own
 * ignored-diagnostic list and assert-valid-template.ts's brace-balance
 * gap: a false positive here (accepting a function that isn't really
 * pure) still gets caught downstream by the golden-master diff itself
 * disagreeing, so it degrades to a REJECTED rather than a silent wrong
 * accept.
 *
 * Real-fixture evidence (checked before writing any detection code,
 * standing practice since ADR-030/034/039): `.factory`/`.service`/
 * `.filter` bodies exist only in `blur-admin` (12 factory/service files,
 * 10 filter files; `angular-phonecat` and `CoreUI-AngularJS` have none,
 * matching filter-to-pipe.ts's own prior count) — every criterion below
 * was spot-checked against real functions there. `baUtil.js`'s
 * `isDescendant(parent, child)` and `hexToRGB(hex, alpha)` are pure,
 * parameter-only, single-`return` functions — the (a)/(b)/(c)-eligible
 * shape this module exists to accept. `theme.service.js` references
 * `navigator.userAgent` and `document.body` directly, confirming DOM
 * globals are a real (not hypothetical) shape to reject on. `preloader.js`'s
 * `loadImg`/`loadAmCharts` methods call `$q.defer()` against the outer
 * factory's `$q` DI parameter, confirming criterion (b)'s async-service
 * shape. No `.factory`/`.service`/`.filter` body in any of the three
 * fixtures references `$scope`/`$rootScope` — that coupling is a
 * controller idiom, as documented elsewhere in this project, so finding
 * zero here is expected, not a gap. One real limitation surfaced by this
 * spot-check and worth flagging (not fixed here, out of the brief's
 * scope): `appImage.js`'s returned filter function closes over the outer
 * factory's `layoutPaths` DI parameter, a free variable that is neither
 * one of `fn`'s own parameters nor on the disallowed-globals list —
 * criterion (a) as specified only catches the five named globals, not
 * arbitrary closed-over identifiers, so this shape would pass eligibility
 * despite not being purely input-derived.
 */
const DISALLOWED_BARE_REFERENCES = ['$scope', '$rootScope', 'document', 'window', 'navigator'];
const DISALLOWED_SERVICE_CALLS = ['$http', '$q', '$timeout', '$interval', '$animate'];

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

  const ownParamNames = new Set(fn.getParameters().map((p) => p.getName()));

  for (const identifier of fn.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const name = identifier.getText();
    if (!DISALLOWED_BARE_REFERENCES.includes(name)) continue;
    if (ownParamNames.has(name)) continue; // a parameter merely named like a global is not the global
    // Exclude the parameter-declaration site itself and property-access names (`x.document`).
    if (Node.isParameterDeclaration(identifier.getParent())) continue;
    const parent = identifier.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) continue;
    return { eligible: false, reason: `references ${name}, disallowed by §6.5 eligibility criterion (a)` };
  }

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
