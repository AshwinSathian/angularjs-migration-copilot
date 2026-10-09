import { Node, Project, SyntaxKind } from 'ts-morph';
import type { ParameterType } from '../types.js';

const STRING_METHODS = new Set([
  'replace', 'toUpperCase', 'toLowerCase', 'trim', 'split', 'substring', 'substr', 'charAt',
  'startsWith', 'endsWith', 'match', 'localeCompare', 'padStart', 'padEnd',
]);
const ARRAY_METHODS = new Set(['map', 'filter', 'reduce', 'forEach', 'push', 'join', 'sort', 'some', 'every']);
const ARITHMETIC = new Set([
  SyntaxKind.AsteriskToken, SyntaxKind.SlashToken, SyntaxKind.MinusToken, SyntaxKind.PercentToken,
]);

function usageType(use: Node): ParameterType | undefined {
  const parent = use.getParentOrThrow();
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === use) {
    const member = parent.getName();
    if (STRING_METHODS.has(member)) return 'string';
    if (ARRAY_METHODS.has(member)) return 'array';
    if (member === 'toFixed') return 'number';
  }
  if (Node.isCallExpression(parent) && parent.getArguments().includes(use)) {
    const callee = parent.getExpression().getText();
    if (callee === 'String') return 'string';
    if (callee.startsWith('Math.')) return 'number';
  }
  if (Node.isBinaryExpression(parent) && ARITHMETIC.has(parent.getOperatorToken().getKind())) return 'number';
  const isCondition =
    (Node.isConditionalExpression(parent) && parent.getCondition() === use) ||
    (Node.isIfStatement(parent) && parent.getExpression() === use) ||
    (Node.isPrefixUnaryExpression(parent) && parent.getOperatorToken() === SyntaxKind.ExclamationToken);
  return isCondition ? 'boolean' : undefined;
}

/**
 * §6.5 "type-based boundary values for each parameter" needs a type, and
 * AngularJS source is untyped JavaScript. This infers one from how the
 * function itself uses each parameter, and only when the usage is
 * unambiguous evidence: a string-only or array-only method call,
 * `String(p)`, arithmetic, or a bare truthiness test.
 *
 * Deliberately conservative — `undefined` (no boundary values generated)
 * beats a guess. `+`, `.length`, `.concat`, `.indexOf`, and `.slice` are
 * not evidence: strings and arrays (or numbers) share them. A parameter
 * with conflicting evidence is `undefined`, except that a truthiness
 * test never conflicts — `text ? String(text) : ''` is a string.
 */
export function inferParameterTypes(functionSource: string): readonly (ParameterType | undefined)[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('/virtual/infer.ts', `const __target = ${functionSource};`);
  const fn = sourceFile.getVariableDeclarationOrThrow('__target').getInitializer();
  if (!fn || !(Node.isFunctionExpression(fn) || Node.isArrowFunction(fn))) return [];

  return fn.getParameters().map((parameter) => {
    const nameNode = parameter.getNameNode();
    if (!Node.isIdentifier(nameNode)) return undefined;
    const evidence = new Set<ParameterType>();
    for (const use of nameNode.findReferencesAsNodes()) {
      const type = usageType(use);
      if (type) evidence.add(type);
    }
    if (evidence.size > 1) evidence.delete('boolean');
    return evidence.size === 1 ? [...evidence][0] : undefined;
  });
}
