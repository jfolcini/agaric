# Session 1729 — the two device-local reads join the conformance differential (#3830)

Refs #3830. `get_reminder_settings` ("device-local reminder preferences
in `app_settings`, outside the conformance snapshot scope") and
`list_peer_refs` ("peer registry outside the conformance snapshot scope")
leave the read waiver list the way #4995 and #4997 lifted the attachment
and link-metadata reads: a seed section per table on both stacks, and a
fixture per command driving the read through it. `NOT_YET_PINNED_READ`
13 to 11.

- `seed.app_settings` rows go into `app_settings` verbatim (`updated_at`
  stamped now, nothing projects it); the backend arm calls
  `reminders::get_settings`, the same function the command calls, and
  projects one fixed-head token, `reminder_settings#enabled=…#time=…`,
  the `count_trash` shape for an answer with no id. Two fixtures, because
  a seed precedes every step: `query_reminder_settings.json` seeds
  `enabled='1'`, `time='07:30'`; `query_reminder_settings_defaults.json`
  seeds nothing for the keys and pins `false` / `09:00`, and says it is
  non-vacuous only as the seeded fixture's twin.
- `seed.peer_refs` rows carry all thirteen columns `list_peer_refs`
  selects (`endpoint_id` 64 hex chars for migration 0107's `CHECK`); the
  projection is one token per row, head `peer_id`, the other twelve in
  `SELECT` order. Three peers discriminate `ORDER BY synced_at DESC` with
  a never-synced row last, and every nullable column is null on one row
  and set on another.
- Mock: an `appSettings` map replaces the module-local reminder struct so
  the seed loader stays generic; `list_peer_refs` sorts by `synced_at`
  descending with nulls last; the TS token grammar gains a `headed` spec
  for the id-less struct.

## Divergences the steps found

Three, fixed in the mock: `list_peer_refs` answered insertion order; its
rows lacked `endpoint_id` and `unpaired_by_peer_at_ms`; reminder settings
had no seedable backing at all.

## Verified

`npm run typecheck` clean; `npx vitest run src/lib/tauri-mock/__tests__/
src/lib/__tests__/tauri-mock.test.ts` 45 files, 1154 passed, plus the
notifications and settings component tests (84) and the pairing and
settings Playwright specs (16 passed); oxlint, oxfmt, `cargo fmt --check`
and typos clean; `cargo nextest run --workspace` 6318 passed, 13 skipped;
doc-tests green; `conformance_fixtures_match_backend` passes without
`CONFORMANCE_UPDATE`, and update mode left the sibling fixtures
byte-identical. The reviewer checked both seed inserts against every
migration touching `app_settings` and `peer_refs` (0053; 0001, 0075,
0100, 0107, 0111, 0113, 0114), the key names against `reminders.rs`, the
peer attribute list against the `SELECT` and the binding, and that the
reminder arm calls what the command calls. Falsified on copies: the
mock's peer sort flipped ascending reddened the `query_peer_refs` fixture
case; the mock ignoring the seed reddened the `query_reminder_settings`
case while its defaults twin stayed green, as the twin's description says
it must; the backend seed binding `device_name` as null reddened
`conformance_fixtures_match_backend`; the reviewer independently flipped
the mock's null-last rule and reddened the peer fixture, and skipped
`streamed_at` in the backend seed and reddened
`conformance_fixtures_match_backend` on all three rows. All restored,
`cmp` clean. Two reviewer notes taken before the push: the peer seed
loader iterates a column list instead of a thirteen-key literal, and the
reminder arm projects the serialized value so the token carries the wire
spelling.
