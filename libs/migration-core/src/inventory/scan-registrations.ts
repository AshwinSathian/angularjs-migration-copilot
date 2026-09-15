import { Node, type Project } from 'ts-morph';
import { extractDependencyNames, forEachPropertyAccessCall, methodCallLine, sortByFileThenLine } from './ast-helpers.js';
import { REGISTRATION_KINDS, type RegistrationEntry, type RegistrationKind } from './types.js';

const REGISTRATION_METHODS: ReadonlySet<string> = new Set(REGISTRATION_KINDS);

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
  if (!controllerProp) return undefined;

  // `{ controller: fn }` / `{ controller: [...] }` is a PropertyAssignment;
  // `{ controller($scope) {...} }` (ES6 shorthand method syntax, common in
  // AngularJS 1.5+ code written after ES6 became normal) is a
  // MethodDeclaration instead and has no separate initializer — the
  // declaration itself is already the function to extract params from.
  if (Node.isPropertyAssignment(controllerProp)) return controllerProp.getInitializer();
  if (Node.isMethodDeclaration(controllerProp)) return controllerProp;

  return undefined;
}

/**
 * Finds `.controller(...)`, `.directive(...)`, `.component(...)`,
 * `.service(...)`, `.factory(...)`, `.provider(...)`, `.value(...)`,
 * `.constant(...)`, `.filter(...)`, `.decorator(...)`, and
 * `.animation(...)` registrations, chained off `angular` or off a
 * `.module(...)` call — both are legal AngularJS and both show up in real
 * code, so the method name is what's matched, not the receiver.
 */
export function scanRegistrations(project: Project): RegistrationEntry[] {
  const entries: RegistrationEntry[] = [];

  forEachPropertyAccessCall(project, (call, expression, sourceFile) => {
    const methodName = expression.getName();
    if (!REGISTRATION_METHODS.has(methodName)) return;

    const [nameArg, definitionArg] = call.getArguments();
    if (!nameArg || !Node.isStringLiteral(nameArg)) return;

    const dependencies =
      methodName === 'component'
        ? extractDependencyNames(extractComponentControllerArg(definitionArg))
        : extractDependencyNames(definitionArg);

    entries.push({
      kind: methodName as RegistrationKind,
      name: nameArg.getLiteralText(),
      filePath: sourceFile.getFilePath(),
      line: methodCallLine(expression),
      dependencies,
    });
  });

  return sortByFileThenLine(entries);
}
