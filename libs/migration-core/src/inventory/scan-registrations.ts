import { Node, type Project } from 'ts-morph';
import { extractDependencyNames } from './ast-helpers.js';
import type { RegistrationEntry, RegistrationKind } from './types.js';

const REGISTRATION_METHODS: ReadonlySet<string> = new Set([
  'controller',
  'directive',
  'service',
  'factory',
  'filter',
  'component',
]);

/**
 * `.component(name, { controller: ..., ... })` — introduced in AngularJS
 * 1.5 — nests its controller inside an object-literal config rather than
 * passing it directly as the second argument like every other
 * registration method. Both array-style and bare-function controllers
 * show up in real code, same as elsewhere; a string-named controller
 * (referencing a separately-registered `.controller(...)`) has no DI list
 * of its own to extract here, so it's reported with no dependencies rather
 * than guessed at.
 */
function extractComponentControllerArg(definitionArg: Node | undefined): Node | undefined {
  if (!definitionArg || !Node.isObjectLiteralExpression(definitionArg)) return undefined;

  const controllerProp = definitionArg.getProperty('controller');
  if (!controllerProp || !Node.isPropertyAssignment(controllerProp)) return undefined;

  return controllerProp.getInitializer();
}

/**
 * Finds `.controller(...)`, `.directive(...)`, `.service(...)`,
 * `.factory(...)`, `.filter(...)`, and `.component(...)` registrations,
 * chained off `angular` or off a `.module(...)` call — both are legal
 * AngularJS and both show up in real code, so the method name is what's
 * matched, not the receiver.
 */
export function scanRegistrations(project: Project): RegistrationEntry[] {
  const entries: RegistrationEntry[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expression = node.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) return;

      const methodName = expression.getName();
      if (!REGISTRATION_METHODS.has(methodName)) return;

      const [nameArg, definitionArg] = node.getArguments();
      if (!nameArg || !Node.isStringLiteral(nameArg)) return;

      const dependencies =
        methodName === 'component'
          ? extractDependencyNames(extractComponentControllerArg(definitionArg))
          : extractDependencyNames(definitionArg);

      entries.push({
        kind: methodName as RegistrationKind,
        name: nameArg.getLiteralText(),
        filePath: sourceFile.getFilePath(),
        // The method name's own line, not the whole call expression's —
        // a chained `angular.module('app').controller(a).controller(b)`
        // would otherwise report every registration on the chain's first
        // line. See the identical fix and rationale in scan-routes.ts.
        line: expression.getNameNode().getStartLineNumber(),
        dependencies,
      });
    });
  }

  return entries.sort((a, b) => a.line - b.line);
}
