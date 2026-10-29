# Session 3085 — Property definitions sync as ops; engine format 6 (#5841 S1)

Slice S1 of #5841, built to the revised design (comment 6254978621) and the maintainer's answers after it. Definitions used to be a local table no op wrote, so a key declared `date` on one device projected as `text` on the other. Now each definition write appends one `set_property_def` op, and each space's Loro doc carries the definitions.

**Shipped:**
- **The op.** `SetPropertyDef { space_id, key, def, prior }`, where `def`/`prior` are `{value_type, options}` or null. `op_log.block_id` is the space id. The reverse swaps `def` and `prior`. No migration: `op_log.op_type` has no CHECK.
- **The engine.** A `property_definitions` root in every space doc holds one plain map per key, with no nested container. `ENGINE_FORMAT_VERSION` goes from 5 to 6. SQL `property_definitions` is now a projection of that root.
- **The commands.** Create, options edit and delete go through one writer, `write_property_def_in_tx`, in a `CommandTx` with engine rollback armed. They return `WithOps`, and delete returns the deleted definition.
  - A write that changes nothing appends no op.
  - The writer refuses built-ins and a type change. No production caller can reach the type-change refusal yet; S3's type change is its own op.
- **New spaces.** `create_space` and the fresh-vault bootstrap emit one op per default. A received space's doc therefore carries its definitions, so the receiver doesn't seed anything itself.
- **Import.** A definitions-only update is no longer swallowed by the no-op fast path, and the healing fallback includes the root's keys. A new definitions pass runs before Pass A in the same transaction. Only keys whose storage column changed have their values re-projected, and those blocks feed the agenda rebuild.
- **Recovery.** It projects the doc's definitions (upsert only) before it types the values.
- **Boot backfill.** `repair_property_definitions` appends one housekeeping op for each SQL row the doc lacks, trashed spaces included. It runs after the #5670 hydration, not in `Repair::OPS`: run earlier, it gave spaces that never had an engine one, and the hydration then seeded them whole (`boot_hydrates_legacy_attachment_rows_into_the_engine_5608` caught it).
- **Undo refuses a re-typing that would hide values.** Undoing a delete, or redoing a create, refuses with the forward create's validation when the key's held values don't fit the restored type. An options-only undo is never refused.
- **History.** The space filter also lists that space's `set_property_def` ops, which it used to drop because a space block has no `space_id`.
- **Settings.** Every definition write, and *Copy to space…*, gets an Undo toast. History labels the op.
- **Mock.** It mirrors all of the above and is pinned by the new `property_def_undo.json` and a same-options step in `property_def_writes.json`.
- **Docs.** AGENTS.md invariant 2 is amended, with the maintainer's approval in the issue. `crdt-and-recovery.md`, `data-and-events.md`, `editor-and-content.md`, `features/properties.md` and FEATURE-MAP are updated.

**Fixtures.** Every `create_space` adds five ops to a fixture's digest. Two fixtures name ops by position: `space_move_onto_a_taken_name` (the move is now O32) and `undo_revives_no_taken_name` (O16, O18, O19). Both are relabelled, comments included. The regeneration re-serialised every fixture. Each one whose parsed JSON was unchanged was restored byte for byte, and the changed ones keep the original key order.

**Accepted, not fixed:**
- **Definition ops touch the space page.** They bump the space page's `last_edited_ms`, and positional page undo on the space's own page can reach them.
- **Definitions that diverged before S1 resolve last-writer-wins.** A fresh device can bring back a default deleted before S1. Only the definition comes back, not its values.
- **A rare crash can resurrect a deleted definition.** Sequence: a peer's delete arrives, and this device crashes between the engine save and the SQL commit. The healing import cannot delete the stale row, and the backfill then re-emits it.
- **Every boot marks spaces with definitions dirty once.** The backfill reads through `for_space`. Cost only.
- **No `reconcile_engine` oracle compares definitions with the doc.** Aliases have none either.

**For S3.** `reproject_property_row_from_engine` routes any `Str` to `value_date` under `date` without checking it. A synced definition can now put a peer's non-date text there. S3's `coerce` is the fix.

**Release hold:** no release between S1 and S4.

**Ran:**
- clippy, clean.
- Full nextest in two partitions: 3618 + 3611 passed. Doc-tests passed.
- Full vitest: 23,781 passed.
- The whole Playwright lane: 1,567 passed. The only failures are the two `diagram-legibility` cases, which fail the same way on `main` with this container's headless shell.
- `prek --hook-stage manual`.
- Both conformance sides, plus targeted runs after the review fixes.
- Not run here: `e2e-tauri/property-defs-sync.e2e.ts`, which needs a native build; CI's `e2e-tauri-gate` covers it. The bench's numbers come from the `bench-smoke` dispatch.
