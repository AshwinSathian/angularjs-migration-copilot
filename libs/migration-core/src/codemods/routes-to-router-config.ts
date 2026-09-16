import { Node, Project, SyntaxKind, type CallExpression, type ObjectLiteralExpression, type ParameterDeclaration, type PropertyAccessExpression } from 'ts-morph';
import { extractDependencyNames, forEachPropertyAccessCall } from '../inventory/ast-helpers.js';
import {
  applyEdits,
  groupInsertionsByPosition,
  hasExistingTopLevelBinding,
  isValidClassName,
  nearestInsertionPointStart,
  resolveNamedFunctionDeclaration,
  resolvesUniquelyTo,
  type WrappableFunction,
} from './class-wrapping.js';
import { getObjectLiteralProperty } from './directive-to-component.js';
import type { CodemodResult } from './types.js';

/**
 * Pattern #8 (docs/product-spec.md §6.3) — flat `$routeProvider`/ui-router
 * `$stateProvider` route definitions → an Angular `Routes` array. "Flat"
 * means a top-level (non-dotted) ui-router state name that isn't
 * `abstract: true` — a dotted child (`'tables.basic'`) or an `abstract`
 * parent has no single leaf view to map to a `{path, component}` entry,
 * and both are the "nested abstract router states" `docs/product-spec.md
 * §6.3`'s own out-of-scope list already names. `$routeProvider` has no
 * such nesting concept at all — every `.when(path, config)` call is flat
 * by construction.
 *
 * Real-fixture evidence checked before writing any detection code
 * (standing practice since ADR-030/034/039/041/043) — and one piece of it
 * corrected a stale claim from the prior session's own resume brief, not
 * just confirmed one: `angular-phonecat/app/app.config.js` has one clean
 * `.config(['$routeProvider', function config($routeProvider) {...}])`
 * with two flat, template-only routes (`/phones`, `/phones/:phoneId`) plus
 * an `.otherwise('/phones')` fallback — array-style DI, exactly as
 * described. `blur-admin` has 37 total `.state()` calls, 8 of them flat
 * (non-dotted); of those 8, only `dashboard` and `profile` are actually
 * non-abstract leaf states (`dashboard.module.js`, `profile.module.js`) —
 * the other 6 flat names (`charts`, `components`, `form`, `maps`, `tables`,
 * `ui`) are all `abstract: true` parent states, correctly out of scope.
 * **`CoreUI-AngularJS` is not the 0/0 the prior resume brief claimed** —
 * its own `fixtures/README.md` calls it "real-world scale, heavy
 * ui-router," and it has 27 real `.state()` calls across 3 files
 * (`AngularJS_Full_Project_GULP/src/js/routes.js`, its `demo/routes.js`,
 * and `AngularJS_Starter_GULP/src/js/routes.js`). It's still a correctly
 * honest 0 real *hits*, though: the only 4 flat (non-dotted) state names
 * across all three files (`app`, `appSimple`, duplicated across the two
 * near-identical GULP variants) are every one of them `abstract: true`
 * container states whose real children are the 23 dotted states this
 * pattern is scoped to skip — so `0/27` (or `0/4` counting only the flat
 * ones), not `0/0`. Verified by actually running the real CLI against the
 * fixture, not by re-deriving the count from source alone.
 *
 * **The one real architectural wrinkle flagged before writing this, now
 * resolved**: `.config(fn)` takes exactly one argument, not every other
 * pattern's `(name, fn)` shape. Three real shapes exist across the
 * fixtures — array-style DI (phonecat), a bare named reference via
 * `.config(routeConfig)` with a separately-declared `/** @ngInject *\/
 * function routeConfig($stateProvider) {...}` (blur-admin, dominant),
 * and (built for, though unseen in any fixture) a bare inline function
 * literal with no array wrapper. `resolveNamedFunctionDeclaration` is
 * reused as-is for the second shape — it had never been exercised against
 * a `.config()` call before, only `.controller`/`.directive`/`.filter`'s
 * `(name, fn)` shape, and works unmodified.
 *
 * **Deliberately more rigorous than `inventory/scan-routes.ts`, not a
 * copy of its looseness** — ADR-019 already flags that scanner's known
 * gap (matches a call's receiver by source text, e.g. `/\$routeProvider/`
 * against `expression.getExpression().getText()`, not by resolving the
 * identifier through real DI binding) as an accepted, low-prevalence
 * read-only-report limitation. A codemod that emits code is a higher bar:
 * this pattern resolves the actual injected `$routeProvider`/
 * `$stateProvider` parameter — by array *position* for array-style DI
 * (the real runtime binding mechanism: the wrapped function's parameter
 * at the same index as the array's `'$routeProvider'`/`'$stateProvider'`
 * string, regardless of what that parameter is locally named), and by
 * parameter *name* for a bare/named-reference function (also the real
 * runtime mechanism — AngularJS's own implicit-annotation injector uses
 * unminified parameter names as the token, which is exactly why
 * `constructorParamsText` and every other pattern in this codebase
 * already treats a DI parameter's name as its injected token) — then
 * walks every `.when`/`.state`/`.otherwise` call in the function body and
 * checks each one's chain-root identifier *resolves*, via
 * `resolvesUniquelyTo`, to that specific parameter. This is what
 * correctly excludes `blur-admin`'s `$urlRouterProvider.when(...)` calls
 * (ui-router's own default-child-redirect API, an entirely different
 * provider that happens to share the `.when()` method name) and
 * `chartJs.module.js`'s second, unrelated `.config(chartJsConfig)` in the
 * same chained `.config(routeConfig).config(chartJsConfig)` call — neither
 * is a text-substring match away from being confused with real routing,
 * and real symbol resolution rejects both by construction rather than by
 * a special-cased guard.
 *
 * **Same insert-only architecture as patterns #4/#9/#5, confirmed here
 * rather than assumed by reflex**: a `Routes` array literal isn't valid
 * `.config(fn)` output any more than a `@Component`-decorated class was
 * valid `.directive()` output for pattern #4 — there's no in-place swap
 * that keeps the original AngularJS app running, so the original
 * `.config(...)` call and its provider function are left untouched and a
 * `const <Name>Routes: Routes = [...]` is inserted alongside. This also
 * means none of pattern #3's nesting-conflict machinery applies (nothing
 * is ever deleted).
 *
 * This pattern only maps `{path, component}` (and `.otherwise(path)` to a
 * `{path: '**', redirectTo}` wildcard) — it does not resolve what
 * `controller`/`template`/`templateUrl` become, the same cross-file
 * resolution limit every pattern in this project already accepts (pattern
 * #4's `controller: 'FooCtrl'` skip is the same boundary). The referenced
 * component class name is derived mechanically from the state name
 * (ui-router) or the path's own segments (`$routeProvider`, which has no
 * separate "name" field) and left as an unresolved identifier — the same
 * `TS2304` class `assertCompiles`'s ignored-diagnostics set already
 * accepts for `@Component`/`@Directive`/`Input`, extended here to a
 * `Routes`-array component reference for the identical reason (a real
 * project supplies the import).
 *
 * Documented, evidence-driven skips, not guessed at: a dotted (nested) or
 * `abstract: true` state; a `.when`/`.state`/`.otherwise` argument that
 * isn't a plain string literal or object literal; a `.state()` with no
 * plain string `url` property; a derived component name that isn't a
 * valid identifier or collides with an existing binding in the file (or
 * with another entry in the same run — checked via a two-phase commit,
 * same ADR-042 precedent: a whole registration's derived names are only
 * claimed once every entry in it is confirmed to survive, so a
 * registration that ultimately fails never blocks a later, unrelated one
 * from reusing the same names).
 */

interface RoutingConfigMatch {
  readonly fn: WrappableFunction;
  readonly providerParam: ParameterDeclaration;
  readonly kind: 'ngRoute' | 'ui-router';
}

/** `$routeProvider`/`$stateProvider`, identified by parameter *name* — the real AngularJS implicit-annotation binding for an unminified, unannotated function (see the module docstring). */
function findProviderParam(fn: WrappableFunction): { param: ParameterDeclaration; kind: 'ngRoute' | 'ui-router' } | undefined {
  const params = fn.getParameters();
  const index = params.findIndex((p) => p.getName() === '$routeProvider' || p.getName() === '$stateProvider');
  if (index === -1) return undefined;
  return { param: params[index], kind: params[index].getName() === '$routeProvider' ? 'ngRoute' : 'ui-router' };
}

/**
 * Resolves a `.config(fn)` call's single argument to a routing candidate,
 * or `undefined` if it isn't one at all (the vast majority of real
 * `.config()` calls — `ChartJsProvider`/`baConfigProvider`/`$ocLazyLoadProvider`
 * config, etc. — have nothing to do with routing and are silently not
 * collected as candidates, never warned about, the same "not a candidate"
 * treatment every other pattern in this codebase gives a structurally
 * unrelated call). `ambiguous` is the one case worth surfacing as a
 * skip reason even though it *is* confirmed to be a routing config: an
 * array-style DI's dependency-array length not matching the function's
 * own parameter count, the same "not safely transformable" ambiguity
 * `array-di-to-constructor.ts` already treats this way.
 */
function resolveRoutingConfig(definitionArg: Node | undefined): RoutingConfigMatch | { readonly ambiguous: string } | undefined {
  if (!definitionArg) return undefined;

  if (Node.isFunctionExpression(definitionArg) || Node.isArrowFunction(definitionArg)) {
    const found = findProviderParam(definitionArg);
    return found ? { fn: definitionArg, providerParam: found.param, kind: found.kind } : undefined;
  }

  if (Node.isIdentifier(definitionArg)) {
    const namedFn = resolveNamedFunctionDeclaration(definitionArg);
    if (!namedFn) return undefined;
    const found = findProviderParam(namedFn);
    return found ? { fn: namedFn, providerParam: found.param, kind: found.kind } : undefined;
  }

  if (Node.isArrayLiteralExpression(definitionArg)) {
    const elements = definitionArg.getElements();
    const last = elements.at(-1);
    if (!last || !(Node.isFunctionExpression(last) || Node.isArrowFunction(last))) return undefined;

    const depNames = extractDependencyNames(definitionArg);
    const providerIndex = depNames.findIndex((n) => n === '$routeProvider' || n === '$stateProvider');
    if (providerIndex === -1) return undefined;

    const paramCount = last.getParameters().length;
    if (depNames.length !== paramCount) {
      return {
        ambiguous: `dependency array has ${depNames.length} names but the function declares ${paramCount} parameter(s) — ambiguous binding, not safely transformable`,
      };
    }

    return { fn: last, providerParam: last.getParameters()[providerIndex], kind: depNames[providerIndex] === '$routeProvider' ? 'ngRoute' : 'ui-router' };
  }

  return undefined;
}

/** The `.config(...)` call's own module name, via `angular.module('X', [...]).config(fn)` — used only to derive the emitted `Routes` variable's name; falls back to a generic name when unresolvable (no real fixture needs the fallback, both real registrations chain directly off `.module(...)`). */
function resolveModuleName(configPropertyAccess: PropertyAccessExpression): string | undefined {
  const receiver = configPropertyAccess.getExpression();
  if (!Node.isCallExpression(receiver)) return undefined;
  const callee = receiver.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'module') return undefined;
  const [nameArg] = receiver.getArguments();
  return nameArg && Node.isStringLiteral(nameArg) ? nameArg.getLiteralText() : undefined;
}

/** The chain root of a (possibly chained) call's receiver — `$stateProvider` for both `$stateProvider.state(a)` and the second link of `$stateProvider.state(a).state(b)`, whose own receiver is the first call, not a plain identifier. */
function resolveChainRoot(node: Node): Node | undefined {
  if (Node.isIdentifier(node)) return node;
  if (Node.isCallExpression(node)) {
    const callee = node.getExpression();
    if (Node.isPropertyAccessExpression(callee)) return resolveChainRoot(callee.getExpression());
  }
  return undefined;
}

/** Every `.when`/`.state`/`.otherwise` call in `fn`'s body whose chain root resolves — via real symbol binding — to `providerParam`, in true source order (a chained call's outer link is visited first by ts-morph's descendant walk, the same reversal `ast-helpers.ts`'s `methodCallLine` already documents, so results are sorted by each call's own method-name-token position afterward). */
function collectRouteCalls(fn: WrappableFunction, providerParam: ParameterDeclaration, kind: 'ngRoute' | 'ui-router'): CallExpression[] {
  const targetNames = kind === 'ngRoute' ? new Set(['when', 'otherwise']) : new Set(['state']);
  const body = fn.getBody();
  if (!body) return [];

  const found: { call: CallExpression; sortKey: number }[] = [];
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || !targetNames.has(callee.getName())) continue;
    const root = resolveChainRoot(callee.getExpression());
    if (!root || !resolvesUniquelyTo(root, [providerParam])) continue;
    found.push({ call, sortKey: callee.getNameNode().getStart() });
  }
  return found.sort((a, b) => a.sortKey - b.sortKey).map((f) => f.call);
}

/** Strips leading `:` (a ui-router/ngRoute path param) and any non-alphanumeric separator, Pascal-casing what's left — e.g. `social-buttons` → `SocialButtons`, `:phoneId` → `PhoneId`. `undefined` for a segment with nothing alphanumeric in it at all. */
function pascalCaseSegment(segment: string): string | undefined {
  const parts = segment.replace(/^:/, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/** A `$routeProvider` path has no separate "name" field the way a ui-router state does — the component name is derived from every path segment (param placeholders included), which also keeps `/phones` and `/phones/:phoneId` from colliding the way taking only the last segment would. */
function deriveComponentNameFromPath(path: string): string | undefined {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return undefined;
  const pieces = segments.map(pascalCaseSegment);
  return pieces.every((p): p is string => p !== undefined) ? pieces.join('') : undefined;
}

function toRouterPath(angularPath: string): string {
  return angularPath.replace(/^\//, '');
}

/**
 * Falls back to the generic `AppRoutes` whenever the module name can't be
 * resolved *or* resolves to something that isn't a valid identifier once
 * Pascal-cased (e.g. a module literally named `'404'`) — found by
 * self-review, not fixture evidence (no real fixture has a purely-numeric
 * module segment): without the `isValidClassName` check here, a module
 * name like `'404'` would derive `404Routes`, invalid syntax once emitted
 * as `const 404Routes: Routes = [...]`. The call site also independently
 * checks `isValidClassName` on this function's return value before using
 * it — a safety net for the invariant this function is already supposed
 * to guarantee, same "enforce it at the one place that needs it, don't
 * just trust every caller remembered" precedent as
 * `constructorParamsText` (class-wrapping.ts).
 */
function deriveRoutesVarName(moduleName: string | undefined): string {
  const lastSegment = moduleName?.split('.').filter(Boolean).at(-1);
  const pascal = lastSegment ? pascalCaseSegment(lastSegment) : undefined;
  const candidate = pascal ? `${pascal}Routes` : undefined;
  return candidate && isValidClassName(candidate) ? candidate : 'AppRoutes';
}

export function transformRoutesToRouterConfig(sourceText: string): CodemodResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/app.js', sourceText);

  interface RawMatch {
    readonly match: RoutingConfigMatch;
    readonly moduleName: string | undefined;
    readonly topStmtStart: number;
    readonly sortKey: number;
  }
  const rawMatches: RawMatch[] = [];
  const skipReasons: string[] = [];

  forEachPropertyAccessCall(project, (call, expression: PropertyAccessExpression) => {
    if (expression.getName() !== 'config') return;
    const args = call.getArguments();
    if (args.length !== 1) return;

    const resolved = resolveRoutingConfig(args[0]);
    if (!resolved) return;

    const moduleName = resolveModuleName(expression);
    if ('ambiguous' in resolved) {
      skipReasons.push(`${moduleName ?? 'config'}: ${resolved.ambiguous}`);
      return;
    }

    rawMatches.push({
      match: resolved,
      moduleName,
      topStmtStart: nearestInsertionPointStart(call),
      sortKey: expression.getNameNode().getStart(),
    });
  });

  rawMatches.sort((a, b) => a.sortKey - b.sortKey);

  const insertions: { pos: number; text: string }[] = [];
  const usedNames = new Set<string>();

  for (const { match, moduleName, topStmtStart } of rawMatches) {
    const { fn, providerParam, kind } = match;
    const routeCalls = collectRouteCalls(fn, providerParam, kind);

    const entries: string[] = [];
    const localUsedNames = new Set<string>();

    for (const call of routeCalls) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const calleeName = callee.getName();

      if (calleeName === 'otherwise') {
        const [pathArg] = call.getArguments();
        if (!pathArg || !Node.isStringLiteral(pathArg)) {
          skipReasons.push(`${moduleName ?? 'config'}: otherwise() argument is not a plain string literal — not safely transformable`);
          continue;
        }
        entries.push(`{ path: '**', redirectTo: '${toRouterPath(pathArg.getLiteralText())}' }`);
        continue;
      }

      const [nameOrPathArg, configArg] = call.getArguments();
      if (!nameOrPathArg || !Node.isStringLiteral(nameOrPathArg)) {
        skipReasons.push(`${moduleName ?? 'config'}: ${calleeName}() name/path is not a plain string literal — not safely transformable`);
        continue;
      }
      const nameOrPath = nameOrPathArg.getLiteralText();

      if (calleeName === 'state' && nameOrPath.includes('.')) {
        skipReasons.push(`${nameOrPath}: nested state — out of scope for pattern #8 (flat states only)`);
        continue;
      }

      if (!configArg || !Node.isObjectLiteralExpression(configArg)) {
        skipReasons.push(`${nameOrPath}: route config is not a plain object literal — not safely transformable`);
        continue;
      }
      const config: ObjectLiteralExpression = configArg;

      if (calleeName === 'state') {
        const abstractProp = getObjectLiteralProperty(config, 'abstract');
        if (abstractProp.present && abstractProp.value?.getKind() !== SyntaxKind.FalseKeyword) {
          skipReasons.push(`${nameOrPath}: abstract state — no leaf route to render, out of scope for pattern #8`);
          continue;
        }
      }

      let routerPath: string;
      if (calleeName === 'state') {
        const urlProp = getObjectLiteralProperty(config, 'url');
        if (!urlProp.present || !urlProp.value || !Node.isStringLiteral(urlProp.value)) {
          skipReasons.push(`${nameOrPath}: no plain string "url" property — not safely transformable`);
          continue;
        }
        routerPath = toRouterPath(urlProp.value.getLiteralText());
      } else {
        routerPath = toRouterPath(nameOrPath);
      }

      const derivedBase = calleeName === 'state' ? pascalCaseSegment(nameOrPath) : deriveComponentNameFromPath(nameOrPath);
      const className = derivedBase ? `${derivedBase}Component` : undefined;
      if (!className || !isValidClassName(className)) {
        skipReasons.push(`${nameOrPath}: could not derive a valid component class name — not safely transformable`);
        continue;
      }
      if (usedNames.has(className) || localUsedNames.has(className) || hasExistingTopLevelBinding(sourceFile, className)) {
        skipReasons.push(`${nameOrPath}: derived class name "${className}" collides with an existing name in this file — ambiguous, not safely transformable`);
        continue;
      }
      localUsedNames.add(className);

      entries.push(`{ path: '${routerPath}', component: ${className} }`);
    }

    if (entries.length === 0) continue;

    const routesVarName = deriveRoutesVarName(moduleName);
    if (!isValidClassName(routesVarName)) {
      skipReasons.push(`${routesVarName}: derived routes constant name is not a valid identifier — not safely transformable`);
      continue;
    }
    if (usedNames.has(routesVarName) || localUsedNames.has(routesVarName) || hasExistingTopLevelBinding(sourceFile, routesVarName)) {
      skipReasons.push(`${routesVarName}: derived routes constant name collides with an existing name in this file — ambiguous, not safely transformable`);
      continue;
    }

    // Two-phase commit (ADR-042 precedent): names derived while walking
    // this registration's route calls are only merged into the
    // file-wide `usedNames` set now that the whole registration —
    // routes variable name included — is confirmed to survive. A
    // registration that fails here (e.g. on the routes-variable
    // collision above) must never have already claimed its entries'
    // component names, or a later, unrelated registration in the same
    // file would be wrongly blocked from reusing them.
    for (const name of localUsedNames) usedNames.add(name);
    usedNames.add(routesVarName);

    insertions.push({
      pos: topStmtStart,
      text: `const ${routesVarName}: Routes = [\n  ${entries.join(',\n  ')},\n];`,
    });
  }

  if (insertions.length === 0) {
    return {
      matched: false,
      reason: skipReasons.length > 0 ? skipReasons.join('; ') : 'no flat $routeProvider/ui-router route registration found',
    };
  }

  const output = applyEdits(sourceFile.getFullText(), groupInsertionsByPosition(insertions));

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
