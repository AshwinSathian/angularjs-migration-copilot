## What this does

<!-- One or two sentences. Link the milestone doc this closes out or advances, e.g. docs/milestones/m1-codemods.md -->

## How it was verified

<!-- Commands run, their output, not just "tests pass." If this touches libs/migration-core/verification, say so explicitly — that path needs a human reviewer regardless of CI status. -->

## Checklist

- [ ] `nx affected:test` run locally, output checked
- [ ] If this touches `libs/migration-core/verification/`: flagged for human review, not merged on green CI alone
- [ ] If this adds a codemod pattern: it's one of the 10 in `docs/product-spec.md §6.3`, not a new one added opportunistically
- [ ] `docs/decisions.md` updated if this makes or changes an architectural call
