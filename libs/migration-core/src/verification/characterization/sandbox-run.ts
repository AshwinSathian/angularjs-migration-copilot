import vm from 'node:vm';
import { ts } from 'ts-morph';
import type { SandboxOutcome } from '../types.js';

const DEFAULT_TIMEOUT_MS = 1000;

/** Errors that mean "this source cannot run standalone here", not "the function threw". */
const ENVIRONMENT_ERROR_NAMES = new Set(['ReferenceError', 'SyntaxError']);

function field(error: unknown, key: string): string | undefined {
  if (typeof error === 'object' && error !== null && key in error) {
    return String((error as Record<string, unknown>)[key]);
  }
  return undefined;
}

/**
 * Runs a standalone function/arrow source string against one input
 * tuple inside a fresh `node:vm` context — not an Angular runtime, not a
 * Node module system. Never throws.
 *
 * Source may be TypeScript: it is transpiled (types stripped, nothing
 * type-checked) first, so a migrated method body can be compared without
 * the caller pre-processing it (docs/decisions.md ADR-054).
 *
 * Three outcomes, kept apart on purpose (ADR-057):
 * - `return` — the function ran and produced a value.
 * - `throw` — the function ran and threw; this is behaviour, and
 *   comparable (e.g. both sides `TypeError` on a `null` input).
 * - `unrunnable` — syntax error, unresolved free variable, or timeout.
 *   That is a property of the extraction, not of the function, and two
 *   sides failing identically must never count as agreement.
 *
 * Errors thrown inside the context belong to another realm, so
 * `instanceof Error` is false for them (ADR-052); `name`/`message` are
 * read as plain properties instead.
 *
 * Each call serializes `args` into the script, so a function that
 * mutates its input cannot leak that mutation into the other side's
 * run. The cost: `undefined` inside `args` arrives as `null`.
 */
export function runInSandbox(
  functionSource: string,
  args: readonly unknown[],
  options: { readonly timeoutMs?: number } = {}
): SandboxOutcome {
  try {
    const js = ts.transpileModule(`const __fn = (${functionSource});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    const syntaxError = js.diagnostics?.[0];
    if (syntaxError) {
      return { type: 'unrunnable', message: ts.flattenDiagnosticMessageText(syntaxError.messageText, ' ') };
    }
    const script = new vm.Script(`(function () {
      ${js.outputText}
      return __fn(...${JSON.stringify(args)});
    })()`);
    const value = script.runInContext(vm.createContext({}), {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }) as unknown;
    return { type: 'return', value };
  } catch (error) {
    const name = field(error, 'name') ?? 'non-Error';
    const message = field(error, 'message') ?? String(error);
    if (ENVIRONMENT_ERROR_NAMES.has(name) || field(error, 'code') === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      return { type: 'unrunnable', message: `${name}: ${message}` };
    }
    return { type: 'throw', name, message };
  }
}
