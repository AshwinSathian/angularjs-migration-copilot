import { Node, type Project } from 'ts-morph';
import type { RouteEntry } from './types.js';

/**
 * Finds `$routeProvider.when(path, config)` and ui-router's
 * `$stateProvider.state(name, config)` calls. Matched by checking whether
 * the receiver's source text mentions the provider name, which is robust
 * to chaining (`$routeProvider.when(...).when(...)`) since every link in
 * that chain's text still includes the original `$routeProvider` token.
 */
export function scanRoutes(project: Project): RouteEntry[] {
  const routes: RouteEntry[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expression = node.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) return;

      const methodName = expression.getName();
      if (methodName !== 'when' && methodName !== 'state') return;

      const receiverText = expression.getExpression().getText();
      const isNgRoute = methodName === 'when' && /\$routeProvider/.test(receiverText);
      const isUiRouter = methodName === 'state' && /\$stateProvider/.test(receiverText);
      if (!isNgRoute && !isUiRouter) return;

      const [pathOrNameArg] = node.getArguments();
      const pathOrStateName = pathOrNameArg
        ? Node.isStringLiteral(pathOrNameArg)
          ? pathOrNameArg.getLiteralText()
          : pathOrNameArg.getText()
        : '';

      routes.push({
        provider: isNgRoute ? 'ngRoute' : 'ui-router',
        pathOrStateName,
        filePath: sourceFile.getFilePath(),
        // The `.when`/`.state` token's own line, not the whole call
        // expression's — for a chained `$routeProvider.when(a).when(b)`,
        // every link in the chain shares the same expression start (back
        // at `$routeProvider` on line 1), so using that would report every
        // route as being on the same line.
        line: expression.getNameNode().getStartLineNumber(),
      });
    });
  }

  // `forEachDescendant` visits outer nodes before inner ones, so a chained
  // `.when(a).when(b)` yields `b` before `a` — the opposite of source
  // order. Sorting by the now-accurate per-call line restores it.
  return routes.sort((a, b) => a.line - b.line);
}
