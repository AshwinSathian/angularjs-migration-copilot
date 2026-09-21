import { Node, Project, SyntaxKind, type ObjectLiteralExpression, type PropertyAccessExpression } from 'ts-morph';
import { forEachPropertyAccessCall } from '../inventory/ast-helpers.js';
import {
  applyEdits,
  constructorParamsText,
  functionBodyText,
  groupInsertionsByPosition,
  hasExistingTopLevelBinding,
  isSimpleParameter,
  isValidClassName,
  nearestInsertionPointStart,
  resolveNamedFunctionDeclaration,
  type WrappableFunction,
} from './class-wrapping.js';
import type { CodemodResult } from './types.js';

/**
 * Pattern #4 (docs/product-spec.md §6.3) — "simple directive (no
 * transclude/compile)" → `@Component`/`@Directive`. Scoped to `.directive`
 * only, not `.component()`: a `.component()` registration's config object
 * is passed directly (no wrapping factory function, no `restrict`, no
 * `scope` object — bindings live at the top level) — different enough
 * from `.directive`'s shape that unifying them into one detection path
 * risked exactly the kind of "looks similar, isn't" bug this project's
 * own review history keeps finding. Deferred, not forgotten — revisit
 * once this transform is proven against `.directive`, per this project's
 * own "rule of three" precedent (ADR-028) for when generalizing pays off.
 *
 * Real-fixture evidence (checked before writing a line of this, not
 * assumed) shaped what's actually in v1 scope:
 * - Every real `.directive('name', X)` call across all three vendored
 *   fixtures uses the named-reference shape (100%, zero inline literals,
 *   zero array-style DI) — the same idiom ADR-030 found dominant for
 *   `.controller`. `resolveNamedFunctionDeclaration` is reused as-is;
 *   array-style DI for the factory itself isn't supported (zero real
 *   evidence, and it would need reconciling with the single-return-shape
 *   restriction below).
 * - The factory function's body is either `return {...};` directly, or
 *   (the dominant shape in `CoreUI-AngularJS`) `var directive = {...};
 *   return directive;` — both supported; anything else (extra logic
 *   using the factory's own injected deps to compute the DDO) is a
 *   documented skip, not guessed at.
 * - `controller` is overwhelmingly a **string** reference to a
 *   separately-registered controller (e.g. `controller: 'FooCtrl'`) in
 *   real fixtures — resolving that requires finding a `.controller(...)`
 *   registration that may live in a *different file*, which no codemod
 *   in this project attempts (every one operates on a single file's
 *   `sourceText`, by design — see `CodemodResult`'s own docstring). A
 *   string (or any non-inline-function) `controller` is a documented
 *   skip, same reasoning as a `.controller('X', Y)` name mismatch
 *   elsewhere in this codebase. `link`, `compile`, `transclude`, and an
 *   isolate `scope` (object or `true`) are also documented skips —
 *   `link` because real fixture link functions uniformly do raw
 *   jQuery/DOM manipulation with no safe syntactic mapping to Angular's
 *   lifecycle hooks; `scope` because one-way-binding translation is
 *   pattern #9's own job, not this one's, and conflating the two risked
 *   half-implementing #9 inside #4.
 *
 * Unlike patterns #1–#3, this codemod never deletes or replaces the
 * original `.directive(...)` registration or its factory function — a
 * class decorated with `@Component`/`@Directive` isn't valid AngularJS
 * registration syntax the way a plain class is a valid `.controller`/
 * `.service`/`.factory` callback, so there's no in-place swap that keeps
 * the AngularJS app running the way patterns #1–#3's swap does. The new
 * class is inserted alongside the untouched original instead, as
 * forward-looking scaffolding for whatever later stage wires it into an
 * Angular `NgModule`. This also means none of pattern #3's nesting-
 * conflict machinery (ADR-034–038) applies here at all — there's nothing
 * being deleted for a sibling registration's edits to end up nested
 * inside, since this pattern only ever inserts.
 */

interface RawMatch {
  readonly directiveName: string;
  readonly definitionArg: Node | undefined;
  readonly sortKey: number;
  readonly topStmtStart: number;
}

/** Exported for reuse by pattern #9 (`bindings-to-input.ts`), which builds the same class-name/selector shapes for `.component()` registrations. */
export function toPascalCase(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toUpperCase() + name.slice(1);
}

export function toKebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function getObjectLiteralPropertyValue(obj: ObjectLiteralExpression, name: string): Node | undefined {
  const prop = obj.getProperty(name);
  return prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
}

/**
 * Distinguishes "property doesn't exist at all" from "property exists but
 * isn't a plain `key: value` assignment" (e.g. ES6 method shorthand,
 * `controller() {...}`) — `getObjectLiteralPropertyValue` alone conflates
 * the two, both returning `undefined`. That's harmless for `scope`/
 * `transclude`/`restrict` (a method-shorthand `scope` is nonsensical
 * AngularJS that wouldn't function at runtime either way), but not for
 * `controller`/`template`/`templateUrl`, where method shorthand is
 * ordinary, valid JS a real directive could plausibly use. Confirmed by
 * actually running a method-shorthand `controller() { this.x = 1; }`
 * through the codemod before this fix: `matched: true`, an empty class
 * body — the controller's entire logic silently dropped, not skipped.
 */
export function getObjectLiteralProperty(obj: ObjectLiteralExpression, name: string): { readonly present: boolean; readonly value: Node | undefined } {
  const prop = obj.getProperty(name);
  if (!prop) return { present: false, value: undefined };
  return { present: true, value: Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined };
}

/**
 * `false` is the AngularJS default for `scope`/`transclude`/`abstract` —
 * only a truthy value (or presence at all, for `compile`/`link`) is a real
 * opt-in worth flagging. Exported for reuse by pattern #8
 * (`routes-to-router-config.ts`, `abstract: true`) rather than
 * re-derived — a route-scoped file originally hand-rolled this exact
 * check and silently diverged on the "present but no value" edge case
 * (e.g. a nonsensical method-shorthand `abstract() {...}`), found by
 * adversarial review.
 */
export function isTruthyValue(value: Node | undefined): boolean {
  return value !== undefined && value.getKind() !== SyntaxKind.FalseKeyword;
}

/**
 * `template`/`templateUrl` extraction, shared between pattern #4
 * (`.directive`'s DDO) and pattern #9 (`.component()`'s definition
 * object) — both read the identical pair of properties off an object
 * literal the same way (prefer `template`, fall back to `templateUrl`,
 * skip on anything but a plain string literal for whichever is present).
 * Originally duplicated near-verbatim between the two files despite this
 * same module already exporting three other helpers for exactly this
 * "reuse rather than re-derive" reason — extracted here once the
 * duplication was flagged by review, not written this way from the
 * start.
 */
export function extractTemplateProp(obj: ObjectLiteralExpression, registrationName: string): { readonly templateProp: string | undefined } | { readonly skipReason: string } {
  const templateProperty = getObjectLiteralProperty(obj, 'template');
  const templateUrlProperty = getObjectLiteralProperty(obj, 'templateUrl');

  if (templateProperty.present) {
    if (!templateProperty.value || !Node.isStringLiteral(templateProperty.value)) {
      return { skipReason: `${registrationName}: template is not a plain string literal — not safely transformable` };
    }
    return { templateProp: `template: ${templateProperty.value.getText()}` };
  }
  if (templateUrlProperty.present) {
    if (!templateUrlProperty.value || !Node.isStringLiteral(templateUrlProperty.value)) {
      return { skipReason: `${registrationName}: templateUrl is not a plain string literal — not safely transformable` };
    }
    return { templateProp: `templateUrl: ${templateUrlProperty.value.getText()}` };
  }
  return { templateProp: undefined };
}

/**
 * The factory function's body must be exactly one of the two shapes real
 * fixtures actually use — anything else (conditional returns, extra
 * statements using the factory's own injected deps) is ambiguous, not
 * guessed at. Resolves the `var x = {...}; return x;` case via real
 * symbol binding, not text matching, same rigor as everywhere else in
 * these codemods.
 */
function extractDdo(fn: WrappableFunction): ObjectLiteralExpression | undefined {
  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) return undefined;
  const statements = body.getStatements();

  if (statements.length === 1) {
    const [stmt] = statements;
    if (!Node.isReturnStatement(stmt)) return undefined;
    const expr = stmt.getExpression();
    return expr && Node.isObjectLiteralExpression(expr) ? expr : undefined;
  }

  if (statements.length === 2) {
    const [first, second] = statements;
    if (!Node.isVariableStatement(first) || !Node.isReturnStatement(second)) return undefined;
    const decls = first.getDeclarationList().getDeclarations();
    if (decls.length !== 1) return undefined;
    const [decl] = decls;
    const init = decl.getInitializer();
    const nameNode = decl.getNameNode();
    if (!init || !Node.isObjectLiteralExpression(init) || !Node.isIdentifier(nameNode)) return undefined;
    const returnExpr = second.getExpression();
    if (!returnExpr || !Node.isIdentifier(returnExpr)) return undefined;
    const returnSymbol = returnExpr.getSymbol();
    return returnSymbol && returnSymbol === nameNode.getSymbol() ? init : undefined;
  }

  return undefined;
}

function deriveSelector(directiveName: string, restrictValue: Node | undefined): string {
  const restrict = restrictValue && Node.isStringLiteral(restrictValue) ? restrictValue.getLiteralText() : 'EA';
  const kebab = toKebabCase(directiveName);
  // Element-selector whenever 'E' is present (the common real shape, and
  // AngularJS's own default when `restrict` is absent) or as the safe
  // fallback for restrict values that name neither 'E' nor 'A' (bare 'C'/
  // 'M', both obscure and deprecated); attribute-selector only when 'A'
  // is present without 'E' — 'A' and 'AC' alike, not just a pure-'A'
  // string as an earlier version of this check required.
  return restrict.includes('A') && !restrict.includes('E') ? `[${kebab}]` : kebab;
}

export function transformDirectiveToComponent(sourceText: string): CodemodResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/app.js', sourceText);

  const rawMatches: RawMatch[] = [];

  forEachPropertyAccessCall(project, (call, expression: PropertyAccessExpression) => {
    if (expression.getName() !== 'directive') return;

    const [nameArg, definitionArg] = call.getArguments();
    if (!nameArg || !Node.isStringLiteral(nameArg)) return;

    rawMatches.push({
      directiveName: nameArg.getLiteralText(),
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
    const { directiveName, definitionArg } = match;

    let factoryFn: WrappableFunction | undefined;
    if (definitionArg && (Node.isFunctionExpression(definitionArg) || Node.isArrowFunction(definitionArg))) {
      factoryFn = definitionArg;
    } else if (definitionArg && Node.isIdentifier(definitionArg)) {
      factoryFn = resolveNamedFunctionDeclaration(definitionArg);
    }

    if (!factoryFn) {
      skipReasons.push(`${directiveName}: second argument is not a function or a resolvable named reference — not safely transformable`);
      continue;
    }

    const ddo = extractDdo(factoryFn);
    if (!ddo) {
      skipReasons.push(`${directiveName}: factory function body is more than a single directive-definition-object literal — not safely transformable`);
      continue;
    }

    if (ddo.getProperty('compile')) {
      skipReasons.push(`${directiveName}: has a compile function — out of scope for this pattern`);
      continue;
    }
    if (ddo.getProperty('link')) {
      skipReasons.push(`${directiveName}: has a link function — no safe syntactic mapping to Angular, out of scope for this pattern`);
      continue;
    }
    if (isTruthyValue(getObjectLiteralPropertyValue(ddo, 'transclude'))) {
      skipReasons.push(`${directiveName}: uses transclude — out of scope for this pattern`);
      continue;
    }
    if (isTruthyValue(getObjectLiteralPropertyValue(ddo, 'scope'))) {
      skipReasons.push(`${directiveName}: has an isolate scope — binding translation is pattern #9's job, not this one's`);
      continue;
    }

    const controllerProp = getObjectLiteralProperty(ddo, 'controller');
    let controllerFn: WrappableFunction | undefined;
    if (controllerProp.present) {
      const { value } = controllerProp;
      if (value && (Node.isFunctionExpression(value) || Node.isArrowFunction(value))) {
        controllerFn = value;
      } else {
        skipReasons.push(
          `${directiveName}: controller is a string, external reference, or an unsupported shape (e.g. method shorthand) — not resolvable within a single file`
        );
        continue;
      }
    }

    if (controllerFn && !controllerFn.getParameters().every(isSimpleParameter)) {
      skipReasons.push(`${directiveName}: controller has a destructured, default-valued, or rest parameter — not safely transformable`);
      continue;
    }

    const templateResult = extractTemplateProp(ddo, directiveName);
    if ('skipReason' in templateResult) {
      skipReasons.push(templateResult.skipReason);
      continue;
    }
    const { templateProp } = templateResult;

    const decoratorName = templateProp ? 'Component' : 'Directive';
    const className = `${toPascalCase(directiveName)}${decoratorName}`;

    if (!isValidClassName(className)) {
      skipReasons.push(`${directiveName}: derived class name "${className}" is not a valid identifier — not safely transformable`);
      continue;
    }
    if (usedClassNames.has(className) || hasExistingTopLevelBinding(sourceFile, className)) {
      skipReasons.push(`${directiveName}: derived class name "${className}" collides with an existing name in this file — ambiguous, not safely transformable`);
      continue;
    }
    usedClassNames.add(className);

    const selector = deriveSelector(directiveName, getObjectLiteralPropertyValue(ddo, 'restrict'));
    const decoratorProps = [`selector: '${selector}'`, templateProp].filter((p): p is string => Boolean(p));
    const constructorText = controllerFn
      ? `\n  constructor(${constructorParamsText(controllerFn)}) ${functionBodyText(controllerFn)}\n`
      : '';
    const classText = `@${decoratorName}({\n  ${decoratorProps.join(',\n  ')},\n})\nclass ${className} {${constructorText}}`;

    insertions.push({ pos: match.topStmtStart, text: classText });
  }

  if (insertions.length === 0) {
    return {
      matched: false,
      reason: skipReasons.length > 0 ? skipReasons.join('; ') : 'no simple directive registration found',
    };
  }

  const output = applyEdits(sourceFile.getFullText(), groupInsertionsByPosition(insertions));

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
