import { Node, type Project } from 'ts-morph';
import type { ModuleDeclaration } from './types.js';

/**
 * Finds `angular.module('name', [deps])` calls — the two-argument form
 * *declares* a module and lists the other modules it depends on. The
 * one-argument form (`angular.module('name')`) just retrieves an
 * already-declared module and isn't a declaration, so it's excluded.
 */
export function scanModuleDeclarations(project: Project): ModuleDeclaration[] {
  const modules: ModuleDeclaration[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expression = node.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) return;
      if (expression.getName() !== 'module') return;
      if (expression.getExpression().getText() !== 'angular') return;

      const [nameArg, depsArg] = node.getArguments();
      if (!nameArg || !Node.isStringLiteral(nameArg) || !depsArg) return;

      const dependsOnModules = Node.isArrayLiteralExpression(depsArg)
        ? depsArg
            .getElements()
            .filter((el) => Node.isStringLiteral(el))
            .map((el) => el.getLiteralText())
        : [];

      modules.push({
        name: nameArg.getLiteralText(),
        dependsOnModules,
        filePath: sourceFile.getFilePath(),
        line: node.getStartLineNumber(),
      });
    });
  }

  return modules;
}
