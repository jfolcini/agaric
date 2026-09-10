# Session 1686 — the block-tree hook tests onto the typed seam

#4668 step 2, sixth directory: the eight hook tests under
`src/components/block-tree/`. `MIGRATION_BACKLOG` 27 → 19, nothing added to
the exceptions. This slice imports the seam helpers that #4946 hoisted into
the shared helper (`stubInvoke`, `deferred`, `echoEditBlock` and friends)
instead of pasting them.

## What the seam caught

- Every `create_block` stub in the auto-create and empty-seed tests
  returned a bare block where the command answers `WithOps<BlockRow>`; the
  store keeps what came back, so the deep-equality assertions now compare
  against a row carrying `op_refs`, as production does.
- `edit_block`, `set_property` and `delete_property` defaults were two- to
  three-field partials of their envelopes; `set_todo_state`, `set_priority`
  and `list_property_keys` fell through to `return undefined`.
- `get_block` stubbed `null` in the multi-select tests, a shape the backend
  cannot send; the intent ("no content, no rename fan-out") is a contentless
  row now. `search_blocks` returned rows with no envelope and eight fields
  short. `list_all_pages_in_space` rows were `{ id, content }`.
- The attachment stub in `useSlashCommandProperty` carried an ISO
  `created_at` where the column has been epoch milliseconds since 0081.
- The strict fallback named a live path the catch-alls had absorbed: a DONE
  toggle fires the `get_property('blocked_by')` probe, in both the slash
  command and event-listener tests. It is modelled now.

Six resolver-capture mocks in the empty-seed tests became one map of
deferreds keyed by parent, which is also the "has the IPC started" probe;
seven per-test dynamic imports of the invoke mock in the event-listener
tests became one file-level mock and a `beforeEach` installer; the
order-dependent double-toggle and rapid-race tests carry counters with a
one-line comment each. No assertion weakened; per-file counts unchanged,
278 in total.

## Falsification

The builder's: the attachment `created_at` back to an ISO string fails
`typecheck` with TS2322 against `TypedInvokeHandler<"add_attachment_with_bytes">`;
the double-toggle counter flipped fails the serialisation test with three
writes instead of one. Mine, independently, on a copy: the multi-select
`get_block` handler back to `null` fails `typecheck` with TS2322 against
`TypedInvokeHandler<"get_block">`. All restored and `cmp`-verified.

## Verified

- vitest on the eight files plus the ratchet: 9 files, 278 passed, by the
  builder (before and after, identical per-file counts) and again by me.
- `npm run typecheck` exit 0, three times; oxlint and oxfmt clean.
- Not run locally: the full suites (CI carries them; the laptop is in use).
