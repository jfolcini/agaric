## Session 954 — #332 remove deprecated v1 (flat-map) Loro engine + migration path (2026-06-02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-02 |
| **Subagents** | orchestrator + 1 Explore (removal-surface map) |
| **Items closed** | #332 |
| **Items modified** | #332 (tracks #86 PEND-80) |
| **Tests added** | +1 / −6 (net −5 Rust; 6 migration tests removed, 1 guard test added) |
| **Files touched** | 1 (`src-tauri/src/loro/engine.rs`) |

**Summary:** Removed the v1→v2 Loro engine migration surface (PEND-80 Phase 3 follow-up).
PEND-80 #331 moved blocks from a flat `LoroMap` (format v1) to a `LoroTree` (v2), migrating
old snapshots forward on every import. Per the maintainer's go-ahead (all snapshots already
on v2), this deletes the now-dead migration/dedup/legacy-read code and replaces it with a
**loud reject guard** so a stray v1 snapshot fails with a clear error instead of silently
yielding an empty tree. Net −649/+73 lines in `engine.rs`. Backend-only; no SQL/migration.

**Done (the issue's checklist):**
- **Guard added** — `LoroEngine::reject_legacy_v1_snapshot` (called from `import` /
  `import_with_changed_blocks` where the migration used to run): errors if the deprecated
  `blocks` flat-map root is non-empty.
- **Removed** — `migrate_flat_blocks_to_tree`, `dedupe_block_nodes` (confirmed sole caller
  was the migration path — no other duplicate-node source), the `FIELD_PARENT_ID` const +
  its legacy read, the now-dead `read_optional_string` helper, the unused `HashSet` import,
  and the 6 migration tests + 3 `legacy_write_*` test helpers.
- **Kept `LEGACY_BLOCKS_ROOT`** — repurposed as the guard's v1-detection sentinel (a v2 doc
  never has a non-empty `blocks` map).
- **`ENGINE_FORMAT_VERSION`** doc updated (v1 no longer migrated → rejected).
- **New test** — `import_rejects_legacy_v1_flat_map_snapshot`: a hand-built v1 snapshot is
  rejected with a clear message; a clean v2 snapshot still imports (no false-positive).

**Deviation flagged for review:**
- **Kept the `PropertyValue::from_loro` Str/I64 tolerance** (the issue listed its "comments"
  for removal). That tolerance covers **pre-§2.1 property encoding** — a separate,
  migration-free concern from the v1 *block* model #332 targets; legacy Str-encoded
  numeric/bool *properties* are recovered via `value_type` at projection and have no
  migration, so removing the fallback would break them. It was also absent from the
  selected-scope preview. Left intact; noted in the PR.

**Verification:**
- `cargo check` clean (no unused-symbol warnings after the removals).
- `cargo nextest run` filtered to loro/engine/import/snapshot/sync — **337 passed**; the new
  guard test passes by exact name.

**Commit plan:** single commit; pushed; PR against `main`; not merged. #332 closed as
completed.
