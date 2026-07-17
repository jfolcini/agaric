//! Spaces bootstrap core (#2621 THE INVERSION).
//!
//! The neutral, transaction-scoped inner core of the boot-time spaces
//! bootstrap + Personal→Work migration, moved down from the app crate's
//! `spaces::bootstrap` module so it depends *down* on the block-write core
//! ([`crate::block_ops::set_property_in_tx`]) and the store
//! (`agaric_store::{op_log, op, db}`) with no upward app edge.
//!
//! The app crate keeps the `CommandTx` / `Materializer` orchestrators
//! (`bootstrap_spaces` / `migrate_personal_pages_to_work`) behind unchanged
//! shims, which open the transaction, forward `&mut sqlx::Transaction` to these
//! helpers, drain the returned op records into the tx's pending queue, and
//! drive commit + post-commit materializer dispatch exactly as before.
//!
//! Every helper here takes an already-open executor (a `&mut sqlx::Transaction`,
//! a generic `Executor`, or a `&SqlitePool`) — none of them touch `CommandTx`
//! or the `Materializer`.

use std::collections::HashMap;

use sqlx::SqlitePool;

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::db::{MAX_SQL_PARAMS, now_ms};
use agaric_store::op::{CreateBlockPayload, OpPayload, SetPropertyPayload};
use agaric_store::op_log::{self, OpRecord};

use crate::block_ops::set_property_in_tx;
use crate::loro::shared::LoroState;

/// Chunk size for the batched `block_properties` UPSERT in
/// [`migrate_pages_to_personal_space_batched`].
///
/// `block_properties` is `(block_id, key, value_text, value_num, value_date,
/// value_ref)` — six bound params per row. SQLite caps bind parameters at
/// [`MAX_SQL_PARAMS`] (999) per statement, giving 166 rows per chunk. Mirrors
/// The chunked-INSERT convention from `cache/block_tag_refs.rs`.
pub const PROPERTIES_INSERT_CHUNK: usize = MAX_SQL_PARAMS / 6;

/// Reserved ULID for the seeded "Personal" space.
///
/// Crockford base32, 26 chars, uppercase only, no `I`/`L`/`O`/`U`. The
/// `seeded_ulids_parse_as_valid_ulids` test guards against typos.
pub const SPACE_PERSONAL_ULID: &str = "00000000000000000AGAR1CPER";

/// Reserved ULID for the seeded "Work" space.
pub const SPACE_WORK_ULID: &str = "00000000000000000AGAR1CWRK";

/// Default accent color token for the seeded "Personal" space.
///
/// The value is a free-form palette token (matching `index.css`'s
/// `--accent-emerald` etc.). Stored on the space block as
/// `block_properties(key='accent_color', value_text=…)`.
pub const SPACE_PERSONAL_DEFAULT_ACCENT: &str = "accent-emerald";

/// Default accent color token for the seeded "Work" space.
pub const SPACE_WORK_DEFAULT_ACCENT: &str = "accent-blue";

/// One-shot migration threshold.
///
/// ULID corresponding to the UTC timestamp `2026-04-26T22:00:00Z`
/// (`1_777_240_800_000` ms since the Unix epoch). Computed via
/// `ulid::Ulid::from_parts(1_777_240_800_000_u64, 0).to_string()` so the
/// timestamp portion (first 10 Crockford-base32 chars) is the lowest
/// possible ULID at that instant and the random portion is all-zero —
/// this gives a deterministic lower bound that is identical on every
/// build and every device.
///
/// Pages whose `id < MIGRATION_THRESHOLD_ULID` were created BEFORE this
/// migration shipped (and so belong to the maintainer's existing vault).
/// Pages whose `id >= MIGRATION_THRESHOLD_ULID` were created AFTER —
/// fresh-install pages which must NOT be touched by the migration.
///
/// The `migration_threshold_ulid_parses_as_valid_ulid` test guards
/// against typos.
pub const MIGRATION_THRESHOLD_ULID: &str = "01KQ5WWYR00000000000000000";

/// Fast-path idempotency check. Returns `true` when both seeded space
/// blocks exist AND both already carry `is_space = "true"`. Any other
/// state — missing block, missing property, partial bootstrap — returns
/// `false` so the transactional path runs and resumes.
pub async fn is_bootstrap_complete(pool: &SqlitePool) -> Result<bool, AppError> {
    let row = sqlx::query!(
        r#"SELECT COUNT(*) as "n!: i64" FROM blocks b
           WHERE b.id IN (?, ?)
             AND b.deleted_at IS NULL
             AND EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id
                   AND p.key = 'is_space'
                   AND p.value_text = 'true'
             )"#,
        SPACE_PERSONAL_ULID,
        SPACE_WORK_ULID,
    )
    .fetch_one(pool)
    .await?;
    Ok(row.n == 2)
}

/// Ensure the block row for a seeded space exists **and is live**. Appends
/// a `CreateBlock` op and upserts the row, clearing `deleted_at` so a
/// soft-deleted seed space is restored. Returns `true` when a fresh op was
/// appended, `false` when the block already existed (live) and the step was
/// skipped.
///
/// #681: the existence check filters `deleted_at IS NULL` to match
/// [`is_bootstrap_complete`]. A seeded Personal/Work space is undeletable
/// state — if it has been soft-deleted, bootstrap must restore it rather
/// than (a) treat bootstrap as incomplete forever (slow transactional path
/// every boot) while (b) never re-creating the block. Restoring also lets
/// the downstream `ensure_is_space_property` / `set_property_in_tx` steps
/// satisfy their "block exists and is not deleted" TOCTOU checks.
pub async fn ensure_space_block(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_id: &str,
    name: &str,
    records: &mut Vec<OpRecord>,
) -> Result<bool, AppError> {
    let exists = sqlx::query_scalar!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?
    .is_some();
    if exists {
        return Ok(false);
    }

    // Use the validating constructor for hand-typed ULID
    // constants. `from_trusted` is reserved for IDs that already came
    // from a prior `BlockId::new()`; the seeded space ULIDs are
    // hand-typed string literals and a banned Crockford char (`I`,
    // `L`, `O`, `U`) would only be caught by the
    // `seeded_ulids_parse_as_valid_ulids` test in `spaces/tests.rs`.
    // The `expect` here is load-bearing — it is the runtime safety net.
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_string(block_id)
            .expect("seeded space ULID constants must validate as Crockford base32"),
        block_type: "page".into(),
        parent_id: None,
        position: Some(1),
        index: None,
        content: name.into(),
    });
    let record = op_log::append_local_op_in_tx(tx, device_id, payload, now_ms()).await?;
    records.push(record);

    // Materialize the block row immediately so downstream steps in this
    // same transaction (ensure_is_space_property, set_property_in_tx for
    // migration) can satisfy their "block exists and is not deleted"
    // TOCTOU checks. Mirrors the materializer's `apply_op_tx` CreateBlock
    // arm but as an UPSERT: #681 — when the seed block already exists but
    // was soft-deleted, clear `deleted_at` to RESTORE it (a plain
    // `INSERT OR IGNORE` would silently no-op on the existing tombstoned
    // row, leaving bootstrap stuck). The conflict target is the primary
    // key, so a fresh insert and a restore both converge to a live row.
    // `page_id` is set to self to match the command path's behaviour for
    // page blocks.
    sqlx::query!(
        "INSERT INTO blocks \
             (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, NULL, 1, ?) \
         ON CONFLICT(id) DO UPDATE SET deleted_at = NULL",
        block_id,
        name,
        block_id,
    )
    .execute(&mut **tx)
    .await?;

    Ok(true)
}

/// Ensure the seeded space block carries `is_space = "true"`. Skips the
/// op append + property write when the row already exists, keeping the
/// op_log quiet on idempotent re-runs. Returns `true` when a fresh op
/// was appended.
pub async fn ensure_is_space_property(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
    block_id: &str,
    records: &mut Vec<OpRecord>,
) -> Result<bool, AppError> {
    let already_set = sqlx::query_scalar!(
        r#"SELECT 1 as "v: i32" FROM block_properties
           WHERE block_id = ? AND key = 'is_space' AND value_text = 'true'"#,
        block_id,
    )
    .fetch_optional(&mut **tx)
    .await?
    .is_some();
    if already_set {
        return Ok(false);
    }

    let (_block, record) = set_property_in_tx(
        tx,
        state,
        device_id,
        block_id.to_owned(),
        "is_space",
        Some("true".to_owned()),
        None,
        None,
        None,
        None,
    )
    .await?;
    records.push(record);
    Ok(true)
}

/// Ensure the seeded space block carries an `accent_color`
/// property pointing at the supplied default token (e.g.
/// `accent-emerald`, `accent-blue`).
///
/// Mirrors [`ensure_is_space_property`]'s idempotency contract: when
/// the block already has any `accent_color` value, this function is a
/// pure no-op and emits no op. Returns `true` when a fresh op was
/// appended, `false` when the property was already present.
///
/// User-driven recolouring via the "Manage spaces…" UI flows
/// through `set_property` and updates the same row — this seed never
/// overwrites a user choice on a re-run.
pub async fn ensure_accent_color_property(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
    block_id: &str,
    default_token: &str,
    records: &mut Vec<OpRecord>,
) -> Result<bool, AppError> {
    let already_set = sqlx::query_scalar!(
        r#"SELECT 1 as "v: i32" FROM block_properties
           WHERE block_id = ? AND key = 'accent_color'"#,
        block_id,
    )
    .fetch_optional(&mut **tx)
    .await?
    .is_some();
    if already_set {
        return Ok(false);
    }

    let (_block, record) = set_property_in_tx(
        tx,
        state,
        device_id,
        block_id.to_owned(),
        "accent_color",
        Some(default_token.to_owned()),
        None,
        None,
        None,
        None,
    )
    .await?;
    records.push(record);
    Ok(true)
}

/// Batched migrator that assigns `space = SPACE_PERSONAL_ULID` to
/// every page in `page_ids`.
///
/// This is the perf path for the / every-boot backfill: a
/// 5000-page first-boot vault used to round-trip ~20k SQL statements
/// inside one bootstrap transaction (the per-page `set_property_in_tx`
/// loop did 4 round-trips per page — definitions lookup, block existence
/// probe, op_log append, property UPSERT). The batched form collapses
/// the property-definitions read to one call and the per-row UPSERTs to
/// chunked multi-row INSERTs of [`PROPERTIES_INSERT_CHUNK`] rows each.
///
/// # Inherited invariants
///
/// ** (op log append-only).** Each page still gets its own
///   `SetProperty` op via [`op_log::append_local_op_in_tx`] because the
///   per-row hash chain (`prev_hash` advance, `parent_seqs`) is part of
///   the op_log contract. Batching the op_log writes is a separate,
/// Larger refactor and is out of scope for.
/// - ** predicate.** [`pages_without_space`] already
///   filters to live, non-conflict pages with `block_type = 'page'`, so
///   the per-page block-existence probe in `set_property_in_tx` is
///   redundant and is intentionally skipped here.
/// - **UPSERT semantics.** The chunked write uses `INSERT OR REPLACE`
///   to mirror `set_property_in_tx`'s row materialisation contract.
///   Steady-state runs see zero candidate pages (the
///   `pages_without_space` `NOT EXISTS` filter short-circuits) so this
///   is exercised only on the first migration boot.
/// - **Seeded property definitions.** Validates that the
///   `property_definitions` row for `'space'` is present (seeded by
///   migration `0035_spaces.sql`). A missing row indicates a
///   fundamentally broken DB and we surface it instead of silently
///   skipping validation.
pub async fn migrate_pages_to_personal_space_batched(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    page_ids: &[String],
    records: &mut Vec<OpRecord>,
) -> Result<(), AppError> {
    if page_ids.is_empty() {
        return Ok(());
    }

    // Step A — cache property_definitions for `space` once. The seeded
    // row from migration 0035_spaces.sql is `('space', 'ref', NULL, …)`.
    // Per-page `set_property_in_tx` reads this row inside the loop; the
    // values are constant per migration call so a single read suffices.
    // The lookup also doubles as a "is the seed migration in place"
    // sanity check — a missing row indicates a broken DB and surfaces
    // here instead of silently skipping the type validation.
    let def = sqlx::query!("SELECT value_type FROM property_definitions WHERE key = 'space'")
        .fetch_optional(&mut **tx)
        .await?;
    if def.is_none() {
        return Err(AppError::InvalidOperation(
            "property_definitions row for 'space' is missing — \
             migration 0035_spaces.sql did not land"
                .into(),
        ));
    }

    // Step B — append one `SetProperty` op per page. AGENTS.md
    // invariant #1 (op log is append-only) plus the hash-chain
    // semantics in `append_local_op_in_tx` (each op reads the previous
    // op's `seq` and computes a blake3 over `parent_seqs`) make these
    // serial calls non-batchable today. A future
    // `append_local_ops_in_tx_batch` helper would be a separate
    // op_log-API change.
    for page_id in page_ids {
        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(page_id),
            key: "space".to_owned(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: Some(BlockId::from(SPACE_PERSONAL_ULID)),
            value_bool: None,
        });
        let record = op_log::append_local_op_in_tx(tx, device_id, payload, now_ms()).await?;
        records.push(record);
    }

    // Step C — chunked `UPDATE blocks SET space_id` (Phase 2: the
    // `blocks.space_id` column is the SOLE source of truth; the
    // `block_properties(key='space')` row is no longer materialized).
    // The op-log `SetProperty(space)` appends above remain the
    // append-only record; here we only project them onto the column.
    //
    // Each page's space membership covers the page block itself
    // (`id IN (chunk)`) and every block whose `page_id` points at one of
    // these pages (`page_id IN (chunk)`), matching the
    // `id=? OR page_id=?` grouping used elsewhere for space membership.
    //
    // SQLite caps bind parameters at MAX_SQL_PARAMS (999) per statement.
    // Each chunk binds the personal-space ref once plus the chunk ids
    // twice (once per `IN` list), so the bind budget per statement is
    // `1 + 2*chunk_len`. Reusing PROPERTIES_INSERT_CHUNK (= 166) keeps us
    // well under the cap (1 + 2*166 = 333 < 999).
    for chunk in page_ids.chunks(PROPERTIES_INSERT_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "?").collect();
        let placeholders = placeholders.join(", ");
        let sql = format!(
            "UPDATE blocks SET space_id = ? \
             WHERE id IN ({placeholders}) OR page_id IN ({placeholders})"
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        q = q.bind(SPACE_PERSONAL_ULID);
        // First `IN (...)` list — the page block ids themselves.
        for page_id in chunk {
            q = q.bind(page_id);
        }
        // Second `IN (...)` list — children whose `page_id` is one of them.
        for page_id in chunk {
            q = q.bind(page_id);
        }
        q.execute(&mut **tx).await?;
    }

    Ok(())
}

/// Return every live, non-conflict page that does not yet carry a
/// `space` property AND is not itself a space block. Used to migrate
/// existing-install pages into the Personal space on the first boot
/// after this feature ships.
pub async fn pages_without_space(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        // #533 Phase 2: space membership is `blocks.space_id` (the old
        // `block_properties(key='space')` rows are gone). "Without a space"
        // is now `space_id IS NULL`. `is_space` remains a property flag
        // (it marks a block AS a space; it was not migrated to a column).
        r#"SELECT id as "id!: String" FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.space_id IS NULL
             AND NOT EXISTS (
                 SELECT 1 FROM block_properties
                 WHERE block_id = b.id
                   AND key = 'is_space'
                   AND value_text = 'true'
             )
           ORDER BY b.id"#,
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|r| r.id).collect())
}

/// Marker fast-path query: does the seeded Personal space block already
/// carry `personal_to_work_migration_v1 = "true"`?
///
/// (f) / 08-MISC-009: parameterised on `sqlx::Executor` so the
/// same body serves both the outer pool-borrowing fast-path call and the
/// inner BEGIN IMMEDIATE second-check call (`&mut *tx` reborrows the
/// transaction's underlying connection). Replaced the
/// pool-vs-tx-duplicated `migration_marker_set` /
/// `migration_marker_set_in_tx` pair.
pub async fn migration_marker_set<'e, E>(executor: E) -> Result<bool, AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let row = sqlx::query_scalar!(
        r#"SELECT 1 as "v: i32" FROM block_properties
           WHERE block_id = ?
             AND key = 'personal_to_work_migration_v1'
             AND value_text = 'true'"#,
        SPACE_PERSONAL_ULID,
    )
    .fetch_optional(executor)
    .await?;
    Ok(row.is_some())
}

/// Return every live, non-conflict, non-space page that:
/// - has `id < MIGRATION_THRESHOLD_ULID` (created before this migration
///   shipped — protects fresh installs);
/// - currently has a `space` property pointing at `SPACE_PERSONAL_ULID`.
///
/// The `is_space != "true"` exclusion keeps a hypothetical user-created
/// space block (carrying both `is_space = "true"` and `space = Personal`)
/// from being moved. The seeded space blocks themselves do not carry a
/// `space` property and so are naturally excluded by the JOIN.
pub async fn pages_to_migrate(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        // #533 Phase 2: a page's space is `blocks.space_id`, not a
        // `block_properties(key='space')` row. Select pre-threshold pages
        // currently in Personal via the column.
        r#"SELECT b.id as "id!: String" FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.space_id = ?
             AND b.id < ?
             AND NOT EXISTS (
                 SELECT 1 FROM block_properties s
                 WHERE s.block_id = b.id
                   AND s.key = 'is_space'
                   AND s.value_text = 'true'
             )
           ORDER BY b.id"#,
        SPACE_PERSONAL_ULID,
        MIGRATION_THRESHOLD_ULID,
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|r| r.id).collect())
}

/// Phase 1 — Path A tag-space bootstrap.
///
/// Every tag block without a `space` property is assigned to the space
/// that most frequently references it (via `block_tag_refs`). Tags with
/// zero references fall back to Personal. The migration emits one
/// `SetProperty` op per orphan tag via the normal op-log pipeline,
/// preserving the append-only invariant.
///
/// This runs once on every boot (like `pages_without_space` above)
/// but is naturally idempotent: the query filters to tags WITHOUT a
/// `space` property, so steady-state boots see zero candidates.
///
/// # Path A sub-phase 1 of 3
///
/// The tag-block migration (assign every tag to a space) is the first
/// of the three Path A sub-phases enumerated in the plan body. Phases
/// 2 (enforcement wiring) and 3 (cross-space severance migration) are
/// downstream of this step.
pub async fn migrate_orphan_tags_to_space(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    records: &mut Vec<OpRecord>,
) -> Result<usize, AppError> {
    // Step 1 — find every live, non-conflict tag block that has no
    // `space` property.
    let orphan_tags = sqlx::query!(
        // #533 Phase 2: an unassigned tag is `space_id IS NULL`.
        r#"SELECT b.id as "id!: String" FROM blocks b
           WHERE b.block_type = 'tag'
             AND b.deleted_at IS NULL
             AND b.space_id IS NULL
           ORDER BY b.id"#,
    )
    .fetch_all(&mut **tx)
    .await?;
    if orphan_tags.is_empty() {
        return Ok(0);
    }

    // Step 2 — compute the majority space for ALL orphan tags in a single
    // query. This replaces the original N+1 pattern (one GROUP BY per tag)
    // with a single bulk pass using json_each + ROW_NUMBER() OVER (PARTITION
    // BY tag_id ...) so only one round-trip is needed regardless of the
    // number of orphan tags.
    //
    // Tags with zero references are absent from the result; the loop below
    // falls back to Personal for those (same policy as before).
    let tag_ids_json = serde_json::to_string(
        &orphan_tags
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
    )?;
    // Runtime query (not macro) so no .sqlx cache entry is needed for the
    // dynamic json_each + window-function shape.
    let majority_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT tag_id, space_id \
         FROM ( \
             SELECT \
                 btr.tag_id, \
                 p.space_id AS space_id, \
                 COUNT(*) AS cnt, \
                 ROW_NUMBER() OVER ( \
                     PARTITION BY btr.tag_id \
                     ORDER BY COUNT(*) DESC, p.space_id ASC \
                 ) AS rn \
             FROM block_tag_refs btr \
             INNER JOIN blocks b \
                 ON b.id = btr.source_id \
                AND b.deleted_at IS NULL \
             INNER JOIN blocks p \
                 ON p.id = b.page_id \
                AND p.space_id IS NOT NULL \
             WHERE btr.tag_id IN (SELECT value FROM json_each(?1)) \
             GROUP BY btr.tag_id, p.space_id \
         ) ranked \
         WHERE rn = 1",
    )
    .bind(&tag_ids_json)
    .fetch_all(&mut **tx)
    .await?;

    // Build a tag_id → majority_space_id lookup.  Tags absent from the
    // result had zero references and will fall back to Personal below.
    let majority_space: HashMap<String, String> = majority_rows.into_iter().collect();

    let mut migrated = 0;
    for row in &orphan_tags {
        let tag_id = &row.id;

        let target_space = majority_space
            .get(tag_id.as_str())
            .map_or(SPACE_PERSONAL_ULID, String::as_str);

        // Step 3 — emit a SetProperty op assigning this tag to the
        // chosen space. The op flows through the normal pipeline so
        // replay / sync / undo see it as a regular property mutation.
        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(tag_id),
            key: "space".to_owned(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: Some(BlockId::from(target_space)),
            value_bool: None,
        });
        let record = op_log::append_local_op_in_tx(tx, device_id, payload, now_ms()).await?;
        records.push(record);

        // Materialize the space membership onto the column immediately so
        // downstream enforcement steps in the same transaction see it
        // (Phase 2: `blocks.space_id` is the SOLE source of truth; the
        // op-log append above remains the append-only record). A tag block
        // carries its own space, and any block whose `page_id` points at
        // the tag is covered by the `id = ? OR page_id = ?` grouping.
        sqlx::query!(
            "UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?",
            target_space,
            tag_id,
            tag_id,
        )
        .execute(&mut **tx)
        .await?;

        migrated += 1;
    }

    Ok(migrated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agaric_core::ulid::BlockId;
    use tempfile::TempDir;

    const DEV: &str = "test-device";

    /// Create a fresh migrated pool with the two seeded space blocks in
    /// place (flagged `is_space = "true"` so the 0089
    /// `spaces_register_is_space` trigger registers them in the `spaces`
    /// table — required by the `blocks.space_id REFERENCES spaces(id)` FK
    /// the migrators stamp).
    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let (pool, tmp) = agaric_store::test_support::test_pool().await;
        // Seed the space blocks so value_ref FK constraints on
        // block_properties are satisfied.
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        for (id, name) in [(SPACE_PERSONAL_ULID, "Personal"), (SPACE_WORK_ULID, "Work")] {
            sqlx::query!(
                "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, 'page', ?, NULL, 1, ?)",
                id,
                name,
                id,
            )
            .execute(&mut *tx)
            .await
            .unwrap();
            // #708: flag the seeded blocks as spaces, exactly as the
            // production bootstrap does. The `is_space` INSERT fires the
            // 0089 `spaces_register_is_space` trigger, registering them in
            // the `spaces` table — required by the rebuilt
            // `blocks.space_id REFERENCES spaces(id)` FK that the
            // migrators below stamp.
            sqlx::query!(
                "INSERT OR IGNORE INTO block_properties (block_id, key, value_text) \
                 VALUES (?, 'is_space', 'true')",
                id,
            )
            .execute(&mut *tx)
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();
        (pool, tmp)
    }

    #[tokio::test]
    async fn orphan_tag_assigned_to_personal_when_no_references() {
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        // Seed inside the tx so FK checks see the row.
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'lonely', NULL, 1, NULL)",
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let migrated = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space = sqlx::query_scalar!("SELECT space_id FROM blocks WHERE id = ?", tag_id,)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space, Some(SPACE_PERSONAL_ULID.to_string()));
    }

    #[tokio::test]
    async fn orphan_tag_assigned_to_referencing_space() {
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();
        let source_id = BlockId::new().to_string();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'work-tag', NULL, 1, NULL)",
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'Test', NULL, 1, ?, ?)",
            source_id,
            source_id,
            SPACE_WORK_ULID,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)",
            source_id,
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let migrated = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space = sqlx::query_scalar!("SELECT space_id FROM blocks WHERE id = ?", tag_id,)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space, Some(SPACE_WORK_ULID.to_string()));
    }

    #[tokio::test]
    async fn orphan_tag_idempotent_on_second_run() {
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'idem', NULL, 1, NULL)",
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let m1 = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(m1, 1);

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let m2 = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(m2, 0);
    }

    #[tokio::test]
    async fn orphan_tag_ignores_deleted_blocks() {
        let (pool, _tmp) = fresh_pool().await;
        let deleted_id = BlockId::new().to_string();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'del', NULL, 1, NULL)",
            deleted_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "UPDATE blocks SET deleted_at = 1577836800000 WHERE id = ?",
            deleted_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let migrated = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 0);
    }

    #[tokio::test]
    async fn orphan_tag_assigned_via_content_block_page_id() {
        // The referencing block is a `content` block (not a `page`), so
        // the space property lives on its parent page. The query must
        // resolve via `b.page_id`.
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();
        let page_id = BlockId::new().to_string();
        let content_id = BlockId::new().to_string();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'via-content', NULL, 1, NULL)",
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'Page', NULL, 1, ?, ?)",
            page_id,
            page_id,
            SPACE_WORK_ULID,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', 'content', ?, 2, ?, ?)",
            content_id,
            page_id,
            page_id,
            SPACE_WORK_ULID,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)",
            content_id,
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let migrated = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space = sqlx::query_scalar!("SELECT space_id FROM blocks WHERE id = ?", tag_id,)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space, Some(SPACE_WORK_ULID.to_string()));
    }

    #[tokio::test]
    async fn empty_table_returns_zero() {
        let (pool, _tmp) = fresh_pool().await;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let migrated = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(migrated, 0);
    }
}
