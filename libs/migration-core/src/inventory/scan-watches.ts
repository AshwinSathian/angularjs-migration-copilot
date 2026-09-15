import { Node, type Project } from 'ts-morph';
import type { WatchUsage } from './types.js';

const WATCH_METHODS: ReadonlySet<string> = new Set([
  '$watch',
  '$watchCollection',
  '$watchGroup',
]);

/**
 * Finds `$scope.$watch(...)` / `$rootScope.$watch(...)` and their
 * collection/group variants. This feeds two later stages: it's a signal
 * that a controller is `$scope`-coupled (relevant to characterization-test
 * eligibility, product-spec.md §6.5), and deep-equality watches are
 * explicitly out of the mechanical codemod scope in §6.3.
 */
export function scanWatchUsages(project: Project): WatchUsage[] {
  const usages: WatchUsage[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expression = node.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) return;

      const methodName = expression.getName();
      if (!WATCH_METHODS.has(methodName)) return;

      const receiverText = expression.getExpression().getText();
      if (!/\$scope|\$rootScope/.test(receiverText)) return;

      const [watchExprArg] = node.getArguments();

      usages.push({
        method: methodName as WatchUsage['method'],
        expressionText: watchExprArg?.getText().slice(0, 200) ?? '',
        filePath: sourceFile.getFilePath(),
        line: node.getStartLineNumber(),
      });
    });
  }

  return usages;
}
