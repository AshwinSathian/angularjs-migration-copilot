import { Node, type Project } from 'ts-morph';
import { forEachPropertyAccessCall, methodCallLine, sortByFileThenLine } from './ast-helpers.js';
import type { RouteEntry } from './types.js';

/**
 * Finds `$routeProvider.when(path, config)` and ui-router's
 * `$stateProvider.state(name, config)` calls. Matched by checking whether
 * the receiver's source text mentions the provider name, which is robust
 * to chaining (`$routeProvider.when(...).when(...)`) since every link in
 * that chain's text still includes the original `$routeProvider` token.
 *
 * Known limitation: this is a text match on the receiver, not identifier
 * resolution. A config function that aliases the injected provider to a
 * different local name — `function (rp) { rp.when('/x', {...}) }` — won't
 * be recognized, since `rp` never appears alongside the literal substring
 * `$routeProvider`. Real-world AngularJS code overwhelmingly keeps DI
 * parameter names matching the injected token (renaming them actively
 * fights the style every AngularJS linter/guide recommends), so this is a
 * deliberate, documented scope line rather than a silent gap — resolving
 * it properly would mean tracing the identifier back through the enclosing
 * function's parameter list to confirm it's bound to the injected
 * `$routeProvider`/`$stateProvider`, a meaningfully larger analysis for a
 * pattern that's rare in practice.
 */
export function scanRoutes(project: Project): RouteEntry[] {
  const routes: RouteEntry[] = [];

  forEachPropertyAccessCall(project, (call, expression, sourceFile) => {
    const methodName = expression.getName();
    if (methodName !== 'when' && methodName !== 'state') return;

    const receiverText = expression.getExpression().getText();
    const isNgRoute = methodName === 'when' && /\$routeProvider/.test(receiverText);
    const isUiRouter = methodName === 'state' && /\$stateProvider/.test(receiverText);
    if (!isNgRoute && !isUiRouter) return;

    const [pathOrNameArg] = call.getArguments();
    const pathOrStateName = pathOrNameArg
      ? Node.isStringLiteral(pathOrNameArg)
        ? pathOrNameArg.getLiteralText()
        : pathOrNameArg.getText()
      : '';

    routes.push({
      provider: isNgRoute ? 'ngRoute' : 'ui-router',
      pathOrStateName,
      filePath: sourceFile.getFilePath(),
      line: methodCallLine(expression),
    });
  });

  return sortByFileThenLine(routes);
}
