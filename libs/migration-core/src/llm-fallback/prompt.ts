import { estimateTokens } from 'provider-scheduler';
import type { CompileDiagnostic } from '../verification/index.js';
import { splitSource } from './split.js';

/** One source file Stage 3 is asked to migrate, with everything the mechanical stages learned about it. */
export interface WorkItem {
  readonly sourceFile: string;
  readonly sourceText: string;
  /** Why it is here: the mechanical outcome (`PipelineReport.files[].outcome`). */
  readonly outcome: 'REJECTED' | 'NO_MATCH' | 'NOT_EMITTED';
  /** What the assembler emitted for this file and the Angular compiler rejected, with its diagnostics. */
  readonly rejected: readonly {
    readonly content: string;
    readonly diagnostics: readonly CompileDiagnostic[];
    readonly followUps: readonly string[];
  }[];
  /** AngularJS templates this script names by `templateUrl`. */
  readonly templates: readonly { readonly path: string; readonly text: string }[];
  /** Already-migrated files that compiled, same directory first — idiom consistency (docs/product-spec.md §6.4). */
  readonly siblings: readonly { readonly path: string; readonly content: string }[];
}

export const SYSTEM_PROMPT = [
  'You migrate AngularJS 1.x source files to modern Angular (standalone APIs, strict TypeScript).',
  'Respond with JSON only, matching this shape exactly: {"files":[{"path":"<relative path>","content":"<full file content>"}]}.',
  'Rules:',
  '- Every file is complete and self-contained: all imports present, nothing elided, no placeholders.',
  '- Paths are bare relative .ts or .html file names such as "phone-list.component.ts". No directories are needed.',
  '- Components, directives and pipes are standalone. A component template goes inline or in an .html file in the same patch.',
  '- Templates use Angular syntax: @if/@for control flow, [prop] and (event) bindings, no ng-* directives, no $ctrl.',
  '- No AngularJS globals: no `angular`, no `$scope`. An AngularJS injectable with no Angular equivalent is injected as `@Inject(\'<name>\') private name: any`.',
  '- Import only from @angular/*, rxjs, or files shown to you under "Already migrated". Never import a file that was not shown.',
  '- Keep behaviour identical. Do not add features, and do not fix bugs.',
  '- If the source needs no Angular counterpart (it only declares an AngularJS module, for example), respond {"files":[]}.',
].join('\n');

const SIBLING_BUDGET_TOKENS = 600;
const MAX_DIAGNOSTICS = 12;

function context(item: WorkItem, capTokens: number): string {
  const sections: string[] = [];

  for (const attempt of item.rejected) {
    const diagnostics = attempt.diagnostics.slice(0, MAX_DIAGNOSTICS).map((d) => `- ${d.code}: ${d.message}`);
    const omitted = attempt.diagnostics.length - diagnostics.length;
    sections.push(
      [
        'A deterministic codemod already produced the file below and the Angular compiler rejected it:',
        '```ts',
        attempt.content.trim(),
        '```',
        'Compiler errors:',
        ...diagnostics,
        ...(omitted > 0 ? [`(${omitted} more not shown)`] : []),
        ...attempt.followUps.map((followUp) => `Still owed: ${followUp}`),
      ].join('\n')
    );
  }

  for (const template of item.templates) {
    // Shown whole or not at all: a cut-off template would be migrated as if it were complete.
    sections.push(
      estimateTokens(template.text) <= capTokens
        ? `AngularJS template ${template.path}, referenced by this file:\n\`\`\`html\n${template.text.trim()}\n\`\`\``
        : `AngularJS template ${template.path} is referenced by this file but is too large to include; keep the templateUrl as written.`
    );
  }

  let budget = SIBLING_BUDGET_TOKENS;
  const shown: string[] = [];
  for (const sibling of item.siblings) {
    const block = `// ${sibling.path}\n${sibling.content.trim()}`;
    if (estimateTokens(block) > budget) continue;
    budget -= estimateTokens(block);
    shown.push(block);
  }
  if (shown.length > 0) sections.push(`Already migrated (compiles; match its idiom, import from it by these paths if needed):\n\`\`\`ts\n${shown.join('\n\n')}\n\`\`\``);

  return sections.join('\n\n');
}

/**
 * The prompts for one work item: one when the source fits the token cap,
 * one per chunk when it had to be split. Unredacted — `generatePatch` is
 * the single place content is redacted and sent.
 */
export function buildPrompts(
  item: WorkItem,
  capTokens: number
): { readonly prompts: readonly string[] } | { readonly tooLarge: string } {
  const split = splitSource(item.sourceText, capTokens);
  if ('tooLarge' in split) return split;

  const shared = context(item, capTokens);
  const total = split.chunks.length;
  return {
    prompts: split.chunks.map((chunk, index) =>
      [
        `Source file: ${item.sourceFile}`,
        ...(total > 1
          ? [
              `This is part ${index + 1} of ${total} of that file, split at function and class boundaries. Migrate only this part; name each output file after what this part declares.`,
            ]
          : []),
        '```js',
        chunk.trim(),
        '```',
        ...(shared ? ['', shared] : []),
      ].join('\n')
    ),
  };
}
