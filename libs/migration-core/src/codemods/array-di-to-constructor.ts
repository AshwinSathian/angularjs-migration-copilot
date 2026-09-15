import { Node, Project, type ArrowFunction, type FunctionExpression } from 'ts-morph';
import { extractDependencyNames, forEachPropertyAccessCall } from '../inventory/ast-helpers.js';
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

const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type DiFunction = FunctionExpression | ArrowFunction;

interface Candidate {
  readonly className: string;
  readonly fn: DiFunction;
  readonly topStmtStart: number;
  readonly arrayStart: number;
  readonly arrayEnd: number;
}

function topLevelStatementStart(node: Node): number {
  let current = node;
  for (;;) {
    const parent = current.getParent();
    if (!parent || Node.isSourceFile(parent)) return current.getStart();
    current = parent;
  }
}

/**
 * A parameter this codemod can safely carry into a constructor signature
 * as `private <name>: any` — a plain identifier, no default value, no
 * rest. A destructured (`{ $scope }`) or default-valued (`$scope = null`)
 * parameter can't be represented that way without either producing
 * invalid TypeScript (a binding pattern can't be a parameter property) or
 * silently dropping the default — so a function with any such parameter
 * is skipped rather than mistranslated.
 */
function isSimpleParameter(param: { getNameNode: () => Node; hasInitializer: () => boolean; isRestParameter: () => boolean }): boolean {
  return Node.isIdentifier(param.getNameNode()) && !param.hasInitializer() && !param.isRestParameter();
}

/**
 * Builds the replacement class's source text from the matched function
 * node, reusing its exact body rather than re-deriving it — preserves
 * original formatting, comments, and behavior untouched. An arrow
 * function with a concise (non-block) body is wrapped in `{ return ...; }`
 * since a constructor body must be a block.
 */
function buildClassText(className: string, fn: DiFunction): string {
  const params = fn.getParameters().map((p) => `private ${p.getName()}: any`).join(', ');
  const body = fn.getBody();
  const bodyText = Node.isBlock(body) ? body.getText() : `{ return ${body.getText()}; }`;

  return `class ${className} {\n  constructor(${params}) ${bodyText}\n}`;
}

export function transformArrayStyleDiToConstructor(sourceText: string): CodemodResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/app.js', sourceText);

  const candidates: Candidate[] = [];
  const skipReasons: string[] = [];
  const usedClassNames = new Set<string>();

  forEachPropertyAccessCall(project, (call, expression) => {
    const methodName = expression.getName();
    if (!TRANSFORMABLE_KINDS.has(methodName)) return;

    const [nameArg, definitionArg] = call.getArguments();
    if (!nameArg || !Node.isStringLiteral(nameArg)) return;
    if (!definitionArg || !Node.isArrayLiteralExpression(definitionArg)) return;

    const className = nameArg.getLiteralText();
    const fn = definitionArg.getElements().at(-1);
    if (!fn || !(Node.isFunctionExpression(fn) || Node.isArrowFunction(fn))) {
      skipReasons.push(`${className}: array's last element is not a function — not safely transformable`);
      return;
    }

    if (!VALID_IDENTIFIER.test(className)) {
      skipReasons.push(`${className}: not a valid class identifier`);
      return;
    }

    if (usedClassNames.has(className)) {
      skipReasons.push(`${className}: duplicate registration name in this file — ambiguous which one to keep, not safely transformable`);
      return;
    }

    const dependencies = extractDependencyNames(definitionArg);
    const paramCount = fn.getParameters().length;
    if (dependencies.length !== paramCount) {
      skipReasons.push(
        `${className}: dependency array has ${dependencies.length} names but the function declares ${paramCount} parameter(s) — ambiguous binding, not safely transformable`
      );
      return;
    }

    if (!fn.getParameters().every(isSimpleParameter)) {
      skipReasons.push(
        `${className}: has a destructured, default-valued, or rest parameter — not safely transformable`
      );
      return;
    }

    usedClassNames.add(className);
    candidates.push({
      className,
      fn,
      topStmtStart: topLevelStatementStart(call),
      arrayStart: definitionArg.getStart(),
      arrayEnd: definitionArg.getEnd(),
    });
  });

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
  // `.controller(...).controller(...).controller(...)` calls all live in
  // the same single top-level statement — so those are grouped by
  // position and concatenated in *source* order (candidates arrive in
  // traversal order, which for a chain visits the outermost — i.e.
  // last-in-source — call first, per ast-helpers.ts's own documented
  // quirk; sorting by each candidate's own array-literal position undoes
  // that before joining). Otherwise splicing them in one at a time at an
  // identical offset would reverse their visual order.
  const insertionsByPos = new Map<number, { sortKey: number; text: string }[]>();
  const replacements: { pos: number; end: number; replacement: string }[] = [];

  for (const candidate of candidates) {
    const group = insertionsByPos.get(candidate.topStmtStart) ?? [];
    group.push({ sortKey: candidate.arrayStart, text: buildClassText(candidate.className, candidate.fn) });
    insertionsByPos.set(candidate.topStmtStart, group);

    replacements.push({
      pos: candidate.arrayStart,
      end: candidate.arrayEnd,
      replacement: candidate.className,
    });
  }

  const edits = [
    ...[...insertionsByPos.entries()].map(([pos, group]) => ({
      pos,
      end: pos,
      replacement: `${group
        .sort((a, b) => a.sortKey - b.sortKey)
        .map((g) => g.text)
        .join('\n\n')}\n\n`,
    })),
    ...replacements,
  ].sort((a, b) => b.pos - a.pos);

  let output = sourceFile.getFullText();
  for (const edit of edits) {
    output = output.slice(0, edit.pos) + edit.replacement + output.slice(edit.end);
  }

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
