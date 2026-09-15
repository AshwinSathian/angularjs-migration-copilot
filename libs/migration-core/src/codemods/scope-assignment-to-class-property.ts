import { Node, Project, SyntaxKind, type BinaryExpression, type Identifier, type ParameterDeclaration } from 'ts-morph';
import {
  applyEdits,
  buildClassSpliceEdits,
  buildClassText,
  classWrappingSkipReason,
  collectBareFunctionControllerMatches,
  constructorParamsText,
  functionBodyText,
  groupInsertionsByPosition,
  isInsideThisRebindingBoundary,
  isPlainAssignment,
  resolvesUniquelyTo,
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
interface ScopeAssignment {
  readonly assignment: BinaryExpression;
  readonly object: Identifier;
}

/**
 * True if `identifier` actually resolves — via ts-morph's real symbol
 * binding, not text matching — to `param`'s own declaration. This is
 * what correctly tells a `$scope.x = y` sitting inside a nested function
 * apart from one where `$scope` has been shadowed by *any* kind of local
 * binding (a nested function's own parameter, a `var`/`let`/`const`
 * declared inside it, a `catch` clause, ...). A hand-rolled ancestor walk
 * checking only "does a nested function declare its own `$scope`
 * parameter" was tried first and missed the `var $scope = ...` case
 * entirely — real binding resolution handles every shadowing shape at
 * once instead of enumerating them one bug report at a time.
 */
function resolvesToParam(identifier: Identifier, param: ParameterDeclaration): boolean {
  return resolvesUniquelyTo(identifier, param);
}

/**
 * `$scope.<name> = <value>` where `$scope` resolves to `scopeParam` —
 * `outerFn`'s own injected `$scope`, not a shadowed local of the same
 * name — and is exactly the object being assigned into, a single
 * property level deep, matching the pattern's literal `$scope.x = y`
 * definition. A deeper chain (`$scope.a.b = y`) or a computed member
 * (`$scope[x] = y`) is a different shape, left untouched rather than
 * guessed at. A shadowed occurrence is excluded here rather than flagged
 * as a skip — it genuinely isn't this pattern's target, since it refers
 * to a different variable entirely; leaving it untouched is correct, not
 * a compromise.
 */
function asScopePropertyAssignment(node: BinaryExpression, scopeParam: ParameterDeclaration): ScopeAssignment | undefined {
  if (!isPlainAssignment(node)) return undefined;
  const left = node.getLeft();
  if (!Node.isPropertyAccessExpression(left)) return undefined;
  const object = left.getExpression();
  if (!Node.isIdentifier(object) || object.getText() !== '$scope') return undefined;
  if (!resolvesToParam(object, scopeParam)) return undefined;
  return { assignment: node, object };
}

function findScopeAssignments(fn: WrappableFunction, scopeParam: ParameterDeclaration): ScopeAssignment[] {
  return fn
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .map((node) => asScopePropertyAssignment(node, scopeParam))
    .filter((match): match is ScopeAssignment => match !== undefined);
}

/**
 * True if the controller's own `$scope` (not a shadowed local) is ever
 * reassigned as a bare identifier anywhere in `fn` — e.g.
 * `$scope = $scope.$new();`. Binding resolution alone can't catch this:
 * a reassignment doesn't change *which* declaration `$scope` refers to,
 * only its runtime value, so every `$scope.x = y` after such a line
 * would still resolve to `scopeParam` and pass `asScopePropertyAssignment`
 * — while actually mutating whatever `$scope` now holds, not the
 * originally-injected value the class constructor captures.
 */
function isReassigned(fn: WrappableFunction, scopeParam: ParameterDeclaration): boolean {
  return fn.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((node) => {
    if (!isPlainAssignment(node)) return false;
    const left = node.getLeft();
    return Node.isIdentifier(left) && left.getText() === '$scope' && resolvesToParam(left, scopeParam);
  });
}

/**
 * True if `fn` has at least one `$scope.<name> = value` assignment this
 * pattern would actually touch — exported so pattern #2 (controllerAs)
 * can exclude a controller already claimed here, keeping the two
 * patterns non-overlapping the same way DI style already keeps #1 and #3
 * non-overlapping. Excludes an assignment inside a nested this-rebinding
 * boundary (the same check `transformScopeAssignmentToClassProperty`
 * itself uses to skip the whole registration): without it, a controller
 * whose *only* `$scope.x = y` is inside such a boundary was reported as
 * "pattern #1's territory" by pattern #2, while pattern #1 itself would
 * skip that same registration — silently missed by both, undercounting
 * the mechanical hit-rate. Found by adversarial review, confirmed by
 * actually running both codemods against the same constructed file
 * before fixing, not assumed from reading the two skip conditions side
 * by side.
 */
export function hasScopePropertyAssignment(fn: WrappableFunction): boolean {
  const scopeParam = fn.getParameters().find((p) => p.getName() === '$scope');
  if (!scopeParam) return false;
  return findScopeAssignments(fn, scopeParam).some(
    ({ assignment }) => !isInsideThisRebindingBoundary(assignment, fn)
  );
}

interface Candidate {
  readonly className: string;
  readonly fn: WrappableFunction;
  readonly isNamedDeclaration: boolean;
  readonly injectStatement: Node | undefined;
  readonly topStmtStart: number;
  readonly scopeEdits: PositionEdit[];
}

export function transformScopeAssignmentToClassProperty(sourceText: string): CodemodResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/app.js', sourceText);

  const rawMatches = collectBareFunctionControllerMatches(project);

  const candidates: Candidate[] = [];
  const skipReasons: string[] = [];
  const usedClassNames = new Set<string>();
  const claimedNamedDeclarations = new Set<Node>();

  for (const match of rawMatches) {
    const { className, fn } = match;

    if (match.isNamedDeclaration) {
      if (claimedNamedDeclarations.has(fn)) {
        skipReasons.push(
          `${className}: another registration in this file already targets the same function declaration for deletion — ambiguous, not safely transformable`
        );
        continue;
      }
      claimedNamedDeclarations.add(fn);
    }

    const scopeParam = fn.getParameters().find((p) => p.getName() === '$scope');
    if (!scopeParam) continue;

    const assignments = findScopeAssignments(fn, scopeParam);
    if (assignments.length === 0) continue;

    if (isReassigned(fn, scopeParam)) {
      skipReasons.push(`${className}: $scope is reassigned within the function, not safely transformable`);
      continue;
    }

    if (assignments.some(({ assignment }) => isInsideThisRebindingBoundary(assignment, fn))) {
      skipReasons.push(
        `${className}: a $scope property assignment is inside a nested function or accessor, not safely transformable — this would not refer to the class instance there`
      );
      continue;
    }

    const skipReason = classWrappingSkipReason(
      className,
      fn,
      sourceFile,
      usedClassNames,
      match.isNamedDeclaration ? fn : undefined
    );
    if (skipReason) {
      skipReasons.push(skipReason);
      continue;
    }

    usedClassNames.add(className);
    candidates.push({
      className,
      fn,
      isNamedDeclaration: match.isNamedDeclaration,
      injectStatement: match.injectStatement,
      topStmtStart: match.topStmtStart,
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
    const classText = buildClassText(
      candidate.className,
      constructorParamsText(candidate.fn),
      functionBodyText(candidate.fn, candidate.scopeEdits)
    );
    const edits = buildClassSpliceEdits(candidate, classText);
    insertions.push(edits.insertion);
    replacements.push(...edits.replacements);
  }

  const output = applyEdits(sourceFile.getFullText(), [
    ...groupInsertionsByPosition(insertions),
    ...replacements,
  ]);

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
