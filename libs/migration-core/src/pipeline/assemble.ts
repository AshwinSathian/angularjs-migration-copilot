import { posix } from 'node:path';
import { Node, Project, SyntaxKind, type ClassDeclaration, type SourceFile } from 'ts-morph';
import {
  transformArrayStyleDiToConstructor,
  transformBindingsToInput,
  transformControllerAsToClass,
  transformDirectiveToComponent,
  transformEventBusToSubject,
  transformFilterToPipe,
  transformHttpThenToHttpClient,
  transformRoutesToRouterConfig,
  transformScopeAssignmentToClassProperty,
  type CodemodResult,
} from '../codemods/index.js';
import { toKebabCase } from '../codemods/directive-to-component.js';
import type { ArtifactType } from '../verification/index.js';

/** The nine script patterns of docs/product-spec.md §6.3, by pattern number. Pattern #7 (templates) is applied by the runner. */
export const SCRIPT_CODEMODS: readonly (readonly [string, (sourceText: string) => CodemodResult])[] = [
  ['#1 scope-assignment-to-class-property', transformScopeAssignmentToClassProperty],
  ['#2 controlleras-to-class', transformControllerAsToClass],
  ['#3 array-di-to-constructor', transformArrayStyleDiToConstructor],
  ['#4 directive-to-component', transformDirectiveToComponent],
  ['#5 filter-to-pipe', transformFilterToPipe],
  ['#6 http-then-to-httpclient', transformHttpThenToHttpClient],
  ['#8 routes-to-router-config', transformRoutesToRouterConfig],
  ['#9 bindings-to-input', transformBindingsToInput],
  ['#10 event-bus-to-subject', transformEventBusToSubject],
];

const IMPORT_SOURCES: Readonly<Record<string, string>> = {
  Component: '@angular/core',
  Directive: '@angular/core',
  Pipe: '@angular/core',
  Injectable: '@angular/core',
  Input: '@angular/core',
  Inject: '@angular/core',
  HttpClient: '@angular/common/http',
  Routes: '@angular/router',
  Observable: 'rxjs',
  Subject: 'rxjs',
};

export interface AssembledDeclaration {
  readonly pattern: string;
  readonly name: string;
  readonly artifactType: ArtifactType;
  /** Workspace-relative, POSIX separators. */
  readonly emittedPath: string;
  readonly content: string;
  /** What a human (or Stage 3) still has to do for this file to work at runtime, even if it compiles. */
  readonly followUps: readonly string[];
  /** The `templateUrl` string as written in the source, when the declaration has one. The runner resolves and rewrites it. */
  readonly templateUrl?: string;
}

export interface AssembledFile {
  readonly matchedPatterns: readonly string[];
  readonly declarations: readonly AssembledDeclaration[];
  /** Per-pattern notes: why a pattern did not apply, codemod warnings, and anything dropped here. */
  readonly notes: readonly string[];
}

function parse(project: Project, path: string, text: string): SourceFile {
  return project.createSourceFile(path, text, { overwrite: true });
}

function decoratorName(declaration: ClassDeclaration): string | undefined {
  return declaration.getDecorators()[0]?.getName();
}

/** `.controller('X', X)` / `.service(...)` / `.factory(...)` — the registration kind an undecorated class was wrapped for. */
function registrationKind(output: SourceFile, className: string): string | undefined {
  for (const call of output.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (call.getArguments().some((arg) => Node.isIdentifier(arg) && arg.getText() === className)) return callee.getName();
  }
  return undefined;
}

function classify(output: SourceFile, declaration: Node, name: string): { artifactType: ArtifactType; suffix: string } {
  if (!Node.isClassDeclaration(declaration)) return { artifactType: 'route', suffix: 'routes' };
  switch (decoratorName(declaration)) {
    case 'Component':
      return { artifactType: 'directive', suffix: 'component' };
    case 'Directive':
      return { artifactType: 'directive', suffix: 'directive' };
    case 'Pipe':
      return { artifactType: 'filter', suffix: 'pipe' };
    case 'Injectable':
      return { artifactType: 'service', suffix: 'service' };
    default:
      return registrationKind(output, name) === 'controller'
        ? { artifactType: 'controller', suffix: 'controller' }
        : { artifactType: 'service', suffix: 'service' };
  }
}

function importsFor(file: SourceFile): string {
  const used = new Set(file.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()));
  const bySource = new Map<string, string[]>();
  for (const [symbol, source] of Object.entries(IMPORT_SOURCES)) {
    if (used.has(symbol)) bySource.set(source, [...(bySource.get(source) ?? []), symbol]);
  }
  return [...bySource].map(([source, symbols]) => `import { ${symbols.join(', ')} } from '${source}';\n`).join('');
}

/**
 * Patterns #1 and #2 target "class property" (docs/product-spec.md §6.3)
 * but emit only the constructor's assignments, never the properties, so
 * every `this.x = y` is `TS2339` under the workspace's strict settings.
 * This declares each assigned field (`x: any;`) — completing those two
 * patterns' stated output, nothing more: no types are inferred and no
 * statement is rewritten.
 *
 * Counted: `this.x = …` whose nearest non-arrow function is the
 * constructor, and `alias.x = …` at any depth where the constructor
 * declares `var alias = this` (a closure keeps `alias` correct inside
 * callbacks; `this` it does not).
 */
function declareAssignedFields(declaration: ClassDeclaration): void {
  const ctor = declaration.getConstructors()[0];
  if (!ctor) return;
  const aliases = new Set(
    ctor
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .filter((v) => v.getInitializer()?.getKind() === SyntaxKind.ThisKeyword)
      .map((v) => v.getName())
  );
  const names = new Set<string>();
  for (const assignment of ctor.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const left = assignment.getLeft();
    if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken || !Node.isPropertyAccessExpression(left)) continue;
    const target = left.getExpression();
    const viaAlias = Node.isIdentifier(target) && aliases.has(target.getText());
    const viaThis =
      target.getKind() === SyntaxKind.ThisKeyword &&
      target.getFirstAncestor(
        (a) => Node.isFunctionExpression(a) || Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a) || Node.isConstructorDeclaration(a) || Node.isGetAccessorDeclaration(a) || Node.isSetAccessorDeclaration(a)
      ) === ctor;
    if (viaAlias || viaThis) names.add(left.getName());
  }
  const taken = new Set([
    ...declaration.getMembers().map((m) => (Node.isConstructorDeclaration(m) ? '' : (m as { getName?: () => string }).getName?.() ?? '')),
    ...ctor.getParameters().filter((p) => p.isParameterProperty()).map((p) => p.getName()),
  ]);
  const fields = [...names].filter((name) => !taken.has(name));
  if (fields.length > 0) declaration.insertProperties(0, fields.map((name) => ({ name, type: 'any' })));
}

/**
 * File-scope helpers the declaration reads — `function random(min, max)`
 * beside a controller, a `var` of shared constants — found by symbol
 * resolution and followed transitively. Without them the class is lifted
 * out of the only scope where those names exist. Only module-level
 * functions and variables of the same source file qualify; anything
 * declared in another file stays unresolved, for the gate to reject.
 */
function fileScopeDependencies(output: SourceFile, declaration: Node): Node[] {
  const moduleScopes = new Set<Node>([output, ...output.getDescendantsOfKind(SyntaxKind.Block).filter((block) => {
    const fn = block.getParent();
    return Node.isFunctionExpression(fn) && Node.isParenthesizedExpression(fn.getParent()); // the IIFE module wrapper
  })]);
  const lifted = new Map<string, Node>();
  const queue: Node[] = [declaration];
  for (let node = queue.shift(); node; node = queue.shift()) {
    for (const identifier of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const name = identifier.getText();
      if (lifted.has(name)) continue;
      for (const found of identifier.getSymbol()?.getDeclarations() ?? []) {
        const statement = Node.isFunctionDeclaration(found)
          ? found
          : Node.isVariableDeclaration(found)
            ? found.getVariableStatement()
            : undefined;
        if (!statement || statement === declaration || !moduleScopes.has(statement.getParentOrThrow())) continue;
        if (statement.getFirstAncestor((a) => a === declaration)) continue;
        lifted.set(name, statement);
        queue.push(statement);
        break; // a name declared twice at file scope (CoreUI's `random`) is lifted once
      }
    }
  }
  return [...new Set(lifted.values())].sort((a, b) => a.getPos() - b.getPos());
}

/**
 * Typing the JavaScript that was lifted, so the workspace's strict
 * settings judge its logic rather than its lack of annotations:
 * - every untyped parameter of a plain function becomes `any` (arrow
 *   functions are left alone — they are contextually typed, and one
 *   written `x => …` has no parentheses to hold an annotation);
 * - in a decorated class, a constructor parameter typed `any` gets
 *   `@Inject('<name>')`. AngularJS injects by name, so the name is the
 *   faithful token; Angular's compiler otherwise rejects the class
 *   (`NG2003`). Nothing provides that token yet — which is why each one
 *   is returned as a follow-up, and why the file can be at most LOW.
 */
function finalize(content: string): { content: string; followUps: string[] } {
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile('/emitted.ts', content);
  const followUps: string[] = [];
  for (const classDeclaration of file.getClasses()) {
    const decorated = classDeclaration.getDecorators().length > 0;
    for (const parameter of classDeclaration.getConstructors()[0]?.getParameters() ?? []) {
      if (parameter.getTypeNode()?.getText() !== 'any') continue;
      followUps.push(`provide '${parameter.getName()}': an AngularJS injectable with no Angular provider yet`);
      if (decorated && parameter.getDecorators().length === 0) {
        parameter.addDecorator({ name: 'Inject', arguments: [`'${parameter.getName()}'`] });
      }
    }
  }
  for (const parameter of file.getDescendantsOfKind(SyntaxKind.Parameter)) {
    const owner = parameter.getParent();
    if (parameter.getTypeNode() || parameter.getInitializer() || Node.isArrowFunction(owner)) continue;
    parameter.setType(parameter.isRestParameter() ? 'any[]' : 'any');
  }
  const body = file.getFullText();
  return { content: body.replace(/\n\n/, `\n${importsFor(file)}\n`), followUps };
}

/** The declaration's text with `export` added in modifier position (after any decorators), via the AST rather than string surgery. */
function exportedText(declaration: Node): string {
  if (Node.isClassDeclaration(declaration) && declaration.getDecorators().length === 0) declareAssignedFields(declaration);
  if (Node.isClassDeclaration(declaration) || Node.isVariableStatement(declaration)) declaration.setIsExported(true);
  return declaration.getText();
}

function templateUrlOf(declaration: Node): string | undefined {
  for (const property of declaration.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const value = property.getInitializer();
    if (property.getName() === 'templateUrl' && value && Node.isStringLiteral(value)) return value.getLiteralText();
  }
  return undefined;
}

/**
 * Stage 2 for one script file (docs/milestones/m2.5-assembler.md).
 *
 * Every codemod runs against the *original* source, never against
 * another codemod's output — the patterns were built and reviewed as
 * independent single-file transforms, and chaining them would create
 * interactions nothing has tested. From each matched output this lifts
 * out what the codemod added — a class the original did not have, or a
 * `Routes` constant — and wraps it as a standalone module: `export`,
 * the `@angular/*`/`rxjs` imports it uses, nothing else. The AngularJS
 * registration code the codemod left beside it stays behind.
 *
 * One completion is applied — fields a wrapped constructor assigns are
 * declared (`declareAssignedFields`). Beyond that it does not repair
 * what the codemod produced: a DI parameter typed `any`, a free
 * AngularJS global, a reference to a component that was never migrated
 * are all emitted as-is, for the gate to judge.
 */
export function assembleScript(sourcePath: string, sourceText: string): AssembledFile {
  const project = new Project({ useInMemoryFileSystem: true });
  const original = parse(project, '/original.ts', sourceText);
  const existing = new Set([
    ...original.getDescendantsOfKind(SyntaxKind.ClassDeclaration).map((c) => c.getName()),
    ...original.getDescendantsOfKind(SyntaxKind.VariableDeclaration).map((v) => v.getName()),
  ]);

  const directory = posix.dirname(sourcePath);
  const matchedPatterns: string[] = [];
  const declarations: AssembledDeclaration[] = [];
  const notes: string[] = [];
  const taken = new Set<string>();

  for (const [pattern, transform] of SCRIPT_CODEMODS) {
    let result: CodemodResult;
    try {
      result = transform(sourceText);
    } catch (error) {
      notes.push(`${pattern}: codemod threw — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!result.matched) {
      notes.push(`${pattern}: ${result.reason}`);
      continue;
    }
    matchedPatterns.push(pattern);
    for (const warning of result.warnings ?? []) notes.push(`${pattern}: ${warning}`);

    const output = parse(project, '/output.ts', result.output);
    const added: Node[] = [
      ...output.getDescendantsOfKind(SyntaxKind.ClassDeclaration),
      ...output
        .getDescendantsOfKind(SyntaxKind.VariableStatement)
        .filter((s) => s.getDeclarations()[0]?.getTypeNode()?.getText() === 'Routes'),
    ];
    for (const declaration of added) {
      const name = Node.isClassDeclaration(declaration)
        ? declaration.getName()
        : Node.isVariableStatement(declaration)
          ? declaration.getDeclarations()[0].getName()
          : undefined;
      if (!name || existing.has(name)) continue;
      if (taken.has(name)) {
        notes.push(`${pattern}: ${name} was already produced by an earlier pattern for this file — not emitted twice`);
        continue;
      }
      taken.add(name);
      const { artifactType, suffix } = classify(output, declaration, name);
      const helpers = fileScopeDependencies(output, declaration).map((helper) => helper.getText());
      const baseName = toKebabCase(name).replace(new RegExp(`-(${suffix}|ctrl|controller)$`), '') || toKebabCase(name);
      declarations.push({
        pattern,
        name,
        artifactType,
        emittedPath: posix.join('src/app/migrated', directory, `${baseName}.${suffix}.ts`),
        ...finalize(
          [`// Migrated from ${sourcePath} by pattern ${pattern}.`, '', ...helpers, exportedText(declaration), ''].join('\n')
        ),
        templateUrl: templateUrlOf(declaration),
      });
    }
  }

  return { matchedPatterns, declarations, notes };
}
