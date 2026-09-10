# Session 1673 — the pages tests onto the typed seam

#4668 step 2, third directory: `src/components/pages/__tests__`, the three
files the backlog listed there. 42 hand-stub sites; `MIGRATION_BACKLOG`
48 → 45. `PagePropertyTable` keeps two `invoke` routes that are not stubs:
its `#2792` / `#2804` blocks drive the real tauri-mock `dispatch`, which is
the point of those blocks, and the ratchet does not count them.

## What the seam caught

- **`restore_blocks_by_ids`** — the Undo test stubbed `{ restored: n }`;
  the command answers `BulkTrashResponse`, `{ affected_count }`.
- **`list_property_defs`** — eight stubs omitted `total_count`, which
  `PageResponse<T>` always serialises. One `defsPage()` helper now.
- **`update_property_def_options`** — the stub spread a `find()` that missed
  whenever the test's def list lacked the key, producing a
  `PropertyDefinition` with no `value_type` and no `created_at`. It now
  answers a complete def.
- **`set_property`** and **`delete_property`** — resolved `undefined`; they
  answer `WithOps<BlockRow>` and `WithOps<DeletePropertyResponse>`. Inside
  the seam's documented `undefined` hole, so they would not have reddened,
  but a shape the backend cannot send all the same.
- Two `beforeEach` catch-alls (`mockResolvedValue(undefined)`,
  `mockResolvedValue(emptyPage)`) handed every command a value; neither
  suite needed one, and the strict fallback now names any call that does.
  Four `137 as unknown as never` casts in `ViewDispatcher` are gone because
  the seam types `count_trash` as `number`.

Two order-dependent stubs became explicit: the Undo test's two `…Once`
values for two different commands are command-keyed handlers installed once,
and the reload-after-save failure in `PagePropertyTable` is a flag the
`set_property` handler flips and `get_properties` reads. A `callCount >= 1`
assertion that could not fail is gone. No assertion weakened; 116 tests keep
what they asserted.

## Falsification

The builder's: restoring `{ restored: n }` on `restore_blocks_by_ids` fails
`typecheck` with TS2322 against `BulkTrashResponse`. Mine, independently, on
a copy: removing `total_count` from `defsPage` fails it with TS2741 on
`PageResponse<PropertyDefinition>`. Both restored and `cmp`-verified,
typecheck back to exit 0.

## Verified

- vitest on the three files plus the ratchet: 4 files, 116 passed; by the
  builder and again by me.
- `npm run typecheck` exit 0, twice.
- Not run locally: the full suites (CI carries them; the laptop is in use).
