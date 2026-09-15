import { Node, Project, type ArrayLiteralExpression, type SourceFile } from 'ts-morph';

export interface KarmaRemediationResult {
  readonly changed: boolean;
  readonly remediated: string;
}

function parse(configContent: string): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });
  return project.createSourceFile('/virtual/karma.conf.js', configContent);
}

/**
 * Finds the `browsers: [...]` array inside a `config.set({ ... })` call —
 * the standard shape every karma-config generator produces. Scoped to
 * exactly this property, not the whole file: an earlier version matched
 * "PhantomJS" as a raw substring anywhere in the file, which meant a
 * leftover comment or a `customLaunchers` entry could trigger a false
 * positive, or — worse, during remediation — get silently rewritten too.
 * (The direct-assignment form, `config.browsers = [...]`, isn't matched;
 * it's rare enough in practice that this is an honest, narrower-but-correct
 * scope rather than a silent gap.)
 */
function findBrowsersArray(sourceFile: SourceFile): ArrayLiteralExpression | undefined {
  let result: ArrayLiteralExpression | undefined;

  sourceFile.forEachDescendant((node, traversal) => {
    if (result) {
      traversal.stop();
      return;
    }
    if (!Node.isPropertyAssignment(node)) return;
    if (node.getName() !== 'browsers') return;
    const initializer = node.getInitializer();
    if (initializer && Node.isArrayLiteralExpression(initializer)) {
      result = initializer;
    }
  });

  return result;
}

/**
 * Whether a Karma config's `browsers` array lists PhantomJS — unmaintained
 * since 2018 and the most common reason a legacy AngularJS test suite
 * fails outright on a current Node version. This is static detection only:
 * it doesn't run the suite, so it can say "this config looks like it'll
 * fail," never "this suite passes." Actually running it is Stage 4's job —
 * see docs/milestones/m2-verification.md.
 */
export function karmaConfigUsesPhantomJs(configContent: string): boolean {
  const browsers = findBrowsersArray(parse(configContent));
  if (!browsers) return false;

  return browsers
    .getElements()
    .some((element) => Node.isStringLiteral(element) && element.getLiteralText() === 'PhantomJS');
}

/**
 * The one documented automated remediation from docs/product-spec.md §6.1:
 * swap a dead PhantomJS launcher for headless Chrome, in the `browsers`
 * array specifically. This only rewrites the config text — it doesn't
 * install `karma-chrome-launcher`, doesn't run the suite, and doesn't
 * decide whether the remediation "worked." Whoever calls this still has to
 * actually run the suite against the result and check the exit code; a
 * config that merely mentions ChromeHeadless is not a passing test suite.
 */
export function remediateKarmaConfig(configContent: string): KarmaRemediationResult {
  const sourceFile = parse(configContent);
  const browsers = findBrowsersArray(sourceFile);
  if (!browsers) return { changed: false, remediated: configContent };

  let changed = false;
  for (const element of browsers.getElements()) {
    if (!Node.isStringLiteral(element) || element.getLiteralText() !== 'PhantomJS') continue;
    const quote = element.getText().at(0) ?? "'";
    element.replaceWithText(`${quote}ChromeHeadless${quote}`);
    changed = true;
  }

  return changed
    ? { changed: true, remediated: sourceFile.getFullText() }
    : { changed: false, remediated: configContent };
}
