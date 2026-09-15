import { Node, Project, SyntaxKind, type BinaryExpression, type Identifier } from 'ts-morph';
import { forEachPropertyAccessCall } from '../inventory/ast-helpers.js';
import {
  applyEdits,
  buildClassText,
  constructorParamsText,
  functionBodyText,
  groupInsertionsByPosition,
  hasExistingTopLevelBinding,
  isSimpleParameter,
  isValidClassName,
  nearestInsertionPointStart,
  type PositionEdit,
  type WrappableFunction,
} from './class-wrapping.js';
import type { CodemodResult } from './types.js';

/**
 * Pattern #1 (docs/product-spec.md §6.3) is scoped to `.controller`
 * registrations using bare-function DI (`function ($scope) {...}`), not
 * array-style DI (`['$scope', function ($scope) {...}]`) — that's pattern
 * #3's job, and the two patterns are kept non-overlapping so a run's
 * mechanical-hit-rate numbers don't double-count the same registration.
 * `.service`/`.factory` are excluded too: `$scope` is a controller/
 * directive-link concept, not something services are conventionally
 * injected with. Scoping decision recorded in docs/decisions.md.
 */
function isBareFunctionController(methodName: string): boolean {
  return methodName === 'controller';
}

function isPlainAssignment(node: BinaryExpression): boolean {
  return node.getOperatorToken().getKind() === SyntaxKind.EqualsToken;
}

interface ScopeAssignment {
  readonly assignment: BinaryExpression;
  readonly object: Identifier;
}

/**
 * `$scope.<name> = <value>` where `$scope` is exactly the object being
 * assigned into — a single property level deep, matching the pattern's
 * literal `$scope.x = y` definition. A deeper chain (`$scope.a.b = y`) or
 * a computed member (`$scope[x] = y`) is a different shape, left
 * untouched rather than guessed at.
 */
function asScopePropertyAssignment(node: BinaryExpression): ScopeAssignment | undefined {
  if (!isPlainAssignment(node)) return undefined;
  const left = node.getLeft();
  if (!Node.isPropertyAccessExpression(left)) return undefined;
  const object = left.getExpression();
  if (!Node.isIdentifier(object) || object.getText() !== '$scope') return undefined;
  return { assignment: node, object };
}

function findScopeAssignments(fn: WrappableFunction): ScopeAssignment[] {
  return fn
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .map(asScopePropertyAssignment)
    .filter((match): match is ScopeAssignment => match !== undefined);
}

/**
 * True if rewriting this assignment's `$scope` to `this` would be wrong
 * because of a function boundary between it and `outerFn` (exclusive of
 * `outerFn` itself). Two distinct ways that happens, both checked here
 * rather than just the first one found: (1) a nested **non-arrow**
 * function — e.g. `$http.get(...).then(function (res) { $scope.x = ... })`
 * — rebinds `this` when called, so `this` inside it would no longer refer
 * to the class instance the way `$scope` correctly still refers to the
 * outer scope via closure; an arrow function doesn't have this problem,
 * since it never rebinds `this`. (2) any nested function (arrow or not)
 * that redeclares its own `$scope` parameter — e.g. a `$watch` callback's
 * `function (newVal, oldVal, $scope) {...}` third argument — shadows the
 * outer `$scope` with a different binding entirely, `this`-rebinding
 * aside.
 */
function isUnsafeNestedAssignment(scopeAssignment: ScopeAssignment, outerFn: WrappableFunction): boolean {
  let current: Node = scopeAssignment.assignment;
  for (;;) {
    const parent: Node | undefined = current.getParent();
    if (!parent || parent === outerFn) return false;

    if (Node.isFunctionExpression(parent) || Node.isArrowFunction(parent) || Node.isFunctionDeclaration(parent) || Node.isMethodDeclaration(parent)) {
      const rebindsThis = !Node.isArrowFunction(parent);
      const shadowsScope = parent.getParameters().some((p) => p.getName() === '$scope');
      if (rebindsThis || shadowsScope) return true;
    }

    current = parent;
  }
}

interface RawMatch {
  readonly className: string;
  readonly fn: WrappableFunction;
  readonly sortKey: number;
  readonly topStmtStart: number;
  readonly fnStart: number;
  readonly fnEnd: number;
}

interface Candidate {
  readonly className: string;
  readonly fn: WrappableFunction;
  readonly topStmtStart: number;
  readonly fnStart: number;
  readonly fnEnd: number;
  readonly scopeEdits: PositionEdit[];
}

export function transformScopeAssignmentToClassProperty(sourceText: string): CodemodResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/app.js', sourceText);

  // Same collect-then-validate-in-true-source-order structure pattern #3
  // uses, for the same reason: a chained `.controller(...).controller(...)`
  // visits its outermost (last-in-source) call first during traversal.
  const rawMatches: RawMatch[] = [];

  forEachPropertyAccessCall(project, (call, expression) => {
    if (!isBareFunctionController(expression.getName())) return;

    const [nameArg, definitionArg] = call.getArguments();
    if (!nameArg || !Node.isStringLiteral(nameArg)) return;
    if (!definitionArg || !(Node.isFunctionExpression(definitionArg) || Node.isArrowFunction(definitionArg))) return;

    rawMatches.push({
      className: nameArg.getLiteralText(),
      fn: definitionArg,
      sortKey: expression.getNameNode().getStart(),
      topStmtStart: nearestInsertionPointStart(call),
      fnStart: definitionArg.getStart(),
      fnEnd: definitionArg.getEnd(),
    });
  });

  rawMatches.sort((a, b) => a.sortKey - b.sortKey);

  const candidates: Candidate[] = [];
  const skipReasons: string[] = [];
  const usedClassNames = new Set<string>();

  for (const match of rawMatches) {
    const { className, fn } = match;

    if (!fn.getParameters().some((p) => p.getName() === '$scope')) continue;

    const assignments = findScopeAssignments(fn);
    if (assignments.length === 0) continue;

    if (assignments.some((assignment) => isUnsafeNestedAssignment(assignment, fn))) {
      skipReasons.push(
        `${className}: a $scope property assignment is inside a nested function, not safely transformable — this would not refer to the class instance there, and/or $scope may be shadowed`
      );
      continue;
    }

    if (!isValidClassName(className)) {
      skipReasons.push(`${className}: not a valid class identifier`);
      continue;
    }

    if (usedClassNames.has(className) || hasExistingTopLevelBinding(sourceFile, className)) {
      skipReasons.push(`${className}: duplicate registration name in this file — ambiguous which one to keep, not safely transformable`);
      continue;
    }

    if (!fn.getParameters().every(isSimpleParameter)) {
      skipReasons.push(
        `${className}: has a destructured, default-valued, or rest parameter — not safely transformable`
      );
      continue;
    }

    usedClassNames.add(className);
    candidates.push({
      className,
      fn,
      topStmtStart: match.topStmtStart,
      fnStart: match.fnStart,
      fnEnd: match.fnEnd,
      scopeEdits: assignments.map(({ object }) => ({
        pos: object.getStart(),
        end: object.getEnd(),
        replacement: 'this',
      })),
    });
  }

  if (candidates.length === 0) {
    return {
      matched: false,
      reason: skipReasons.length > 0
        ? skipReasons.join('; ')
        : 'no bare-function controller with a $scope property assignment found',
    };
  }

  const insertions: { pos: number; text: string }[] = [];
  const replacements: PositionEdit[] = [];

  for (const candidate of candidates) {
    insertions.push({
      pos: candidate.topStmtStart,
      text: buildClassText(
        candidate.className,
        constructorParamsText(candidate.fn),
        functionBodyText(candidate.fn, candidate.scopeEdits)
      ),
    });
    replacements.push({ pos: candidate.fnStart, end: candidate.fnEnd, replacement: candidate.className });
  }

  const output = applyEdits(sourceFile.getFullText(), [
    ...groupInsertionsByPosition(insertions),
    ...replacements,
  ]);

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
