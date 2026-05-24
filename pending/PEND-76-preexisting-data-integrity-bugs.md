# PEND-76 — Pre-existing data-integrity & wiring bugs

Surfaced and verified by the 2026-05-24 overnight code-review campaign (30 rounds,
16 lenses across the whole codebase). **Every cluster here is pre-existing on
`main`** — none was introduced by the search-view hardening PR (#50). They were
deliberately NOT fixed during the unattended campaign because each is a
design-level, destructive-path, or product-decision change that is unsafe to
apply speculatively. Each carries an empirical repro or a verified premise; file
refs are as of the campaign snapshot.

Ordered by severity. **F1's headline cascade-wipe + edit-resurrection are FIXED
(2026-05-24); the remote-change *propagation* residual is deferred — see the F1
Status block.** F2–F5 are unstarted.

---

## F1 — Inbound delta-sync cascade-wipes the whole space (CRITICAL, data-usability)

`apply_remote` projects engine state to SQL via `project_block_full_to_sql`
(`loro/projection.rs:408`), which runs:

```sql
INSERT OR REPLACE INTO blocks (id, block_type, content, parent_id, position) VALUES (...)
```

With `PRAGMA foreign_keys=ON` (set on every connection, `db.rs`) and the
`ON DELETE CASCADE` FKs from migrations 0034/0061/0062, SQLite's `REPLACE`
*deletes* the conflicting `blocks` row first → cascade-deletes `block_tags`,
`block_properties`, `block_links`, `page_aliases`, `tags_cache`, `pages_cache`,
`agenda_cache`, `block_tag_inherited`, … and resets the un-listed columns
(`deleted_at`, `todo_state`, `priority`, `due_date`, `scheduled_date`, `page_id`)
to NULL. Compounding it: `import_with_changed_blocks` (`loro/engine.rs`) returns
**every** block in the space, not just the changed ones, so a single inbound sync
REPLACEs (and thus wipes) the whole space. `apply_remote`
(`sync_protocol/loro_sync.rs`) never re-projects tags/properties/`deleted_at`, and
the orchestrator (`sync_protocol/orchestrator.rs:~406`) enqueues no FTS/cache
rebuild (its `materializer` field is `#[expect(dead_code)]`; the returned
`space_id` is dropped).

The Loro engine keeps the correct state, so this is **data-USABILITY divergence
(tags/props appear to vanish post-sync), not permanent loss** — op_log + engine
are intact; a restart-replay / snapshot RESET restores it. The reviewer
reproduced the REPLACE-cascade empirically against the real schema. Existing e2e
misses it (`loro_sync_e2e_update_against_seeded_peer` only syncs disjoint
*creates*, never an edit to an existing tagged/propertied block, so REPLACE never
conflicts).

**Field-coverage facets of the same root cause:**

- **Soft-deletes resurrect on sync-pull (MAJOR).** `BlockSnapshot`
  (`loro/engine.rs:149`) carries no `deleted_at`; `read_block` never surfaces the
  engine's `FIELD_DELETED_AT`; the REPLACE writes `deleted_at = NULL`. Device A
  soft-deletes X + syncs → B resurrects X. The engine layer converges `deleted_at`
  correctly (proptest verifies) — the gap is purely the SQL projection.
- **`archived_at` / `is_conflict` / `conflict_source` clobbered (MINOR)** on any
  remotely-touched block (non-CRDT columns revert to defaults on every
  re-projection).
- **`apply_create_block` silently overwrites an existing block_id's container
  (MINOR)** (`engine.rs:218` — `insert_container` is last-writer-wins, not a merge
  or error). Rare (unique ULIDs + cursor-gated replay), but two peers creating the
  same id (deterministic id / purge-then-recreate race) silently drop one peer's
  content + edit-history with no logged error. Needs CRDT-semantics sign-off.
- **Phase-2 SQL uses `pool.begin()` (deferred tx) not `begin_immediate_logged`
  (MINOR)** (`sync_protocol/loro_sync.rs`), deviating from the L-5 / SQL-M-1
  convention. Mechanically safe to swap, but fix it WITH the upsert redesign.
- **Inbound apply discards `space_id` ⇒ no FE cache-invalidation / data-changed
  event (MINOR)** (`orchestrator.rs:~406`, `ApplyOutcome::Imported(_space_id)`).
  Even once F1 is fixed, the UI won't refresh after an inbound sync.

**Status (2026-05-24):**

✅ **FIXED — the cascade-wipe + edit-resurrection (the data-loss-grade symptom).**
`project_block_full_to_sql` now UPSERTs (`INSERT … ON CONFLICT(id) DO UPDATE`) only
the engine-authoritative core columns (`block_type`, `content`, `parent_id`,
`position`) instead of `INSERT OR REPLACE`. The row is never deleted, so the
`ON DELETE CASCADE` no longer fires: `block_tags`, `block_properties`,
`block_links`, `page_aliases`, all caches, and the un-listed columns (`deleted_at`,
`todo_state`, …) **survive** every inbound sync. `apply_remote`'s tx switched from
`pool.begin()` to `begin_immediate_logged` (SQL-M-1). Tests:
`project_block_full_upsert_preserves_derived_and_soft_delete_state`,
`project_block_full_reproject_does_not_resurrect_soft_deleted_cohort`,
`project_block_full_inserts_new_block` (projection.rs) +
`apply_remote_does_not_wipe_existing_block_derived_state` (loro_sync.rs).

⏳ **REMAINING — remote-change *propagation* to SQL (deferred; not a regression).**
The bulk path still does not re-project remote tag/property *changes* or remote
delete/restore into SQL (it never did — pre-existing). Critically, `deleted_at`
**cannot** be re-derived from the engine in this bulk path: `read_deleted` marks
only the delete *seed* (descendant soft-deletes are an SQL-side CTE fan-out, never
mirrored into the engine), so a per-block re-derive would resurrect soft-deleted
descendants — which is exactly why the upsert *preserves* `deleted_at` rather than
re-projecting it. Closing the propagation gap needs a **per-op-style projection in
the sync path** (replay each imported op through the existing
`project_*`/`tag_inheritance::*` helpers with the op's timestamp + descendant CTE),
or storing the real `deleted_at` timestamp in the engine. Couples with: enqueuing
an FTS/cache rebuild for the returned `space_id` (the orchestrator's `materializer`
field is still `#[expect(dead_code)]`), the `space_id`-drop FE-refresh MINOR, the
`archived_at`/`is_conflict` clobber MINOR, and the `apply_create_block`
overwrite MINOR. This is a design-level change requiring the per-op-vs-bulk
projection decision — schedule as its own focused effort.

## F2 — Attachment upload + render pipeline is unwired end-to-end (CRITICAL — verify intent)

The backend storage, sync transfer, and GC machinery are well-engineered and
correct; only the FE↔backend wiring is missing:

- **C1:** `add_attachment_inner` (`commands/attachments.rs:78,121-133`) requires a
  *relative* `fs_path` under `app_data_dir` with the bytes already written there,
  but there is **no `@tauri-apps/plugin-fs` dependency** (absent from
  `package.json`) and the FE upload sites (`EditableBlock.tsx:55-78`,
  `useSlashCommandProperty.ts:187-213`) pass the browser's **absolute** `file.path`
  with no byte-copy → `check_attachment_fs_path_shape` rejects every real-build
  upload.
- **C2:** `tauri.conf.json` has `assetProtocol: { scope: [], enable: false }` and
  `AttachmentRenderer.tsx` feeds a relative path to `convertFileSrc`, so even an
  existing file wouldn't render. Masked in tests by the tauri-mock.

**This is a feature-completion task, not a CR fix** (build the FE byte-copy via
plugin-fs + configure an `assetProtocol` scope to `$APPDATA/attachments/**` +
resolve fs_path to absolute). **First decide whether attachments are intentionally
not-yet-shipped.** Sub-items if pursued:

- **Single-block purge leaks attachment files (MAJOR).**
  `purge_block_inner` (`commands/blocks/crud.rs:1278-1303`) deletes attachment
  *rows* but never unlinks the files / enqueues `CleanupOrphanedAttachments` —
  whereas both bulk paths (`purge_blocks_by_ids_inner:2108-2205`,
  `purge_all_deleted_inner:1653`) do. Reachable from TrashView (purge one) +
  TagList (delete tag). Files leak until the boot/post-compaction sweep reclaims
  them (bounded). Fix = mirror the bulk pattern.
- **FE/BE MIME-list divergence (MINOR).** `lib/file-utils.ts:23-30` allows
  mp4/mov/mp3/wav/docx/xlsx; backend allow-list (`commands/mod.rs:377-384`) permits
  only image/pdf/text/json/zip/tar, with no FE pre-validation of MIME or the 50 MB
  cap → confusing generic failure. Share the allow-list + cap with the FE.

## F3 — Pairing writes a junk empty-string `peer_refs` row (MAJOR — contract/wiring)

`PairingDialog.tsx:297` passes `confirmPairing(passphrase, '')` →
`confirm_pairing_inner` (`commands/sync_cmds.rs:190-232`) has no `is_empty` guard
→ `upsert_peer_ref(pool, "")`. Effects: a blank ghost peer in `PairingPeersList`,
and `should_start_active` (`sync_daemon/mod.rs:122`) sees a non-empty peer list
and flips the daemon out of dormant mode for a peer that can never sync. **Not a
one-line fix:** the FE *always* sends `''` (the comment claiming the id is "derived
from the passphrase" is wrong), so a bare backend `is_empty` reject would break ALL
pairing — the real fix wires the FE to pass the scanned/typed remote device_id (a
pairing-contract change). Tests miss it (they pass a non-empty `"device-remote"`).
Verify the pairing flow with the maintainer.

## F4 — Session-created tags lack a `space` property (MAJOR — needs manual confirm)

`handleCreateTag` (`hooks/useBlockTags.ts:115`) calls
`createBlock({blockType:'tag'})` with no space/parent, so a tag created mid-session
resolves to space `None`; the target block resolves to `Some(S)`; `add_tag_inner`'s
`src_space != tag_space` guard (`tags.rs:113-124`) then fails with "cross-space
tag" until the boot-time `migrate_orphan_tags_to_space`
(`spaces/bootstrap.rs:698`). Manifests as a `tags.addFailed` toast right after
creating a tag in a non-default space. The FE unit test mocks `add_tag` to succeed,
so it doesn't exercise the real guard — needs manual verification in a
non-default-space context. Fix: set the active space on the new tag block at create
time, or relax the guard to auto-adopt the source block's space.

## F5 — Cross-space ref/content validators are dead code (MAJOR — needs product decision)

`validate_content_cross_space_refs` (`spaces/cross_space_validation.rs:30`) and
`validate_ref_property_cross_space` (`:79`) have **zero production callers** (only
`#[cfg(test)]`), despite the module doc + `space.rs:206-210` claiming they are
wired into `set_property` ref validation, `edit_block` content-scan, sync-ingress,
and bulk-import. So setting a ref-type property to a block in a different space is
NOT rejected, and editing a block to contain cross-space `[[ULID]]` / `#[ULID]`
tokens is NOT rejected (only `add_tag_inner` enforces cross-space, via its own
inline check). Fix: either wire the validators into `set_property_in_tx` + the
edit/create content paths, OR — if cross-space non-tag refs are intentionally
allowed — correct the misleading docs. Wiring enforcement may reject existing data
→ needs a product call.

---

## Notes

- These were captured from the 2026-05-24 CR campaign's "Deferred findings". The
  MINOR a11y / perf / UX / docs / test-coverage findings from the same campaign
  live in `REVIEW-LATER.md` (search the `CR-*` IDs).
- All file/line refs are a dated snapshot — re-locate before editing.
- F1 is the only confirmed release-relevant data bug; F2–F5 are correctness /
  feature-completeness gaps that have shipped on `main` for a while without a
  user-visible report (single-user / no-adversary threat model, per AGENTS.md).
