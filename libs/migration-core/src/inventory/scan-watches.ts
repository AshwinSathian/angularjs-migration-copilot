import { type Project } from 'ts-morph';
import { forEachPropertyAccessCall } from './ast-helpers.js';
import { WATCH_METHODS, type WatchUsage } from './types.js';

const WATCH_METHOD_SET: ReadonlySet<string> = new Set(WATCH_METHODS);

/**
 * Finds `$scope.$watch(...)` / `$rootScope.$watch(...)` and their
 * collection/group variants. This feeds two later stages: it's a signal
 * that a controller is `$scope`-coupled (relevant to characterization-test
 * eligibility, product-spec.md §6.5), and deep-equality watches are
 * explicitly out of the mechanical codemod scope in §6.3.
 *
 * Known limitation, same class as scan-routes.ts's provider-aliasing gap:
 * this matches the receiver's source text, not identifier resolution, so
 * `var scope = $scope; scope.$watch(...)` (a local alias) is missed. Older
 * callback-heavy AngularJS code sometimes does this to avoid repeating
 * `$scope.` inside nested closures — documented here as a real, if
 * uncommon, false negative rather than silently assumed away.
 */
export function scanWatchUsages(project: Project): WatchUsage[] {
  const usages: WatchUsage[] = [];

  forEachPropertyAccessCall(project, (call, expression, sourceFile) => {
    const methodName = expression.getName();
    if (!WATCH_METHOD_SET.has(methodName)) return;

    const receiverText = expression.getExpression().getText();
    if (!/\$scope|\$rootScope/.test(receiverText)) return;

    const [watchExprArg] = call.getArguments();

    usages.push({
      method: methodName as WatchUsage['method'],
      expressionText: watchExprArg?.getText().slice(0, 200) ?? '',
      filePath: sourceFile.getFilePath(),
      line: call.getStartLineNumber(),
    });
  });

  return usages;
}
