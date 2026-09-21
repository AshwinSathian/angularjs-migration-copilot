import { Node, Project, type PropertyAccessExpression } from 'ts-morph';
import { arrayDiArityMismatchReason, extractDependencyNames, forEachPropertyAccessCall } from '../inventory/ast-helpers.js';
import {
  applyEdits,
  buildClassText,
  constructorParamsText,
  findInjectAssignmentStatements,
  findNestedDeletionConflicts,
  functionBodyText,
  groupInsertionsByPosition,
  hasExistingTopLevelBinding,
  hasOtherReferences,
  isSimpleParameter,
  isValidClassName,
  nearestInsertionPointStart,
  resolveNamedFunctionDeclaration,
  type NestingCheckItem,
  type PositionEdit,
  type WrappableFunction,
} from './class-wrapping.js';
import type { CodemodResult } from './types.js';

/**
 * Pattern #3 (docs/product-spec.md §6.3) is scoped to `.controller`,
 * `.service`, and `.factory` — the three registration methods whose
 * second argument is directly a function that can become a class
 * constructor. `.directive`/`.component` nest their controller inside a
 * config object (pattern #4's job), `.provider` has `$get` semantics
 * beyond a plain constructor, and `.filter`/`.value`/`.constant` don't fit
 * this shape at all. Scoping decision recorded in docs/decisions.md
 * (ADR-024).
 */
const TRANSFORMABLE_KINDS = new Set(['controller', 'service', 'factory']);

interface RawMatch {
  readonly className: string;
  readonly fn: Node | undefined;
  readonly sortKey: number;
  readonly topStmtStart: number;
  readonly arrayStart: number;
  readonly arrayEnd: number;
}

interface Candidate {
  readonly className: string;
  readonly fn: WrappableFunction;
  readonly topStmtStart: number;
  readonly arrayStart: number;
  readonly arrayEnd: number;
  /**
   * Set when the array's last element was an identifier resolving to a
   * separately-declared `function <name>(...) {...}` (the same
   * `.controller('X', X)`-style named-reference shape patterns #1/#2
   * already handle for bare-function DI — ADR-030) rather than an inline
   * function/arrow literal. The original declaration (and any `$inject`
   * annotations for it) must be deleted alongside inserting the class, or
   * it's left behind as dead — and, if its own name happens to equal the
   * registration name, colliding — code.
   */
  readonly namedDecl?: {
    readonly declStart: number;
    readonly declEnd: number;
    readonly injectStatements: readonly Node[];
  };
}

export function transformArrayStyleDiToConstructor(sourceText: string): CodemodResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/app.js', sourceText);

  // Collect every candidate call first, without validating — traversal
  // order for a chained `.controller(...).controller(...)` visits the
  // outermost (last-in-source) call first (ast-helpers.ts's documented
  // quirk), so validating as matches are found would let two
  // same-named registrations inside one chain "collide" in the wrong
  // (reversed) order. Sorting by each call's own method-name-token
  // position — not the call expression's start, which is identical for
  // every link in a chain — restores true source order before any
  // decision (which one is the "duplicate") gets made.
  const rawMatches: RawMatch[] = [];

  forEachPropertyAccessCall(project, (call, expression: PropertyAccessExpression) => {
    const methodName = expression.getName();
    if (!TRANSFORMABLE_KINDS.has(methodName)) return;

    const [nameArg, definitionArg] = call.getArguments();
    if (!nameArg || !Node.isStringLiteral(nameArg)) return;
    if (!definitionArg || !Node.isArrayLiteralExpression(definitionArg)) return;

    rawMatches.push({
      className: nameArg.getLiteralText(),
      fn: definitionArg.getElements().at(-1),
      sortKey: expression.getNameNode().getStart(),
      topStmtStart: nearestInsertionPointStart(call),
      arrayStart: definitionArg.getStart(),
      arrayEnd: definitionArg.getEnd(),
    });
  });

  rawMatches.sort((a, b) => a.sortKey - b.sortKey);

  // Resolved but not yet deduped by name against sibling candidates — that
  // check is deferred to after nesting-conflict filtering below (see the
  // comment there for why: claiming a name here, before a nesting
  // conflict can reject the candidate that claimed it, would wrongly
  // block an unrelated, otherwise-valid registration later in the file
  // from using that same name once it's actually free again).
  const resolved: Candidate[] = [];
  const skipReasons: string[] = [];

  for (const match of rawMatches) {
    const { className, fn: element } = match;

    // The array's last element is either an inline function/arrow literal,
    // or (the same named-reference idiom ADR-030 found dominant for
    // bare-function `.controller('X', X)` registrations — untested and
    // unfixed here until now) an identifier resolving to a separately-
    // declared `function X(...) {...}`. `resolveNamedFunctionDeclaration`
    // and `hasOtherReferences` are the same real-symbol-binding checks
    // patterns #1/#2 already rely on, reused rather than re-derived.
    let resolvedFn: WrappableFunction | undefined;
    let namedDecl: Candidate['namedDecl'];

    if (element && (Node.isFunctionExpression(element) || Node.isArrowFunction(element))) {
      resolvedFn = element;
    } else if (element && Node.isIdentifier(element)) {
      // Unlike `collectBareFunctionControllerMatches`'s bare-function
      // path, this branch doesn't require `namedFn.getName() === className`
      // — deliberately, not an oversight. That check exists there because
      // the call site keeps referencing the function by its own original
      // identifier (`.controller('X', X)`), so a name mismatch could leave
      // a dangling reference once the declaration is deleted. Here the
      // *entire array* (`arrayStart`..`arrayEnd`, including this
      // identifier) is always replaced by `className` below, so the
      // function's own original name never survives into the output
      // regardless of whether it matches the registration string.
      const namedFn = resolveNamedFunctionDeclaration(element);
      if (namedFn) {
        const injectAssignments = findInjectAssignmentStatements(sourceFile, namedFn);
        const injectIdentifiers = injectAssignments.map((a) => a.identifier);
        if (hasOtherReferences(namedFn, element, injectIdentifiers)) {
          skipReasons.push(
            `${className}: array's last element references a function used elsewhere in the file — ambiguous, not safely transformable`
          );
          continue;
        }
        resolvedFn = namedFn;
        namedDecl = {
          declStart: namedFn.getStart(true),
          declEnd: namedFn.getEnd(),
          injectStatements: injectAssignments.map((a) => a.statement),
        };
      }
    }

    if (!resolvedFn) {
      skipReasons.push(`${className}: array's last element is not a function — not safely transformable`);
      continue;
    }

    if (!isValidClassName(className)) {
      skipReasons.push(`${className}: not a valid class identifier`);
      continue;
    }

    // Only a pre-existing binding *already in the file* is checked here —
    // a collision with a sibling pattern-#3 candidate is checked later,
    // after nesting-conflict filtering (see below). A named declaration's
    // own pre-existing binding isn't a real collision either way — it's
    // the transform's own target, about to be deleted.
    if (hasExistingTopLevelBinding(sourceFile, className, namedDecl ? resolvedFn : undefined)) {
      skipReasons.push(`${className}: duplicate registration name in this file — ambiguous which one to keep, not safely transformable`);
      continue;
    }

    const definitionArg = element?.getParent();
    if (!definitionArg || !Node.isArrayLiteralExpression(definitionArg)) continue;
    const actualDependencies = extractDependencyNames(definitionArg);
    const paramCount = resolvedFn.getParameters().length;
    const arityReason = arrayDiArityMismatchReason(actualDependencies, paramCount);
    if (arityReason) {
      skipReasons.push(`${className}: ${arityReason}`);
      continue;
    }

    if (!resolvedFn.getParameters().every(isSimpleParameter)) {
      skipReasons.push(
        `${className}: has a destructured, default-valued, or rest parameter — not safely transformable`
      );
      continue;
    }

    resolved.push({
      className,
      fn: resolvedFn,
      topStmtStart: match.topStmtStart,
      arrayStart: match.arrayStart,
      arrayEnd: match.arrayEnd,
      namedDecl,
    });
  }

  // A candidate's own function body — whether a separately-declared
  // named function being deleted, or an inline literal whose entire span
  // (including its body) gets replaced by the bare class name — can
  // contain a second, unrelated registration's call as one of its
  // statements. `hasOtherReferences` only rules out an *other* reference
  // to the same named function, not a sibling candidate's edit positions
  // sitting nested inside this candidate's own deleted/replaced range —
  // and an inline literal's replaced range is just as much a conflict
  // source as a named declaration's deletion range, even though nothing
  // is textually *removed* from the file for the inline case. `applyEdits`
  // assumes edits are disjoint; a nested range breaks that assumption and
  // corrupts the sibling's edits while still reporting success. See
  // `findNestedDeletionConflicts`'s own docstring for the full repro.
  const nestingItems: NestingCheckItem[] = resolved.map((c) => ({
    protectedPositions: [
      c.topStmtStart,
      c.arrayStart,
      c.arrayEnd,
      ...(c.namedDecl
        ? [c.namedDecl.declStart, c.namedDecl.declEnd, ...c.namedDecl.injectStatements.flatMap((s) => [s.getStart(true), s.getEnd()])]
        : []),
    ],
    deletedRanges: [
      { start: c.arrayStart, end: c.arrayEnd },
      ...(c.namedDecl
        ? [
            { start: c.namedDecl.declStart, end: c.namedDecl.declEnd },
            ...c.namedDecl.injectStatements.map((s) => ({ start: s.getStart(true), end: s.getEnd() })),
          ]
        : []),
    ],
  }));
  const conflictingIndices = findNestedDeletionConflicts(nestingItems);
  const nonConflicting = resolved.filter((c, i) => {
    if (!conflictingIndices.has(i)) return true;
    skipReasons.push(
      `${c.className}: deleting the referenced function would also corrupt another registration nested inside it — not safely transformable`
    );
    return false;
  });

  // Name deduplication runs last, over only the candidates that survived
  // every other rejection — a candidate that was going to be dropped for
  // an unrelated reason (nesting conflict, above) must never claim a name
  // and block a later, otherwise-valid registration from using it. Found
  // by adversarial review, confirmed by actually constructing a file
  // where an unrelated `Foo` was wrongly rejected as a "duplicate" of a
  // different `Foo` that was itself already being dropped for nesting.
  const usedClassNames = new Set<string>();
  const survivingCandidates: Candidate[] = [];
  for (const c of nonConflicting) {
    if (usedClassNames.has(c.className)) {
      skipReasons.push(`${c.className}: duplicate registration name in this file — ambiguous which one to keep, not safely transformable`);
      continue;
    }
    usedClassNames.add(c.className);
    survivingCandidates.push(c);
  }

  if (survivingCandidates.length === 0) {
    return {
      matched: false,
      reason: skipReasons.length > 0
        ? skipReasons.join('; ')
        : 'no array-style DI controller/service/factory registration found',
    };
  }

  // Array→identifier replacements are always at distinct spans, one per
  // candidate. Class insertions can share a position — e.g. three chained
  // calls all landing in the same enclosing statement.
  const insertions: { pos: number; text: string }[] = [];
  const replacements: PositionEdit[] = [];

  for (const candidate of survivingCandidates) {
    insertions.push({
      pos: candidate.topStmtStart,
      text: buildClassText(candidate.className, constructorParamsText(candidate.fn), functionBodyText(candidate.fn)),
    });
    replacements.push({
      pos: candidate.arrayStart,
      end: candidate.arrayEnd,
      replacement: candidate.className,
    });
    if (candidate.namedDecl) {
      replacements.push({ pos: candidate.namedDecl.declStart, end: candidate.namedDecl.declEnd, replacement: '' });
      for (const stmt of candidate.namedDecl.injectStatements) {
        replacements.push({ pos: stmt.getStart(true), end: stmt.getEnd(), replacement: '' });
      }
    }
  }

  const output = applyEdits(sourceFile.getFullText(), [
    ...groupInsertionsByPosition(insertions),
    ...replacements,
  ]);

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
