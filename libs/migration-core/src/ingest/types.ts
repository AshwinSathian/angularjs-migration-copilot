export interface AngularVersionDetection {
  readonly detected: boolean;
  readonly version?: string;
  readonly source?: 'package.json' | 'bower.json';
}

export type BuildTool = 'gulp' | 'grunt' | 'webpack' | 'none';

export interface TestRunnerDetection {
  readonly tool: 'karma' | 'none';
  readonly configPath?: string;
  /**
   * Whether the config's `browsers` list references PhantomJS — a strong
   * signal it will fail outright on any current Node version, since
   * PhantomJS itself has been unmaintained since 2018. This is a static
   * signal, not proof the suite is broken or that it isn't: actually
   * running it is Stage 4's job (docs/milestones/m2-verification.md), not
   * ingest's.
   */
  readonly usesPhantomJs: boolean;
  /**
   * The config text with PhantomJS swapped for ChromeHeadless, present
   * only when `usesPhantomJs` is true. Generated, not applied or executed
   * — see `remediateKarmaConfig`'s doc comment for exactly what this
   * does and doesn't prove.
   */
  readonly remediatedConfig?: string;
}

export interface IngestReport {
  readonly angularVersion: AngularVersionDetection;
  readonly buildTool: BuildTool;
  readonly testRunner: TestRunnerDetection;
  readonly secretsFound: number;
}
