# Session 1711 — the per-block History sheet ordered by per-device `seq` (#4964)

`list_block_history` ended `ORDER BY ol.seq DESC, ol.device_id DESC` and its
doc called that "newest first". `seq` is allocated per device — the `op_log`
PK is `(device_id, seq)` — and a peer's replicated rows carry `block_id` and
reach this query unfiltered, so the merged set was ranked by each device's
lifetime op count. With device A at seq ≈ 50 000 and a device paired last
week at seq ≈ 200, every one of B's ops sorted below every one of A's. The
sibling `list_page_history` already used `(created_at, seq, device_id)`, so
the two History sheets answered differently about the same ops.

## The keyset change

`list_block_history` adopts the sibling's keyset verbatim
(`agaric-store/src/pagination/history.rs`): `ORDER BY ol.created_at DESC,
ol.seq DESC, ol.device_id DESC`, the three-arm keyset predicate
(`created_at <` / `= AND seq <` / `= AND = AND device_id <`), and
`Cursor::for_history_full` in place of `Cursor::for_history_seq`.
`created_at` was already selected on `HistoryEntry`, so no new type, column
or migration — the SQL, the cursor binding and the doc block at the top of
the function are the whole change.

The cursor binding is the sibling's, including its refusal: a cursor whose
`deleted_at` slot carries no `created_at` is now an `AppError::Validation`
("cursor missing created_at for block history query") rather than a
defaulted sentinel. Neither stack mints such a cursor and nothing persists
one across a restart (there is no react-query persister), so the only way to
produce it is to hand one query another's cursor — which is what the page
listing already refuses.

`Cursor::for_history_seq` (`pagination/mod.rs:739`) now has no caller. It is
left in place, along with two comments that still describe the two-slot
block cursor — `tests/command_integration/conformance_query.rs:1073-1074`
and `src/lib/tauri-mock/handlers/blocks.ts:246-248` — because this session
was scoped to the files the issue names. All three are a follow-up sweep,
not a behaviour question.

## `.sqlx` regeneration

`just gen-sqlx` from the worktree root, against the seeded `src-tauri/dev.db`.
The query's hash moved, so each of the four caches lost
`query-640d88a72b…json` and gained `query-9858f77d89…json`: root,
`agaric-store`, `agaric-engine`, `agaric-sync` (invariant 6 — all four in
the one commit).

## The inverted test

`test_list_block_history_multi_device_pagination`
(`agaric-store/src/pagination/tests.rs`) asserted `(2,B), (2,A), (1,B),
(1,A)` — i.e. that device A's seq-2 op from 01:00 outranks device B's seq-1
op from 02:00. Its fixture needed **no** timestamp tweak: the four ops are
already A1 00:00 < A2 01:00 < B1 02:00 < B2 03:00, so the two orders differ
at positions 2 and 3 and the expectation simply inverts to `(2,B), (1,B),
(2,A), (1,A)`. Either order returns the same four rows, so the sequence is
the only thing that can tell them apart — which is what makes the assertion
non-vacuous.

The other `list_block_history` tests are single-device with `created_at`
rising with `seq`, so they are unaffected and were re-run.

## Mock and conformance

`blockHistoryKey` and `pageHistoryKey` were the same tuple minus the lead
component, so they collapsed into one `historyKey`
(`src/lib/tauri-mock/handlers/history.ts`) and `get_block_history` now
paginates over the `['deleted_at', 'seq']` slots the page listing uses
(testing invariant 3).

`conformance/fixtures/query_history.json` regenerated with
`CONFORMANCE_UPDATE=1`. Exactly one recorded value moved: the
`block_history_page_1` step's `cursor`, `v1:{id,seq}` → `v1:{deleted_at,id,seq}`.
The regeneration also reflowed 35 unrelated fixtures (the updater writes
one array element per line); `npx oxfmt --write` on the 36 files put those
back byte-for-byte, verified by JSON-comparing every changed fixture against
`HEAD` — `query_history.json` was the only semantic diff.

**What the fixture does and does not pin.** It pins the cursor SHAPE, which
is the half of the fix the mock can get wrong on its own. It cannot pin the
row ORDER: every fixture op is appended through the one harness device
(`common.rs`'s `DEV`), the `seed` section takes only blocks, property
defs, properties and tags, and there is no per-op device knob — so `seq`
and `created_at` never disagree inside a fixture and a step whose two
orders coincide pins nothing. Giving the harness a second device is a
change to `conformance.rs` and the mock's replay twin, not to this fixture,
and was not taken here. The order itself is pinned by the Rust test above.
The step comments now say so, in place of the `Cursor::for_history_seq`
prose they carried.

## Verified

- `cargo check --workspace --all-targets` (SQLX_OFFLINE): clean.
- `cargo nextest run --workspace -E 'test(list_block_history) |
  test(block_history) | test(conformance_fixtures_match_backend)'`: 18
  passed, including `snapshot_block_history_response` (insta) and the two
  `#4336` attachment-op cases.
- `npx vitest run src/lib/tauri-mock/__tests__/ src/components/history/__tests__/
  src/lib/__tests__/tauri-mock.test.ts`: 54 files, 1302 passed.
- `npm run typecheck`: exit 0. `cargo fmt --all`: no change.

## Falsified

Both arms against `cp` copies, restored `cmp`-clean inside the same shell
invocation so the tree never held a disabled fix across a tool call.

- **Rust.** `history.rs` reverted to its `HEAD` content and the four
  `query-640d88a72b…json` cache entries restored from `HEAD` so the old SQL
  still compiled offline; the inverted test went red at `tests.rs:3498` —
  `assertion left == right failed: second: 02:00 — seq=1, device-B / left:
  (2, "device-A") / right: (1, "device-B")`. That is the defect itself:
  device A's seq-2 op from an hour earlier served ahead of device B's.
- **Mock.** `get_block_history`'s key reverted to `[seq, device_id]` with
  the `['seq']` slot list; `conformance.test.ts` went red on
  `fixture 'query_history'` at the `block_history_page_1` step —
  `- "cursor": "v1:{deleted_at,id,seq}" / + "cursor": "v1:{id,seq}"`.

## Not done

`docs/FEATURE-MAP.md` untouched: grepping it and `docs/features/views.md`
for the History ordering found nothing describing a keyset — the map carries
one line naming the History view, and `views.md` mentions ordering only for
batch revert.

No e2e spec. The divergence needs two paired devices in one op log, which
neither the mock-backed lane nor `e2e-tauri/` can stage today.
