# Session 1680 — the store tests onto the typed seam

#4668 step 2, fifth directory: `src/stores/__tests__`, the nine files the
backlog listed there. `MIGRATION_BACKLOG` 36 → 27, nothing added to the
exceptions. This was the directory the issue warned about: the page-block
store tests chain many positional `…Once` values across different commands
in one flow, so most of the work was turning those queues into
command-keyed handlers with explicit state, and a `deferred()` promise where
a test parks one command's answer while another interleaves.

## What the seam caught

- `delete_block` stubs spelled `deleted_at` as an ISO string (epoch
  milliseconds since migration 0080) and omitted `affected_page_ids` and
  `op_refs`; every `move_block` literal omitted `op_refs`; `create_block`
  and `edit_block` echoes were six-field partials of `WithOps<BlockRow>`,
  and three resolved a bare `{}`.
- Two `load_page_subtree` fallbacks in `page-blocks.reorder.test.ts`
  returned a page envelope, a shape that command never sends, so `.blocks`
  was `undefined` and both cross-parent-guard tests passed on a phantom
  reload. They now answer a `PageSubtree` and still pass.
- `list_all_pages_in_space` stubbed with `{ id, content }` where it returns
  `PageHeading`; `resolve.test.ts` had some twenty `list_blocks` pages
  without `total_count` and rows eight columns short.
- Every `mockImplementation` switch ended in `return undefined` or
  `return null`, absorbing any unmodelled command; the strict fallback now
  names one.

Eighteen `mockOnNewAction` assertions became `('PAGE_1', [])`: the undo
registry takes the refs arm whenever `op_refs` is present, and the backend
always sends it, so the single-argument shape was reachable only through an
untyped stub. The batch commands' ref-less assertions are unchanged, because
there the arity is the subject.

One test was found not testing its stated subject. The indent slot-drift
case in `page-blocks.move-reparent.test.ts` resolved `move_block` with
`undefined`, which sent the store down the parent-echo-mismatch branch, so
the slot-drift reconcile never ran. With a real `move_block` response it
takes `reconcileProvisionalMoveSuccess`, and still asserts the reload and
the parent.

Also in this PR, from #4941's review: a `page(items, rest?)` helper beside
`emptyPage` in `src/lib/__tests__/agenda-filters.test.ts`, collapsing the
spelled-out page literals.

## Falsification

The builder's: a `delete_block` response in the old shape fails `typecheck`
with TS2322 against `WithOps<DeleteResponse>`; a frozen snapshot counter in
the prefetch test fails the fresh-reload assertion. Mine, independently, on
a copy: `moveResp` returning the bare `MoveResponse` fails `typecheck` with
TS2322 against `WithOps<MoveResponse>`. All restored and `cmp`-verified,
typecheck back to exit 0.

## Verified

- vitest on the nine files, `agenda-filters` and the ratchet: 11 files,
  431 passed; by the builder and again by me. Per-file counts unchanged.
- `npm run typecheck` exit 0, twice; oxlint and oxfmt clean on the files.
- Not run locally: the full suites (CI carries them; the laptop is in use).
