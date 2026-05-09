# PEND-09 — FE edit coordinate space

## Scope

This doc captures the **front-end ↔ back-end edit-coordinate boundary**: who owns the in-progress edit while a user is typing, what happens when a remote sync arrives mid-edit, and where the authority transfers. It is the design-doc artefact called for by `pending/PEND-09-SPIKE-REPORT.md` §6 readiness checklist item 10 (line 244) — "Confirm the FE edit-coordinate space" — and by spike notebook Q10 (`pending/PEND-09-SPIKE-NOTES.md` day-2; restated in `pending/PEND-09-SPIKE-REPORT.md` §3 row "Notebook 10").

It does **not** cover the LWW resolution rule for property + move conflicts (see `pending/PEND-09-lww-resolution-rule.md`) and does not cover the materializer's own apply pipeline.

## The problem

The user is typing into a block. Their cursor is at offset X. A remote sync completes, bringing in a peer's edit that inserts text at offset Y inside the same block. Two things must not happen:

- The user's in-progress keystrokes must not be silently overwritten by the remote arrival.
- The user's cursor must not be teleported to a wrong offset because the FE's view of the block content was rewritten under it.

This is the classic real-time-collaboration coordinate-space problem. Operational-transform and CRDT-with-cursor-tracking (Yjs `Y.RelativePosition`, Loro `Cursor`) are the canonical solutions in shared-doc editors (Google Docs, Notion). Agaric's offline-occasional-sync model lets us pick a much simpler boundary.

## The agaric rule, plainly stated

**The FE owns local edits in-progress.** While a TipTap editor instance is mounted on a block (i.e. that block is focused and the user is actively editing), the FE's `editor.state` is the source of truth for that block's content. The store's optimistic copy (`page-blocks.blocks[i].content` at `src/stores/page-blocks.ts:330-353`) reflects the last-flushed value, not the in-progress one.

**The BE owns post-flush state.** The flush boundary is a blur (or other unmount-trigger) calling `editor.unmount()` (`src/editor/use-roving-editor.ts:452-505`) → `edit(blockId, content)` → IPC `editBlock` (`src/stores/page-blocks.ts:330-353`) → `op_log` append → materialiser → SQL `blocks.content` row. Once that round-trip completes, the BE row is authoritative; on the next FE re-render the static block reads from `blocks[i].content` and nothing in the FE remembers the editor's transient state.

**On remote sync arrival, the FE re-loads the page tree but explicitly preserves the focused block's optimistic content.** The whole-page reload is at `src/hooks/useSyncEvents.ts:101-114` (the `sync:complete` handler that walks `pageBlockRegistry` and calls each page store's `load()`). The focus-preserving step is at `src/stores/page-blocks.ts:246-256` — a defensive map-pass that, after fetching fresh rows from `listBlocks`, replaces the focused block's content with whatever the FE store currently holds:

```ts
// Preserve focused block's content during sync reload to prevent
// visual flash and store/editor divergence
const focusedBlockId = useBlockStore.getState().focusedBlockId
if (focusedBlockId) {
  const currentBlock = get().blocksById.get(focusedBlockId)
  if (currentBlock) {
    newBlocks = newBlocks.map((b) =>
      b.id === focusedBlockId ? { ...b, content: currentBlock.content } : b,
    )
  }
}
```

The TipTap editor itself is **not** unmounted by the sync handler. Its in-memory ProseMirror doc keeps the user's keystrokes; the surrounding store reload does not run `replaceDocSilently()` on it. When the user blurs, the normal `unmount()` → `edit()` path flushes their final content as a fresh `edit_block` op, which the merge layer then reconciles with whatever the remote inserted (via `merge_block_text_only`, with a possible conflict copy if the two diverged below the line-merge threshold).

## Why FE-authoritative locally

- **Keystroke-rate IPC roundtrips are not viable.** Every TipTap doc transaction would otherwise need to round-trip through Tauri IPC + SQLite + materialiser before the FE could redraw. Even at sub-ms IPC, the resulting input lag (waiting for the BE to confirm the cursor position) destroys typing fluency. We measured this informally during the spike's day-2 LoroText demo (see `pending/PEND-09-SPIKE-REPORT.md` §4.3).
- **Operational-transform / CRDT-for-cursors is over-engineering for our latency targets.** Agaric is offline-first, sync-on-meet (mDNS + WiFi); we are not Google Docs. The user is the same person on both ends; "two simultaneous typists at sub-second latency" is not a target use case. Yjs's `Y.RelativePosition` and Loro's `Cursor` would each cost a non-trivial integration (cursor mapping, peer-id plumbing into the editor) for a benefit (cross-device cursor preservation under concurrent typing) that does not match agaric's UX promise.
- **The flush boundary is a natural breakpoint.** Users blur a block when they finish editing it (move to the next, click elsewhere, switch tabs). That is exactly when a remote merge becomes well-defined: the user's local intent has been committed, and the merge layer can three-way-merge it against any concurrent remote edit. The blur boundary buys us a non-realtime convergence story without the full RTC stack.

## What the BE owns

- **Persistence + DAG truth.** Every flushed `edit_block` op enters `op_log` with a hash, parent_seqs, and a `created_at`. The DAG is the source of truth for "what edits exist in the world"; the `blocks.content` cache row is a derived view (`materializer/handlers.rs::apply_op`).
- **Three-way merge under divergence.** When two devices flushed concurrent `edit_block` ops, the next sync's `merge_diverged_blocks` (`src-tauri/src/sync_protocol/operations.rs:438-513`) calls `merge_block_text_only` (`src-tauri/src/merge/apply.rs:47-140`). The FE never participates in this; the BE produces either a clean merge (a synthetic `edit_block` op stitching the two heads) or a conflict copy (the original retains "ours"; a new block holds "theirs"). The FE's `sync:complete` reload picks up whichever shape resulted.
- **Materialised state for unfocused blocks.** Every other block on the page is rebuilt from BE rows on each `load()`. Only the focused block is preserved across reload, and only as long as it stays focused.

The handover from FE to BE is **the unmount call, not the keystroke**. While the editor is mounted: FE wins. The instant `unmount()` returns: BE owns the next round-trip's outcome.

## Edge case 1: block deleted while FE editing

If a remote `delete_block` arrives while the user is editing the same block, the sync handler's `load()` (`src/hooks/useSyncEvents.ts:101-114`) re-fetches the page tree without that block. The focus-preserve guard at `src/stores/page-blocks.ts:246-256` checks `blocksById.get(focusedBlockId)` — but in `newBlocks` (the freshly-fetched, post-delete list) that block is absent, so the conditional `if (currentBlock)` falls through and the block disappears from the rendered tree.

The TipTap editor is still mounted in DOM-land at that point. On the next render the block's wrapper `<section>` no longer exists, React unmounts the `EditableBlock`, and TipTap's underlying view is destroyed. The user's in-progress edits are **lost** in this case — they are not flushed back to the deleted block (which would be wrong: the edit-beats-delete resurrection path requires a flushed `edit_block` op, and we never got one). The BE-side resurrection rule (`merge_diverged_blocks` step 4 — `operations.rs:824` onward) only fires when both ops landed in `op_log`; the un-flushed FE keystrokes never enter the DAG.

This is the **documented loss case**. The flush boundary is the contract: until you blur, your edits are not durable. A future polish (out of scope here) could `flushSync(() => edit(...))` from inside the `load()` reducer when it detects "this focused block no longer exists in the new tree, before-loss flush?" — but that crosses the focus-preserve boundary and risks resurrecting a block the user had not yet decided to keep. The current behaviour is the conservative one.

## Edge case 2: type during a sync push

When a sync is in progress (`useSyncTrigger` is streaming ops to a peer), the user can keep typing locally. Their keystrokes mutate the TipTap state but do not enter `op_log` until blur. The push side of the sync only ships ops already in `op_log`; the in-progress edit is not part of that stream by construction. On the next sync round (after blur → flush), the now-committed `edit_block` op ships normally.

The remote's incoming ops, conversely, land in `op_log` and trigger the materialiser + the `sync:complete` event regardless of whether the user is typing. The focus-preserve step is what keeps the user's typing from flashing on screen as a stale BE-row content. There is no "pause sync while user is typing" lock; sync and editing run independently. The merge layer absorbs the divergence at next-blur time.

This ordering — **incoming ops are applied to BE eagerly; FE preserves the focused block's optimistic state across the reload; outgoing op is created at blur** — is what `useSyncEvents.ts` and `page-blocks.ts:load` together implement. There is no explicit FE-side queue or backpressure.

## Where this is implemented

- **Editor mount + unmount lifecycle:** `src/editor/use-roving-editor.ts:381-505` (`mount` at 381-450, `unmount` at 452-505).
- **Blur-driven flush:** `src/hooks/useEditorBlur.ts:43-148` — the 5-step guard chain that decides whether a blur should `unmount()` and call `edit()` or `splitBlock()`.
- **Optimistic store edit:** `src/stores/page-blocks.ts:330-353` (`edit` action — optimistic content update + IPC + rollback on failure).
- **Sync arrival handler:** `src/hooks/useSyncEvents.ts:74-139` (`sync:complete` listener — calls `load()` on every mounted page store when `ops_received > 0`).
- **Focus-preserving reload:** `src/stores/page-blocks.ts:225-277` (`load` action), with the focus-preserving block at lines 246-256.
- **Three-way merge (BE-side):** `src-tauri/src/merge/apply.rs:47-140` (`merge_block_text_only`).
- **Draft autosave (the safety net):** `src/hooks/useDraftAutosave.ts` — polled every 500 ms while focused (see `EditableBlock.tsx:138-153`); persists the live editor content as a draft row so a process crash mid-edit doesn't lose typing. Drafts are discarded on successful flush (`useEditorBlur.ts:138-141`). This is **not** the flush mechanism (a draft row is not an `op_log` entry) — it is a separate crash-recovery path.

## Loro-mode equivalence

In Phase 1 (shadow mode, the present), the FE never sees Loro state — Loro runs alongside diffy in `src-tauri/src/loro/`, mirrors every applied op for parity comparison, and is read by no FE code. The FE coord-space rule above is independent of which engine is authoritative on the BE side; its only assumption is that the BE produces well-defined `blocks.content` row values and `sync:complete` events.

In Phase 2 (cutover), Loro becomes the BE source of truth. The FE flush path still goes through `editBlock` IPC → typed `edit_block` op (until Phase 2 also rewrites the IPC surface, which is a separate decision); the materialiser will project from the Loro doc into the same `blocks.content` row the FE reads. The FE coord-space contract is unchanged.

In Phase 2.5 / Phase 3, **a future revisit may want richer merge semantics on the FE.** Specifically, `LoroText` supports character-level merge (`pending/PEND-09-SPIKE-REPORT.md` §4.3 demonstrates two peers converging on `"The slow brown dog"` from divergent edits to `"The quick brown fox"`). If we wanted the user to see the remote's in-band insertions appear in their in-progress edit (Notion-style live merge), we would need to:

- Subscribe the FE editor to Loro doc updates (a `subscribe()` callback on the per-space `LoroDoc`).
- Bridge Loro's USV-coordinate edits (`LoroText::insert/delete/splice` — see `pending/PEND-09-SPIKE-REPORT.md` §4.3 closing paragraph and notebook Q10) into TipTap's UTF-16 ProseMirror transactions; TipTap / contenteditable typically emits UTF-16, Loro speaks USV.
- Track cursor position via Loro `Cursor` (or our own `RelativePosition` analogue) to keep the user's caret stable through remote insertions.

This is the **flagged-for-Phase-2 work** that `pending/PEND-09-SPIKE-REPORT.md` §6 item 10 calls out. It is **not** Phase 1 scope. Phase 1's deliverable is "the FE coord-space contract is documented and the BE shadow-engine doesn't disturb it" — both true today.

## See also

- `pending/PEND-09-SPIKE-REPORT.md` §6 readiness item 10 — the open question this doc answers.
- `pending/PEND-09-SPIKE-REPORT.md` §3 row "Notebook 10" — the USV vs UTF-16 coordinate-coercion question for the eventual FE-side Loro bridge.
- `pending/PEND-09-lww-resolution-rule.md` — companion doc covering property + move LWW.
- `pending/PEND-09-SPIKE-REPORT.md` §4.3 — the LoroText character-merge demo motivating Phase 2's live-merge possibility.
