# Sync Blockers Implementation Plan

> **COMPLETED** — All 18 items resolved in commit `a3a38a5` (2026-04-01 Session 28). See SESSION-LOG.md Session 28 for details.

> 18 open items from REVIEW-LATER.md Tier 1 (Sync Blockers). All must be resolved before Phase 4 multi-device sync.

## Strategy

Two waves of parallel build subagents, following AGENTS.md workflow (BUILD → TEST → REVIEW → MERGE → COMMIT → LOG). Wave 1 targets non-overlapping file groups. Wave 2 handles the pervasive type-safety refactor plus remaining hardening items.

---

## Wave 1 — 4 parallel builds (worktrees, no file overlap)

### Build A: Hash & Serialization (#1, #8, #9)

**Files:** `src-tauri/src/hash.rs`, `src-tauri/src/op_log.rs`

#### #1 — Canonical JSON ordering for cross-version determinism

**Problem:** `serialize_inner_payload` calls `serde_json::to_string(p)` which outputs fields in Rust struct declaration order. This is deterministic within a single serde version but NOT guaranteed across serde versions. The doc comment says "canonical JSON" but the serialization is not truly canonical.

**Fix:** Serialize through `serde_json::to_value()` first, then `serde_json::to_string()`. Since serde_json uses `BTreeMap` by default (no `preserve_order` feature in `Cargo.toml`), the intermediate `Value` has alphabetically sorted keys. The final string output is therefore canonical.

```rust
// op_log.rs — change serialize_variant macro (lines 49-55):
macro_rules! serialize_variant {
    ($op:expr; $($variant:ident),+ $(,)?) => {
        match $op {
            $(OpPayload::$variant(p) => {
                // Serialize to Value first for canonical key ordering (BTreeMap).
                // serde_json::to_string on derive(Serialize) outputs fields in
                // declaration order — deterministic within a serde version but
                // not guaranteed across versions. Going through Value ensures
                // alphabetical key ordering regardless of serde internals.
                let value = serde_json::to_value(p)?;
                Ok(serde_json::to_string(&value)?)
            },)+
        }
    };
}
```

**Impact on existing data:** Changes hash output for all payloads where declaration order differs from alphabetical order. Since sync (Phase 4) is not implemented, no cross-device verification exists yet. The golden hash test vector in `hash.rs` tests must be updated to match the new canonical output.

**Tests:**
- Update golden hash test vector to match new canonical serialization
- New test: `canonical_json_keys_are_sorted` — serialize a payload with multiple fields, parse back as `serde_json::Value`, assert keys are alphabetically ordered
- New test: `canonical_json_matches_across_serialization_paths` — verify `to_value → to_string` matches for all 12 payload types

#### #8 — Null-byte separator collision risk in hash inputs

**Problem:** `compute_op_hash` uses `\0` as a field delimiter. If any input field contained `\0`, two different inputs could produce the same hash (collision). Currently safe because ULIDs, UUIDs, JSON, and op_type strings never contain `\0`, but no guard prevents this invariant from being broken.

**Fix:** Add `debug_assert!` guards in `compute_op_hash` (lines 57-66):

```rust
// After line 45 (parent_seqs_canonical assignment):
debug_assert!(
    !device_id.contains('\0'),
    "device_id must not contain null bytes"
);
debug_assert!(
    !parent_seqs_canonical.contains('\0'),
    "parent_seqs must not contain null bytes"
);
debug_assert!(
    !op_type.contains('\0'),
    "op_type must not contain null bytes"
);
// payload may validly contain \0 in JSON string escapes (\u0000),
// but serde_json serializes \0 as \\u0000, so raw \0 in the
// serialized string would indicate corruption.
debug_assert!(
    !payload.contains('\0'),
    "payload must not contain raw null bytes"
);
```

**Tests:**
- Existing test `embedded_null_bytes_produce_distinct_hashes` already covers the hash-level behavior
- New test: verify debug_assert fires in debug builds when device_id contains `\0`

#### #9 — `constant_time_eq` length check leaks timing information

**Problem:** The function name implies constant-time comparison, but the early `if a.len() != b.len()` return leaks length timing info. For blake3 hashes (always 64 hex chars), this is benign, but the function name is misleading if reused.

**Fix:** Add a doc comment clarifying the fixed-length invariant (no code change needed):

```rust
/// Constant-time byte-slice comparison (avoids early-exit on first diff).
///
/// **Note:** The `a.len() != b.len()` early return means this is only truly
/// constant-time for equal-length inputs. This is safe for our use case
/// (blake3 hex hashes are always exactly 64 bytes) but callers should not
/// assume constant-time behavior for variable-length inputs.
#[inline]
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
```

**Tests:** No new tests needed (existing 4 tests cover the function).

**Verification:** `cd /tmp/wt-buildA/src-tauri && cargo test -p block-notes-lib -- hash:: op_log::`

---

### Build B: DB & Infrastructure (#5, #10, #12, #13)

**Files:** `src-tauri/src/db.rs`, `src-tauri/src/snapshot.rs`, `src-tauri/src/materializer.rs`, `src-tauri/migrations/0003_op_log_block_id_index.sql`

#### #5 — `json_extract` queries on op_log are O(n)

**Problem:** 14 instances of `json_extract(payload, '$.block_id')` across 5 files do full table scans with JSON parsing per row. Becomes a bottleneck as op_log grows with multi-device sync.

**Fix:** Add an expression index via a new migration. SQLite 3.9+ supports indexes on expressions. The query planner will use this index for any WHERE clause matching the exact expression.

```sql
-- migrations/0003_op_log_block_id_index.sql
-- Expression index to avoid full-table scans on json_extract queries.
-- Covers the 14 instances of json_extract(payload, '$.block_id') across
-- recovery.rs, commands.rs, reverse.rs, pagination.rs, dag.rs.
CREATE INDEX IF NOT EXISTS idx_op_log_payload_block_id
    ON op_log(json_extract(payload, '$.block_id'));
```

No code changes needed — existing queries already use the exact `json_extract(payload, '$.block_id')` expression that the index covers.

**Impact:** After migration, the 14 json_extract queries go from O(n) table scan to O(log n) index lookup. The index is maintained automatically on INSERT.

**Tests:**
- New test in `op_log.rs`: `expression_index_exists` — verify the index exists after migration by querying `sqlite_master`
- Run `cargo sqlx prepare -- --lib` to regenerate offline cache (migration adds new file)

#### #10 — No explicit WAL checkpoint configuration

**Problem:** No `PRAGMA wal_autocheckpoint` is set. During Phase 4 sync initial load, the WAL file could grow very large before being checkpointed.

**Fix:** Add to `base_connect_options` in `db.rs` (line 47):

```rust
fn base_connect_options(db_path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(db_path)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .create_if_missing(true)
        .pragma("foreign_keys", "ON")
        .pragma("wal_autocheckpoint", "1000")  // checkpoint every 1000 pages (~4MB)
        .busy_timeout(std::time::Duration::from_secs(5))
}
```

1000 pages is SQLite's default, but making it explicit documents our intent and prevents unexpected WAL growth if a future SQLite version changes the default.

**Tests:**
- New test in `db.rs`: `wal_autocheckpoint_is_configured` — query `PRAGMA wal_autocheckpoint` and assert it returns 1000

#### #12 — Old snapshots accumulate without cleanup

**Problem:** `compact_op_log` creates new snapshots but never deletes old ones. The `log_snapshots` table grows unboundedly.

**Fix:** Add `cleanup_old_snapshots` function to `snapshot.rs`:

```rust
/// Delete old snapshots, keeping only the `keep` most recent complete snapshots.
/// Returns the number of deleted rows.
pub async fn cleanup_old_snapshots(
    pool: &SqlitePool,
    keep: usize,
) -> Result<u64, AppError> {
    let keep_i64 = keep as i64;
    let result = sqlx::query!(
        "DELETE FROM log_snapshots WHERE id NOT IN \
         (SELECT id FROM log_snapshots WHERE status = 'complete' \
          ORDER BY id DESC LIMIT ?)",
        keep_i64,
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}
```

Call it at the end of `compact_op_log` after purging old ops:

```rust
// After line 451 (DELETE FROM op_log WHERE created_at < ?):
cleanup_old_snapshots(pool, 3).await?;  // keep 3 most recent
```

**Tests:**
- New test: `cleanup_old_snapshots_keeps_n_most_recent` — create 5 snapshots, call cleanup(2), verify 2 remain
- New test: `cleanup_old_snapshots_noop_when_fewer_than_keep` — create 1, call cleanup(3), verify 1 remains
- New test: `compact_op_log_cleans_up_old_snapshots` — verify compaction also triggers cleanup

#### #13 — `handle_foreground_task` is a no-op stub

**Problem:** `dispatch_op()` enqueues `ApplyOp` on the foreground queue but `handle_foreground_task` just logs a debug message. Silent no-op that could mask Phase 4 integration issues.

**Fix:** Replace the debug log with a more prominent warning that documents the Phase 4 intent. Do NOT use `todo!()` or `unimplemented!()` — the function IS called for every operation and panicking would crash the app.

```rust
MaterializeTask::ApplyOp(record) => {
    // Phase 1: local ops are applied directly by command handlers.
    // Phase 4 TODO: implement remote op application here — when sync
    // delivers remote ops, this handler must apply them to the blocks
    // table (the command layer only handles local ops).
    tracing::debug!(
        op_type = %record.op_type,
        seq = record.seq,
        "foreground ApplyOp no-op (Phase 1: command handler already applied)"
    );
    Ok(())
}
```

**Tests:** No new tests needed (existing materializer tests verify the function doesn't error).

**Verification:** `cd /tmp/wt-buildB/src-tauri && cargo test -p block-notes-lib -- db:: snapshot:: materializer::`

---

### Build C: DAG & Merge (#6, #11, #67)

**Files:** `src-tauri/src/dag.rs`, `src-tauri/src/merge.rs`

#### #6 — `find_lca` compaction guard missing

**Problem:** `find_lca` walks the `prev_edit` chain but silently fails with `AppError::NotFound` if compaction has purged intermediate ops. The docstring warns about this but no runtime guard exists.

**Fix:** Add a compaction check at the top of `find_lca` that detects when the chain is broken. Query the earliest op for the block — if either head predates a compaction boundary, return a clear error instead of a cryptic NotFound.

```rust
pub async fn find_lca(
    pool: &SqlitePool,
    op_a: &(String, i64),
    op_b: &(String, i64),
) -> Result<Option<(String, i64)>, AppError> {
    // Guard: detect if a compaction may have broken the chain.
    // If a snapshot exists AND op_log is missing entries before a head's
    // earliest ancestor, the chain is incomplete.
    let has_snapshots = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'"
    )
    .fetch_one(pool)
    .await?;

    // Build visited set from chain A (including op_a itself)
    let mut visited: HashSet<(String, i64)> = HashSet::new();
    let mut current: Option<(String, i64)> = Some(op_a.clone());
    while let Some(key) = current.take() {
        visited.insert(key.clone());
        match get_op_by_seq(pool, &key.0, key.1).await {
            Ok(record) => current = extract_prev_edit(&record)?,
            Err(AppError::NotFound(_)) if has_snapshots > 0 => {
                return Err(AppError::InvalidOperation(format!(
                    "edit chain for ({}, {}) is broken — likely due to op log compaction. \
                     LCA requires intact chains.",
                    key.0, key.1
                )));
            }
            Err(e) => return Err(e),
        }
    }

    // Walk chain B, checking each step against the visited set
    let mut current: Option<(String, i64)> = Some(op_b.clone());
    while let Some(key) = current.take() {
        if visited.contains(&key) {
            return Ok(Some(key));
        }
        match get_op_by_seq(pool, &key.0, key.1).await {
            Ok(record) => current = extract_prev_edit(&record)?,
            Err(AppError::NotFound(_)) if has_snapshots > 0 => {
                return Err(AppError::InvalidOperation(format!(
                    "edit chain for ({}, {}) is broken — likely due to op log compaction. \
                     LCA requires intact chains.",
                    key.0, key.1
                )));
            }
            Err(e) => return Err(e),
        }
    }

    Ok(None)
}
```

**Tests:**
- New test: `find_lca_after_compaction_returns_clear_error` — compact the op log, then attempt find_lca, verify `AppError::InvalidOperation` with "compaction" message
- Existing test `find_lca_after_compaction_produces_not_found` should be updated to match new behavior

#### #11 — `MAX_CHAIN_WALK_ITERATIONS` too large

**Problem:** The 10,000 iteration limit in `merge.rs` means a corrupted cyclic chain could consume significant CPU before being caught. The chain walk in merge.rs (line 21) also doesn't use a `HashSet` for cycle detection — it relies solely on the iteration count.

**Fix:**
1. Reduce `MAX_CHAIN_WALK_ITERATIONS` from 10,000 to 1,000 (personal notes app — chains longer than 1000 edits are pathological)
2. Add `HashSet` cycle detection to the chain walk in `merge_text` (lines 99-127):

```rust
const MAX_CHAIN_WALK_ITERATIONS: usize = 1_000;

// In merge_text, the no-LCA fallback walk:
let mut visited_walk: HashSet<(String, i64)> = HashSet::new();
while let Some(key) = current.take() {
    iterations += 1;
    if iterations > MAX_CHAIN_WALK_ITERATIONS {
        return Err(AppError::InvalidOperation(format!(
            "prev_edit chain for block '{}' exceeded {} iterations \
             — possible cycle in corrupted data",
            block_id, MAX_CHAIN_WALK_ITERATIONS,
        )));
    }
    if !visited_walk.insert(key.clone()) {
        return Err(AppError::InvalidOperation(format!(
            "cycle detected in prev_edit chain for block '{}' at ({}, {})",
            block_id, key.0, key.1,
        )));
    }
    // ... rest of loop body
}
```

**Tests:**
- New test: `chain_walk_detects_cycle` — construct a cyclic prev_edit chain (requires direct DB insertion), verify `InvalidOperation` error with "cycle" message
- Update any tests that reference the old 10,000 limit

#### #67 — merge.rs conflict copies discard local ("ours") content

**Problem:** In `merge_block` (lines 329-357), the conflict branch destructures with `ours: _` (discards local edits) and sets the original block to ancestor text (`to_text: ancestor`). The user's local work is lost — they see the stale ancestor and the remote version, but their own edits are gone.

**Fix:** Keep local content ("ours") on the original block, put remote content ("theirs") on the conflict copy (the Git model). This is a one-line logic change plus a field name update:

```rust
MergeResult::Conflict {
    ours,          // was: ours: _
    theirs,
    ancestor: _,   // was: ancestor
} => {
    // Conflict copy gets "theirs" (remote) content — already correct
    let conflict_op = create_conflict_copy(pool, device_id, block_id, &theirs).await?;

    // Original block keeps "ours" (local) content — was ancestor
    let merge_payload = OpPayload::EditBlock(EditBlockPayload {
        block_id: block_id.to_owned(),
        to_text: ours,   // was: ancestor
        prev_edit: Some(our_head.clone()),
    });
    let parent_entries = vec![our_head.clone(), their_head.clone()];
    let _merge_record =
        dag::append_merge_op(pool, device_id, merge_payload, parent_entries).await?;

    Ok(MergeOutcome::ConflictCopy {
        original_kept_ancestor: false,  // was: true
        conflict_block_op: conflict_op,
    })
}
```

Also rename `original_kept_ancestor` to `original_kept_ours` in `MergeOutcome` for clarity:

```rust
pub enum MergeOutcome {
    Merged(OpRecord),
    ConflictCopy {
        original_kept_ours: bool,  // was: original_kept_ancestor
        conflict_block_op: OpRecord,
    },
    AlreadyUpToDate,
}
```

**Tests:**
- Update existing conflict merge tests to verify original block has "ours" text (not ancestor)
- New test: `conflict_merge_preserves_local_content` — merge with conflicting edits, verify original block's `to_text` matches local content and conflict copy has remote content
- Update any tests referencing `original_kept_ancestor`

**Verification:** `cd /tmp/wt-buildC/src-tauri && cargo test -p block-notes-lib -- dag:: merge::`

---

### Orchestrator: Design Decisions (#68, #69, #70)

**File:** `ADR.md` — direct edits, no subagent needed (doc-only, no code or tests).

#### #68 — Concurrent delete+edit: no sync-time resolution

**Decision:** Resurrect. A remote `edit_block` targeting a locally-deleted block means the remote user intended the block to exist. Apply the edit AND clear `deleted_at`. Emit a synthetic `restore_block` op before applying the `edit_block`. Log the auto-resurrection in Status View.

**Rationale:** Discarding silently loses data. Conflict copy is overcomplicated for this case (the remote user's intent is clear). The Git model also resurrects — a merge commit that includes both a delete and an edit in different branches keeps the file if the edit is more recent.

#### #69 — `move_block` sync conflicts: 3 unspecified scenarios

**Decisions:**
1. **Same block moved to different parents:** LWW on `created_at` (same as property conflicts). Winner's parent is used. Logged in Status View.
2. **Block moved into a concurrently deleted subtree:** Reparent to document root (parent_id = NULL). Emit synthetic `move_block` to root. Log in Status View as "Block [id] reparented to root — original parent was deleted."
3. **Interleaved batch move ops:** Resolve position conflicts per-parent using the existing position compaction (insert at position, shift siblings). Process in `created_at` order within each parent.

#### #70 — Duplicate tag blocks across devices after sync

**Decision:** Materializer background dedup. On cache rebuild, detect tag blocks with duplicate content (case-insensitive). Keep the lexicographically smallest ULID as canonical. Emit `edit_block` ops to rewrite `#[loser-ULID]` tokens to `#[winner-ULID]` in all blocks that reference the loser. Update `block_tags` rows. This is a background reconciliation — no user action needed. Log dedup events in Status View.

**Rationale:** Option (a) (merge on sync) is correct but invasive and generates ops during sync streaming. Option (c) (expose to user) adds UI complexity for a fixable problem. Background dedup runs after sync completes and is idempotent.

All three decisions are appended to ADR-09.

---

## Wave 2 — 1 build subagent (after Wave 1 merged)

### Build D: Type Safety & Hardening (#2, #3, #4, #7, #130)

**Files:** `src-tauri/src/op.rs`, `src-tauri/src/device.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/recovery.rs`, `src-tauri/src/reverse.rs`, `src-tauri/src/merge.rs`, `src-tauri/src/dag.rs`

This is the largest build — #2 is a pervasive mechanical refactor touching all files that construct or destructure `OpPayload` variants. Grouped with the remaining small items since they overlap in the same files.

#### #2 — Op payload `block_id` fields are `String`, not `BlockId`

**Problem:** All 12 `OpPayload` structs use `pub block_id: String` instead of the `BlockId` newtype. Runtime normalization via `normalize_block_ids()` mitigates but doesn't provide compile-time safety. A future sync path could construct payloads with non-normalized ULIDs, breaking cross-device hash determinism.

**Fix:** Change all ULID-typed `String` fields to `BlockId` (or `AttachmentId` for attachment IDs). `BlockId` auto-normalizes on deserialization and implements `Serialize` as a plain string, so JSON compatibility is preserved.

**Fields to change:**

| Struct | Field | From | To |
|--------|-------|------|-----|
| CreateBlockPayload | `block_id` | `String` | `BlockId` |
| CreateBlockPayload | `parent_id` | `Option<String>` | `Option<BlockId>` |
| EditBlockPayload | `block_id` | `String` | `BlockId` |
| DeleteBlockPayload | `block_id` | `String` | `BlockId` |
| RestoreBlockPayload | `block_id` | `String` | `BlockId` |
| PurgeBlockPayload | `block_id` | `String` | `BlockId` |
| MoveBlockPayload | `block_id` | `String` | `BlockId` |
| MoveBlockPayload | `new_parent_id` | `Option<String>` | `Option<BlockId>` |
| AddTagPayload | `block_id` | `String` | `BlockId` |
| AddTagPayload | `tag_id` | `String` | `BlockId` |
| RemoveTagPayload | `block_id` | `String` | `BlockId` |
| RemoveTagPayload | `tag_id` | `String` | `BlockId` |
| SetPropertyPayload | `block_id` | `String` | `BlockId` |
| DeletePropertyPayload | `block_id` | `String` | `BlockId` |
| AddAttachmentPayload | `block_id` | `String` | `BlockId` |
| AddAttachmentPayload | `attachment_id` | `String` | `AttachmentId` |
| DeleteAttachmentPayload | `attachment_id` | `String` | `AttachmentId` |

**Fields NOT changed:**
- `EditBlockPayload.prev_edit: Option<(String, i64)>` — the String is a device_id (UUID), not a ULID
- `RestoreBlockPayload.deleted_at_ref: String` — a timestamp
- `AddAttachmentPayload.mime_type`, `filename`, `fs_path` — not IDs
- `SetPropertyPayload.key`, `value_text`, `value_date` — not IDs
- `SetPropertyPayload.value_ref: Option<String>` — could be a BlockId but also supports non-ULID refs; defer to Phase 4

**Construction site updates (mechanical):**
- `commands.rs`: ~12 command functions construct payloads. Change `block_id: id.to_string()` or `block_id: block_id.clone()` to use `BlockId` directly (most already have `BlockId` from `BlockId::new()` or function params).
- `reverse.rs`: ~10 reverse functions destructure payloads and reconstruct. Since deserialization auto-normalizes, destructured fields are already `BlockId`.
- `merge.rs`: 2 `EditBlockPayload` constructions (lines 318, 344). Change `block_id: block_id.to_owned()` to `BlockId::from_string(block_id)?`.
- `recovery.rs`: 1 `EditBlockPayload` construction. Same pattern.
- `dag.rs`: `extract_prev_edit` and `text_at` destructure deserialized payloads — types flow through automatically.

**Simplification of `normalize_block_ids()`:** After this change, `BlockId` fields are already normalized on construction/deserialization. The function can be simplified to only normalize the remaining `String` fields (none after full conversion). Consider marking it as a no-op or removing it, but keep the call site in `append_local_op_in_tx` as a defensive guard.

**`OpPayload::block_id()` return type:** Change from `Option<&str>` to `Option<&str>` (using `BlockId::as_str()`). No signature change needed.

**Tests:**
- All existing tests should continue to pass (BlockId serializes as a String)
- Snapshot tests may need `cargo insta review` if field serialization changes (unlikely — BlockId serializes identically to String)
- New test: `payload_block_id_rejects_invalid_ulid_on_deser` — verify that deserializing a payload with an invalid block_id produces an error
- New test: `payload_block_id_normalizes_on_deser` — verify lowercase input normalizes to uppercase

#### #7 — DeviceId has public inner field

**Problem:** `DeviceId(pub String)` allows untrusted construction bypassing UUID validation. A sync path could introduce invalid device IDs.

**Fix:** Make the field private, add constructor and accessor:

```rust
#[derive(Clone, Debug)]
pub struct DeviceId(String);

impl DeviceId {
    /// Create a DeviceId from a validated UUID string.
    pub fn new(id: String) -> Self {
        Self(id)
    }

    /// Returns the inner UUID string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for DeviceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
```

Update all `.0` access sites to use `.as_str()`. Search for `device_id.0` and `DeviceId(` across the codebase.

**Tests:**
- Update existing `device_id_stores_and_exposes_inner_string` test to use `.as_str()`
- New test: `device_id_display_shows_uuid` — verify Display impl

#### #4 — No input length limits on command string parameters

**Problem:** `create_block_inner` and `edit_block_inner` accept arbitrarily large strings. A remote sync payload could exhaust memory or bloat the op_log.

**Fix:** Add a `MAX_CONTENT_LENGTH` constant and validation at the top of `create_block_inner` and `edit_block_inner`:

```rust
/// Maximum allowed content length for a single block (256 KB).
/// This is a safety limit for sync — local UI is unlikely to produce
/// content this large (auto-split limits blocks to ~1 paragraph).
const MAX_CONTENT_LENGTH: usize = 256 * 1024;

// In create_block_inner, after block_type validation:
if content.len() > MAX_CONTENT_LENGTH {
    return Err(AppError::Validation(format!(
        "content length {} exceeds maximum {MAX_CONTENT_LENGTH}",
        content.len()
    )));
}

// In edit_block_inner, at the top:
if to_text.len() > MAX_CONTENT_LENGTH {
    return Err(AppError::Validation(format!(
        "content length {} exceeds maximum {MAX_CONTENT_LENGTH}",
        to_text.len()
    )));
}
```

Also add limits for property keys (already validated at 64 chars in `validate_set_property`) and property values:

```rust
/// Maximum allowed length for a property value_text (64 KB).
const MAX_PROPERTY_VALUE_LENGTH: usize = 64 * 1024;
```

**Tests:**
- New test: `create_block_rejects_oversized_content` — verify Validation error for content > 256KB
- New test: `edit_block_rejects_oversized_content` — same for edit
- Update existing `100KB content test` to verify it still passes (100KB < 256KB)

#### #3 — `recovery.rs find_prev_edit` ORDER BY created_at needs Phase 4 rework

**Problem:** `find_prev_edit` uses `ORDER BY created_at DESC` which is correct for single-device but breaks with multi-device sync where clocks diverge. The function already has a TODO comment (line 292) and a docstring noting Phase 4 rework.

**Fix:** Enhance the documentation to be more specific about what the Phase 4 rework entails. No code change — the function works correctly for Phase 1 and the rework requires DAG integration that doesn't exist yet.

```rust
/// Find the most recent `edit_block` or `create_block` op for a given block.
///
/// # Phase 4 rework required
///
/// This function uses `ORDER BY created_at DESC` which assumes a single
/// device with a monotonic clock. For multi-device sync (Phase 4), this
/// must be replaced with DAG-aware head discovery:
///
/// 1. Use `get_block_edit_heads()` from `dag.rs` to find all edit heads
///    across devices.
/// 2. If exactly one head exists, use it as prev_edit.
/// 3. If multiple heads exist (concurrent edits), the caller must first
///    merge them via `merge_block()` before proceeding.
///
/// The `ORDER BY created_at DESC` approach will produce incorrect results
/// when device clocks are skewed — it may select a causally-earlier op
/// from a device with a faster clock over a causally-later op from a
/// device with a slower clock.
```

**Tests:** No new tests needed — this is a documentation change.

#### #130 — EditBlock reverse sets `prev_edit: None`, breaks edit chain

**Problem:** In `reverse.rs` line 118, `reverse_edit_block` hardcodes `prev_edit: None` instead of pointing to the op being reversed. After an undo/redo cycle, the edit chain becomes "forked" and subsequent three-way merges lose accuracy.

**Fix:** Set `prev_edit` to point to the original op that is being reversed (the reverse op follows it in the chain):

```rust
async fn reverse_edit_block(pool: &SqlitePool, record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: EditBlockPayload = serde_json::from_str(&record.payload)?;

    let prior_text = find_prior_text(pool, &payload.block_id, &record.created_at, record.seq)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "no prior text found for block '{}' before ({}, {})",
                payload.block_id, record.device_id, record.seq
            ))
        })?;

    Ok(OpPayload::EditBlock(EditBlockPayload {
        block_id: payload.block_id,
        to_text: prior_text,
        // Point back to the op being reversed to maintain the edit chain.
        // This ensures three-way merge can walk the full chain and find
        // correct LCA during multi-device sync.
        prev_edit: Some((record.device_id.clone(), record.seq)),
    }))
}
```

**Tests:**
- Update existing `reverse_edit_block_produces_edit_with_prior_text` test to assert `prev_edit` is `Some((device_id, seq))` instead of `None`
- New test: `reverse_edit_preserves_chain_lineage` — create → edit → reverse(edit), verify the reverse op's `prev_edit` points to the original edit op
- New test: `undo_redo_cycle_maintains_continuous_chain` — create → edit → undo → redo, verify the full chain can be walked via `prev_edit` without gaps

**Verification:** `cd src-tauri && cargo test -p block-notes-lib -- op:: device:: commands:: recovery:: reverse:: merge:: dag::`

---

## Merge Strategy

### Wave 1 merge (3 worktrees → main)

Each build touches non-overlapping files:
- Build A: `hash.rs`, `op_log.rs`
- Build B: `db.rs`, `snapshot.rs`, `materializer.rs`, `migrations/0003_*`
- Build C: `dag.rs`, `merge.rs`

Copy changed files from each worktree directly. No merge conflicts expected.

After merge: `cargo sqlx prepare -- --lib` (for new migration in Build B).

### Wave 2 merge (single build, direct in main worktree)

Build D modifies many files but runs alone — no parallel conflicts. Changes layer on top of Wave 1 results.

After merge: `cargo sqlx prepare -- --lib` (if query macros changed) + `cargo test -- specta_tests --ignored` (if payload types changed visible to specta).

---

## Verification

After both waves merged:

```bash
cd src-tauri
cargo nextest run          # all Rust tests
cargo fmt --check          # formatting
cargo clippy -- -D warnings # lint
```

Then from repo root:

```bash
npx vitest run             # frontend tests (if bindings changed)
prek run --all-files       # full pre-commit check
```

---

## Commit

Single commit for all 18 items:

```
fix: resolve 18 sync blockers (#1-#13, #67-#70, #130)

- #1: canonical JSON via serde_json::to_value for sorted keys
- #2: BlockId newtype in all OpPayload structs (compile-time ULID safety)
- #3: enhanced Phase 4 rework doc on find_prev_edit
- #4: MAX_CONTENT_LENGTH (256KB) validation on create/edit
- #5: expression index on json_extract(payload, '$.block_id')
- #6: compaction guard in find_lca with clear error message
- #7: DeviceId field private with constructor/accessor
- #8: debug_assert no null bytes in hash inputs
- #9: doc comment on constant_time_eq fixed-length invariant
- #10: explicit PRAGMA wal_autocheckpoint = 1000
- #11: MAX_CHAIN_WALK reduced to 1000 + HashSet cycle detection
- #12: cleanup_old_snapshots(keep=3) called after compaction
- #13: handle_foreground_task documented as Phase 1 no-op
- #67: conflict merge keeps local content (ours), not ancestor
- #68: design decision — resurrect on delete+edit conflict
- #69: design decision — LWW/reparent/position-order for move conflicts
- #70: design decision — materializer background tag dedup
- #130: reverse_edit_block prev_edit points to reversed op
```

---

## Post-commit

1. Update REVIEW-LATER.md: mark all 18 items as resolved with commit hash
2. Update SESSION-LOG.md: add Session 26 entry with build details
3. Update project-plan.md: mark sync blockers as resolved
