import { Node, Project, type ObjectLiteralExpression, type PropertyAccessExpression } from 'ts-morph';
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
import { getObjectLiteralProperty, toKebabCase, toPascalCase } from './directive-to-component.js';
import type { CodemodResult } from './types.js';

/**
 * Pattern #9 (`docs/product-spec.md §6.3`) — one-way `bindings: { x: '<' }`
 * → `@Input()`. Scoped to `.component()` registrations only, not
 * `.directive()`'s isolate `scope: {...}` object — ADR-039 (pattern #4)
 * deferred directive isolate-scope translation here by name, but real
 * fixture evidence (checked before writing this, same standing practice
 * as every prior pattern) shows that deferral wouldn't unlock anything:
 * every real isolate-`scope` directive across all three vendored fixtures
 * (7 files in `blur-admin`, the only fixture using the idiom at all) also
 * has a `link` function doing raw DOM manipulation, which pattern #4
 * already unconditionally skips independent of scope — so a directive
 * that could ever reach this pattern's bindings-translation step doesn't
 * exist in this project's own fixtures, and building it would duplicate
 * pattern #4's entire DDO-extraction/controller/selector machinery a
 * second time with zero fixture evidence to verify it against. Flagged as
 * a considered, not-forgotten deferral in `docs/decisions.md` ADR-041,
 * same "flag, don't guess" precedent as every other real-but-unverifiable
 * gap in this codebase (e.g. ADR-019's scan-routes aliasing gap).
 *
 * `.component()`'s definition object is a plain object literal passed
 * directly as the call's second argument (no wrapping factory function
 * the way `.directive`'s DDO is), so this pattern doesn't need
 * `resolveNamedFunctionDeclaration`/`extractDdo`-style factory-body
 * unwrapping the way pattern #4 does — it only needs to resolve the
 * `controller` property, which (same real-fixture idiom ADR-030 found for
 * `.controller`) is either an inline function/arrow or a named reference.
 * Like pattern #4, this never deletes or replaces the original
 * `.component(...)` call — a `@Component`-decorated class isn't valid
 * AngularJS registration syntax — the new class is inserted alongside the
 * untouched original instead, which sidesteps pattern #3's entire
 * nesting-conflict bug class (ADR-034–038) the same way pattern #4 does.
 *
 * Only the one-way (`<`, optionally `<?` and/or aliased to a different
 * attribute name, e.g. `<myAttr`) binding shape is in scope, per the
 * pattern's own literal definition — a two-way (`=`), interpolated (`@`),
 * or expression (`&`) binding anywhere in `bindings` is a documented
 * whole-registration skip, not partially translated and not guessed at.
 * Real-fixture check (this session): zero `.component()` registrations
 * across all three vendored fixtures declare a `bindings` property at
 * all (`angular-phonecat`'s only two `.component()` calls, the sole real
 * `.component()` usage in any of the three fixtures, have neither) — so
 * this pattern's honest real hit-rate is 0/0/0/0 across all three repos,
 * reported as such rather than smoothed or omitted, same as pattern #3's
 * ADR-034 precedent for an equally real, equally zero-hit fix.
 */

interface RawMatch {
  readonly componentName: string;
  readonly definitionArg: Node | undefined;
  readonly sortKey: number;
  readonly topStmtStart: number;
}

interface InputField {
  readonly propName: string;
  readonly alias: string | undefined;
}

/** `mode` + optional `?` + optional alternate attribute name — AngularJS's own binding-definition syntax. Only `<`/`<?` (with or without an alias) is one-way; anything else is a different, out-of-scope binding mode. */
const ONE_WAY_BINDING = /^<(\?)?([A-Za-z_$][\w$]*)?$/;

type BindingsResult = { readonly fields: readonly InputField[] } | { readonly skipReason: string };

function parseBindings(bindingsObj: ObjectLiteralExpression, componentName: string): BindingsResult {
  const fields: InputField[] = [];

  for (const prop of bindingsObj.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) {
      return {
        skipReason: `${componentName}: a binding is not a plain "key: value" assignment (e.g. method shorthand) — not safely transformable`,
      };
    }
    const nameNode = prop.getNameNode();
    const propName = Node.isIdentifier(nameNode)
      ? nameNode.getText()
      : Node.isStringLiteral(nameNode)
        ? nameNode.getLiteralText()
        : undefined;
    const initializer = prop.getInitializer();

    if (!propName || !initializer || !Node.isStringLiteral(initializer)) {
      return {
        skipReason: `${componentName}: binding "${propName ?? prop.getText()}" does not have a plain string-literal mode — not safely transformable`,
      };
    }

    const modeText = initializer.getLiteralText();
    const match = ONE_WAY_BINDING.exec(modeText);
    if (!match) {
      return {
        skipReason: `${componentName}: binding "${propName}" uses mode "${modeText}", not one-way ('<') — out of scope for this pattern`,
      };
    }

    fields.push({ propName, alias: match[2] });
  }

  return { fields };
}

export function transformBindingsToInput(sourceText: string): CodemodResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  const sourceFile = project.createSourceFile('/virtual/app.js', sourceText);

  const rawMatches: RawMatch[] = [];

  forEachPropertyAccessCall(project, (call, expression: PropertyAccessExpression) => {
    if (expression.getName() !== 'component') return;

    const [nameArg, definitionArg] = call.getArguments();
    if (!nameArg || !Node.isStringLiteral(nameArg)) return;

    rawMatches.push({
      componentName: nameArg.getLiteralText(),
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
    const { componentName, definitionArg } = match;

    if (!definitionArg || !Node.isObjectLiteralExpression(definitionArg)) continue;

    const bindingsProp = getObjectLiteralProperty(definitionArg, 'bindings');
    if (!bindingsProp.present) continue; // no bindings at all — not this pattern's target, not a skip

    if (!bindingsProp.value || !Node.isObjectLiteralExpression(bindingsProp.value)) {
      skipReasons.push(`${componentName}: bindings is not an inline object literal — not safely transformable`);
      continue;
    }

    const parsed = parseBindings(bindingsProp.value, componentName);
    if ('skipReason' in parsed) {
      skipReasons.push(parsed.skipReason);
      continue;
    }

    const controllerProp = getObjectLiteralProperty(definitionArg, 'controller');
    let controllerFn: WrappableFunction | undefined;
    if (controllerProp.present) {
      const { value } = controllerProp;
      if (value && (Node.isFunctionExpression(value) || Node.isArrowFunction(value))) {
        controllerFn = value;
      } else if (value && Node.isIdentifier(value)) {
        controllerFn = resolveNamedFunctionDeclaration(value);
        if (!controllerFn) {
          skipReasons.push(`${componentName}: controller reference does not resolve to a single function declaration — not safely transformable`);
          continue;
        }
      } else {
        skipReasons.push(
          `${componentName}: controller is a string, array-style DI, or an unsupported shape (e.g. method shorthand) — not safely transformable`
        );
        continue;
      }
    }

    if (controllerFn && !controllerFn.getParameters().every(isSimpleParameter)) {
      skipReasons.push(`${componentName}: controller has a destructured, default-valued, or rest parameter — not safely transformable`);
      continue;
    }

    // A parameter property (`private <name>: any`) auto-declares a class
    // member of that name — if a binding shares a name with a controller
    // dependency, the emitted `@Input()` field and the constructor's own
    // parameter property would collide as two declarations of the same
    // class member. Not seen in any real fixture (zero real bindings
    // exist to check against), but cheap to guard against rather than
    // emit a plausible compile error unchecked.
    const depNames = new Set((controllerFn?.getParameters() ?? []).map((p) => p.getName()));
    const collidingField = parsed.fields.find((f) => depNames.has(f.propName));
    if (collidingField) {
      skipReasons.push(
        `${componentName}: binding "${collidingField.propName}" has the same name as a controller dependency — ambiguous, not safely transformable`
      );
      continue;
    }

    const className = `${toPascalCase(componentName)}Component`;
    if (!isValidClassName(className)) {
      skipReasons.push(`${componentName}: derived class name "${className}" is not a valid identifier — not safely transformable`);
      continue;
    }
    if (usedClassNames.has(className) || hasExistingTopLevelBinding(sourceFile, className)) {
      skipReasons.push(`${componentName}: derived class name "${className}" collides with an existing name in this file — ambiguous, not safely transformable`);
      continue;
    }
    usedClassNames.add(className);

    const templateProperty = getObjectLiteralProperty(definitionArg, 'template');
    const templateUrlProperty = getObjectLiteralProperty(definitionArg, 'templateUrl');
    let templateProp: string | undefined;
    if (templateProperty.present) {
      if (!templateProperty.value || !Node.isStringLiteral(templateProperty.value)) {
        skipReasons.push(`${componentName}: template is not a plain string literal — not safely transformable`);
        continue;
      }
      templateProp = `template: ${templateProperty.value.getText()}`;
    } else if (templateUrlProperty.present) {
      if (!templateUrlProperty.value || !Node.isStringLiteral(templateUrlProperty.value)) {
        skipReasons.push(`${componentName}: templateUrl is not a plain string literal — not safely transformable`);
        continue;
      }
      templateProp = `templateUrl: ${templateUrlProperty.value.getText()}`;
    }

    const selector = toKebabCase(componentName);
    const decoratorProps = [`selector: '${selector}'`, templateProp].filter((p): p is string => Boolean(p));
    const inputFieldsText = parsed.fields
      .map((f) => (f.alias ? `@Input('${f.alias}') ${f.propName}: any;` : `@Input() ${f.propName}: any;`))
      .join('\n  ');
    const constructorText = controllerFn
      ? `\n  constructor(${constructorParamsText(controllerFn)}) ${functionBodyText(controllerFn)}\n`
      : '';
    const classBody = [inputFieldsText, constructorText].filter((s) => s.length > 0).join('\n  ');
    const classText = `@Component({\n  ${decoratorProps.join(',\n  ')},\n})\nclass ${className} {\n  ${classBody}\n}`;

    insertions.push({ pos: match.topStmtStart, text: classText });
  }

  if (insertions.length === 0) {
    return {
      matched: false,
      reason: skipReasons.length > 0 ? skipReasons.join('; ') : 'no .component() registration with one-way bindings found',
    };
  }

  const output = applyEdits(sourceFile.getFullText(), groupInsertionsByPosition(insertions));

  return skipReasons.length > 0 ? { matched: true, output, warnings: skipReasons } : { matched: true, output };
}
