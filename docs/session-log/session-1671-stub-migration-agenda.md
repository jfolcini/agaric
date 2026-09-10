# Session 1671 — the agenda tests onto the typed seam

#4668 step 2, second directory: `src/components/agenda/__tests__`, the three
files the backlog listed there and nowhere else, so the directory goes to
zero. 51 hand-stub sites across three files; `MIGRATION_BACKLOG` 51 → 48.

## What the seam caught

Three stub shapes the backend cannot send, and one it sends differently:

- **`get_status`** — the `StatusPanel` fixture carried four fields.
  `StatusInfo` has thirty-four, all required. Every test in the file pinned
  a response nothing produces, and the panel's `?? 0` for `fg_high_water`,
  `bg_high_water` and `bg_dropped` is dead against the real backend. The
  fixture now carries all of them, counters zeroed so every assertion that
  read a defaulted zero still reads zero; `retry_queue_pending`, the one
  nullable field of the pair, stays `null` so the staleness notice's live
  `?? 0` branch stays covered. Two tests that were titled after omitted
  fields are retitled after the zeros they actually assert.
- **`start_sync`** — the catch-all handed it a `StatusInfo`; it returns
  `SyncSessionInfo`. Stubbed with a real one.
- **`count_agenda_batch_by_source`** — the `GlobalDateControls` catch-all
  resolved `[]` for both commands the dropdown fires; this one returns a
  `Record<date, Record<source, count>>`. It is genuinely invoked: dropping
  the handler reddens six of the seventeen tests on the strict fallback.
- **`list_tags_by_prefix`** — rows omitted `updated_at`, which `TagCacheRow`
  always carries.

Four positional queues became command-keyed handlers: two `…Once` pairs in
`StatusPanel` (mount load, then a poll that answers differently) now key on
call order inside one handler; two `mockRejectedValueOnce` sites in
`GlobalDateControls` that relied on hook registration order now name the
command that fails. No assertion was weakened; 121 tests keep what they
asserted.

## Falsification

The builder's: removing `retry_queue_pending: null` from the fixture fails
`typecheck` with TS2741 on `StatusInfo`. Mine, independently, on a copy:
removing `updated_at` from `tagRow` fails it on `TagCacheRow`. Both restored
and `cmp`-verified, typecheck back to exit 0.

## Outside this directory, for the next pass

`src/lib/tauri-mock/handlers/system.ts`'s `get_status` returns the same
eight-field subset the vitest fixture used to. The invoke ratchet cannot see
it — it is the mock, not a stub — but it is the same drift, one layer over.

## Verified

- vitest on the three files plus the ratchet: 4 files, 121 passed; run by
  the builder and again by me.
- `npm run typecheck` exit 0, twice.
- Not run locally: the full suites (CI carries them; the laptop is in use).
