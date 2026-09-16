import { Node, Project, SyntaxKind, type Identifier, type ParameterDeclaration } from 'ts-morph';
import { forEachPropertyAccessCall } from '../inventory/ast-helpers.js';
import {
  applyEdits,
  constructorParamsText,
  functionBodyText,
  groupInsertionsByPosition,
  hasExistingTopLevelBinding,
  isInsideThisRebindingBoundary,
  isSimpleParameter,
  isValidClassName,
  nearestInsertionPointStart,
  resolveNamedFunctionDeclaration,
  resolvesUniquelyTo,
  type PositionEdit,
  type WrappableFunction,
} from './class-wrapping.js';
import { toPascalCase } from './directive-to-component.js';
import type { CodemodResult } from './types.js';

/**
 * Pattern #5 (docs/product-spec.md §6.3) — a pure filter (`.filter(name,
 * factory)`) → an Angular `@Pipe`. Real-fixture evidence (checked before
 * writing any detection code, standing practice since ADR-030/034/039):
 * every real `.filter('name', X)` call across all three vendored fixtures
 * (5 in `blur-admin`, 0 elsewhere) uses the same named-reference idiom
 * ADR-030 found dominant for `.controller`/`.directive` — `X` is an
 * identifier resolving to a separately-declared `function X(...) {...}`,
 * never an inline literal. `resolveNamedFunctionDeclaration` is reused
 * as-is; an inline factory literal is also accepted below since nothing
 * about the detection logic depends on the named-reference shape, but it
 * has zero real evidence behind it.
 *
 * A filter factory's own body must be exactly `return function (input,
 * ...) {...};` — a single statement, returning a function/arrow literal.
 * "Pure" (no external state beyond the factory's own DI) is the in-scope
 * case; there's no safe mechanical way to tell a factory that
 * conditionally builds a different returned function, or that closes over
 * mutable module state, from one that doesn't — so, same conservative
 * treatment pattern #4 gave a multi-statement DDO body, any shape beyond
 * this single-statement one is a documented skip, not guessed at.
 *
 * Same insert-only architecture as patterns #4/#9: a `@Pipe`-decorated
 * class isn't valid AngularJS filter-factory output any more than
 * `@Component`/`@Directive` was valid registration output for those
 * patterns, so the original `.filter(...)` call and its factory are left
 * untouched and the new class is inserted alongside them. This also means
 * none of pattern #3's nesting-conflict machinery applies — nothing is
 * ever deleted, so there's no deletion range for a sibling's edits to end
 * up nested inside.
 *
 * One correctness issue specific to this pattern, not present in #4/#9:
 * the returned function becomes a `transform` *method*, not the
 * constructor body itself, so a bare reference inside it to one of the
 * factory's own DI parameters (`layoutPaths.images.root + input`, the
 * dominant real shape in three of `blur-admin`'s five real filters) would
 * silently break once lifted out of the closure that used to make it work
 * — `transform` has no access to the factory's own parameter scope. Every
 * such reference is rewritten to `this.<name>` (the DI parameter becomes a
 * constructor parameter property, so `this.<name>` is exactly what the
 * emitted constructor already provides). A reference sitting inside a
 * nested non-arrow function/accessor inside the returned function is the
 * same this-rebinding hazard `isInsideThisRebindingBoundary` already
 * guards elsewhere in these codemods — the whole registration is skipped
 * rather than emitting a `this.<name>` that wouldn't refer to the class
 * instance there.
 */

interface RawMatch {
  readonly filterName: string;
  readonly definitionArg: Node | undefined;
  readonly sortKey: number;
  readonly topStmtStart: number;
}

/**
 * The one shape a pure filter factory's body may take: a single `return`
 * statement returning a function or arrow literal. Anything else (extra
 * statements, a conditional definition of the returned function, a
 * `return` of something other than a function literal) is ambiguous —
 * same "skip when the shape isn't the one confirmed-safe case" philosophy
 * `extractDdo` (directive-to-component.ts) already applies to a factory
 * body.
 */
function extractTransformFn(factoryFn: WrappableFunction): WrappableFunction | undefined {
  const body = factoryFn.getBody();
  if (!body || !Node.isBlock(body)) return undefined;
  const statements = body.getStatements();
  if (statements.length !== 1) return undefined;

  const [stmt] = statements;
  if (!Node.isReturnStatement(stmt)) return undefined;
  const expr = stmt.getExpression();
  return expr && (Node.isFunctionExpression(expr) || Node.isArrowFunction(expr)) ? expr : undefined;
}

/**
 * Every identifier inside `transformFn` that resolves — via real symbol
 * binding, not text matching — to `param`, one of the enclosing factory's
 * own parameters. A same-named parameter of `transformFn` itself shadows
 * it correctly (`resolvesUniquelyTo` resolves to the *nearest* enclosing
 * declaration), same shadow-safety `resolvesToParam` already relies on in
 * scope-assignment-to-class-property.ts.
 */
function findClosureReferences(transformFn: WrappableFunction, param: ParameterDeclaration): Identifier[] {
  return transformFn
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter((identifier) => resolvesUniquelyTo(identifier, [param]));
}

function plainParamsText(fn: WrappableFunction): string {
  return fn.getParameters().map((p) => `${p.getName()}: any`).join(', ');
}

/**
 * True if `transformFn` is a *named* function expression whose own name is
 * referenced inside its own body — a self-recursive filter transform, e.g.
 * `function step(input) { return input <= 1 ? input : step(input - 1); }`.
 * A named function expression's own name is only visible inside its own
 * body (an ES spec scoping rule, not the this-rebinding hazard
 * `isInsideThisRebindingBoundary` already guards against) — `functionBodyText`
 * copies only the body text, not the enclosing named expression that binds
 * that name, so a self-reference resolves to nothing once spliced into
 * `transform(...) {...}`, a real `ReferenceError` at runtime and a real
 * `TS7023`/undefined-name error at compile time. Found by adversarial
 * review, confirmed by constructing exactly this case and running it
 * through both the transform and `assertCompiles`. Same "skip when
 * ambiguous" philosophy as everywhere else in this module — recursion in a
 * filter's transform function is real but rare, and worth a documented
 * skip rather than the added complexity of hoisting the recursive name
 * into scope.
 */
function hasSelfReference(transformFn: WrappableFunction): boolean {
  if (!Node.isFunctionExpression(transformFn)) return false;
  const nameNode = transformFn.getNameNode();
  if (!nameNode) return false;
  // The name node itself is a descendant of the FunctionExpression and
  // trivially resolves to its own declaration — excluded so a harmless
  // named function (no recursive call anywhere in its body) isn't
  // mistaken for a self-referencing one, found by adversarial review and
  // confirmed by direct execution: an earlier version of this check
  // rejected every named returned function unconditionally.
  return transformFn
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .some((identifier) => identifier !== nameNode && resolvesUniquelyTo(identifier, [transformFn]));
}

export function transformFilterToPipe(sourceText: string): CodemodResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/app.js', sourceText);

  const rawMatches: RawMatch[] = [];

  forEachPropertyAccessCall(project, (call, expression) => {
    if (expression.getName() !== 'filter') return;

    const [nameArg, definitionArg] = call.getArguments();
    if (!nameArg || !Node.isStringLiteral(nameArg)) return;

    rawMatches.push({
      filterName: nameArg.getLiteralText(),
      definitionArg,
      sortKey: expression.getNameNode().getStart(),
      topStmtStart: nearestInsertionPointStart(call),
    });
  });

  rawMatches.sort((a, b) => a.sortKey - b.sortKey);

  const insertions: { pos: number; text: string }[] = [];
  const skipReasons: string[] = [];
  const usedClassNames = new Set<string>();

  for (const match of rawMatches) {
    const { filterName, definitionArg } = match;

    let factoryFn: WrappableFunction | undefined;
    if (definitionArg && (Node.isFunctionExpression(definitionArg) || Node.isArrowFunction(definitionArg))) {
      factoryFn = definitionArg;
    } else if (definitionArg && Node.isIdentifier(definitionArg)) {
      factoryFn = resolveNamedFunctionDeclaration(definitionArg);
    }

    if (!factoryFn) {
      skipReasons.push(`${filterName}: second argument is not a function or a resolvable named reference — not safely transformable`);
      continue;
    }
    if (!factoryFn.getParameters().every(isSimpleParameter)) {
      skipReasons.push(`${filterName}: factory has a destructured, default-valued, or rest parameter — not safely transformable`);
      continue;
    }

    const transformFn = extractTransformFn(factoryFn);
    if (!transformFn) {
      skipReasons.push(`${filterName}: factory body is more than a single "return function (...) {...}" — not safely transformable as a pure pipe`);
      continue;
    }
    if (!transformFn.getParameters().every(isSimpleParameter)) {
      skipReasons.push(`${filterName}: returned function has a destructured, default-valued, or rest parameter — not safely transformable`);
      continue;
    }
    if (hasSelfReference(transformFn)) {
      skipReasons.push(`${filterName}: returned function is a named function expression that references its own name (recursion) — not safely transformable`);
      continue;
    }

    let unsafeClosureReference = false;
    const closureEdits: PositionEdit[] = [];
    for (const param of factoryFn.getParameters()) {
      for (const identifier of findClosureReferences(transformFn, param)) {
        if (isInsideThisRebindingBoundary(identifier, transformFn)) {
          unsafeClosureReference = true;
          break;
        }
        // An ES6 object-literal shorthand (`{ layoutPaths }`) can't take
        // `this.layoutPaths` as its shorthand form — replacing just the
        // identifier would produce `{ this.layoutPaths }`, a syntax error
        // (a member-access expression isn't a valid shorthand property
        // name). It has to expand to the full `key: value` form instead.
        const name = identifier.getText();
        const replacement = Node.isShorthandPropertyAssignment(identifier.getParent())
          ? `${name}: this.${name}`
          : `this.${name}`;
        closureEdits.push({ pos: identifier.getStart(), end: identifier.getEnd(), replacement });
      }
      if (unsafeClosureReference) break;
    }
    if (unsafeClosureReference) {
      skipReasons.push(
        `${filterName}: references an injected dependency from inside a nested function or accessor — not safely transformable, this would not refer to the class instance there`
      );
      continue;
    }

    const className = `${toPascalCase(filterName)}Pipe`;
    if (!isValidClassName(className)) {
      skipReasons.push(`${filterName}: derived class name "${className}" is not a valid identifier — not safely transformable`);
      continue;
    }
    if (usedClassNames.has(className) || hasExistingTopLevelBinding(sourceFile, className)) {
      skipReasons.push(`${filterName}: derived class name "${className}" collides with an existing name in this file — ambiguous, not safely transformable`);
      continue;
    }
    usedClassNames.add(className);

    const ctorText = factoryFn.getParameters().length > 0
      ? `\n  constructor(${constructorParamsText(factoryFn)}) {}\n`
      : '';
    const classText = `@Pipe({\n  name: '${filterName}',\n})\nclass ${className} {${ctorText}\n  transform(${plainParamsText(transformFn)}) ${functionBodyText(transformFn, closureEdits)}\n}`;

    insertions.push({ pos: match.topStmtStart, text: classText });
  }

  if (insertions.length === 0) {
    return {
      matched: false,
      reason: skipReasons.length > 0 ? skipReasons.join('; ') : 'no pure filter registration found',
    };
  }

  const output = applyEdits(sourceFile.getFullText(), groupInsertionsByPosition(insertions));

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
