export { runIngest } from './run-ingest.js';
export { detectAngularVersion } from './detect-angular-version.js';
export { detectBuildTooling } from './detect-build-tooling.js';
export { detectTestRunner } from './detect-test-runner.js';
export { karmaConfigUsesPhantomJs, remediateKarmaConfig } from './karma-config.js';
export type { KarmaRemediationResult } from './karma-config.js';
export { scanRepoForSecrets } from './scan-repo-for-secrets.js';
export type {
  AngularVersionDetection,
  BuildTool,
  IngestReport,
  TestRunnerDetection,
} from './types.js';
