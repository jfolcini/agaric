# Session 1687 — the backlog is empty

#4668 step 2, the last slice: the nineteen component tests still in
`MIGRATION_BACKLOG`, scattered across editor, filters, history, journal,
peers, query, templates, attachments, dialogs and the page browser. With
the block-tree slice merged earlier today the list is now `[]`; the two
`DELIBERATE_EXCEPTIONS` (`read_attachment`'s raw-byte command with no
binding, and the seam's own test) are the documented minority the issue
asked for, so this PR closes it.

## What the seam caught

- Epoch-millisecond columns stubbed as ISO strings: `AttachmentRow.created_at`
  (since 0081) and `CompactionStatus.oldest_op_date`. The #4555 Spanish-locale
  date test still passes on the corrected type.
- `PeerRef` literals in `DeviceManagement` short of `last_address`,
  `endpoint_id` and `unpaired_by_peer_at_ms`; `PageHeading` literals short
  of the four task columns; `quick_capture_block` and `get_block` rows as
  six-field partials of `BlockRow`; `PageSubtree.blocks` carrying a `depth`
  that is not a wire field.
- Envelopes without `total_count` or `has_more` (`list_property_defs`,
  `query_by_tags`, `get_backlinks`); `delete_block` stubbed
  `{ deleted_count }`, a shape it never sends; a dozen mutations resolving
  `undefined` where they answer `null` or `WithOps<…>`.
- Catch-alls that answered commands the tests never modelled:
  `count_agenda_batch_by_source` in both journal files, seven mount commands
  in `viewTransition`, and `BlockTree`'s "benign default" for everything.
- Two comments in `QueryResult.test.tsx` claiming the error paths went
  through `filtered_blocks_query`; they go through `run_advanced_query`.

`BlockTree.test.tsx` was the large one: 161 `mockImplementation` switches
became one typed map of the 33 commands the tree can fire, with per-test
overrides. One assertion changed with its reason in the file: the undo
registry receives `('PAGE_1', [], 'edit:b1')`, not `('PAGE_1')`, because the
bare arm was reachable only through a stub without `op_refs`, the same
finding as session 1680. One dead branch went: a `moved` flag whose
`'A' : 'B'` arm can never be taken because the batched move reconciles
without a reload; falsification proved it and it was deleted. Fifteen
`…Once` chains in `HistoryView` and forty-nine positional stubs in
`TagFilterPanel` became installers with explicit state, with load-more keyed
on the cursor rather than call order. No test deleted, no assertion
weakened; 886 tests before and after.

Left, and worth a follow-up: `QueryResult.test.tsx` and `TemplatesView.test.tsx`
still hold command-keyed `mockImplementation` switches with untyped literals
and a `return null` / `return emptyPage` tail. They carry no ratchet entry
(the pattern is keyed by command, so the positional-theft hazard is absent)
and the builder's scripted rewrite of one produced malformed output, so they
were left intact rather than half-landed.

## Falsification

The builder's: `oldest_op_date` back to an ISO string fails `typecheck`
with TS2322; a `depth` field restored on a `BlockRow` literal fails with
TS2353; the revert-run state flag removed fails the reload-after-revert
test. Mine, independently, on a copy: the same ISO `oldest_op_date`
(TS2322 against `CompactionStatus`), after the rebase onto the block-tree
merge. All restored and `cmp`-verified.

## Verified

- vitest on the nineteen files plus the ratchet: 20 files, 887 passed, on
  the rebased tree (builder before rebase: 886 + 1, identical per-file
  counts to its baseline).
- `npm run typecheck` exit 0, three times; oxlint and oxfmt clean.
- Not run locally: the full suites (CI carries them; the laptop is in use).
