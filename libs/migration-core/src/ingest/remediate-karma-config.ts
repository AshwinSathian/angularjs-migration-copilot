export interface KarmaRemediationResult {
  readonly changed: boolean;
  readonly remediated: string;
}

/**
 * The one documented automated remediation from docs/product-spec.md §6.1:
 * swap a dead PhantomJS launcher for headless Chrome. This only rewrites
 * the config text — it doesn't install `karma-chrome-launcher`, doesn't
 * run the suite, and doesn't decide whether the remediation "worked."
 * Whoever calls this still has to actually run the suite against the
 * result and check the exit code; a config that merely mentions
 * ChromeHeadless is not a passing test suite.
 */
export function remediateKarmaConfig(configContent: string): KarmaRemediationResult {
  if (!/PhantomJS/.test(configContent)) {
    return { changed: false, remediated: configContent };
  }

  const remediated = configContent
    .replace(/(['"])PhantomJS\1/g, '$1ChromeHeadless$1')
    .replace(/PhantomJS(?=[\s,\]])/g, 'ChromeHeadless');

  return { changed: true, remediated };
}
