import { Node, Project, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import { applyEdits, hasExistingTopLevelBinding, isPlainAssignment, VALID_IDENTIFIER } from './class-wrapping.js';
import { getObjectLiteralProperty } from './directive-to-component.js';
import type { CodemodResult } from './types.js';

/**
 * Pattern #6 (docs/product-spec.md §6.3) — `$http` + `.then()` chains,
 * depth ≤ 2, → `HttpClient` + RxJS.
 *
 * Real-fixture evidence checked before writing any detection code
 * (standing practice since ADR-030/034/039/041/043/044/046): `$http` is
 * barely used across the three vendored fixtures at all.
 * `CoreUI-AngularJS` has zero `$http` references anywhere in app code.
 * `angular-phonecat` fetches data exclusively through `$resource`
 * (`app/core/phone/phone.service.js`), never `$http` directly — zero real
 * hits. `blur-admin` has exactly 2 real `$http` call sites, both in one
 * file (`WeatherCtrl.js`): `$http({ method: method, url: url, params:
 * {...} }).then(success, error)` (the config-object form, with `method`/
 * `url` bound through local `var` declarations rather than inline
 * literals) and `$http.jsonp(url).then(success, error)`. Both success/
 * error callbacks are inline named function expressions passed directly
 * as `.then()` arguments (not the separately-declared-function idiom
 * ADR-030 found dominant elsewhere), and both bodies are heavily
 * entangled with `$scope` and sibling closure functions
 * (`saveWeatherData`, `makeChart`) that have no safe, general way to be
 * lifted out of their original closure.
 *
 * **Scope confirmed with the user given this real entanglement (a step up
 * in risk from every pattern so far)**: a signature-only scaffold. For
 * each qualifying `$http(...)` call chained with 1–2 `.then`/`.catch`
 * links, this generates a typed `HttpClient`-based method with the right
 * shape (method, URL, and an optional `params`/`body` parameter) — but
 * never attempts to copy or rewrite the `.then`/`.catch` callback bodies
 * at all. The callback logic itself (the actual `$scope` updates, chart
 * rendering, error handling) is left as a documented, out-of-scope gap
 * for manual migration, the same conservatism pattern #4 applies to a
 * directive's `link` function. This also means, unlike patterns #1/#2/#3,
 * this pattern never needs to reason about closure references or
 * this-rebinding at all — there's no body being copied for either hazard
 * to apply to.
 *
 * Same insert-only architecture as patterns #4/#9/#5/#8/#10: a
 * `@Injectable`-decorated `HttpClient`-based method isn't valid AngularJS
 * output any more than a `Subject`-backed service was for pattern #10, and
 * — like #10, unlike #4/#9/#5/#8 — there's no single registration call
 * this pattern is even attached to (a `$http(...).then(...)` chain can sit
 * anywhere inside any function). The generated service is inserted
 * alongside the untouched original file, at true module-top-level (not
 * `nearestInsertionPointStart` — see event-bus-to-subject.ts's own
 * docstring for why that helper's contract doesn't hold for an arbitrarily
 * nested call site): the generated class has no constructor parameters
 * beyond the injected `HttpClient` and closes over nothing from the
 * source file, so it has no need to stay inside an enclosing IIFE.
 * (`moduleTopLevelInsertPos` is duplicated here rather than imported from
 * event-bus-to-subject.ts — a second real user of the same shape, still
 * pattern-local per this project's own "generalize on a third occurrence"
 * precedent, ADR-028/029.)
 *
 * `.jsonp(...)` is a documented whole-match skip, not attempted: Angular's
 * `HttpClient.jsonp(url, callbackParam)` needs a different module
 * (`HttpClientJsonpModule`) and a different call signature (an explicit
 * callback-parameter name) than `$http.jsonp(url)`'s auto-detected
 * `JSON_CALLBACK` placeholder — a real, structural API difference, not
 * something safely guessed at from one real example.
 */

const NO_BODY_METHODS = new Set(['get', 'delete', 'head']);
const WITH_BODY_METHODS = new Set(['post', 'put', 'patch']);
const KNOWN_METHODS = new Set([...NO_BODY_METHODS, ...WITH_BODY_METHODS]);

const SERVICE_CLASS_NAME = 'HttpMigrationService';

/**
 * A derived method name colliding with either of these breaks
 * compilation regardless of `VALID_IDENTIFIER`/collision checks aimed at
 * *file-level* names — `http` is the generated class's own constructor
 * parameter property (`TS2300: Duplicate identifier`), `constructor` is
 * the reserved class-member name itself (`TS2392: Multiple constructor
 * implementations`). Found by adversarial review, confirmed by
 * `assertCompiles` against both constructed repros (an enclosing
 * `function http() {...}`, an enclosing `function constructor() {...}`).
 */
const RESERVED_METHOD_NAMES = new Set(['http', 'constructor']);

/**
 * Resolves `node` to a static string value — a plain string literal, or an
 * identifier resolving (via real symbol binding, exactly one declaration,
 * same rigor `resolvesUniquelyTo` applies elsewhere) to a `var`/`let`/
 * `const` declaration whose own initializer is a string literal — and that
 * is never reassigned anywhere else in the file. Needed because the one
 * real fixture example (`WeatherCtrl.js`) binds `method`/`url` through
 * local variables, not inline literals — an inline-literal-only check
 * would match zero real cases. The reassignment check matters because
 * `getDeclarations()` only reports where a symbol is *declared*, never
 * where it's later reassigned — found by self-review, confirmed by direct
 * execution: `var method = 'GET'; method = 'POST';` resolved to the
 * declaration's own initializer (`'GET'`) with no check for the
 * reassignment two lines later, a real `matched: true`-but-wrong bug (the
 * scaffolded method calls `this.http.get(...)` when the real runtime
 * method is `POST`). Not reachable by any real fixture (neither real
 * `method`/`url` variable is ever reassigned), but the same "skip when
 * ambiguous" conservatism as everywhere else in this pattern family.
 *
 * The reassignment check covers *every* assignment-family operator
 * (`=`, `+=`, `-=`, ...), not just plain `=` — found too narrow by
 * adversarial review, confirmed by direct execution: `var url = '/api/
 * users'; url += '/extra';` still resolved to the stale `'/api/users'`
 * initializer under a plain-`=`-only check, the exact same silently-wrong
 * failure class the reassignment guard was added to close in the first
 * place, just reached through a different operator.
 */
const ASSIGNMENT_OPERATOR_KINDS = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

function resolveStaticString(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node)) return node.getLiteralText();
  if (!Node.isIdentifier(node)) return undefined;

  const declarations = node.getSymbol()?.getDeclarations() ?? [];
  if (declarations.length !== 1) return undefined;
  const [decl] = declarations;
  if (!Node.isVariableDeclaration(decl)) return undefined;
  const initializer = decl.getInitializer();
  if (!initializer || !Node.isStringLiteral(initializer)) return undefined;

  const nameNode = decl.getNameNode();
  const isReassigned = Node.isIdentifier(nameNode) && nameNode.findReferencesAsNodes().some((ref) => {
    const parent = ref.getParent();
    return Node.isBinaryExpression(parent) && ASSIGNMENT_OPERATOR_KINDS.has(parent.getOperatorToken().getKind()) && parent.getLeft() === ref;
  });
  return isReassigned ? undefined : initializer.getLiteralText();
}

/** Escapes `\` and `'` so a raw string can be embedded inside a single-quoted TS string literal without breaking out of it — found missing by self-review, confirmed by direct execution: an unescaped URL containing a single quote (e.g. `/api/o'brien`) produced a real syntax error in the emitted output. */
function escapeSingleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * True if `args`' last argument is a genuine trailing *config* object
 * literal (not the body/data argument a body-bearing verb's shorthand
 * takes positionally) with a truthy-or-present `params` property.
 * `minArgsForConfig` is the argument count a config object can only
 * appear at *beyond* — 2 for a no-body verb (`get(url, config)`), 3 for a
 * body-bearing one (`post(url, data, config)`) — found missing by
 * adversarial review, confirmed by direct execution: without this, a
 * body-bearing verb's 2-argument call (`post(url, data)`, no config at
 * all) that happened to pass an object literal containing a `params` key
 * as its *body* was misread as a config object, silently splitting real
 * POST body data into a separate, caller-supplied `params` argument.
 */
function hasParamsConfig(verb: string, args: readonly Node[]): boolean {
  const minArgsForConfig = WITH_BODY_METHODS.has(verb) ? 3 : 2;
  if (args.length < minArgsForConfig) return false;
  const last = args[args.length - 1];
  return !!last && Node.isObjectLiteralExpression(last) && getObjectLiteralProperty(last, 'params').present;
}

interface HttpMatch {
  readonly call: CallExpression;
  readonly method: string;
  readonly url: string;
  readonly hasParams: boolean;
  /**
   * Whether the original call actually passed body/`data`, not just
   * whether the verb is one of POST/PUT/PATCH — found by adversarial
   * review: basing the generated method's `body: unknown` parameter on
   * the verb alone forced callers to supply a body argument even for a
   * real no-payload trigger POST (`$http.post('/api/trigger')`), the same
   * "only add what was actually present" treatment `hasParams` already
   * gets.
   */
  readonly hasBody: boolean;
  readonly sortKey: number;
}

/**
 * Number of consecutive `.then`/`.catch` links chained directly onto
 * `call` — `0` if none (not this pattern at all), `1`/`2` if within the
 * spec's own depth ceiling, anything higher left uncapped so the caller
 * can tell "too deep" apart from "not chained" and report an honest skip
 * reason for the former rather than silently ignoring it.
 */
function chainLinkCount(call: CallExpression): number {
  let current: Node = call;
  let links = 0;
  for (;;) {
    const parent = current.getParent();
    if (!parent || !Node.isPropertyAccessExpression(parent)) return links;
    const name = parent.getName();
    if (name !== 'then' && name !== 'catch') return links;
    const callParent = parent.getParent();
    if (!callParent || !Node.isCallExpression(callParent) || callParent.getExpression() !== parent) return links;
    links++;
    current = callParent;
  }
}

/** The nearest enclosing function/arrow — the http call's own attachment point for name derivation, never an outer ancestor beyond it. */
function findEnclosingFunction(node: Node): Node | undefined {
  let current = node.getParent();
  while (current) {
    if (Node.isFunctionDeclaration(current) || Node.isFunctionExpression(current) || Node.isArrowFunction(current)) return current;
    current = current.getParent();
  }
  return undefined;
}

/**
 * A method name derived from how the enclosing function is itself bound —
 * both real fixture shapes are covered: a named `function updateGeoData()
 * {...}` declaration, and `$scope.updateWeather = function () {...}` (an
 * anonymous function expression assigned via property access). A `var x =
 * function () {...}` assignment is also covered symmetrically, though
 * unseen in any real fixture. Anything else (an IIFE-invoked expression,
 * an unassigned callback argument, ...) has no safe name to derive —
 * `undefined`, a documented skip, not guessed at.
 */
function deriveMethodName(fn: Node): string | undefined {
  if ((Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn)) && fn.getName()) {
    return fn.getName();
  }
  const parent = fn.getParent();
  if (parent && Node.isBinaryExpression(parent) && isPlainAssignment(parent) && parent.getRight() === fn) {
    const left = parent.getLeft();
    if (Node.isPropertyAccessExpression(left)) return left.getName();
    if (Node.isIdentifier(left)) return left.getText();
  }
  if (parent && Node.isVariableDeclaration(parent) && parent.getInitializer() === fn) {
    return parent.getName();
  }
  return undefined;
}

/** Same reasoning as event-bus-to-subject.ts's own copy: the generated class closes over nothing, so it belongs at true module-top-level, after any leading `'use strict'` directive-prologue statement, not inside whatever closure the matched call happens to sit in. */
function moduleTopLevelInsertPos(sourceFile: SourceFile): number {
  const firstNonDirective = sourceFile
    .getStatements()
    .find((s) => !(Node.isExpressionStatement(s) && Node.isStringLiteral(s.getExpression())));
  return firstNonDirective ? firstNonDirective.getStart() : sourceFile.getEnd();
}

export function transformHttpThenToHttpClient(sourceText: string): CodemodResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/app.js', sourceText);

  const matches: HttpMatch[] = [];
  const skipReasons: string[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();

    // Config-object form: `$http({ method, url, params, ... })`.
    if (Node.isIdentifier(callee) && callee.getText() === '$http') {
      const [config] = node.getArguments();
      if (!config || !Node.isObjectLiteralExpression(config)) return;

      const links = chainLinkCount(node);
      if (links === 0) return;
      if (links > 2) {
        skipReasons.push(`$http({...}) at line ${node.getStartLineNumber()}: promise chain is ${links} links deep (limit 2) — not safely transformable`);
        return;
      }

      const method = resolveStaticString(getObjectLiteralProperty(config, 'method').value)?.toLowerCase();
      if (!method || !KNOWN_METHODS.has(method)) {
        skipReasons.push(`$http({...}) at line ${node.getStartLineNumber()}: method is not a plain string literal (or a simple, unambiguous string-valued variable) naming a known HTTP verb — not safely transformable`);
        return;
      }
      const url = resolveStaticString(getObjectLiteralProperty(config, 'url').value);
      if (!url) {
        skipReasons.push(`$http({...}) at line ${node.getStartLineNumber()}: url is not a plain string literal (or a simple, unambiguous string-valued variable) — not safely transformable`);
        return;
      }

      matches.push({
        call: node,
        method,
        url,
        hasParams: getObjectLiteralProperty(config, 'params').present,
        hasBody: getObjectLiteralProperty(config, 'data').present,
        sortKey: node.getStart(),
      });
      return;
    }

    // Shorthand form: `$http.get(url, ...)`, `.post(url, data, ...)`, etc.
    if (Node.isPropertyAccessExpression(callee) && Node.isIdentifier(callee.getExpression()) && callee.getExpression().getText() === '$http') {
      const verb = callee.getName();
      if (verb !== 'jsonp' && !KNOWN_METHODS.has(verb)) return;

      const links = chainLinkCount(node);
      if (links === 0) return;
      if (links > 2) {
        skipReasons.push(`$http.${verb}(...) at line ${node.getStartLineNumber()}: promise chain is ${links} links deep (limit 2) — not safely transformable`);
        return;
      }

      if (verb === 'jsonp') {
        skipReasons.push(`$http.jsonp(...) at line ${node.getStartLineNumber()}: Angular's HttpClient.jsonp() needs HttpClientJsonpModule and a different call signature — not attempted`);
        return;
      }

      const args = node.getArguments();
      const url = resolveStaticString(args[0]);
      if (!url) {
        skipReasons.push(`$http.${verb}(...) at line ${node.getStartLineNumber()}: url is not a plain string literal (or a simple, unambiguous string-valued variable) — not safely transformable`);
        return;
      }

      matches.push({
        call: node,
        method: verb,
        url,
        hasParams: hasParamsConfig(verb, args),
        hasBody: WITH_BODY_METHODS.has(verb) && args.length >= 2,
        sortKey: node.getStart(),
      });
    }
  });

  if (matches.length === 0) {
    return {
      matched: false,
      reason: skipReasons.length > 0 ? skipReasons.join('; ') : 'no $http(...).then()/.catch() call (depth ≤ 2) found',
    };
  }

  const collidingName = [SERVICE_CLASS_NAME, 'HttpClient', 'Observable', 'Injectable'].find((name) => hasExistingTopLevelBinding(sourceFile, name));
  if (collidingName) {
    return {
      matched: false,
      reason: `derived/referenced name "${collidingName}" collides with an existing binding in this file — not safely transformable`,
    };
  }

  matches.sort((a, b) => a.sortKey - b.sortKey);

  const usedMethodNames = new Set<string>();
  const methodBlocks: string[] = [];

  for (const match of matches) {
    const enclosingFn = findEnclosingFunction(match.call);
    const methodName = enclosingFn && deriveMethodName(enclosingFn);

    if (!methodName || !VALID_IDENTIFIER.test(methodName)) {
      skipReasons.push(`$http.${match.method}('${match.url}') at line ${match.call.getStartLineNumber()}: no safe method name could be derived from its enclosing function — not safely transformable`);
      continue;
    }
    if (RESERVED_METHOD_NAMES.has(methodName)) {
      skipReasons.push(`${methodName}: collides with the generated class's own "http" constructor parameter or its "constructor" member — not safely transformable`);
      continue;
    }
    if (usedMethodNames.has(methodName)) {
      skipReasons.push(`${methodName}: derives the same service method name as another $http call in this file — ambiguous, not safely transformable`);
      continue;
    }
    usedMethodNames.add(methodName);

    // HttpClient's real post/put/patch signature takes `body` as a
    // required positional argument (its type permits `null`, but the
    // parameter itself can't be omitted) — a body-bearing verb with no
    // real body data still needs *something* passed positionally before
    // any trailing `options`, or the emitted call is missing a required
    // argument. `null` is passed literally (no method parameter exposed
    // for it) rather than forcing every params-only trigger POST to also
    // declare a meaningless `body: unknown` parameter.
    const isBodyVerb = WITH_BODY_METHODS.has(match.method);
    const bodyArg = isBodyVerb ? (match.hasBody ? 'body' : 'null') : undefined;
    const params = [match.hasBody ? 'body: unknown' : undefined, match.hasParams ? 'params?: Record<string, string | number | boolean>' : undefined].filter(Boolean).join(', ');
    const args = [`'${escapeSingleQuoted(match.url)}'`, bodyArg, match.hasParams ? '{ params }' : undefined].filter(Boolean).join(', ');

    methodBlocks.push(
      [
        `  // Signature-only migration: the original .then()/.catch() callback logic is not migrated — see ADR-047.`,
        `  ${methodName}(${params}): Observable<unknown> {`,
        `    return this.http.${match.method}(${args});`,
        '  }',
      ].join('\n')
    );
  }

  if (methodBlocks.length === 0) {
    return { matched: false, reason: skipReasons.join('; ') };
  }

  const insertPos = moduleTopLevelInsertPos(sourceFile);
  const classText = `@Injectable({ providedIn: 'root' })\nclass ${SERVICE_CLASS_NAME} {\n  constructor(private http: HttpClient) {}\n\n${methodBlocks.join('\n\n')}\n}`;
  const output = applyEdits(sourceFile.getFullText(), [{ pos: insertPos, end: insertPos, replacement: `${classText}\n\n` }]);

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
