# Session 1705 — the debounced commit stops rebasing blur's baseline (#4957)

Two halves of one defect: something else commits the block's content before
blur does, and the thing that reads the content afterwards reads the wrong copy.

## The debounced commit defers to all three flush classifications

`commitNow` guarded exactly one of blur's three classifications — inline
`key:: value` properties (#2675) — then committed verbatim and rebased the
editor's delta baseline with `markCommitted`. Blur's `unmount()` then reported
no delta, so `runUnmountFlush` never reached its split or checkbox branch: three
pasted paragraphs stayed one row with embedded blank lines, and a pasted
`- [ ] buy milk` kept the literal marker with `todo_state` null. The comment
above the property guard already spelled out that exact argument; it just only
covered one branch.

Two more early returns next to it, `shouldSplitOnBlur(md)` and
`processCheckboxSyntax(md).todoState`, under one shared reason. The debounced
commit is the only production caller of `markCommitted` (grepped:
`use-roving-editor.ts` defines it, `useLazyRovingEditor.ts` forwards it, the
orchestrator's mention is a comment), so with those three guards the baseline is
never rebased ahead of a blur that still has work to do.

## The restructure handlers remount the post-split baseline

`handleIndent` / `handleDedent` / `handleMoveUp` / `handleMoveDown` and their
four `*ById` variants all capture `getMarkdown()`, call `handleFlush()`, and
remount with the capture. When the capture is multi-block the flush splits it —
`splitBlock` truncates the source to line 1 and creates siblings for the rest —
so the remount handed the editor the pre-split text as its new baseline and the
next keystroke re-committed lines 2..N that already existed as siblings.

A local `remountBaseline(blockId, captured)` now answers "what to remount with":
the store's row when `shouldSplitOnBlur(captured)`, the capture otherwise. It
needs the page store, which the hook did not take — `pageStore` is now a
parameter, passed from `BlockTree` (which already holds it) exactly as
`useBlockFlush` takes it. `splitBlock` writes line 1 through `edit()`'s
synchronous optimistic `set` before its first `await`, so the store is already
correct when `handleFlush()` returns; no flush result has to be threaded out.
The `?? captured` fallback is load-bearing rather than defensive: `handleFlush`
returns without flushing for a block owned by another page's store (#4550
embeds), and mounting `''` there would blank the editor.

The issue says "six handlers" and then lists eight. All eight share the shape
and all eight are fixed; `handleDeleteBlock` and `handleFocusNext` (#4972,
#4973) were left alone.

## Falsification

Every new test was shown red against a `cp` copy, restored with `cmp`.

- `useDebouncedContentCommit.test.tsx`: dropping `shouldSplitOnBlur` reddens
  "defers to the flush for multi-block content"; dropping the checkbox guard
  reddens "defers to the flush for a leading GFM task marker". The property case
  stays green through both, and a plain paragraph carrying a mid-line `- [ ] `
  still commits (the negative arm).
- `use-block-action-orchestration.test.ts`: a helper that always returns the
  capture reddens the three split cases (indent, indent-by-id, move-up) — that
  is `main`'s behaviour; one that always reads the store reddens the
  no-split control; `?? ''` instead of `?? captured` reddens the embed case.
  `handleFlush` is the injected mock there, standing in for the split by writing
  line 1 to a real per-page store.
- `e2e/task-paste-wiring.spec.ts`: with the checkbox guard removed the new case
  fails with `todo_state` still `null` after paste → pause → blur, exactly as
  the issue predicted; green with it.

## The e2e case blurs, it does not save

First attempt used `helpers.saveBlock` (Enter). It fails even with the fix:
`handleEnterSave` found a caret split available and committed through `edit()`
plus `createBelow`, never reaching the classifying flush — the recorded IPC was
`edit_block` → `delete_draft` → `create_block`, with no `set_todo_state`.
`helpers.blurEditors` is wrong for the opposite reason: its leading Escape is
the discard gesture. The spec therefore blurs `document.activeElement`
directly, which is the click-away path, and re-reads the persisted row over
`get_block`. Confirmed end to end: content `buy milk`, `todo_state` `TODO`.

That Enter-after-a-pasted-marker leaves the literal marker in `content` is
behaviour this session did not touch; it is the caret-split path, not the
baseline rebase, and it is unchanged from `main`.

## Not done

`docs/FEATURE-MAP.md` is unchanged: it has no paste-to-split or checkbox-fold
entry to correct (its only nearby row describes the debounced commit itself).
Playwright's Chromium was absent from this box, so `scripts/setup.sh`'s
best-effort `npx playwright install chromium` was run once before the e2e lane
could execute.
