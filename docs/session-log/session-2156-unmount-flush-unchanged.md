# Session 2156 — an unchanged block is not flushed on a no-blur unmount (#5423 item 6)

#5423 item 6 said that an unmount while focused runs `saveDraft` + `flushDraft` after the blur has already committed, and that `flush_draft` then finds the draft superseded. Both halves are wrong.
- A blur returns Effect B's cleanup early (`blockIdRef.current === null`, or the discarded marker), so a blurred block never reaches the save.
- The no-blur unmount does reach it: navigation with no pointer blur, or window teardown. There `saveDraft` stores a fresh row anchored at the device's op-log high-water, so `flush_draft_inner` finds no superseding op. It then appends an `edit_block` even when the text equals the committed content, and neither `flush_draft_inner` nor `edit_block_in_tx` compares content.

The cost was one redundant op in the append-only log per such unmount, plus a history entry and a sync payload. It was not a wasted transaction.

**Fix.** The cleanup now compares the live markdown with the roving editor's baseline (`originalMarkdown`), the same check `commitNow` skips on. When they are equal, it deletes the draft row instead of saving and flushing. A debounced row up to two seconds old can hold text the user has since undone, and boot recovery must not replay it. The block-switch path and the typed-content path are unchanged.

**Tests.**
- vitest: "unchanged content on unmount deletes the draft row instead of saving and flushing". The existing gap-2 test now has a baseline that differs from its live text, so it is the other half of the pair.
- `e2e/draft-autosave.spec.ts`, mock lane, both re-querying `get_block_history` and `get_block`:
  - a still-focused, unedited block left by the search chord appends no `edit_block`;
  - the same with typed text appends exactly one `edit_block` carrying that text.
- The row's absence is not asserted in e2e: the old flush deleted the row too, so that assertion held with or without the fix. The vitest pins the `deleteDraft` call instead.
- Deleting the focused block through its context menu cannot show the duplicate. `delete_block` lands before the flush, and the flush then drops the draft as an orphan, typed or not.

**Falsified** on copies:
- Removing the skip fails the new vitest (one `saveDraft` call) and the unedited e2e case (one `edit_block`, expected none).
- Making the skip unconditional fails four typed-content vitests and both typed e2e cases.
- Dropping the `deleteDraft` call fails the new vitest.
- Dropping the `latest &&` guard fails "blockId change flushes exactly once, old block row untouched".

Ran:
- `npx vitest run` on `useDraftAutosave`, `useEditorBlur` and `EditableBlock` (169);
- `npm run typecheck`;
- `oxlint` and `oxfmt --check`;
- `e2e/draft-autosave.spec.ts` (7).
