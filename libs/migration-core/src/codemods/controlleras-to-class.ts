import { Node, Project, SyntaxKind, type Identifier, type VariableDeclaration } from 'ts-morph';
import {
  applyEdits,
  buildClassSpliceEdits,
  buildClassText,
  buildNoMatchReason,
  classWrappingSkipReason,
  collectBareFunctionControllerMatches,
  constructorParamsText,
  functionBodyText,
  groupInsertionsByPosition,
  isInsideThisRebindingBoundary,
  isPlainAssignment,
  resolvesUniquelyTo,
  type BareFunctionControllerMatch,
  type PositionEdit,
  type WrappableFunction,
} from './class-wrapping.js';
import { hasScopePropertyAssignment } from './scope-assignment-to-class-property.js';
import type { CodemodResult } from './types.js';

/**
 * Pattern #2 (docs/product-spec.md §6.3) is scoped to `.controller`
 * registrations using bare-function DI whose body follows the
 * `controllerAs` idiom — assigning directly onto `this`, or onto a local
 * alias declared as `var/let/const <name> = this;` (`vm`, `self`, ... —
 * any identifier, the alias name itself carries no meaning). Array-style
 * DI is pattern #3's job, same non-overlap reasoning as pattern #1
 * (ADR-027). A controller that *also* has a `$scope.x = y` assignment is
 * pattern #1's territory and is excluded here via
 * `hasScopePropertyAssignment`, so the two patterns' mechanical-hit-rate
 * numbers never double-count the same registration — recorded in
 * docs/decisions.md ADR-029.
 *
 * Unlike pattern #1, no internal rewriting is needed: whether written as
 * `this.x = y` or `vm.x = y` (with `vm` closure-capturing the controller's
 * own `this`), the assignment already resolves correctly once the whole
 * function body is wrapped verbatim as a class constructor — `this`
 * inside a constructor is the new instance exactly as it was inside the
 * original AngularJS-invoked constructor function. The pattern only needs
 * to *detect* a genuine controllerAs signal to decide whether to fire at
 * all, the same reason `isInsideThisRebindingBoundary` still matters here:
 * a `this.x = y` or `var vm = this` sitting inside a nested non-arrow
 * function/accessor refers to a different, dynamically-bound `this`, not
 * the controller instance, so it doesn't count as a hit.
 */

/** `this.<name> = <value>` where `this` is not inside a rebinding boundary relative to `fn` — the direct (unaliased) controllerAs form. */
function hasDirectThisAssignment(fn: WrappableFunction): boolean {
  return fn.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((node) => {
    if (!isPlainAssignment(node)) return false;
    const left = node.getLeft();
    if (!Node.isPropertyAccessExpression(left)) return false;
    if (!Node.isThisExpression(left.getExpression())) return false;
    return !isInsideThisRebindingBoundary(node, fn);
  });
}

/**
 * `var/let/const <alias> = this;` declared where `this` is not inside a
 * rebinding boundary — i.e. the alias genuinely closure-captures the
 * controller's own instance, not some nested function's dynamically-bound
 * `this`.
 */
function findValidAliasDeclarations(fn: WrappableFunction): VariableDeclaration[] {
  return fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration).filter((decl) => {
    const initializer = decl.getInitializer();
    if (!initializer || !Node.isThisExpression(initializer)) return false;
    return !isInsideThisRebindingBoundary(initializer, fn);
  });
}

/** True if `identifier` resolves — via real symbol binding, not text matching — to one of `aliasDeclarations`. */
function resolvesToOneOf(identifier: Identifier, aliasDeclarations: readonly VariableDeclaration[]): boolean {
  return resolvesUniquelyTo(identifier, aliasDeclarations);
}

/**
 * `<alias>.<name> = <value>` anywhere in `fn` (nested is fine — the alias
 * is a captured closure variable, not `this` itself, so it doesn't cross
 * the this-rebinding hazard the direct form has to guard against) where
 * `<alias>` resolves to one of `aliasDeclarations`.
 */
function hasAliasPropertyAssignment(fn: WrappableFunction, aliasDeclarations: readonly VariableDeclaration[]): boolean {
  if (aliasDeclarations.length === 0) return false;
  return fn.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((node) => {
    if (!isPlainAssignment(node)) return false;
    const left = node.getLeft();
    if (!Node.isPropertyAccessExpression(left)) return false;
    const object = left.getExpression();
    return Node.isIdentifier(object) && resolvesToOneOf(object, aliasDeclarations);
  });
}

function isControllerAsIdiom(fn: WrappableFunction): boolean {
  return hasDirectThisAssignment(fn) || hasAliasPropertyAssignment(fn, findValidAliasDeclarations(fn));
}

export function transformControllerAsToClass(sourceText: string): CodemodResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/app.js', sourceText);

  const { matches: rawMatches, nestingConflictClassNames } = collectBareFunctionControllerMatches(project);

  const candidates: BareFunctionControllerMatch[] = [];
  const skipReasons: string[] = [];
  const usedClassNames = new Set<string>();
  const claimedNamedDeclarations = new Set<WrappableFunction>();

  for (const match of rawMatches) {
    const { className, fn } = match;

    if (!isControllerAsIdiom(fn)) continue;

    if (hasScopePropertyAssignment(fn)) {
      skipReasons.push(`${className}: also has a $scope property assignment — handled by pattern #1, not double-counted here`);
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

    // Claimed only now — after every other check has already decided
    // this candidate would otherwise be transformed — not the moment a
    // named-declaration match is seen. Claiming eagerly meant a second
    // registration sharing a function that was *never* going to be a
    // real hit (e.g. no controllerAs idiom present at all) still got a
    // misleading "already targets the same function declaration"
    // ambiguity warning instead of silently not matching, same as any
    // other non-candidate. Found by adversarial review, confirmed by
    // constructing exactly that file and observing the wrong reason
    // surface in `CodemodResult`'s warnings.
    if (match.isNamedDeclaration) {
      if (claimedNamedDeclarations.has(fn)) {
        skipReasons.push(
          `${className}: another registration in this file already targets the same function declaration for deletion — ambiguous, not safely transformable`
        );
        continue;
      }
      claimedNamedDeclarations.add(fn);
    }

    usedClassNames.add(className);
    candidates.push(match);
  }

  if (candidates.length === 0) {
    return {
      matched: false,
      reason: buildNoMatchReason(
        skipReasons,
        nestingConflictClassNames,
        'no bare-function controller using the controllerAs (this/vm) idiom found'
      ),
    };
  }

  const insertions: { pos: number; text: string }[] = [];
  const replacements: PositionEdit[] = [];

  for (const candidate of candidates) {
    const classText = buildClassText(candidate.className, constructorParamsText(candidate.fn), functionBodyText(candidate.fn));
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
