import { Node, Project, SyntaxKind } from 'ts-morph';
import { resolveNamedFunctionDeclaration } from '../codemods/class-wrapping.js';
import { inferParameterTypes, type CharacterizationTarget } from '../verification/index.js';

/**
 * The one characterization producer v1 has: a migrated `@Pipe` against
 * the AngularJS filter it came from. Original side is the function the
 * filter factory returns; migrated side is the pipe's `transform`
 * method, re-expressed as a function.
 *
 * Returns `undefined` when either side cannot be located — the gate then
 * tiers the file LOW ("no characterization target"), which is the truth.
 * No call-site literals are supplied: filters are invoked from templates
 * (`{{ x | name }}`), which carry no literal arguments to harvest, so
 * eligibility rests on inferable parameter types alone (§6.5).
 */
export function pipeCharacterizationTarget(
  originalSource: string,
  emittedPipeSource: string
): CharacterizationTarget | undefined {
  const project = new Project({ useInMemoryFileSystem: true });
  const pipe = project.createSourceFile('/pipe.ts', emittedPipeSource).getClasses()[0];
  const transform = pipe?.getMethod('transform');
  const nameProperty = pipe
    ?.getDecorator('Pipe')
    ?.getFirstDescendantByKind(SyntaxKind.PropertyAssignment)
    ?.getInitializer();
  if (!transform || !nameProperty || !Node.isStringLiteral(nameProperty)) return undefined;
  const filterName = nameProperty.getLiteralText();

  const original = project.createSourceFile('/original.ts', originalSource);
  for (const call of original.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const [nameArg, factoryArg] = call.getArguments();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'filter') continue;
    if (!nameArg || !Node.isStringLiteral(nameArg) || nameArg.getLiteralText() !== filterName || !factoryArg) continue;

    const factory = Node.isFunctionExpression(factoryArg) ? factoryArg : resolveNamedFunctionDeclaration(factoryArg);
    const body = factory?.getBody();
    const returned = (Node.isBlock(body) ? body.getStatements() : []).find(Node.isReturnStatement)?.getExpression();
    if (!returned || !Node.isFunctionExpression(returned)) return undefined;

    const originalFunctionSource = returned.getText();
    return {
      artifactType: 'filter',
      originalFunctionSource,
      migratedFunctionSource: `function ${transform.getText()}`,
      parameterNames: returned.getParameters().map((p) => p.getName()),
      parameterTypes: inferParameterTypes(originalFunctionSource),
      callSiteArgLiterals: [],
    };
  }
  return undefined;
}
