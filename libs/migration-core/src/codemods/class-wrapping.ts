import { Node, SyntaxKind, type ArrowFunction, type BinaryExpression, type CallExpression, type FunctionDeclaration, type FunctionExpression, type Identifier, type Project, type PropertyAccessExpression, type SourceFile } from 'ts-morph';
import { forEachPropertyAccessCall } from '../inventory/ast-helpers.js';

/**
 * Shared plumbing for every codemod pattern that wraps an AngularJS
 * function-based registration into an ES6/TS class — pattern #3 (array-
 * style DI → constructor injection) was the first to need this, pattern
 * #1 ($scope.x = y → class property) reuses it rather than re-deriving
 * it, and any future pattern that produces a class should too.
 */

export type WrappableFunction = FunctionExpression | ArrowFunction | FunctionDeclaration;

export const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** ECMA-262 reserved words — `VALID_IDENTIFIER` alone accepts these (they're syntactically identifier-shaped) but none is legal as a class name. */
export const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await',
  'implements', 'package', 'protected', 'interface', 'private', 'public',
]);

export function isValidClassName(name: string): boolean {
  return VALID_IDENTIFIER.test(name) && !RESERVED_WORDS.has(name);
}

/** `=` only, not `+=`/`-=`/etc. — shared by every pattern that needs to tell a plain assignment apart from a compound one. */
export function isPlainAssignment(node: BinaryExpression): boolean {
  return node.getOperatorToken().getKind() === SyntaxKind.EqualsToken;
}

/**
 * True if `identifier` resolves — via real symbol binding, not text
 * matching — to exactly one declaration, and that declaration is one of
 * `targets` (e.g. pattern #1 checking `$scope` resolves to the
 * controller's own parameter — a one-element array; pattern #2 checking
 * an alias resolves to one of its valid `var x = this` declarations — a
 * multi-element array). Requiring exactly one declaration overall is
 * correct here — unlike `resolveNamedFunctionDeclaration`'s deliberately
 * looser, type-filtered check, which exists specifically because it
 * *can't* require that (see that function's own docstring for why).
 *
 * An ES6 object-literal shorthand property (`{ layoutPaths }`, sugar for
 * `{ layoutPaths: layoutPaths }`) is a special case: `identifier.getSymbol()`
 * on its one identifier resolves to the `ShorthandPropertyAssignment`
 * itself — the object literal's own property symbol — not the outer
 * variable the shorthand reads, so a plain `getSymbol()` call silently
 * fails to match here even though the identifier is a real reference to
 * `targets`. Confirmed by adversarial review, then by direct execution
 * (a probe script showing `getSymbol()`'s declarations for a shorthand
 * identifier is `[ShorthandPropertyAssignment]`, never the referenced
 * parameter) — not assumed from the API surface. `getValueSymbol()`
 * (ts-morph's wrapper for `TypeChecker#getShorthandAssignmentValueSymbol`)
 * is the correct resolution for this one shape.
 */
export function resolvesUniquelyTo(identifier: Node, targets: readonly Node[]): boolean {
  if (!Node.isIdentifier(identifier)) return false;
  const parent = identifier.getParent();
  const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : identifier.getSymbol();
  const declarations = symbol?.getDeclarations() ?? [];
  return declarations.length === 1 && targets.includes(declarations[0]);
}

/**
 * The nearest point a class declaration can be inserted without being
 * hoisted out of an enclosing scope it needs to stay inside — stops at
 * the first ancestor whose parent is the `SourceFile` itself *or* a
 * `Block`. Without the `Block` case, a registration inside the extremely
 * common `(function () { ... })()` IIFE wrapper (62 of 66
 * registration-bearing files across this project's own vendored
 * fixtures use it) would have its class hoisted above the IIFE entirely,
 * severing any reference the body makes to a closure variable declared
 * inside that wrapper.
 */
export function nearestInsertionPointStart(node: Node): number {
  let current = node;
  for (;;) {
    const parent = current.getParent();
    if (!parent || Node.isSourceFile(parent) || Node.isBlock(parent)) return current.getStart();
    current = parent;
  }
}

/**
 * `ignore` excludes one specific declaration from counting as a collision
 * — needed when the candidate itself *is* an existing top-level function
 * declaration (the `.controller('X', X)` named-reference idiom, see
 * `collectBareFunctionControllerMatches`): replacing that declaration
 * in place with a same-named class isn't a real collision, it's the
 * transform's own target.
 */
export function hasExistingTopLevelBinding(sourceFile: SourceFile, name: string, ignore?: Node): boolean {
  const existing = sourceFile.getFunction(name) ?? sourceFile.getClass(name) ?? sourceFile.getVariableDeclaration(name);
  return existing !== undefined && existing !== ignore;
}

/**
 * A parameter that can safely carry into a constructor signature as
 * `private <name>: any` — a plain identifier, no default value, no rest.
 * A destructured (`{ $scope }`) or default-valued (`$scope = null`)
 * parameter can't be represented that way without either producing
 * invalid TypeScript (a binding pattern can't be a parameter property) or
 * silently dropping the default — so a function with any such parameter
 * is skipped rather than mistranslated.
 */
export function isSimpleParameter(param: { getNameNode: () => Node; hasInitializer: () => boolean; isRestParameter: () => boolean }): boolean {
  return Node.isIdentifier(param.getNameNode()) && !param.hasInitializer() && !param.isRestParameter();
}

/**
 * Enforces the `isSimpleParameter` invariant itself, at the one place
 * that actually needs it to hold, rather than relying on every caller to
 * remember to check first. A caller should still check `isSimpleParameter`
 * up front to produce a proper, specific skip reason instead of an
 * exception — this is the safety net for the case that gets forgotten,
 * not the primary path.
 */
export function constructorParamsText(fn: WrappableFunction): string {
  const params = fn.getParameters();
  const nonSimple = params.find((p) => !isSimpleParameter(p));
  if (nonSimple) {
    throw new Error(
      `constructorParamsText: parameter "${nonSimple.getName()}" is destructured, default-valued, or rest — callers must check isSimpleParameter before calling`
    );
  }
  return params.map((p) => `private ${p.getName()}: any`).join(', ');
}

/**
 * True if `node` sits inside a nested function or accessor boundary
 * (relative to `outerFn`, exclusive of `outerFn` itself) whose own
 * `this` is dynamically bound rather than inherited lexically from
 * `outerFn` — a plain function expression/declaration, a class method,
 * or a get/set accessor all rebind `this` based on how they're invoked,
 * not where they're written. An arrow function is the one exception: it
 * never rebinds `this`, so nesting inside one (without crossing another,
 * non-arrow boundary first) is safe. Any codemod pattern that rewrites a
 * free reference inside a wrapped function's body to `this.<x>` needs
 * this check — pattern #1 ($scope.x = y) was the first, but the hazard
 * isn't specific to it.
 */
export function isInsideThisRebindingBoundary(node: Node, outerFn: WrappableFunction): boolean {
  let current: Node = node;
  for (;;) {
    const parent = current.getParent();
    if (!parent || parent === outerFn) return false;
    if (
      Node.isFunctionExpression(parent) ||
      Node.isFunctionDeclaration(parent) ||
      Node.isMethodDeclaration(parent) ||
      Node.isGetAccessorDeclaration(parent) ||
      Node.isSetAccessorDeclaration(parent)
    ) {
      return true;
    }
    current = parent;
  }
}

/**
 * An arrow function's concise (non-block) body is wrapped in
 * `{ return ...; }` since a constructor body must be a block.
 * `internalEdits` (positions in the *full source file*'s coordinates, as
 * every other position this module deals in) let a caller rewrite text
 * inside the body — e.g. pattern #1 replacing a `$scope` reference with
 * `this` — without having to separately account for the concise-body
 * wrapper prefix shifting every offset.
 */
export function functionBodyText(fn: WrappableFunction, internalEdits: readonly PositionEdit[] = []): string {
  const body = fn.getBody();
  if (!body) {
    throw new Error('functionBodyText: function has no body — should be unreachable for a real parsed registration');
  }
  const bodyStart = body.getStart();
  const rawText = body.getText();
  const editedText = internalEdits.length === 0
    ? rawText
    : applyEdits(
        rawText,
        internalEdits.map((e) => ({ pos: e.pos - bodyStart, end: e.end - bodyStart, replacement: e.replacement }))
      );

  return Node.isBlock(body) ? editedText : `{ return ${editedText}; }`;
}

export function buildClassText(className: string, params: string, bodyText: string): string {
  return `class ${className} {\n  constructor(${params}) ${bodyText}\n}`;
}

/**
 * The name-validity/duplicate/simple-parameter tail every class-wrapping
 * pattern's candidate loop ends with, in this order — identical across
 * patterns #1 and #3, and now #2, which is what confirms (per the
 * "revisit once a third pattern shows the actual shape" note in
 * docs/decisions.md ADR-028) that this part, at least, generalizes cleanly
 * rather than only appearing to. What differs between patterns (how a
 * candidate is detected in the first place, and what — if anything — gets
 * rewritten inside its body) does not generalize as cleanly and is
 * deliberately left to each pattern's own file rather than forced into a
 * one-size-fits-all pipeline here.
 *
 * Returns a skip reason, or `undefined` if the candidate may proceed. On
 * `undefined`, the caller is responsible for adding `className` to
 * `usedClassNames` itself — kept a separate step so a pattern that
 * rejects an otherwise-valid candidate for a reason outside this check
 * (e.g. an unrelated conflicting idiom) never pollutes the used-name set.
 */
export function classWrappingSkipReason(
  className: string,
  fn: WrappableFunction,
  sourceFile: SourceFile,
  usedClassNames: ReadonlySet<string>,
  ignoreOwnBinding?: Node
): string | undefined {
  if (!isValidClassName(className)) return `${className}: not a valid class identifier`;

  if (usedClassNames.has(className) || hasExistingTopLevelBinding(sourceFile, className, ignoreOwnBinding)) {
    return `${className}: duplicate registration name in this file — ambiguous which one to keep, not safely transformable`;
  }

  if (!fn.getParameters().every(isSimpleParameter)) {
    return `${className}: has a destructured, default-valued, or rest parameter — not safely transformable`;
  }

  return undefined;
}

interface BareFunctionControllerMatchBase {
  readonly className: string;
  readonly fn: WrappableFunction;
  readonly sortKey: number;
  readonly topStmtStart: number;
}

/**
 * A discriminated union, not two independently-optional fields — `fn`'s
 * shape is either an inline function literal, or (the dominant
 * real-world shape, see the branch's own docstring) a `.controller('X',
 * X)` named reference, which always carries its own `$inject`
 * annotations (there can be zero, one, or several — see
 * `findInjectAssignmentStatements`), never the other way around. This is
 * the third occurrence of the same `isNamedDeclaration`/`injectStatement`
 * pairing (this type, plus each pattern's own `Candidate` interface) —
 * per this project's own "generalize once a third occurrence confirms
 * the shape" precedent (ADR-028/029), that's the signal to make the
 * illegal state (a non-named match carrying inject statements)
 * unrepresentable rather than deferring again.
 */
export type BareFunctionControllerMatch =
  | (BareFunctionControllerMatchBase & {
      /** An inline function literal passed directly as the call's second argument. */
      readonly isNamedDeclaration: false;
    })
  | (BareFunctionControllerMatchBase & {
      /**
       * `fn` is the separately-declared `function X(...) {...}` the
       * call's identifier argument resolves to. The dominant real-world
       * shape (66 of 91 `.controller` calls across this project's own
       * vendored `blur-admin`/`CoreUI-AngularJS` fixtures use it, 0 use
       * an inline literal) — found only once pattern #2 was actually
       * run against real fixture files and matched nothing, not assumed
       * from the inline-literal shape patterns #1/#3 originally
       * handled. See docs/decisions.md ADR-030. Determines how
       * `buildClassSpliceEdits` splices the class in: a named
       * declaration's own `function` statement is deleted and the class
       * is inserted before the call instead (see that function's
       * docstring for why in-place replacement is wrong), an inline
       * literal is wrapped via insertion + call-arg replacement.
       */
      readonly isNamedDeclaration: true;
      /**
       * Every `<name>.$inject = [...]` ng-annotate statement whose
       * `<name>` resolves to `fn` (possibly empty). Deleted alongside
       * `fn` by `buildClassSpliceEdits`: the DI information they carry
       * is now redundant with the emitted constructor's own parameters,
       * and left in place each is a TypeScript error (`Property
       * '$inject' does not exist on type 'typeof X'`) once `X` is a
       * class instead of a function. See ADR-030/ADR-032 — an earlier
       * version of this field only ever captured the *first* such
       * statement, silently leaving every other one in place.
       */
      readonly injectStatements: readonly Node[];
    });

/**
 * Resolves `identifier` to a `function <name>(...) {...}` declaration via
 * real symbol binding, not text matching — the same rigor
 * `resolvesUniquelyTo` already applies elsewhere in these codemods.
 * Returns `undefined` for anything else a bare-function `.controller` call's
 * second argument, or an array-style-DI registration's last array element
 * (pattern #3), could be an identifier reference to (an imported binding, a
 * `var x = function () {}`, a class, ...) — this codemod only recognizes
 * the confirmed-dominant `function` declaration shape, not every way a
 * name could resolve to something function-shaped.
 *
 * Filters to the *function* declarations among the symbol's declarations
 * rather than requiring exactly one declaration overall — TypeScript's JS
 * binder records the equally-common `Ctrl.$inject = ['$scope'];`
 * ng-annotate idiom as a second, non-function "declaration" of the same
 * symbol (an expando-property assignment target), which an
 * exactly-one-declaration check would have rejected as ambiguous even
 * though there's exactly one real function to resolve to. Found by
 * actually running this against `CoreUI-AngularJS`, which uses this
 * exact idiom throughout and produced zero matches before this fix —
 * not assumed from reading the resolver logic. See ADR-030.
 */
export function resolveNamedFunctionDeclaration(identifier: Node): FunctionDeclaration | undefined {
  if (!Node.isIdentifier(identifier)) return undefined;
  const declarations = identifier.getSymbol()?.getDeclarations() ?? [];
  const functionDeclarations = declarations.filter(Node.isFunctionDeclaration);
  return functionDeclarations.length === 1 ? functionDeclarations[0] : undefined;
}

/**
 * Every `<name>.$inject = [...]` statement in `sourceFile` whose `<name>`
 * resolves — via real symbol binding, not text matching — to `fn`,
 * paired with the identifier node itself (so callers can exclude it from
 * an "are there other references to `fn`" check — see
 * `collectBareFunctionControllerMatches`). Searches the whole file, not
 * just top-level statements: the assignment can sit inside the same
 * enclosing IIFE `fn` does.
 *
 * Two real bugs here, both found by adversarial review, both confirmed
 * by actually running the codemod against a constructed file, not
 * assumed from reading the traversal: (1) an earlier version returned
 * the *first* match and stopped, silently leaving any second `$inject`
 * statement for the same function untouched — a real `TS2339` in the
 * output. (2) it accepted the assignment's *nearest* enclosing
 * `ExpressionStatement` ancestor regardless of how deeply nested the
 * assignment itself was — `getFirstAncestorByKind` walks straight past
 * a `ParenthesizedExpression`/`VariableDeclaration` wrapper, so
 * `var deps = (X.$inject = [...]);` resolved to the *enclosing var
 * statement*, and deleting that (rather than refusing to touch it)
 * deleted unrelated code around it — up to and including an entire IIFE
 * when the assignment sat inside one, confirmed with a constructed
 * marker string that visibly survived corruption. A single-statement
 * `if` body without braces (`if (x) X.$inject = [...];`) has the same
 * hazard from the other direction: the assignment's *direct* parent
 * really is an `ExpressionStatement`, but deleting it leaves a dangling
 * `if (x)` with no body. Both are now rejected by requiring the
 * assignment's direct parent to be an `ExpressionStatement` *and* that
 * statement's own parent to be a `Block` or `SourceFile` — i.e. a
 * genuine standalone statement, not a sub-expression of something else
 * and not the single-statement body of a control-flow construct. A
 * non-conforming `$inject` assignment is simply left untouched rather
 * than guessed at, same "skip when ambiguous" philosophy as everywhere
 * else in this module.
 */
export function findInjectAssignmentStatements(sourceFile: SourceFile, fn: FunctionDeclaration): { statement: Node; identifier: Identifier }[] {
  const results: { statement: Node; identifier: Identifier }[] = [];
  for (const expr of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (!isPlainAssignment(expr)) continue;
    const left = expr.getLeft();
    if (!Node.isPropertyAccessExpression(left) || left.getName() !== '$inject') continue;
    const object = left.getExpression();
    if (!Node.isIdentifier(object)) continue;
    const declarations = object.getSymbol()?.getDeclarations() ?? [];
    if (!declarations.includes(fn)) continue;

    const statement = expr.getParent();
    if (!statement || !Node.isExpressionStatement(statement)) continue;
    const statementParent = statement.getParent();
    if (!statementParent || (!Node.isBlock(statementParent) && !Node.isSourceFile(statementParent))) continue;

    results.push({ statement, identifier: object });
  }
  return results;
}

/**
 * True if `fn` has any reference other than `expectedReference` (the
 * identifier that resolved to it — a bare-function `.controller` call's
 * own argument, or an array-style-DI registration's last array element)
 * and the identifiers in `injectIdentifiers` (already accounted for —
 * they're deleted alongside `fn`, so their presence doesn't threaten
 * declare-before-use safety). A caller that inserts the replacement class
 * only before *this* reference's own enclosing statement can only
 * guarantee declare-before-use for that one reference — if some other
 * code (a `.prototype` extension, a second registration under another
 * name, ...) references the same function earlier in the file, deleting
 * the function and inserting the class later can still leave that other
 * reference before the class's new declaration point, resurfacing the
 * exact `TS2449` bug this whole named-declaration path exists to avoid.
 * Confirmed by constructing a `X.prototype.helper = ...;` line before the
 * registration and typechecking the (pre-this-check) output. Rather than
 * compute a correct-for-every-reference insertion point, an
 * unaccounted-for reference is simply grounds to skip the candidate —
 * same "skip when ambiguous" philosophy as everywhere else in this
 * module, and it keeps every such caller's "before *the* call" strategy
 * honestly true for every candidate it actually processes.
 *
 * Also rejects the degenerate case where `expectedReference` itself sits
 * nested inside `fn`'s own body — a registration call written inside the
 * very function it registers (`function X($scope) { ...; angular.module
 * ('app').controller('X', X); }`). Found by adversarial review, confirmed
 * by actually running both this codemod's array-style-DI caller and the
 * already-merged bare-function `.controller('X', X)` caller
 * (`scope-assignment-to-class-property.ts`) against a constructed repro:
 * `expectedReference` is the *only* reference (so the check above alone
 * accepts it), but the caller's insertion point — the reference's own
 * enclosing top-level statement — falls inside `fn`'s deleted range,
 * since that statement is itself nested inside `fn`. `applyEdits` then
 * splices the insertion and the deletion as if they were disjoint, which
 * they aren't, producing visibly corrupted, still-`matched: true` output
 * in both callers.
 */
export function hasOtherReferences(fn: FunctionDeclaration, expectedReference: Node, injectIdentifiers: readonly Identifier[]): boolean {
  const nameNode = fn.getNameNode();
  if (!nameNode) return false;
  if (expectedReference.getStart() >= fn.getStart(true) && expectedReference.getEnd() <= fn.getEnd()) return true;
  // findReferencesAsNodes() includes the declaration's own name node
  // among its results (confirmed empirically, not assumed from the API
  // docs) — that's not a "reference" in the sense this check cares
  // about, it's the declaration itself, so it's excluded alongside the
  // call's own argument and any $inject annotation's identifier.
  return nameNode.findReferencesAsNodes().some(
    (ref) => ref !== nameNode && ref !== expectedReference && !injectIdentifiers.includes(ref as Identifier)
  );
}

/**
 * One item's protected positions (every edit position it needs, both
 * insertion and replacement/deletion) plus every `[start, end)` range its
 * own edits remove or replace outright — a named declaration's deletion
 * range, `$inject` statement ranges, *and* an inline function literal's
 * own replaced span (the whole literal, body included, is replaced by
 * the bare class name — just as much a "this text is gone" edit as a
 * named declaration's deletion, even though nothing is textually
 * deleted from the file elsewhere).
 */
export interface NestingCheckItem {
  readonly protectedPositions: readonly number[];
  readonly deletedRanges: readonly { readonly start: number; readonly end: number }[];
}

/**
 * Indices (into `items`) of every item with a `deletedRanges` entry that
 * strictly contains another item's protected position — a structural
 * conflict `hasOtherReferences`'s per-candidate, self-only check cannot
 * see, since it only knows about one candidate's own function at a time,
 * not the full accepted set.
 *
 * `applyEdits` assumes every edit's `[pos, end)` is either disjoint from
 * every other edit or exactly equal (the same-position insertion case
 * `groupInsertionsByPosition` already merges) — never one *containing*
 * another. A candidate's own deleted/replaced range can violate that
 * assumption even when `hasOtherReferences` correctly finds no *other*
 * reference to that candidate's own function: nothing stops a sibling
 * candidate's registration call from being written *inside* that range —
 * inside a named declaration's body (ADR-034/035) or, just as corrupting,
 * inside an inline function literal's own body, which gets replaced by
 * the bare class name wholesale. Either way, deleting/replacing the
 * outer range also destroys the text the sibling's own edits are
 * computed against, and `applyEdits` — which slices using each edit's
 * *original*-text offsets — corrupts the output while still reporting
 * `matched: true`. Confirmed by actually constructing both shapes (an
 * outer named-declaration controller and, found by a later review round,
 * an outer *inline-literal* controller, each with a second, unrelated
 * `.controller(...)` call nested in its body) and running them through
 * both the array-style-DI codemod and the already-merged bare-function
 * `.controller(...)` one — all four combinations produced visibly
 * garbled, brace-unbalanced output before this check covered inline
 * literals too. The fix: reject the *outer* (containing) candidate
 * entirely rather than try to compute a correct-for-every-nested-sibling
 * edit order — same "skip when ambiguous" philosophy as everywhere else
 * in this module. The nested sibling itself is unaffected and still
 * transforms normally, since the outer candidate's own transform is
 * skipped and its source text is left exactly as written.
 */
export function findNestedDeletionConflicts(items: readonly NestingCheckItem[]): ReadonlySet<number> {
  const conflicting = new Set<number>();
  items.forEach((item, i) => {
    const hasConflict = item.deletedRanges.some((range) =>
      items.some((other, j) => i !== j && other.protectedPositions.some((p) => p > range.start && p < range.end))
    );
    if (hasConflict) conflicting.add(i);
  });
  return conflicting;
}

/**
 * Collects every `.controller(name, ...)` registration across `project`
 * whose definition is bare-function DI — either an inline function
 * literal, or (the dominant real-world shape, see
 * `BareFunctionControllerMatch#isNamedDeclaration`) an identifier
 * resolving to a separately-declared `function` — sorted into true
 * source order. Array-style DI is pattern #3's shape, not this one.
 * Shared between pattern #1 ($scope.x = y) and pattern #2 (controllerAs),
 * which both key off this exact same call shape and differ only in what
 * they look for inside the function body.
 *
 * Collected unsorted first and sorted after, same reason as every other
 * class-wrapping pattern: a chained `.controller(a).controller(b)` visits
 * its outermost (last-in-source) call first during traversal, so sorting
 * by each call's own method-name-token position afterward restores true
 * source order before any candidate decision is made.
 *
 * `nestingConflictClassNames` is returned alongside `matches`, not
 * silently dropped, even though a conflicting match is still excluded
 * from `matches` itself (same silent-exclusion precedent as every other
 * case in this function where resolving a match turns out to be
 * ambiguous). Without it, a caller whose *only* real candidate happened
 * to be nesting-conflicted had no way to tell "the idiom wasn't there"
 * apart from "the idiom was there but got rejected for an unrelated
 * reason," and fell back to the generic "not found" reason even though
 * something real was found — a misleading-reason gap a later adversarial
 * review round caught, not a hypothetical.
 */
export function collectBareFunctionControllerMatches(project: Project): {
  readonly matches: readonly BareFunctionControllerMatch[];
  readonly nestingConflictClassNames: readonly string[];
} {
  const rawMatches: BareFunctionControllerMatch[] = [];

  forEachPropertyAccessCall(project, (call: CallExpression, expression: PropertyAccessExpression, sourceFile: SourceFile) => {
    if (expression.getName() !== 'controller') return;

    const [nameArg, definitionArg] = call.getArguments();
    if (!nameArg || !Node.isStringLiteral(nameArg)) return;
    if (!definitionArg) return;

    const sortKey = expression.getNameNode().getStart();
    const className = nameArg.getLiteralText();

    if (Node.isFunctionExpression(definitionArg) || Node.isArrowFunction(definitionArg)) {
      rawMatches.push({
        className,
        fn: definitionArg,
        sortKey,
        topStmtStart: nearestInsertionPointStart(call),
        isNamedDeclaration: false,
      });
      return;
    }

    // Only the confirmed-dominant `.controller('X', X)` shape — the
    // registration name and the referenced function's own name must
    // match. Without this, `.controller('A', X).controller('B', X)`
    // (a mismatched-name reference, not seen in any real fixture) would
    // resolve both to the same `function X`, and the surviving
    // candidate's call site would still read `X` after `X`'s own
    // declaration is deleted — an undefined-identifier bug, not just the
    // duplicate-target ambiguity the collect/validate loop's own
    // `claimedNamedDeclarations` dedup guards against.
    const namedFn = resolveNamedFunctionDeclaration(definitionArg);
    if (!namedFn || namedFn.getName() !== className) return;

    const injectAssignments = findInjectAssignmentStatements(sourceFile, namedFn);
    const injectIdentifiers = injectAssignments.map((a) => a.identifier);
    if (hasOtherReferences(namedFn, definitionArg, injectIdentifiers)) return;

    rawMatches.push({
      className,
      fn: namedFn,
      sortKey,
      topStmtStart: nearestInsertionPointStart(call),
      isNamedDeclaration: true,
      injectStatements: injectAssignments.map((a) => a.statement),
    });
  });

  const sorted = rawMatches.sort((a, b) => a.sortKey - b.sortKey);

  // Same silent-exclusion precedent as the `namedFn`/`hasOtherReferences`
  // checks above: a structurally-conflicting match (named-declaration or
  // inline-literal alike — see `findNestedDeletionConflicts`'s own
  // docstring for why an inline literal's replaced span is just as much
  // a conflict source) is treated as not safely recognized, not as a
  // recognized-but-skipped candidate — consistent with how this function
  // already handles every other case where resolving the shape turns out
  // to be ambiguous.
  const items: NestingCheckItem[] = sorted.map((m) => ({
    protectedPositions: m.isNamedDeclaration
      ? [m.topStmtStart, m.fn.getStart(true), m.fn.getEnd(), ...m.injectStatements.flatMap((s) => [s.getStart(true), s.getEnd()])]
      : [m.topStmtStart, m.fn.getStart(), m.fn.getEnd()],
    deletedRanges: m.isNamedDeclaration
      ? [
          { start: m.fn.getStart(true), end: m.fn.getEnd() },
          ...m.injectStatements.map((s) => ({ start: s.getStart(true), end: s.getEnd() })),
        ]
      : [{ start: m.fn.getStart(), end: m.fn.getEnd() }],
  }));
  const conflicting = findNestedDeletionConflicts(items);

  return {
    matches: sorted.filter((_, i) => !conflicting.has(i)),
    nestingConflictClassNames: sorted.filter((_, i) => conflicting.has(i)).map((m) => m.className),
  };
}

/**
 * Splices a candidate's class text into the output — the two shapes
 * `collectBareFunctionControllerMatches` can produce need different
 * edits:
 *
 * - An inline function literal is wrapped by inserting the class before
 *   the enclosing statement and replacing the literal itself with the
 *   bare class name (leaving `.controller('X', X)` valid-shaped).
 *
 * - A named declaration is **not** replaced in place. `function`
 *   declarations hoist, so `.controller('X', X)` calling `X` before its
 *   textual declaration — the dominant real-world ordering, confirmed in
 *   both this project's vendored fixtures — is valid in the original
 *   source. A `class` declaration does not hoist, so replacing the
 *   function with a same-named class at that same later position leaves
 *   the earlier `.controller('X', X)` reference using `X` before its
 *   declaration — a real compile error (`Class 'X' used before its
 *   declaration`), confirmed by actually typechecking the codemod's own
 *   output before this fix, not assumed. Instead: delete the original
 *   `function` statement (and every `$inject` annotation found for it —
 *   `BareFunctionControllerMatch#injectStatements`) and insert the class
 *   before the call's own enclosing statement (`topStmtStart`, the same
 *   IIFE-safe position the inline-literal path already uses). Combined
 *   with `hasOtherReferences`' refusal to match a candidate with any
 *   other reference to the same function, the class is then always
 *   declared before every reference to it that this codemod actually
 *   processes, regardless of where the original function happened to sit
 *   in the file.
 */
export function buildClassSpliceEdits(
  match: BareFunctionControllerMatch,
  classText: string
): { readonly insertion: { readonly pos: number; readonly text: string }; readonly replacements: readonly PositionEdit[] } {
  if (match.isNamedDeclaration) {
    const replacements: PositionEdit[] = [
      { pos: match.fn.getStart(true), end: match.fn.getEnd(), replacement: '' },
      ...match.injectStatements.map((stmt) => ({ pos: stmt.getStart(true), end: stmt.getEnd(), replacement: '' })),
    ];
    return { insertion: { pos: match.topStmtStart, text: classText }, replacements };
  }
  return {
    insertion: { pos: match.topStmtStart, text: classText },
    replacements: [{ pos: match.fn.getStart(), end: match.fn.getEnd(), replacement: match.className }],
  };
}

/**
 * The `matched: false` `reason` string for a pattern whose candidate loop
 * ended with nothing to transform — shared by both `collectBareFunctionControllerMatches`
 * callers (patterns #1/#2) so the fallback reason honestly distinguishes
 * "the idiom was never there" from "the idiom was there but every
 * instance got rejected," rather than always falling back to the same
 * generic "not found" message regardless of which is true. Found missing
 * by adversarial review: a file whose *only* real candidate was silently
 * dropped by `collectBareFunctionControllerMatches`'s own nesting-conflict
 * filter reported the generic reason, which is factually wrong — the
 * idiom genuinely was found, just rejected for an unrelated,
 * corruption-avoidance reason.
 */
export function buildNoMatchReason(
  skipReasons: readonly string[],
  nestingConflictClassNames: readonly string[],
  genericReason: string
): string {
  if (skipReasons.length > 0) return skipReasons.join('; ');
  if (nestingConflictClassNames.length > 0) {
    return nestingConflictClassNames
      .map((name) => `${name}: deleting/replacing it would also corrupt another registration nested inside it — not safely transformable`)
      .join('; ');
  }
  return genericReason;
}

export interface PositionEdit {
  readonly pos: number;
  readonly end: number;
  readonly replacement: string;
}

/** Sorts by position descending and splices — safe to call with edits computed against the *original*, unmodified text, regardless of how many there are or whether any share a position. */
export function applyEdits(sourceText: string, edits: readonly PositionEdit[]): string {
  let output = sourceText;
  for (const edit of [...edits].sort((a, b) => b.pos - a.pos)) {
    output = output.slice(0, edit.pos) + edit.replacement + output.slice(edit.end);
  }
  return output;
}

/**
 * Groups class insertions that land at the same position — e.g. three
 * chained `.controller(...).controller(...).controller(...)` calls all
 * living in one enclosing statement — and joins them in the order given,
 * which callers must already have sorted into true source order.
 * Splicing them in one at a time at an identical offset would otherwise
 * reverse their visual order.
 */
export function groupInsertionsByPosition(items: readonly { pos: number; text: string }[]): PositionEdit[] {
  const byPos = new Map<number, string[]>();
  for (const { pos, text } of items) {
    const texts = byPos.get(pos) ?? [];
    texts.push(text);
    byPos.set(pos, texts);
  }
  return [...byPos.entries()].map(([pos, texts]) => ({
    pos,
    end: pos,
    replacement: `${texts.join('\n\n')}\n\n`,
  }));
}
