import { Node, Project, type ArrowFunction, type FunctionExpression, type PropertyAccessExpression, type SourceFile } from 'ts-morph';
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

/** ECMA-262 reserved words — `VALID_IDENTIFIER` alone accepts these (they're syntactically identifier-shaped) but none is legal as a class name. */
const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await',
  'implements', 'package', 'protected', 'interface', 'private', 'public',
]);

type DiFunction = FunctionExpression | ArrowFunction;

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
  readonly fn: DiFunction;
  readonly topStmtStart: number;
  readonly arrayStart: number;
  readonly arrayEnd: number;
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
function nearestInsertionPointStart(node: Node): number {
  let current = node;
  for (;;) {
    const parent = current.getParent();
    if (!parent || Node.isSourceFile(parent) || Node.isBlock(parent)) return current.getStart();
    current = parent;
  }
}

function hasExistingTopLevelBinding(sourceFile: SourceFile, name: string): boolean {
  return (
    sourceFile.getFunction(name) !== undefined ||
    sourceFile.getClass(name) !== undefined ||
    sourceFile.getVariableDeclaration(name) !== undefined
  );
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

    if (!VALID_IDENTIFIER.test(className) || RESERVED_WORDS.has(className)) {
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
  // calls all landing in the same enclosing statement — so those are
  // grouped by position and joined in true source order (candidates is
  // already sorted that way, from rawMatches above).
  const insertionsByPos = new Map<number, string[]>();
  const replacements: { pos: number; end: number; replacement: string }[] = [];

  for (const candidate of candidates) {
    const group = insertionsByPos.get(candidate.topStmtStart) ?? [];
    group.push(buildClassText(candidate.className, candidate.fn));
    insertionsByPos.set(candidate.topStmtStart, group);

    replacements.push({
      pos: candidate.arrayStart,
      end: candidate.arrayEnd,
      replacement: candidate.className,
    });
  }

  const edits = [
    ...[...insertionsByPos.entries()].map(([pos, classTexts]) => ({
      pos,
      end: pos,
      replacement: `${classTexts.join('\n\n')}\n\n`,
    })),
    ...replacements,
  ].sort((a, b) => b.pos - a.pos);

  let output = sourceFile.getFullText();
  for (const edit of edits) {
    output = output.slice(0, edit.pos) + edit.replacement + output.slice(edit.end);
  }

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
