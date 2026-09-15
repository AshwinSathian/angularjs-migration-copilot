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
 * this shape at all. Scoping decision recorded in docs/decisions.md.
 */
const TRANSFORMABLE_KINDS = new Set(['controller', 'service', 'factory']);

const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type DiFunction = FunctionExpression | ArrowFunction;

interface Edit {
  readonly pos: number;
  readonly end: number;
  readonly replacement: string;
}

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

  forEachPropertyAccessCall(project, (call, expression) => {
    const methodName = expression.getName();
    if (!TRANSFORMABLE_KINDS.has(methodName)) return;

    const [nameArg, definitionArg] = call.getArguments();
    if (!nameArg || !Node.isStringLiteral(nameArg)) return;
    if (!definitionArg || !Node.isArrayLiteralExpression(definitionArg)) return;

    const fn = definitionArg.getElements().at(-1);
    if (!fn || !(Node.isFunctionExpression(fn) || Node.isArrowFunction(fn))) return;

    const className = nameArg.getLiteralText();
    if (!VALID_IDENTIFIER.test(className)) {
      skipReasons.push(`${className}: not a valid class identifier`);
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
      reason: skipReasons[0] ?? 'no array-style DI controller/service/factory registration found',
    };
  }

  const edits: Edit[] = candidates.flatMap((candidate) => [
    {
      pos: candidate.topStmtStart,
      end: candidate.topStmtStart,
      replacement: `${buildClassText(candidate.className, candidate.fn)}\n\n`,
    },
    { pos: candidate.arrayStart, end: candidate.arrayEnd, replacement: candidate.className },
  ]);
  edits.sort((a, b) => b.pos - a.pos);

  let output = sourceFile.getFullText();
  for (const edit of edits) {
    output = output.slice(0, edit.pos) + edit.replacement + output.slice(edit.end);
  }

  return { matched: true, output };
}
