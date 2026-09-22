import vm from 'node:vm';
import type { SandboxOutcome } from '../types.js';

const DEFAULT_TIMEOUT_MS = 1000;

/**
 * Runs a standalone, self-contained function/arrow source string against
 * one input tuple inside a fresh `node:vm` context — deliberately not a
 * real Angular runtime or a real Node module system. Characterization
 * eligibility (eligibility.ts) already guarantees the function neither
 * touches `$scope`/DOM globals nor calls an async Angular service, so it
 * needs nothing from either runtime to execute correctly; running it
 * this way instead of bootstrapping Angular's DI is what makes clause 3
 * fast and dependency-free rather than a second, slower compile-and-run
 * cycle on top of clause 1's already-real `tsc` check.
 *
 * A timeout (default 1s, generous for a pure function operating on
 * boundary-sized inputs) guards against an accidental infinite loop in
 * extracted source; a timed-out or throwing call is reported as a
 * `throw` outcome, never propagated as a real exception out of this
 * function — the caller (run-characterization.ts) treats every outcome,
 * including a timeout, as one more thing to diff against the other
 * side, not a reason to abort the whole verification run.
 */
export function runInSandbox(
  functionSource: string,
  args: readonly unknown[],
  options: { readonly timeoutMs?: number } = {}
): SandboxOutcome {
  const context = vm.createContext({});
  const script = new vm.Script(
    `(function () {
      const __fn = (${functionSource});
      const __args = ${JSON.stringify(args)};
      return __fn(...__args);
    })()`
  );
  try {
    const value = script.runInContext(context, { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS }) as unknown;
    return { type: 'return', value };
  } catch (error) {
    let message: string;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      message = String((error as Record<string, unknown>).message);
    } else {
      message = String(error);
    }
    // Strip "Error: " prefix that might be added by error stringification
    if (message.startsWith('Error: ')) {
      message = message.substring(7);
    }
    return { type: 'throw', message };
  }
}
