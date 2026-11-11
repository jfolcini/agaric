# Session 3690 — the small-area frontend mutants

Part of the sweep on the frontend mutation tracker (#4691): its nine small areas in one PR. Each mutant was reproduced with `node scripts/run-mutation.mjs <module>` on `origin/main` first, and then got a test, a deletion, or a `mutation-accepted.tsv` entry.

## What shipped

- **Tests.** tree-utils (a list whose first block is not a root), inline-property-parse (what opens a fence), meeting-link (the warn it logs), page-gutter (the grip takes its block's `--block-first-line`), export-graph (`pageMarkdownForCopy`, which no test ran), page-lists (a parent made a task tells the block under it), recording-attachments (an audio named only by its extension), template-utils (text on one side of `<% recording %>`). Each new test was shown red against its mutant in one restoring shell command.
- **One deletion.** `countTasksAtOrAbove`'s `depth > 0 ?` did nothing, since a root reads `atDepth[-1]`, which is never set. Both of its mutants go with it.
- **Accepted as equivalent.** These are in `mutation-accepted.tsv`:
  - **inline-property-parse, `if (fence !== null) continue`.** A fence opener starts with a backtick or tilde run, which the key alphabet already rejects.
  - **template-utils, `m?.[1]?.trim`.** Group 1 always exists once the regex matches.
  - **template-utils, `child.content ?? ''`.** Neither `''` nor the mutant's string is a placeholder.
  - **read-aloud, `readings += 1`.** The counter feeds only a toast id, which stays unique counting down.

## Traps

- **Shell quoting.** Falsifying a regex through shell quoting doubles its backslashes, which makes a different mutant than Stryker's. Read the replacements from a quoted heredoc instead.
- **Two counts.** The local Stryker summary nets out `mutation-accepted.tsv`, while the raw `mutation.json` does not. Compare tracked counts through `scripts/lib/mutation-accepted.mjs`'s `frontendKey`, as the filer does.
- **page-lists counts.** On current main it had five tracked survivors the last weekly run predates, all on the tasks-above path. The page-lists test kills them too.

## Counts

Distinct tracked mutants (no coverage + survived, after `mutation-accepted.tsv`), before on `origin/main` and after on this branch:

| Module | Before | After |
|---|--:|--:|
| tree-utils | 0 + 3 | 0 |
| inline-property-parse | 0 + 6 | 0 |
| meeting-link | 0 + 2 | 0 |
| page-gutter | 0 + 2 | 0 |
| export-graph | 1 + 0 | 0 |
| page-lists | 1 + 5 | 0 |
| read-aloud | 0 + 1 | 0 |
| recording-attachments | 0 + 1 | 0 |
| template-utils (after #6434) | 0 + 4 | 0 |

Suites run: the touched test files, the full vitest suite, `npm run typecheck`, oxlint/oxfmt on the changed files, and the Stryker pass above.
