# Session 1684 — review notes from five PRs, one follow-up

The non-blocking notes the reviewer left on #4939, #4940, #4942 and #4943,
acted on together so that none of those approved branches took a push of
its own.

Two of the notes named real gaps. The mock's `count_trash` answered 0 for a
Global scope where the backend rejects with `validation`; it now rejects the
same way, and a `queries` step beside `trash_rejects_global_scope` pins the
rejection for the count as well. And the `diff_link_targets` block that
#4943 duplicated into both reindexer variants is one function with two
callers; both `#[expect(clippy::too_many_lines)]` attributes are still
earned, so they stay.

The rest is housekeeping the store-test migration owed. The seam helpers
that had been pasted into eight store test files (`stubInvoke`, `moveResp`,
`deleteResp`, `echoEditBlock`, `deferred`) now live beside
`mockInvokeCommands` in the shared helper; `stubInvoke` takes the mock as its
first argument because the helper module cannot value-import
`@tauri-apps/api/core` (its own doc records the deadlock), the same shape as
`stubPageRowInvoke`. `deleteResp` drops the `descendants_affected` parameter
nothing read and keeps the optional `op_refs` one that two undo-registry
tests use. Nine `edit_block` handlers registered for tests that never edit
are gone, so an unexpected `edit_block` in those flows now fails by name
instead of being absorbed. Two comments that argued with deleted waivers are
deleted; three kill-date comment blocks are re-wrapped to their neighbours'
width, with the `REMOVE AFTER` phrase untouched. The `scan.out/` ignore line
stays; it is harmless and the lane is documented as hand-reproducible.

## Verified

- `cargo nextest run --workspace -E 'test(block_links) | test(conformance)'`:
  169 passed; clippy `-D warnings` exit 0.
- vitest over `src/stores/__tests__`, the conformance files and the
  hand-stub ratchet: 40 files, 1075 passed; per-file store counts unchanged.
- `npm run typecheck`, knip, the remove-after-markers, tauri-mock-parity and
  the three baseline guards: exit 0.
- Falsified on copies, restored `cmp`-clean: the mock's `count_trash` back to
  0 on Global (the new fixture step red); `diff_link_targets` without the
  kind comparison (both reindexer tests red). Re-adding a dead `edit_block`
  handler reddens nothing, as expected; the value is the converse.
- Not run locally: the full suites (CI carries them; the laptop is in use).
