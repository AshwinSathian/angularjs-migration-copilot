import { Node } from 'ts-morph';

/**
 * Pulls dependency-injection names out of an AngularJS definition argument,
 * whichever style it's written in:
 *
 *   ['$http', 'MyService', function ($http, MyService) { ... }]   // array-style
 *   function ($http, MyService) { ... }                            // bare function
 *
 * Both forms show up across real codebases — codemod pattern #3 in
 * docs/product-spec.md §6.3 exists specifically to convert the former to
 * constructor injection, which means inventory has to recognize both.
 */
export function extractDependencyNames(definitionArg: Node | undefined): string[] {
  if (!definitionArg) return [];

  if (Node.isArrayLiteralExpression(definitionArg)) {
    return definitionArg
      .getElements()
      .filter((element) => Node.isStringLiteral(element))
      .map((element) => element.getLiteralText());
  }

  if (Node.isFunctionExpression(definitionArg) || Node.isArrowFunction(definitionArg)) {
    return definitionArg.getParameters().map((param) => param.getName());
  }

  return [];
}
