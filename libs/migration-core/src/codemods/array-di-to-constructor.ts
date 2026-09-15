import { Node, Project, type PropertyAccessExpression } from 'ts-morph';
import { extractDependencyNames, forEachPropertyAccessCall } from '../inventory/ast-helpers.js';
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

  const candidates: Candidate[] = [];
  const skipReasons: string[] = [];
  const usedClassNames = new Set<string>();

  for (const match of rawMatches) {
    const { className, fn } = match;

    if (!fn || !(Node.isFunctionExpression(fn) || Node.isArrowFunction(fn))) {
      skipReasons.push(`${className}: array's last element is not a function — not safely transformable`);
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

    const definitionArg = fn.getParent();
    if (!definitionArg || !Node.isArrayLiteralExpression(definitionArg)) continue;
    const actualDependencies = extractDependencyNames(definitionArg);
    const paramCount = fn.getParameters().length;
    if (actualDependencies.length !== paramCount) {
      skipReasons.push(
        `${className}: dependency array has ${actualDependencies.length} names but the function declares ${paramCount} parameter(s) — ambiguous binding, not safely transformable`
      );
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
      arrayStart: match.arrayStart,
      arrayEnd: match.arrayEnd,
    });
  }

  if (candidates.length === 0) {
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

  for (const candidate of candidates) {
    insertions.push({
      pos: candidate.topStmtStart,
      text: buildClassText(candidate.className, constructorParamsText(candidate.fn), functionBodyText(candidate.fn)),
    });
    replacements.push({
      pos: candidate.arrayStart,
      end: candidate.arrayEnd,
      replacement: candidate.className,
    });
  }

  const output = applyEdits(sourceFile.getFullText(), [
    ...groupInsertionsByPosition(insertions),
    ...replacements,
  ]);

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
