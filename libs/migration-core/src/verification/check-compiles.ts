import { runCommand } from '../scaffold/index.js';
import type { CompileCheckResult, CompileDiagnostic } from './types.js';

const DEFAULT_APP_TSCONFIG = 'tsconfig.app.json';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
/** `path:line:col - error CODE: message` (ngc's pretty form) or `path(line,col): error CODE: message` (tsc's plain form). */
const DIAGNOSTIC_LINE = /^(.+?)(?::\d+:\d+ - |\(\d+,\d+\): )error (TS-?\d+|NG\d+): (.*)$/;

export function parseDiagnostics(log: string): readonly CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const line of log.replace(ANSI, '').split('\n')) {
    const match = DIAGNOSTIC_LINE.exec(line.trim());
    if (match) diagnostics.push({ file: match[1], code: match[2].replace('TS-99', 'NG'), message: match[3] });
  }
  return diagnostics;
}

/**
 * Stage 4 clause 1 (docs/product-spec.md §6.5): compiles the whole
 * scaffolded workspace with the Angular compiler, `ngc --noEmit` — never
 * the source repo.
 *
 * `ngc`, not bare `tsc` (docs/decisions.md ADR-061): `tsc` ignores
 * `angularCompilerOptions`, so it accepts an unresolvable DI token
 * (`NG2003`), an unknown element (`NG8001`), and a template bound to a
 * property that doesn't exist. Confirmed by running both against the
 * same file in a real workspace: `tsc` exit 0, `ngc` exit 1.
 *
 * `--no-install` so a workspace without `@angular/compiler-cli` fails
 * here instead of `npx` fetching whatever version is current.
 */
export async function runCompileCheck(
  workspaceDir: string,
  appTsConfigPath: string = DEFAULT_APP_TSCONFIG
): Promise<CompileCheckResult> {
  const result = await runCommand('npx', ['--no-install', 'ngc', '-p', appTsConfigPath, '--noEmit'], {
    cwd: workspaceDir,
  });
  const log = `${result.stdout}${result.stderr}`;
  if (result.exitCode === 0) return { passed: true, log };

  const diagnostics = result.reason ? [] : parseDiagnostics(log);
  return { passed: false, log, failure: diagnostics.length > 0 ? 'diagnostics' : 'could-not-run', diagnostics };
}
