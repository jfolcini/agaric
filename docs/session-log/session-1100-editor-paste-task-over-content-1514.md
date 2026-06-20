# Session 1100 — /batch-issues loop: fix paste-task-over-content data loss (#1514)

## What happened

One of the two HIGH editor data-loss bugs from the deep review. Built in `wt-1514`,
adversarially reviewed, and verified at runtime via Playwright.

## Shipped

PR `fix/editor-1514`:

- **#1514** (HIGH, correctness / data loss) — pasting a GFM task line (`- [ ] todo`) over
  a non-empty block wiped the existing content. Root cause: `TaskPaste.handlePaste`
  (`src/editor/extensions/task-paste.ts`) guarded only on `view.state.selection.empty` —
  true for a collapsed caret even inside non-empty text — then unconditionally replaced the
  entire enclosing paragraph (`replaceRangeWith($from.before, $from.after, …)`), discarding
  the existing text.
  - **Fix:** after parsing the pasted task node, return `false` when the caret's block is
    non-empty or already a task (`if (parent.content.size > 0 || parent.attrs?.['todoState'])`).
    The plugin now only takes over a genuinely empty, non-task paragraph; otherwise it falls
    through to ProseMirror's default paste (the raw `- [ ]` marker is inserted at the caret
    and folded into `todo_state` at flush). Duck-typed (no `instanceof TextSelection`).

## Review pass

Reviewer (PASS, no defects): confirmed the data-loss path is closed (collapsed caret in
non-empty text falls through, no paragraph wipe); the empty-block takeover is preserved
(empty non-task paragraph still becomes a TODO); edge cases covered (caret mid-text,
empty-but-already-task, over-selection, multi-line, non-task paste); no `instanceof`
footgun; no over-reach. 1433 editor unit tests, tsc + oxlint clean. **e2e
`paste-task-over-content-1514.spec.ts` ran 3/3 PASS at runtime** (fresh build:e2e +
preview, ports confirmed clear — no stale-server false-green): original content survives
the task-line paste, empty block still becomes a task.

## Notes

- Files: `src/editor/extensions/task-paste.ts`, `src/editor/__tests__/task-paragraph.test.ts`,
  `e2e/paste-task-over-content-1514.spec.ts`. FE-only.
- Branch base is current `origin/main`.
