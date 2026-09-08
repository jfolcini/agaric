# Session 1606 — the GC swept the bytes undo needs, at boot (#4250)

## The facts, established before designing anything

**Trigger.** `CleanupOrphanedAttachments` on the materializer *background*
queue, enqueued from four places: boot (`lib.rs:1413`), a 24 h maintenance tick
(`maintenance.rs:200`), after op-log compaction (`compaction.rs:261`), and after
`purge_block` / empty-trash (`blocks/crud.rs:3317`). Boot is the one that
matters — "delete → restart → undo" hit the sweep on the way back in, every
time.

**What undo needs that the GC destroyed: the bytes only.** Since #1993/#3259
`delete_attachment_inner` hard-deletes the row and leaves the file and the
`attachment_blobs` mapping to this GC.
`reverse::attachment_ops::reverse_delete_attachment` rebuilds the
`AddAttachment` from the delete payload's `fs_path`/`filename`, so the row and
the mapping come back from the op log. Only the file cannot, and #3706's
byte-existence guard then refuses.

**The path is reachable — the issue is not smaller than it looks.** AGENTS.md
says `delete_attachment` is non-reversible, but that is
`STATIC_NON_REVERSIBLE_OP_TYPES`, which gates *page-level restore-to-a-point*.
The op-addressed paths do reverse it, and `history.rs:522` says so in its own
words: the guard fires for `revert_ops`, `undo_ops`/`undo_op`, and
`undo_page_op` "since #4247 made the positional path able to select a
`delete_attachment` at all". `undo_op`/`undo_ops` are real commands in
`bindings.ts`; `undo.op.deleteAttachment` is a shipped user-facing string;
`useBlockAttachments.ts:95` is the delete the user takes back.

**No existing horizon fits.** `compaction_watermark` (0116) says in its own
header not to treat it as a retention floor. `TOMBSTONE_RETENTION_DAYS` is
soft-deleted blocks. `DEFAULT_RETENTION_DAYS = 90` is the op-log window — the
horizon undo is *actually* bounded by, and honouring it literally is exactly
the unbounded-disk objection that made #3706 decline this. The maintainer's
2026-09-02 comment picks a fixed 7 days; that tension is recorded on the
constant.

## The fix: no migration, no new table, no op type

`op_log.created_at` is already INTEGER ms (0079) and indexed
(`idx_op_log_created`), and the `delete_attachment` payload already carries
`fs_path`. So it is one bounded query per pass plus a set-membership test in
the walk loop.

Two placement decisions that are not cosmetic:

- The query runs on the **write** pool. A lagging read replica that missed a
  just-committed delete would cost a destroyed file.
- The skip sits after the `referenced_paths` test and **ahead** of the
  blob-mapping prune and the write-pool re-check, so a retained file never
  enters the destructive path at all.

A load failure aborts the pass, matching the existing `referenced_paths`
contract: being unable to establish what must be kept is not a licence to
destroy it.

## Red → green → red, and the pair

Written test-first and seen red against the original code:
`the sweep reclaimed a just-deleted attachment's bytes — the user's undo now
has nothing to restore (#4250)`. Green after the fix. Disabling the skip
reddens it again.

The half-covered-pair check is the one that matters. Removing the horizon
(`cutoff_ms = 0`, retain forever) reddens the **other** arm — four tests:
`undo_of_delete_attachment_after_gc_refuses…`,
`redo_of_an_undone_add_attachment_after_a_gc_pass_refuses_3706`,
`a_batch_undo_containing_a_byte_less_delete_attachment_aborts_the_whole_batch_3706`
and `block_cmd_tests::delete_attachment_removes_row` — while the inside-window
test still passes. So the window is proven to **bound**, not merely to keep.

## Six tests were pinning the buggy timing

They asserted "delete → GC → bytes gone" with a *fresh* delete op — the
reclamation duty is right, the timing was not. Both fixtures now age the delete
op past the horizon first, under the migration-0036
`enable/disable_op_log_mutation_bypass` bracket that compaction already uses,
and derive the bound from `DELETED_ATTACHMENT_RETENTION_MS` rather than a
literal — so shortening the window cannot leave them silently testing the
inside case. Together the two fixtures are the issue's acceptance verbatim.

## Deliberately not done

The bulk `attachment_blobs` prune does not learn the window: undo needs the
bytes, not the mapping, and #3371's own asymmetry says a mapping pruned while
its file survives costs one redundant re-copy on the next ingest — the
self-healing direction. Excluding a variable-length set would also have meant
dynamic SQL and a baseline bump.

No new index: `idx_op_log_created` already bounds the scan, and this runs at
boot / every 24 h. The #3706 TOCTOU item is untouched — the maintainer's
scoping comment dropped it.

Two stale paragraphs in `commands/history.rs` are corrected: they said the
reclamation "is the ordinary outcome" and that #4250 "is what would close it
properly". Both now state the inside/outside split.
