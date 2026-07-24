use agaric_core::attachment_filename::sanitize_attachment_filename;
use sqlx::{Row, SqlitePool};

use super::now_ms;
// `reserved_key_blocks_column` moved down into `agaric_store::db` (#2621, wave
// E1); reach it via the `db` module's re-export so the replay calls below stay
// unqualified.
use super::reserved_key_blocks_column;

// ======================================================================
// Recovery helpers for corrupted databases (missing blocks table)
// ======================================================================

/// If the `blocks` table is missing (e.g. from a partial migration-73
/// DROP TABLE that was not rolled back), create a temporary table and
/// replay block-level ops from `op_log` to reconstruct it.
///
/// Dependent tables (block_properties, block_tags, …) are recovered
/// *after* migrations run via [`recover_derived_state_from_op_log`]
/// because migration 73's DROP TABLE blocks would CASCADE-delete them.
///
/// #616: returns `true` iff block recovery actually fired this boot (the
/// temp table was created and ops replayed). The caller threads this
/// positive corruption signal into [`recover_derived_state_from_op_log`],
/// which no longer infers corruption from empty derived tables alone (a
/// reserved-key-only vault legitimately keeps `block_properties` and
/// `block_tags` empty forever post-0088). For crash-retry coverage the
/// same signal is also persisted as the [`DERIVED_RECOVERY_PENDING_KEY`]
/// marker row, when the `app_settings` table (migration 0053) exists.
pub(crate) async fn ensure_blocks_table_exists(
    pool: &SqlitePool,
) -> Result<bool, agaric_core::error::AppError> {
    // R4 (#347): propagate probe errors with `?` rather than masking a
    // transient failure as `0`/false. A swallowed error here would skip
    // recovery entirely and let migrations run against a missing `blocks`
    // table — far worse than surfacing the boot error.
    let exists = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'blocks'"
    )
    .fetch_one(pool)
    .await?
        > 0;

    if exists {
        return Ok(false);
    }

    // Only recover if this is a corrupted database (migrations have already
    // run at least once). Fresh databases have no _sqlx_migrations yet.
    let migrations_table_exists: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'"
    )
    .fetch_one(pool)
    .await?;

    if migrations_table_exists == 0 {
        return Ok(false);
    }

    // #618: the highest applied migration version determines the era-correct
    // temp-table schema and `deleted_at` encoding below. `IFNULL(MAX(…), 0)`
    // doubles as the fresh-DB gate: 0 rows ⇒ no migration ever ran ⇒ this is
    // a fresh database, not a corrupted one — skip recovery.
    let max_applied_migration =
        sqlx::query_scalar!(r#"SELECT IFNULL(MAX(version), 0) AS "v!: i64" FROM _sqlx_migrations"#)
            .fetch_one(pool)
            .await?;

    if max_applied_migration == 0 {
        return Ok(false);
    }

    // #618: era switches — `ensure_blocks_table_exists` fires for ANY
    // missing-blocks state (every rebuild migration DROPs `blocks`, and
    // external corruption can hit a fully-migrated DB), so the temp schema
    // must match what the migrations still pending a (re-)run expect:
    //
    // * `deleted_at` flipped TEXT rfc3339 → INTEGER epoch-ms in 0080. Only
    //   0080 julianday()-converts; the later rebuilds (0085, 0089) copy the
    //   column RAW into a `STRICT` INTEGER column, and an at-head DB keeps
    //   this temp table as the live `blocks` where every reader decodes i64.
    //   Writing rfc3339 TEXT on a ≥0080 DB therefore wedges boot permanently:
    //   this recovery tx commits before migrations run, so the next boot
    //   finds `blocks` present, skips recovery, and fails the same rebuild
    //   again (SQLITE_CONSTRAINT_DATATYPE).
    // * `space_id` (#605) exists iff 0086 is recorded. With 0086 applied no
    //   later migration re-adds the column, and the post-migration
    //   `set_property(space)` replay needs it ("no such column" otherwise);
    //   WITHOUT 0086 recorded, `ALTER TABLE blocks ADD COLUMN space_id`
    //   re-runs at boot and would abort with "duplicate column name" if the
    //   temp table already carried it (the exactly-0085-era sibling wedge).
    let deleted_at_is_ms = max_applied_migration >= 80;
    let has_space_id_column = max_applied_migration >= 86;

    tracing::warn!(
        max_applied_migration,
        "blocks table missing — likely from a partial blocks-rebuild migration run. \
         Creating temporary table and recovering from op_log."
    );

    let mut tx = pool.begin().await?;

    // Temporary blocks table: no STRICT, no FK constraints, no CHECK. The
    // pending re-run of the rebuild migration that lost the table restores
    // the proper constraints (or, at head, this table serves as-is).
    let deleted_at_type = if deleted_at_is_ms { "INTEGER" } else { "TEXT" };
    let space_id_column = if has_space_id_column {
        ",\n            space_id       TEXT"
    } else {
        ""
    };
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "CREATE TABLE blocks (
            id             TEXT NOT NULL PRIMARY KEY,
            block_type     TEXT NOT NULL DEFAULT 'content',
            content        TEXT,
            parent_id      TEXT,
            position       INTEGER,
            deleted_at     {deleted_at_type},
            todo_state     TEXT,
            priority       TEXT,
            due_date       TEXT,
            scheduled_date TEXT,
            page_id        TEXT{space_id_column}
        )"
    )))
    .execute(&mut *tx)
    .await?;

    // Replay create / edit / move / delete / restore / purge ops into blocks.
    recover_blocks_from_op_log(&mut tx, deleted_at_is_ms).await?;

    // #616: persist the "derived recovery still pending" marker in the SAME
    // tx, so a crash between this commit and the post-migration derived-state
    // replay leaves a durable retry signal (the next boot sees `blocks`
    // present and would otherwise never re-run the derived recovery).
    // `app_settings` exists iff migration 0053 has run — true for every
    // rebuild-migration corruption era this recovery targets (0073+); on an
    // ancient pre-0053 DB the marker is skipped and the same-boot in-memory
    // flag alone gates the derived replay.
    let app_settings_exists: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'"
    )
    .fetch_one(&mut *tx)
    .await?;
    if app_settings_exists > 0 {
        let now = now_ms();
        sqlx::query(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, '1', ?)",
        )
        .bind(DERIVED_RECOVERY_PENDING_KEY)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(true)
}

/// #616: `app_settings` key marking that block-table recovery fired and the
/// post-migration derived-state replay has not yet completed. Written by
/// [`ensure_blocks_table_exists`] (same tx as the temp-table rebuild),
/// cleared by [`recover_derived_state_from_op_log`] in the same tx as a
/// successful replay — so the replay retries on every boot until it lands,
/// and never runs without a positive corruption signal.
pub(crate) const DERIVED_RECOVERY_PENDING_KEY: &str = "recovery.derived_replay_pending";

/// #2920: `app_settings` key marking that the engine-first reprojection
/// ([`reproject_blocks_from_engine`]) skipped at least one space or block and is
/// therefore INCOMPLETE. Written whenever a reprojection commits with skips (or
/// every snapshot failed to decode), cleared ONLY by a fully-clean reprojection.
///
/// The boot path ([`crate::db::pool::init_pools`]) re-attempts reprojection
/// whenever this marker is present — even though the `blocks` table is present
/// again on a later boot, which makes the `blocks_recovered` gate this-boot-only
/// and would otherwise never re-fire. Without this marker a partial engine
/// recovery is silently, permanently lost (remote-authored content invisible in
/// SQL). Mirrors the [`DERIVED_RECOVERY_PENDING_KEY`] philosophy: retries on
/// every boot until the reprojection lands fully. A block that fails
/// DETERMINISTICALLY (e.g. an unrecognised `block_type` the local CHECK rejects)
/// keeps the marker armed until a re-sync or an upgrade makes it projectable —
/// one extra (idempotent) reprojection per boot, which is the correct trade for
/// never silently dropping the recovery.
pub(crate) const ENGINE_REPROJECT_PENDING_KEY: &str = "recovery.engine_reproject_pending";

/// #2920: set (`pending = true`) or clear (`pending = false`) the
/// [`ENGINE_REPROJECT_PENDING_KEY`] retry marker. Generic over the executor so
/// the caller can write it atomically inside the reprojection transaction
/// (`&mut *tx`) or standalone against the pool. `app_settings` (migration 0053)
/// always exists here — this only runs after migrations.
async fn set_engine_reproject_pending<'e, E>(
    exec: E,
    pending: bool,
) -> Result<(), agaric_core::error::AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    if pending {
        sqlx::query(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, '1', ?)",
        )
        .bind(ENGINE_REPROJECT_PENDING_KEY)
        .bind(now_ms())
        .execute(exec)
        .await?;
    } else {
        sqlx::query("DELETE FROM app_settings WHERE key = ?")
            .bind(ENGINE_REPROJECT_PENDING_KEY)
            .execute(exec)
            .await?;
    }
    Ok(())
}

/// #2920: is an engine-first reprojection retry pending from a prior boot that
/// skipped some spaces/blocks? Gates the boot re-attempt of
/// [`reproject_blocks_from_engine`] independently of the this-boot-only
/// `blocks_recovered` signal. Guards on `app_settings` existence so an
/// ancient/odd schema returns `false` rather than erroring the boot.
pub(crate) async fn engine_reproject_pending(
    pool: &SqlitePool,
) -> Result<bool, agaric_core::error::AppError> {
    let table_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
    )
    .fetch_one(pool)
    .await?;
    if table_exists == 0 {
        return Ok(false);
    }
    let pending: i64 =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_settings WHERE key = ?")
            .bind(ENGINE_REPROJECT_PENDING_KEY)
            .fetch_one(pool)
            .await?;
    Ok(pending > 0)
}

/// #429: read an `op_log` row's `created_at` as an rfc3339 string, for use as
/// `blocks.deleted_at` when recovery replays a `delete_block` on a pre-0080
/// database (post-0080 the column is INTEGER ms — see [`op_created_at_ms`],
/// #618).
///
/// `created_at` is INTEGER-ms post-migration 0079/0080 but original-format
/// **TEXT rfc3339** on the older databases that actually reach this recovery
/// path — a partial-migration-73 DB has NOT run 0079 yet, so its `created_at`
/// is still TEXT. **TEXT is therefore tried FIRST**: reading a TEXT rfc3339
/// value as `i64` would otherwise yield the wrong timestamp (a coercion
/// artefact / the value's leading integer), silently defeating the
/// cohort-timestamp preservation on the exact population this fixes.
///
/// Robust to both column eras: if `created_at` is TEXT we get the rfc3339
/// string directly (and, defensively, convert it if it is actually an
/// all-digit ms value); if it is INTEGER we fall through to the `i64` read and
/// render rfc3339. `fallback` (boot-time `now`) is used only if neither read
/// succeeds — it never should for a well-formed op row.
pub(crate) fn op_created_at_rfc3339(row: &sqlx::sqlite::SqliteRow, fallback: &str) -> String {
    if let Ok(s) = row.try_get::<String, _>("created_at") {
        // Defensive: a TEXT column holding an all-digit ms value (or an
        // integer coerced to text) — render rfc3339 rather than emit a bare
        // integer string as `deleted_at`.
        if let Ok(ms) = s.parse::<i64>()
            && let Some(dt) = chrono::DateTime::from_timestamp_millis(ms)
        {
            return dt.to_rfc3339();
        }
        if !s.is_empty() {
            return s;
        }
    }
    if let Ok(ms) = row.try_get::<i64, _>("created_at")
        && let Some(dt) = chrono::DateTime::from_timestamp_millis(ms)
    {
        return dt.to_rfc3339();
    }
    fallback.to_string()
}

/// #618: read an `op_log` row's `created_at` as epoch-ms, for use as
/// `blocks.deleted_at` when recovery replays a `delete_block` on a database
/// where migration 0080 has already run (`deleted_at` is INTEGER ms there,
/// and no later migration converts — the 0085/0089 rebuild re-runs copy the
/// column RAW into a `STRICT` INTEGER column).
///
/// On that population `created_at` is INTEGER ms (0080 applied ⇒ 0079
/// applied), but a TEXT read is still tried (first, mirroring
/// [`op_created_at_rfc3339`]) so the helper is robust to either column era.
/// sqlx's `try_get` type-checks the stored value, so each read either
/// matches its era exactly or fails cleanly — an `i64` read of a TEXT value
/// errors (`ColumnDecode` mismatch) rather than coercing through the value's
/// leading integer, and vice versa. `fallback_ms` (boot-time `now_ms()`) is
/// used only if neither read succeeds — it never should for a well-formed
/// op row.
pub(crate) fn op_created_at_ms(row: &sqlx::sqlite::SqliteRow, fallback_ms: i64) -> i64 {
    if let Ok(s) = row.try_get::<String, _>("created_at") {
        // Defensive: a TEXT column holding an all-digit ms value.
        if let Ok(ms) = s.parse::<i64>() {
            return ms;
        }
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&s) {
            return dt.timestamp_millis();
        }
    }
    if let Ok(ms) = row.try_get::<i64, _>("created_at") {
        return ms;
    }
    fallback_ms
}

/// #2504: count the per-space Loro engine snapshots persisted in
/// `loro_doc_state`. Returns `0` when the table is absent (an ancient pre-0052
/// database) or empty.
///
/// This is the signal the op-log rebuild ([`recover_blocks_from_op_log`]) uses
/// to decide whether it is about to silently drop remote-authored content. The
/// op_log is strictly device-local (remote ops never land in it post-#490-M1),
/// so a full-log replay reconstructs **only** locally-authored blocks. A
/// non-empty `loro_doc_state` means the device has synced: the engine holds the
/// complete convergent state — including every remote-authored block, property,
/// and tag — that this rebuild cannot see. The count is emitted as a loud log so
/// the disaster is not silent (issue #2504; the engine-first reprojection that
/// would actually recover that content is a separate rework — see #2503).
async fn persisted_engine_snapshot_count(
    executor: &mut sqlx::SqliteConnection,
) -> Result<i64, agaric_core::error::AppError> {
    let table_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'loro_doc_state'",
    )
    .fetch_one(&mut *executor)
    .await?;
    let table_exists = table_exists > 0;

    if !table_exists {
        return Ok(0);
    }

    // Only rows carrying an actual snapshot blob represent recoverable engine
    // state; a NULL/empty snapshot column holds no droppable content.
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM loro_doc_state \
         WHERE snapshot IS NOT NULL AND LENGTH(snapshot) > 0",
    )
    .fetch_one(&mut *executor)
    .await?;

    Ok(count)
}

/// #2504: engine-first disaster rebuild of the SQL primary state.
///
/// [`recover_blocks_from_op_log`] rebuilds `blocks` by replaying the strictly
/// device-local op_log (post-#490-M1 remote ops never land in it), so on a
/// device that has ever synced it reconstructs **only locally-authored content**
/// and silently drops every remote-authored block, property, and tag. The
/// complete convergent state lives instead in the per-space Loro engine
/// snapshots (`loro_doc_state`, persisted every 60s-if-dirty + at shutdown).
/// This function reprojects the SQL primary state — `blocks`, `block_properties`,
/// `block_tags`, and `blocks.deleted_at` — directly from those engines, so
/// remote-authored content survives the rebuild.
///
/// It reuses the SAME projection helpers the live inbound-sync path
/// (`sync_protocol::loro_sync::import_and_project`) runs — a throwaway
/// [`agaric_engine::loro::engine::LoroEngine`] per space imports the persisted snapshot,
/// its full live tree is enumerated parent-before-child, and each block is
/// projected through Pass A (core columns + properties), Pass B (tags), Pass C
/// (soft-delete) exactly as a sync pull would. The engine is the source of
/// truth, so this is the canonical Loro→SQL projection, not a recovery-only
/// reimplementation.
///
/// ## Ordering / fallback contract
///
/// Runs AFTER migrations (the projection helpers need the full post-migration
/// schema and `property_definitions`) and AFTER the op-log derived recovery
/// ([`recover_derived_state_from_op_log`]), gated by the caller on
/// `blocks_recovered`. Ordering rationale:
///
/// * The op-log derived pass runs first and restores `attachments` (which are
///   NOT modelled in the Loro engine) plus device-local properties/tags into
///   the empty derived tables.
/// * This engine pass then runs authoritatively: `project_block_full_to_sql`
///   upserts every engine block (adding remote-authored blocks the op-log pass
///   never saw), and the property/tag reprojections DELETE-then-reinsert per
///   block, so the engine's complete set (local + remote) overwrites the op-log
///   pass's local-only rows. Attachments are untouched.
///
/// Returns `Ok(true)` iff at least one engine snapshot was reprojected. Returns
/// `Ok(false)` when `loro_doc_state` is absent/empty (a device that never
/// synced — local content is already complete via the op-log pass) or when every
/// snapshot failed to decode (the op-log pass's local content stands, and
/// [`recover_blocks_from_op_log`] has already logged the remote-content-missing
/// hazard).
///
/// Local ops authored AFTER the last engine snapshot (the ≤60s snapshot lag) are
/// not in these snapshots; they are replayed on top from the op_log tail by the
/// always-on boot replay (`recovery::replay::replay_unmaterialized_ops`), so no
/// op-log tail replay is needed here.
///
/// ## Derived caches
///
/// After the primary passes commit, the visibility-critical derived caches
/// (`blocks.page_id`, the `fts_blocks` search index, and the tag-inheritance
/// cache) are rebuilt full-table so the restored remote content is actually
/// visible to page-scoped reads / search / tag filters — the live inbound-sync
/// path rebuilds these via its post-projection materializer fan-out, which is
/// unreachable at `init_pools` time (the materializer does not exist yet). See
/// the rebuild block at the end of the function body for the rationale.
pub(crate) async fn reproject_blocks_from_engine(
    pool: &SqlitePool,
) -> Result<bool, agaric_core::error::AppError> {
    use agaric_engine::loro::projection::{
        project_block_full_to_sql, reproject_block_deleted_at_from_engine,
        reproject_block_properties_from_engine, reproject_block_tags_from_engine,
    };
    // #2920: `tx.begin()` on the shared transaction opens a nested SAVEPOINT so a
    // per-block projection failure rolls back only that block, not the whole
    // recovery. Requires the `Acquire` trait in scope.
    use sqlx::Acquire;

    // `loro_doc_state` may be absent on an ancient pre-0052 database.
    let table_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'loro_doc_state'",
    )
    .fetch_one(pool)
    .await?;
    if table_exists == 0 {
        return Ok(false);
    }

    // Every space that carries a real (non-empty) engine snapshot. A NULL/empty
    // snapshot column holds no recoverable state.
    let snapshots: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT space_id, snapshot FROM loro_doc_state \
         WHERE snapshot IS NOT NULL AND LENGTH(snapshot) > 0 \
         ORDER BY space_id",
    )
    .fetch_all(pool)
    .await?;
    if snapshots.is_empty() {
        return Ok(false);
    }

    // `property_definitions` drives typed-column routing for non-reserved
    // properties. Load ONCE for the whole rebuild (hoisted out of the per-block
    // loop), mirroring the live inbound-sync path. This is the identical query
    // `import_and_project` runs, so it is already in the offline `.sqlx` cache.
    let value_types: std::collections::HashMap<String, String> =
        sqlx::query!("SELECT key, value_type FROM property_definitions")
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|r| (r.key, r.value_type))
            .collect();

    let mut tx = pool.begin().await?;
    let mut spaces_reprojected = 0usize;
    let mut blocks_reprojected = 0usize;
    // #2920: per-space AND per-block failures are NON-FATAL. Every space shares
    // this ONE transaction (committed by the boot path), so a single
    // un-readable / un-projectable block must NOT `?`-abort the whole rebuild
    // and roll back the spaces and blocks that projected cleanly. Track what was
    // skipped so the retry marker can be armed below (and so a next boot
    // re-attempts) instead of the recovery being silently, permanently lost.
    let mut skipped_spaces = 0usize;
    let mut skipped_blocks_total = 0usize;

    for (space_id_str, bytes) in &snapshots {
        // Build a throwaway engine and load this space's persisted snapshot. A
        // decode failure is non-fatal: skip this space (its local content still
        // stands from the op-log pass) and keep rebuilding the rest.
        let mut engine = agaric_engine::loro::engine::LoroEngine::new();
        if let Err(e) = engine.import(bytes) {
            tracing::error!(
                space_id = %space_id_str,
                error = %e,
                "recovery (#2504): failed to load persisted Loro snapshot — remote-authored \
                 content for this space cannot be reprojected and will be missing until re-sync"
            );
            skipped_spaces += 1;
            continue;
        }

        let space_id = agaric_store::space::SpaceId::from_trusted(space_id_str);
        // Full live tree, parent-before-child (soft-deleted nodes are included,
        // so Pass C can re-stamp their tombstones). Hard-purged blocks are gone
        // from the engine index already, so there is nothing to sweep here.
        let block_ids = engine.live_blocks_preorder();
        if block_ids.is_empty() {
            spaces_reprojected += 1;
            continue;
        }
        let n = block_ids.len();
        // Per-block skip flags for THIS space. A block flagged here is excluded
        // from every later pass, so a failure in one pass can't cascade into a
        // hard error in the next (e.g. a tag edge onto a block whose core row
        // never landed).
        let mut skipped = vec![false; n];

        // Engine core read: fast O(N) bulk path, with a per-block fallback
        // (#2920). If the bulk read fails because ONE block's engine metadata is
        // corrupt, re-read block-by-block so only the bad block(s) are skipped
        // instead of aborting the entire space.
        let id_refs: Vec<&str> = block_ids
            .iter()
            .map(agaric_core::ulid::BlockId::as_str)
            .collect();
        let core = match engine.read_blocks_bulk(&id_refs) {
            Ok(core) => core,
            Err(e) => {
                tracing::warn!(
                    space_id = %space_id_str,
                    error = %e,
                    "recovery (#2920): bulk engine core-read failed; falling back to per-block \
                     reads to isolate the corrupt block(s)"
                );
                let mut v = Vec::with_capacity(n);
                for (i, block_id) in block_ids.iter().enumerate() {
                    match engine.read_block(block_id.as_str()) {
                        Ok(snap) => v.push(snap),
                        Err(e) => {
                            tracing::error!(
                                space_id = %space_id_str,
                                block_id = %block_id.as_str(),
                                error = %e,
                                "recovery (#2920): engine core-read failed for block; skipping it \
                                 (remote content for this block missing until re-sync)"
                            );
                            skipped[i] = true;
                            v.push(None);
                        }
                    }
                }
                v
            }
        };

        // Per-block engine state reads (properties / tags / deleted_at), each
        // non-fatal (#2920). Aligned with `block_ids` by index; a skipped block
        // holds `None`.
        let mut states = Vec::with_capacity(n);
        for (i, block_id) in block_ids.iter().enumerate() {
            if skipped[i] {
                states.push(None);
                continue;
            }
            let props = match engine.read_all_properties_typed(block_id.as_str()) {
                Ok(p) => p,
                Err(e) => {
                    tracing::error!(
                        space_id = %space_id_str, block_id = %block_id.as_str(), error = %e,
                        "recovery (#2920): engine property-read failed for block; skipping it"
                    );
                    skipped[i] = true;
                    states.push(None);
                    continue;
                }
            };
            let tags = match engine.read_tags(block_id.as_str()) {
                Ok(t) => t,
                Err(e) => {
                    tracing::error!(
                        space_id = %space_id_str, block_id = %block_id.as_str(), error = %e,
                        "recovery (#2920): engine tag-read failed for block; skipping it"
                    );
                    skipped[i] = true;
                    states.push(None);
                    continue;
                }
            };
            let deleted_at = match engine.read_deleted_at(block_id.as_str()) {
                Ok(d) => d,
                Err(e) => {
                    tracing::error!(
                        space_id = %space_id_str, block_id = %block_id.as_str(), error = %e,
                        "recovery (#2920): engine deleted_at-read failed for block; skipping it"
                    );
                    skipped[i] = true;
                    states.push(None);
                    continue;
                }
            };
            states.push(Some((props, tags, deleted_at)));
        }

        // Pass A — core columns + properties. FIRST upsert EVERY (non-skipped)
        // block's core row (incl. tag blocks) so all `blocks` rows a later
        // `block_tags.tag_id` FK references exist before Pass B/C. Each block
        // runs under its OWN savepoint (#2920): a failing INSERT (e.g. an
        // unrecognised `block_type` the local schema's CHECK rejects) rolls back
        // only that block and flags it skipped, leaving the shared tx intact so
        // the remaining blocks and spaces still commit.
        for (i, (block_id, snapshot)) in block_ids.iter().zip(&core).enumerate() {
            if skipped[i] {
                continue;
            }
            let mut sp = tx.begin().await?;
            match project_block_full_to_sql(&mut sp, &space_id, block_id, snapshot.as_ref()).await {
                Ok(()) => {
                    sp.commit().await?;
                }
                Err(e) => {
                    sp.rollback().await?;
                    tracing::error!(
                        space_id = %space_id_str,
                        block_id = %block_id.as_str(),
                        error = %e,
                        "recovery (#2920): SQL core-projection failed for block; skipping it and \
                         continuing (other blocks and spaces still commit)"
                    );
                    skipped[i] = true;
                }
            }
        }

        // Pass B/C/D — properties, then tags (FK-ordered after every Pass A core
        // row exists), then soft-delete state. Grouped per block under one
        // savepoint (#2920): all Pass A rows are already present, so the
        // intra-block grouping preserves the cross-block FK ordering while still
        // isolating a per-block failure.
        for (i, block_id) in block_ids.iter().enumerate() {
            if skipped[i] {
                continue;
            }
            let Some((props, tags, deleted_at)) = states[i].as_ref() else {
                continue;
            };
            let mut sp = tx.begin().await?;
            let res = async {
                reproject_block_properties_from_engine(&mut sp, block_id, props, &value_types)
                    .await?;
                reproject_block_tags_from_engine(&mut sp, block_id, tags).await?;
                reproject_block_deleted_at_from_engine(&mut sp, block_id, deleted_at.as_deref())
                    .await?;
                Ok::<(), agaric_core::error::AppError>(())
            }
            .await;
            match res {
                Ok(()) => {
                    sp.commit().await?;
                }
                Err(e) => {
                    sp.rollback().await?;
                    tracing::error!(
                        space_id = %space_id_str,
                        block_id = %block_id.as_str(),
                        error = %e,
                        "recovery (#2920): SQL derived-projection failed for block; skipping it \
                         and continuing"
                    );
                    skipped[i] = true;
                }
            }
        }

        let space_skipped = skipped.iter().filter(|&&s| s).count();
        skipped_blocks_total += space_skipped;
        spaces_reprojected += 1;
        blocks_reprojected += n - space_skipped;
    }

    let anything_skipped = skipped_spaces > 0 || skipped_blocks_total > 0;

    if spaces_reprojected == 0 {
        // Every snapshot failed to DECODE — nothing rebuilt. Roll back the
        // (empty) tx and let the op-log pass's local content stand. Arm the
        // engine-reproject retry marker (#2920) so a subsequent boot re-attempts
        // instead of the blocks-table-present gate silently skipping recovery
        // forever (the decode may succeed on a later boot, e.g. after a re-sync).
        tx.rollback().await?;
        set_engine_reproject_pending(pool, true).await?;
        tracing::error!(
            skipped_spaces,
            "recovery (#2920): every engine snapshot failed to decode — SQL primary state NOT \
             rebuilt from the engine; retry marker armed for the next boot"
        );
        return Ok(false);
    }

    // #2920: arm-or-clear the engine-reproject retry marker ATOMICALLY with the
    // reprojected content. If any space or block was skipped the reprojection is
    // INCOMPLETE, so leave the marker SET — the boot path re-attempts whenever it
    // is present, even though `blocks` is present again on the next boot (the
    // this-boot-only `blocks_recovered` gate would otherwise never re-fire,
    // permanently and silently losing the skipped remote content). Only a
    // fully-clean reprojection clears it.
    set_engine_reproject_pending(&mut *tx, anything_skipped).await?;

    tx.commit().await?;

    // #2504: the passes above restore the PRIMARY state (blocks / properties /
    // tags / deleted_at) for the remote-authored content, but NOT the derived
    // caches the live inbound-sync path rebuilds via its post-projection fan-out
    // (`Materializer::enqueue_inbound_sync_rebuilds`). That fan-out is
    // unreachable here — this runs inside `init_pools`, BEFORE the materializer
    // exists. Without it the freshly-restored remote blocks land with NULL
    // `page_id` (invisible to every `WHERE page_id = ?` page-scoped read), no
    // `fts_blocks` row (unsearchable), and no inherited-tag rows (missing from
    // tag-filtered reads) — recovered-but-invisible until an unrelated full
    // cache rebuild happens to run.
    //
    // The boot fan-out (`spawn_boot_maintenance`) enqueues an unconditional
    // full-table `RebuildPageIds`, but only rebuilds FTS when `fts_blocks` is
    // EMPTY (a stale-but-non-empty index after a partial corruption never
    // triggers it) and never rebuilds tag-inheritance unconditionally. So we
    // cannot rely on it to cover the reprojected content. Rebuild the
    // visibility-critical derived caches synchronously and deterministically
    // here instead (the disaster path is rare, so the one-shot full rebuild
    // cost is acceptable — and correctness/visibility beats deferral).
    //
    // Order: `page_id` first — the FTS and tag-inheritance rebuilds are
    // independent of it, but `page_id` is the foundation other `page_id`-scoped
    // caches (rebuilt by the boot fan-out) consume, and rebuilding it here
    // closes the NULL-`page_id` window without waiting for the background task.
    // All three are full-table, idempotent, and pool-only (no engine / space
    // bootstrap dependency), so they are safe to run at init. Best-effort:
    // a rebuild failure must NOT wedge boot — the primary content is already
    // durably committed above, every read path degrades gracefully on a stale
    // cache, and the boot fan-out + next-op incremental updates are a backstop.
    if let Err(e) = agaric_store::cache::rebuild_page_ids(pool).await {
        tracing::warn!(error = %e, "recovery (#2504): page_id rebuild after engine reproject failed (non-fatal; boot fan-out retries)");
    }
    if let Err(e) = agaric_store::fts::rebuild_fts_index(pool).await {
        tracing::warn!(error = %e, "recovery (#2504): FTS rebuild after engine reproject failed (non-fatal; reprojected content unsearchable until next rebuild)");
    }
    if let Err(e) = agaric_store::tag_inheritance::rebuild_all(pool).await {
        tracing::warn!(error = %e, "recovery (#2504): tag-inheritance rebuild after engine reproject failed (non-fatal; inherited-tag reads stale until next rebuild)");
    }

    if anything_skipped {
        // #2920: partial recovery. Good content is durably committed above, but
        // some spaces/blocks were skipped — the retry marker is armed so the
        // next boot re-attempts. Log a greppable summary of what was lost this
        // boot at error severity so the partial recovery is observable.
        tracing::error!(
            spaces_reprojected,
            blocks_reprojected,
            skipped_spaces,
            skipped_blocks = skipped_blocks_total,
            "recovery (#2920): engine reprojection committed the good content but SKIPPED some \
             spaces/blocks — reprojection INCOMPLETE; retry marker armed so the next boot \
             re-attempts (remote content for the skipped spaces/blocks is missing until then)"
        );
    } else {
        tracing::warn!(
            spaces_reprojected,
            blocks_reprojected,
            "recovery (#2504): rebuilt SQL primary state from the Loro engine snapshots — \
             remote-authored content restored (engine-first disaster recovery)"
        );
    }
    Ok(true)
}

/// Replay block-level ops from `op_log` into an existing (temporary)
/// `blocks` table.  Called by [`ensure_blocks_table_exists`] inside a
/// transaction so the rebuild is atomic.
///
/// `deleted_at_is_ms` (#618) selects the era-correct encoding the delete arm
/// writes into `deleted_at`: INTEGER epoch-ms once `_sqlx_migrations` shows
/// 0080 applied (nothing converts after 0080 — the 0085/0089 rebuilds copy
/// RAW into a STRICT INTEGER column), rfc3339 TEXT before that (0080's
/// julianday() backfill is the designated converter).
///
/// **Device-local recovery caveat (#2504).** This rebuild replays the op_log,
/// which is strictly device-local (remote ops never land in it post-#490-M1).
/// On a device that has ever synced, it therefore reconstructs **only
/// locally-authored content** and silently omits every remote-authored block,
/// property, and tag. The complete convergent state lives in the per-space Loro
/// engine snapshots (`loro_doc_state`); when those are present this function
/// logs loudly that remote content is being dropped. The complete content is
/// restored by [`reproject_blocks_from_engine`] (the engine-first rebuild, #2504),
/// which the caller runs after migrations; this op-log replay remains the
/// device-local scaffold that gives migration 73's rebuild a target table and
/// the last-resort fallback when the engine snapshots are themselves unreadable.
async fn recover_blocks_from_op_log(
    executor: &mut sqlx::SqliteConnection,
    deleted_at_is_ms: bool,
) -> Result<(), agaric_core::error::AppError> {
    // Guard: op_log might not exist on ancient databases.
    // R4 (#347): propagate with `?` — a transient probe failure must not
    // silently skip block recovery.
    let op_log_exists = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'op_log'"
    )
    .fetch_one(&mut *executor)
    .await?
        > 0;

    if !op_log_exists {
        tracing::warn!("op_log table missing — cannot recover blocks data");
        return Ok(());
    }

    // #2504: loudly surface the device-local-only limitation of this rebuild.
    // The op_log holds ONLY locally-authored ops (#490-M1), so replaying it
    // reconstructs only local content. If the device has synced, the per-space
    // Loro engine snapshots in `loro_doc_state` hold the complete convergent
    // state — including remote-authored content this replay cannot see — and it
    // is about to be dropped. This is a disaster-path last resort; it must not
    // fail silently. (Engine-first reprojection that would recover that content
    // is a separate rework: #2503 / #2504.)
    let engine_snapshots = persisted_engine_snapshot_count(&mut *executor).await?;
    if engine_snapshots > 0 {
        tracing::error!(
            engine_snapshots,
            "DISASTER RECOVERY DATA LOSS (#2504): rebuilding `blocks` from the device-local \
             op_log only. This device has synced ({engine_snapshots} Loro engine snapshot(s) in \
             `loro_doc_state`), but the op_log holds only locally-authored ops — every \
             remote-authored block, property, and tag WILL BE MISSING from the rebuilt table. \
             The complete convergent state survives in `loro_doc_state`; recover it via an \
             engine-first reprojection or a fresh re-sync from a peer."
        );
    } else {
        tracing::warn!(
            "Recovering `blocks` from the device-local op_log (#2504). No synced Loro engine \
             state present, so local content is complete; note this replay would omit any \
             remote-authored content if the device had synced."
        );
    }

    // C8 (#345): replay in materializer LWW order. The live materializer
    // resolves cross-device same-block edits by `created_at DESC` (last
    // writer wins); replaying in `(device_id, seq)` order instead would
    // let the lexically-largest `device_id` win regardless of wall-clock
    // time, diverging the recovered `blocks` table from a normally-applied
    // log. `created_at` is an indexed INTEGER-ms column post-migration
    // 0079/0080; `(device_id, seq)` is the deterministic tiebreaker for
    // ops sharing a millisecond.
    let ops = sqlx::query(
        "SELECT op_type, payload, created_at FROM op_log ORDER BY created_at, device_id, seq",
    )
    .fetch_all(&mut *executor)
    .await?;

    if ops.is_empty() {
        return Ok(());
    }

    tracing::info!("Replaying {} ops into temporary blocks table", ops.len());

    // #429: fallbacks only — used when an op's own `created_at` cannot be
    // read/converted (it never should). The delete arm stamps the op's OWN
    // timestamp so each delete cohort keeps a distinct `(seed, deleted_at)`
    // identity that `list_trash` / `restore_block` group on; a shared
    // boot-time `now` would collapse every recovered deletion into one cohort.
    let now_rfc3339 = chrono::Utc::now().to_rfc3339();
    let now_ms_fallback = now_ms();

    for row in ops {
        let op_type: String = row.try_get("op_type")?;
        let payload_str: String = row.try_get("payload")?;

        let payload: serde_json::Value =
            serde_json::from_str(&payload_str).map_err(agaric_core::error::AppError::Json)?;

        match op_type.as_str() {
            "create_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                let block_type = payload["block_type"].as_str().unwrap_or("content");
                let content = payload
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let parent_id = payload.get("parent_id").and_then(serde_json::Value::as_str);
                // #1252: a new-scheme (#400/#603) `create_block` carries a
                // 0-based `index` and OMITS the legacy sparse `position`
                // (`CreateBlockPayload.position` is
                // `skip_serializing_if = "Option::is_none"`). Reading only
                // `position` here wrote `blocks.position = NULL` for every
                // such block, collapsing recovered siblings to ULID order.
                // Mirror the SQL-only materializer fallback
                // (`apply_create_block_sql_only`): prefer the legacy
                // `position`, else derive a 1-based provisional position from
                // `index` via `index_to_provisional_position`.
                let position = payload
                    .get("position")
                    .and_then(serde_json::Value::as_i64)
                    .or_else(|| {
                        payload
                            .get("index")
                            .and_then(serde_json::Value::as_i64)
                            .map(agaric_store::pagination::index_to_provisional_position)
                    });

                // #1536: keep `OR IGNORE` so recovery is idempotent (a re-run,
                // or a row already materialized by an earlier op in this same
                // replay, must not abort). But unlike the keyed UPDATE/DELETE
                // arms, a silently-ignored create is invisible: ULIDs make a
                // real id collision impossible, so `rows_affected == 0` means
                // the op_log carried two `create_block` ops for the same id —
                // i.e. corruption. The first create wins and is preserved
                // (success behaviour unchanged); we only surface the drop so a
                // corrupted log is observable rather than silently flattened.
                let result = sqlx::query(
                    "INSERT OR IGNORE INTO blocks \
                     (id, block_type, content, parent_id, position, deleted_at, \
                      todo_state, priority, due_date, scheduled_date, page_id) \
                     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)",
                )
                .bind(block_id)
                .bind(block_type)
                .bind(content)
                .bind(parent_id)
                .bind(position)
                .execute(&mut *executor)
                .await?;
                if result.rows_affected() == 0 {
                    tracing::warn!(
                        block_id,
                        "duplicate create_block skipped during recovery — \
                         op_log carries two create ops for the same id \
                         (first wins); possible op_log corruption"
                    );
                }
            }
            "edit_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                if let Some(to_text) = payload.get("to_text").and_then(serde_json::Value::as_str) {
                    // #2043: route the content UPDATE through the shared
                    // projection (`project_edit_block_to_sql`) so its shape
                    // (`SET content = ? WHERE id = ? AND deleted_at IS NULL`)
                    // cannot drift from the engine/sql-only arms. The added
                    // `deleted_at IS NULL` guard is inert here: recovery replays
                    // in `created_at` order, so an `edit_block` always precedes
                    // its block's later `delete_block` — the target row is never
                    // yet soft-deleted when the edit lands. The temp `blocks`
                    // table's `content` column is plain TEXT (constraint-free),
                    // so the macro-checked query runs unchanged against it. We
                    // synthesize the `BlockSnapshot` the projection expects from
                    // the op payload; only `content` + `block_id` are read (the
                    // other fields are inert placeholders), exactly as
                    // `apply_edit_block_sql_only` does.
                    let snapshot = agaric_engine::loro::engine::BlockSnapshot {
                        block_id: block_id.to_owned(),
                        block_type: String::new(),
                        content: to_text.to_owned(),
                        parent_id: None,
                        position: 0,
                    };
                    agaric_engine::loro::projection::project_edit_block_to_sql(
                        &mut *executor,
                        &snapshot,
                    )
                    .await?;
                }
            }
            "move_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                let new_parent_id = payload
                    .get("new_parent_id")
                    .and_then(serde_json::Value::as_str);
                // #1252: prefer the new-scheme 0-based `new_index` (as a
                // 1-based provisional position) when present, else the legacy
                // `new_position`. Mirrors `apply_move_block_sql_only`. The
                // `move_block` arm was less broken than `create_block`
                // (`MoveBlockPayload.new_position` is always serialized and
                // mirrors `new_index`), but routing on `new_index` keeps
                // recovery consistent with the live materializer.
                let new_position = payload
                    .get("new_index")
                    .and_then(serde_json::Value::as_i64)
                    .map(agaric_store::pagination::index_to_provisional_position)
                    .or_else(|| {
                        payload
                            .get("new_position")
                            .and_then(serde_json::Value::as_i64)
                    });

                // #2894: this arm shares the byte-identical UPDATE shape with the
                // shared projection (`project_move_block_to_sql`:
                // `UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?`),
                // but is INTENTIONALLY left inline rather than routed through it.
                // The projection binds `snapshot.position: i64` (a concrete rank —
                // the engine read-back is never NULL); this recovery replay reads
                // a raw op-log payload and binds `new_position: Option<i64>`,
                // preserving a defensive `position = NULL` write for the
                // (well-formed ops never hit it, but corruption-path) case where
                // BOTH `new_index` and `new_position` are absent from the JSON.
                // Converging would force that NULL corner onto the projection's
                // non-nullable `i64` — there is no move-side sentinel mapping to
                // fall back on (unlike the *create* path, where
                // `apply_create_block_sql_only` folds an absent position into the
                // `i64::MAX` NULL_POSITION_SENTINEL; `MoveBlockPayload.new_position`
                // is a non-optional `i64`, so `apply_move_block_sql_only` never
                // synthesizes that sentinel and `index_to_provisional_position`
                // caps strictly below it). Converging is therefore an observable
                // change in exactly the malformed-op-log corner this recovery
                // exists to survive, and inconsistent with the `create_block`
                // arm's NULL convention. The convergence is the UPDATE *shape*
                // (which already matches), not the bind: leaving it inline is
                // behaviour-preserving. The projection also has no cycle probe
                // here (unlike the engine-less `apply_move_block_sql_only`
                // fallback, which runs the shared `move_would_cycle` probe), so
                // recovery's cycle-probe-free behaviour is likewise unchanged.
                sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
                    .bind(new_parent_id)
                    .bind(new_position)
                    .bind(block_id)
                    .execute(&mut *executor)
                    .await?;
            }
            "delete_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                // #429: a `delete_block` op encodes ONLY the root, but the
                // production path (`delete_block_inner`) soft-deletes the whole
                // active subtree and stamps every member with the op's single
                // timestamp. Recovery must do the same or descendants reappear
                // live under a tombstoned ancestor, and the deletion cohort is
                // lost. Stamp the op's OWN `created_at` (not boot-time `now`)
                // so distinct delete ops keep distinct cohorts, and cascade
                // through the temp `blocks` tree (depth-bounded, same shape as
                // production / the purge cascade). The `deleted_at IS NULL`
                // guard preserves an already-deleted descendant's original
                // cohort timestamp (mirrors `descendants_cte_active!()`).
                //
                // #618: encode per era — INTEGER epoch-ms once 0080 has run
                // (any later rebuild re-run copies `deleted_at` RAW into a
                // STRICT INTEGER column, so rfc3339 TEXT wedges 0085/0089 and
                // corrupts at-head i64 reads), rfc3339 TEXT before that
                // (0080's julianday() backfill converts it).
                //
                // #2043: this arm is INTENTIONALLY left inline, not routed
                // through `project_delete_block_to_sql`. That projection is
                // i64-only (`deleted_at` INTEGER) and its recursive CTE filter
                // differs; the era-switched TEXT/INTEGER stamp above cannot be
                // expressed through it, so unifying would mis-stamp the
                // pre-0080 (TEXT) era.
                // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
                let query = sqlx::query(
                    "UPDATE blocks SET deleted_at = ?1 \
                     WHERE deleted_at IS NULL \
                       AND id IN ( \
                           WITH RECURSIVE descendants(id, depth) AS ( \
                               SELECT id, 0 FROM blocks WHERE id = ?2 \
                               UNION ALL \
                               SELECT b.id, d.depth + 1 FROM blocks b \
                               JOIN descendants d ON b.parent_id = d.id \
                               WHERE d.depth < 100 \
                           ) \
                           SELECT id FROM descendants \
                       )",
                );
                let query = if deleted_at_is_ms {
                    query.bind(op_created_at_ms(&row, now_ms_fallback))
                } else {
                    query.bind(op_created_at_rfc3339(&row, &now_rfc3339))
                };
                query.bind(block_id).execute(&mut *executor).await?;
            }
            "restore_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                // #613: a `restore_block` op encodes ONLY the root. This arm
                // un-deletes a FLAT subtree cohort keyed on the originating
                // delete op's `deleted_at_ref`, by design.
                //
                // #2043: this is INTENTIONALLY DIVERGENT from the projection
                // (`project_restore_block_to_sql` / `collect_restore_cohort`)
                // and MUST NOT be unified with it. The projection uses the
                // stricter connected-cohort walk (#1055) plus upward ancestor
                // restore (#1884/#2017); routing recovery through it would
                // CHANGE which blocks get un-deleted (the exact
                // orphan-promotion / RestoreBlock regression class #2043
                // cites). Recovery deliberately keeps the flat
                // `(seed, deleted_at_ref)` cohort + no ancestor restore.
                //
                // The previous root-only UPDATE left every descendant
                // tombstoned after a delete(root)+restore(root) replay, and
                // ignored the cohort token entirely (a root deleted
                // independently earlier would get resurrected by a later
                // unrelated restore op).
                //
                // Use the #429 delete-arm cascade shape, keyed on the cohort
                // timestamp: `deleted_at_ref` is the originating delete op's
                // `created_at` in epoch-ms — exactly what the delete arm
                // above stamped into `deleted_at` (per era, #618). Pre-0080
                // (TEXT era) the delete arm stored rfc3339, so the guard
                // compares via the same julianday()→ms conversion migration
                // 0079/0080 use; this is the deliberate TEXT-era exception
                // to the "no julianday on INTEGER columns" rule.
                //
                // A legacy payload missing `deleted_at_ref` (pre-cohort
                // producers) falls back to un-deleting the whole subtree
                // unconditionally — the legacy restore semantics.
                let deleted_at_ref = payload
                    .get("deleted_at_ref")
                    .and_then(serde_json::Value::as_i64);
                // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
                const RESTORE_CASCADE_PREFIX: &str = "UPDATE blocks SET deleted_at = NULL \
                     WHERE id IN ( \
                         WITH RECURSIVE descendants(id, depth) AS ( \
                             SELECT id, 0 FROM blocks WHERE id = ?1 \
                             UNION ALL \
                             SELECT b.id, d.depth + 1 FROM blocks b \
                             JOIN descendants d ON b.parent_id = d.id \
                             WHERE d.depth < 100 \
                         ) \
                         SELECT id FROM descendants \
                     )";
                match deleted_at_ref {
                    Some(ref_ms) if deleted_at_is_ms => {
                        sqlx::query(sqlx::AssertSqlSafe(format!(
                            "{RESTORE_CASCADE_PREFIX} AND deleted_at = ?2"
                        )))
                        .bind(block_id)
                        .bind(ref_ms)
                        .execute(&mut *executor)
                        .await?;
                    }
                    Some(ref_ms) => {
                        // TEXT era: `deleted_at` is rfc3339 (possibly the op
                        // row's original string formatting), so compare on
                        // the parsed ms value rather than string equality.
                        sqlx::query(sqlx::AssertSqlSafe(format!(
                            "{RESTORE_CASCADE_PREFIX} \
                             AND deleted_at IS NOT NULL \
                             AND CAST(ROUND((julianday(deleted_at) - 2440587.5) * 86400000.0) \
                                 AS INTEGER) = ?2"
                        )))
                        .bind(block_id)
                        .bind(ref_ms)
                        .execute(&mut *executor)
                        .await?;
                    }
                    None => {
                        sqlx::query(sqlx::AssertSqlSafe(format!(
                            "{RESTORE_CASCADE_PREFIX} AND deleted_at IS NOT NULL"
                        )))
                        .bind(block_id)
                        .execute(&mut *executor)
                        .await?;
                    }
                }
            }
            "purge_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                // #615: production purge (`apply_purge_block_*`) hard-deletes
                // the whole subtree, but the temp recovery table has no FK
                // cascade (created constraint-free above), so a root-only
                // DELETE left every purged descendant alive — and the orphan
                // cleanup after this loop then PROMOTED them to live
                // top-level blocks (`parent_id = NULL`), resurrecting
                // user-destroyed data. Cascade with the same depth-bounded
                // recursive CTE shape as the delete arm.
                // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
                sqlx::query(
                    "DELETE FROM blocks \
                     WHERE id IN ( \
                         WITH RECURSIVE descendants(id, depth) AS ( \
                             SELECT id, 0 FROM blocks WHERE id = ?1 \
                             UNION ALL \
                             SELECT b.id, d.depth + 1 FROM blocks b \
                             JOIN descendants d ON b.parent_id = d.id \
                             WHERE d.depth < 100 \
                         ) \
                         SELECT id FROM descendants \
                     )",
                )
                .bind(block_id)
                .execute(&mut *executor)
                .await?;
            }
            _ => {
                // set_property / delete_property / add_tag are handled
                // post-migration so they survive migration 73's DROP TABLE.
            }
        }
    }

    // Clean up orphaned parent_ids so migration 73's INSERT into _new_blocks
    // doesn't fail on dangling FK references (e.g. parent created on another
    // device and not present in the local op_log).
    sqlx::query(
        "UPDATE blocks SET parent_id = NULL \
         WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM blocks)",
    )
    .execute(&mut *executor)
    .await?;

    // Compute page_id: pages self-reference, content blocks inherit from
    // nearest page ancestor, tags stay NULL.
    sqlx::query("UPDATE blocks SET page_id = id WHERE block_type = 'page'")
        .execute(&mut *executor)
        .await?;

    loop {
        let rows = sqlx::query(
            "UPDATE blocks SET page_id = (
                SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END
                FROM blocks AS parent WHERE parent.id = blocks.parent_id
            )
            WHERE block_type = 'content' AND page_id IS NULL AND parent_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM blocks AS parent
                  WHERE parent.id = blocks.parent_id AND parent.page_id IS NOT NULL
              )",
        )
        .execute(&mut *executor)
        .await?
        .rows_affected();

        if rows == 0 {
            break;
        }
    }

    Ok(())
}

/// After migrations run, recover dependent tables (block_properties,
/// block_tags, attachments) from `op_log` — but only when block-table
/// recovery actually fired (#616: `blocks_recovered_this_boot`, or the
/// persisted pending marker from a prior crashed attempt) AND the derived
/// tables are empty. Reserved-key properties (todo_state, priority,
/// due_date, scheduled_date, space) are replayed directly onto their
/// denormalised `blocks` columns (#534), not into `block_properties`.
pub(crate) async fn recover_derived_state_from_op_log(
    pool: &SqlitePool,
    blocks_recovered_this_boot: bool,
) -> Result<(), agaric_core::error::AppError> {
    // Guard: skip if op_log is empty or missing.
    //
    // R4 (#347): propagate probe errors with `?` rather than masking them
    // as `0` (which would wrongly skip recovery against an already-populated
    // DB, or silently swallow a transient query failure at boot).
    let op_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await?;

    if op_count == 0 {
        return Ok(());
    }

    // #616: require a POSITIVE corruption signal before replaying anything.
    //
    // The old gate ("recover iff block_properties AND block_tags are both
    // empty", C9/#345) assumed the two tables never empty independently of
    // corruption. Post-0088 that premise is dead: reserved-key properties
    // (todo_state / priority / due_date / scheduled_date / space) live on
    // `blocks` columns and create NO `block_properties` rows, so a vault
    // using only TODO states/dates and no tags legitimately keeps both
    // counts at 0 forever — and the old gate re-ran the full O(op_count)
    // op-log replay (plus a scary warn) on EVERY boot.
    //
    // The positive signal is "block-table recovery fired": either this very
    // boot (`blocks_recovered_this_boot`, threaded from
    // `ensure_blocks_table_exists`) or a prior boot that crashed before this
    // replay completed (the durable `DERIVED_RECOVERY_PENDING_KEY` marker,
    // written in the recovery tx and cleared below in the replay tx).
    let marker_pending: i64 =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_settings WHERE key = ?")
            .bind(DERIVED_RECOVERY_PENDING_KEY)
            .fetch_one(pool)
            .await?;

    if !blocks_recovered_this_boot && marker_pending == 0 {
        return Ok(());
    }

    // Secondary duplicate-protection guard: only replay into EMPTY derived
    // tables — otherwise we would duplicate / clobber rows.
    //
    // R4 (#347): propagate probe errors with `?` rather than masking them
    // as `0` (which would wrongly trigger a full re-replay against an
    // already-populated DB).
    let prop_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_properties")
        .fetch_one(pool)
        .await?;

    let tag_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags")
        .fetch_one(pool)
        .await?;

    // C9 (#345) — the OR is intentional; a per-table gate is NOT safe here.
    // The corruption this recovery targets (a rebuild migration's
    // `DROP TABLE blocks` CASCADE) empties both tables *together*, so any
    // rows in EITHER table mean the DB is already populated and replaying
    // would duplicate. Clear the pending marker too: there is nothing left
    // for a retry to do, and a stale marker would re-trip this probe (and
    // the duplicate risk) forever.
    if prop_count > 0 || tag_count > 0 {
        if marker_pending > 0 {
            sqlx::query("DELETE FROM app_settings WHERE key = ?")
                .bind(DERIVED_RECOVERY_PENDING_KEY)
                .execute(pool)
                .await?;
        }
        return Ok(());
    }

    tracing::warn!(
        "block recovery fired and derived tables are empty (op_log has {} ops) — \
         recovering properties, tags, and attachments",
        op_count
    );

    let mut tx = pool.begin().await?;

    // C8 (#345): replay derived-state ops in materializer LWW order
    // (`created_at DESC` semantics → ascending replay with last-writer
    // overwriting earlier values), `(device_id, seq)` as the same-ms
    // tiebreaker. See the matching rationale in `recover_blocks_from_op_log`.
    //
    // #374: `created_at` is selected so the `add_attachment` arm can restore
    // `attachments.created_at` (a NOT NULL column) from the originating op's
    // timestamp — the same value the live `apply_add_attachment_tx` writes.
    //
    // #616: stream in keyset-paginated chunks instead of one unbounded
    // `fetch_all` — at the 100k-op target a whole-log buffer inside a write
    // tx is a multi-second, multi-MB boot stall. The row-value comparison
    // `(created_at, device_id, seq) > (?, ?, ?)` continues exactly where the
    // previous chunk ended under the same total order; the surrounding tx
    // gives a stable snapshot, so the iteration is consistent.
    const DERIVED_REPLAY_CHUNK: i64 = 500;
    let mut cursor: Option<(i64, String, i64)> = None;
    loop {
        let chunk = match &cursor {
            None => {
                sqlx::query(
                    "SELECT op_type, payload, created_at, device_id, seq FROM op_log \
                     ORDER BY created_at, device_id, seq LIMIT ?",
                )
                .bind(DERIVED_REPLAY_CHUNK)
                .fetch_all(&mut *tx)
                .await?
            }
            Some((ca, dev, seq)) => {
                sqlx::query(
                    "SELECT op_type, payload, created_at, device_id, seq FROM op_log \
                     WHERE (created_at, device_id, seq) > (?, ?, ?) \
                     ORDER BY created_at, device_id, seq LIMIT ?",
                )
                .bind(ca)
                .bind(dev)
                .bind(seq)
                .bind(DERIVED_REPLAY_CHUNK)
                .fetch_all(&mut *tx)
                .await?
            }
        };
        if chunk.is_empty() {
            break;
        }

        for row in chunk {
            let op_type: String = row.try_get("op_type")?;
            let payload_str: String = row.try_get("payload")?;
            cursor = Some((
                row.try_get("created_at")?,
                row.try_get("device_id")?,
                row.try_get("seq")?,
            ));
            let payload: serde_json::Value =
                serde_json::from_str(&payload_str).map_err(agaric_core::error::AppError::Json)?;

            match op_type.as_str() {
                "set_property" => {
                    let block_id = payload["block_id"].as_str().unwrap_or("");
                    let key = payload["key"].as_str().unwrap_or("");
                    let value_text = payload
                        .get("value_text")
                        .and_then(serde_json::Value::as_str);
                    let value_num = payload.get("value_num").and_then(serde_json::Value::as_f64);
                    let value_date = payload
                        .get("value_date")
                        .and_then(serde_json::Value::as_str);
                    let value_ref = payload.get("value_ref").and_then(serde_json::Value::as_str);
                    let value_bool = payload
                        .get("value_bool")
                        .and_then(serde_json::Value::as_bool)
                        .map(i64::from);

                    // A `SetProperty` with NO value set is an explicit *clear*
                    // (value = None) — the live projection represents a cleared
                    // property as row-absent, never an all-NULL row. Inserting
                    // the all-NULL row here would violate the `exactly_one_value`
                    // CHECK (migration 0062, which requires exactly one value
                    // column non-NULL) and abort startup with a (275) panic.
                    // Replay it as a DELETE so the LWW order is preserved: a
                    // clear removes any prior value for this (block_id, key).
                    let value_count = i32::from(value_text.is_some())
                        + i32::from(value_num.is_some())
                        + i32::from(value_date.is_some())
                        + i32::from(value_ref.is_some())
                        + i32::from(value_bool.is_some());
                    if value_count == 0 {
                        // #534: reserved keys are column-backed on `blocks` (the
                        // single source of truth); a clear is replayed as nulling
                        // the column, never a `block_properties` DELETE (which is
                        // now CHECK-forbidden for these keys anyway).
                        if let Some(col) = reserved_key_blocks_column(key) {
                            // `col` is a fixed internal literal from the allowlist
                            // in `reserved_key_blocks_column`, never user input.
                            // `space` fans out to the whole owning-page group, like
                            // `project_delete_property_to_sql`; the others are 1:1.
                            let q = if col == "space_id" {
                                sqlx::query(sqlx::AssertSqlSafe(format!(
                                    "UPDATE blocks SET {col} = NULL WHERE id = ? OR page_id = ?"
                                )))
                                .bind(block_id)
                                .bind(block_id)
                            } else {
                                sqlx::query(sqlx::AssertSqlSafe(format!(
                                    "UPDATE blocks SET {col} = NULL WHERE id = ?"
                                )))
                                .bind(block_id)
                            };
                            q.execute(&mut *tx).await?;
                            continue;
                        }
                        sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
                            .bind(block_id)
                            .bind(key)
                            .execute(&mut *tx)
                            .await?;
                        continue;
                    }

                    // #534: reserved keys (`todo_state` / `priority` / `due_date` /
                    // `scheduled_date` / `space`) are column-backed on `blocks` and
                    // are FORBIDDEN in `block_properties` by the migration-0088
                    // CHECK constraint. Route the set to the dedicated `blocks` column
                    // (the same reserved-key→column mapping the projection uses)
                    // instead of inserting a (now-rejected) property row.
                    //
                    // #2043: this arm is INTENTIONALLY left inline, not routed
                    // through `project_set_property_to_sql`. Recovery adds
                    // FK-existence guards the projection LACKS — it skips the op if
                    // the owning block is absent (purged / never reached this
                    // device, below) and skips a dangling `space` ref (#605/#708) —
                    // because recovery runs with `foreign_keys=ON` on every boot, so
                    // a dangling write would trip FK 787 and PERMANENTLY wedge boot.
                    // Dropping those guards to share the projection is unsafe.
                    if let Some(col) = reserved_key_blocks_column(key) {
                        // `space` is value_ref-typed; the date/text keys carry their
                        // value in value_date / value_text respectively. Pick the
                        // payload field that matches the column's storage.
                        let col_value: Option<&str> = match key {
                            "due_date" | "scheduled_date" => value_date,
                            agaric_store::op::SPACE_PROPERTY_KEY => value_ref,
                            _ => value_text,
                        };
                        if key == agaric_store::op::SPACE_PROPERTY_KEY {
                            // #605: `blocks.space_id` carries an FK and recovery
                            // runs with `foreign_keys=ON`, so an op whose target
                            // is absent (purged locally, or created on another
                            // device and never present in the local op_log) would
                            // trip FK 787 — and because recovery re-runs on every
                            // boot until it succeeds, that single dangling ref
                            // becomes a PERMANENT boot failure. Skip the op
                            // instead, exactly like the generic value_ref branch
                            // below: a dead ref means the assignment is dead.
                            // #708: the FK target is now `spaces(id)` (migration
                            // 0089), so the guard checks the registry — a target
                            // that exists as a block but was never flagged
                            // `is_space` (the #612 mis-stamp class) is skipped
                            // too. Replay order keeps legitimate targets
                            // registered before they are referenced: the
                            // `SetProperty(is_space)` op precedes any
                            // `SetProperty(space)` pointing at it, and its
                            // `block_properties` INSERT fires the 0089
                            // `spaces_register_is_space` trigger.
                            // The block keeps its prior (NULL/unchanged) space_id;
                            // a later import / rebuild reconciles once the space
                            // block exists (same degrade contract as
                            // `project_block_full_to_sql`'s subquery stamp).
                            if let Some(target) = col_value {
                                let target_exists: i64 = sqlx::query_scalar(
                                    "SELECT EXISTS(SELECT 1 FROM spaces WHERE id = ?)",
                                )
                                .bind(target)
                                .fetch_one(&mut *tx)
                                .await?;
                                if target_exists == 0 {
                                    tracing::warn!(
                                        block_id,
                                        space_id = target,
                                        "recovery: set_property(space) references a block that \
                                     is not a registered space — skipping (dangling or \
                                     mis-stamped value_ref, #605/#708)"
                                    );
                                    continue;
                                }
                            }
                            // `space` fans out to the whole owning-page group, like
                            // the live projection (`blocks.space_id`).
                            // `col` is a fixed internal literal from the allowlist
                            // in `reserved_key_blocks_column`, never user input.
                            let sql =
                                format!("UPDATE blocks SET {col} = ? WHERE id = ? OR page_id = ?");
                            sqlx::query(sqlx::AssertSqlSafe(sql))
                                .bind(col_value)
                                .bind(block_id)
                                .bind(block_id)
                                .execute(&mut *tx)
                                .await?;
                        } else {
                            // `col` is a fixed internal literal from the allowlist
                            // in `reserved_key_blocks_column`, never user input.
                            let sql = format!("UPDATE blocks SET {col} = ? WHERE id = ?");
                            sqlx::query(sqlx::AssertSqlSafe(sql))
                                .bind(col_value)
                                .bind(block_id)
                                .execute(&mut *tx)
                                .await?;
                        }
                        continue;
                    }

                    // Guard the two FK columns (block_id, value_ref → blocks(id)).
                    // An op may reference a block that was purged or created on
                    // another device and is absent from the local op_log, so
                    // inserting blindly would trip FOREIGN KEY constraint failed
                    // (787) and abort startup. Skip the row entirely if its owning
                    // block is gone, or if a non-null value_ref dangles: under the
                    // exactly-one-value invariant (migration 0062) value_ref is the
                    // row's sole value, and its FK is ON DELETE CASCADE, so a dead
                    // ref means the whole property is dead — nulling it would just
                    // trade FK 787 for a CHECK violation on the now all-NULL row.
                    sqlx::query(
                        "INSERT OR REPLACE INTO block_properties \
                     (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
                     SELECT ?, ?, ?, ?, ?, ?, ? \
                     WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?) \
                       AND (? IS NULL OR EXISTS (SELECT 1 FROM blocks WHERE id = ?))",
                    )
                    .bind(block_id)
                    .bind(key)
                    .bind(value_text)
                    .bind(value_num)
                    .bind(value_date)
                    .bind(value_ref)
                    .bind(value_bool)
                    .bind(block_id)
                    .bind(value_ref)
                    .bind(value_ref)
                    .execute(&mut *tx)
                    .await?;
                }
                "delete_property" => {
                    let block_id = payload["block_id"].as_str().unwrap_or("");
                    let key = payload["key"].as_str().unwrap_or("");

                    // #2043: route through the shared projection
                    // (`project_delete_property_to_sql`) instead of re-hand-rolling
                    // the per-key fan-out. It is genuinely equivalent: reserved
                    // keys clear the dedicated `blocks` column (single source of
                    // truth); `space` clears `space_id` for the whole owning-page
                    // group; non-reserved keys DELETE the `block_properties` row —
                    // the same `reserved_key_blocks_column` / `is_reserved_property_key`
                    // dispatch. This arm runs post-migration against the REAL
                    // schema, and a clear-to-NULL / row DELETE cannot trip FK 787,
                    // so there is no FK-guard concern (unlike `set_property` /
                    // `add_tag`, which keep their guards inline). All branches are
                    // idempotent (0-row UPDATE/DELETE no-ops).
                    agaric_engine::loro::projection::project_delete_property_to_sql(
                        &mut tx, block_id, key,
                    )
                    .await?;
                }
                "add_tag" => {
                    let block_id = payload["block_id"].as_str().unwrap_or("");
                    let tag_id = payload["tag_id"].as_str().unwrap_or("");

                    // Both columns are FKs to blocks(id): skip the tag if either
                    // the tagged block or the tag block is absent (purged, or
                    // never created in the local op_log) to avoid FK 787 panic.
                    sqlx::query(
                        "INSERT OR IGNORE INTO block_tags (block_id, tag_id) \
                     SELECT ?, ? \
                     WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?) \
                       AND EXISTS (SELECT 1 FROM blocks WHERE id = ?)",
                    )
                    .bind(block_id)
                    .bind(tag_id)
                    .bind(block_id)
                    .bind(tag_id)
                    .execute(&mut *tx)
                    .await?;
                }
                // #614: a later `remove_tag` must win over its earlier `add_tag`
                // (LWW replay order) — the exact analogue of the #374
                // `delete_attachment` arm below. Without this arm every tag the
                // user added and later removed resurrected after a recovery.
                "remove_tag" => {
                    let block_id = payload["block_id"].as_str().unwrap_or("");
                    let tag_id = payload["tag_id"].as_str().unwrap_or("");

                    // #2894: route the `block_tags` delete through the shared
                    // projection (`project_remove_tag_to_sql`) — the exact fn the
                    // engine arm (`apply_remove_tag_via_loro`) and the SQL-only
                    // fallback (`apply_remove_tag_sql_only`) both run — so the
                    // `DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?`
                    // shape lives in ONE place and cannot drift between the three
                    // paths. This is the exact analogue of the already-converged
                    // `delete_property` arm above (#2043): a keyed DELETE cannot
                    // trip FK 787 (it removes a child row), is idempotent (0-row
                    // no-op when the pair is absent), and reads only `block_id` /
                    // `tag_id` straight from the payload — so unlike the `add_tag`
                    // / `set_property` arms it needs NO recovery-only FK-existence
                    // guard, and routing it through the projection is
                    // byte-for-byte equivalent. The inherited-tag cleanup that the
                    // command/sql_only wrappers run AFTER the projection
                    // (`remove_inherited_tag`) is deliberately NOT invoked here:
                    // this replay rebuilds only `block_tags`, exactly as the old
                    // inline DELETE did (the `block_tag_inherited` view is
                    // reconstructed by its own recompute path, not this loop).
                    agaric_engine::loro::projection::project_remove_tag_to_sql(
                        &mut tx, block_id, tag_id,
                    )
                    .await?;
                }
                // #374: `attachments` is the one AUTHORITATIVE child of `blocks`
                // (its rows are the source of truth for fs_path / mime_type /
                // filename / size_bytes — NOT a derived cache). Migration 0061
                // gave `attachments.block_id` an `ON DELETE CASCADE` to
                // `blocks(id)`, so the `DROP TABLE blocks` in the 0073/0080
                // rebuilds cascade-deleted every attachment row under
                // `foreign_keys=ON`, silently destroying that metadata and
                // orphaning the on-disk files. The op-log `add_attachment`
                // payload carries every column the row needs, so replay it here
                // to restore the table (this arm runs on the same all-derived-
                // tables-empty corruption path as the property/tag arms above).
                "add_attachment" => {
                    let attachment_id = payload["attachment_id"].as_str().unwrap_or("");
                    let block_id = payload["block_id"].as_str().unwrap_or("");
                    let mime_type = payload["mime_type"].as_str().unwrap_or("");
                    // #3029 (SECURITY): the filename comes from a peer's op —
                    // sanitize before it lands in `attachments.filename` so a
                    // hostile `../../evil.sh` can never be replayed into a
                    // traversal-shaped name. Sanitize (never reject): a reject
                    // here would wedge the entire recovery replay on one op.
                    let raw_filename = payload["filename"].as_str().unwrap_or("");
                    let filename = sanitize_attachment_filename(raw_filename);
                    if filename != raw_filename {
                        tracing::warn!(
                            attachment_id,
                            original = raw_filename,
                            sanitized = %filename,
                            "sanitized traversal-unsafe peer attachment filename on recovery replay (add_attachment)"
                        );
                    }
                    let size_bytes = payload["size_bytes"].as_i64().unwrap_or(0);
                    let fs_path = payload["fs_path"].as_str().unwrap_or("");
                    let created_at: i64 = row.try_get("created_at")?;

                    // Guard the `block_id` FK (→ blocks(id)): an attachment whose
                    // owning block was purged (or never reached this device) must
                    // stay deleted — restoring it would trip FK 787 and abort
                    // startup. `INSERT OR IGNORE` makes a duplicate `add_attachment`
                    // (same id) a no-op and keeps recovery idempotent across boots.
                    sqlx::query(
                        "INSERT OR IGNORE INTO attachments \
                     (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
                     SELECT ?, ?, ?, ?, ?, ?, ? \
                     WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?)",
                    )
                    .bind(attachment_id)
                    .bind(block_id)
                    .bind(mime_type)
                    .bind(filename)
                    .bind(size_bytes)
                    .bind(fs_path)
                    .bind(created_at)
                    .bind(block_id)
                    .execute(&mut *tx)
                    .await?;
                }
                // #374: a later `delete_attachment` must win over its earlier
                // `add_attachment` (LWW replay order), so drop any row this op
                // removed — otherwise recovery would resurrect a deleted file.
                "delete_attachment" => {
                    let attachment_id = payload["attachment_id"].as_str().unwrap_or("");

                    sqlx::query("DELETE FROM attachments WHERE id = ?")
                        .bind(attachment_id)
                        .execute(&mut *tx)
                        .await?;
                }
                // #651: replay `rename_attachment` so a recovered attachment
                // keeps its post-rename filename instead of reverting to the
                // `add_attachment` original. LWW replay order means the last
                // rename wins, mirroring the live `apply_rename_attachment_tx`.
                // No-op if the row was never restored (owning block purged —
                // the add_attachment arm above skipped it).
                "rename_attachment" => {
                    let attachment_id = payload["attachment_id"].as_str().unwrap_or("");
                    let raw_new_filename = payload["new_filename"].as_str().unwrap_or("");

                    // Preserve the existing empty-skip (an empty rename is a
                    // no-op), but #3029: sanitize any non-empty peer filename
                    // before store so a hostile rename can't replay a
                    // traversal-shaped name onto the attachment.
                    if !raw_new_filename.is_empty() {
                        let new_filename = sanitize_attachment_filename(raw_new_filename);
                        if new_filename != raw_new_filename {
                            tracing::warn!(
                                attachment_id,
                                original = raw_new_filename,
                                sanitized = %new_filename,
                                "sanitized traversal-unsafe peer attachment filename on recovery replay (rename_attachment)"
                            );
                        }
                        sqlx::query("UPDATE attachments SET filename = ? WHERE id = ?")
                            .bind(new_filename)
                            .bind(attachment_id)
                            .execute(&mut *tx)
                            .await?;
                    }
                }
                _ => {}
            }
        }
    }

    // #534: the denormalised reserved-key columns (`todo_state` / `priority`
    // / `due_date` / `scheduled_date` / `space_id`) are written directly in
    // the replay loop above — they are the single source of truth and no
    // longer have backing `block_properties` rows (migration-0088 forbids
    // them), so there is nothing to backfill from `block_properties` here.

    // #616: clear the pending marker atomically with the replay — a crash
    // before this commit leaves the marker for the next boot's retry.
    sqlx::query("DELETE FROM app_settings WHERE key = ?")
        .bind(DERIVED_RECOVERY_PENDING_KEY)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// #618 / #851: the TEXT-era (pre-0080) `restore_block` cohort branch in
    /// [`recover_blocks_from_op_log`]. Before migration 0080, `deleted_at` was
    /// rfc3339 TEXT, so the cohort guard cannot string-compare against the
    /// epoch-ms `deleted_at_ref`; it converts the stored TEXT via
    /// `julianday()→ms` and compares on the parsed value. This drives that
    /// branch directly with `deleted_at_is_ms = false`: only the cohort whose
    /// `deleted_at` parses to `deleted_at_ref` is un-deleted; a sibling row
    /// tombstoned at a different time stays deleted, and a descendant of the
    /// restored root is resurrected with it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_text_era_restore_block_cohort_julianday_branch() {
        let (pool, _dir) = test_pool().await;

        // The migrated DB created an INTEGER-era `blocks` table; drop it and
        // recreate the pre-0080 TEXT-era shape (`deleted_at TEXT`) so the
        // recovery's julianday() branch is exercised, not the ms branch.
        sqlx::query("DROP TABLE IF EXISTS blocks")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE blocks (
                 id             TEXT NOT NULL PRIMARY KEY,
                 block_type     TEXT NOT NULL DEFAULT 'content',
                 content        TEXT,
                 parent_id      TEXT,
                 position       INTEGER,
                 deleted_at     TEXT,
                 todo_state     TEXT,
                 priority       TEXT,
                 due_date       TEXT,
                 scheduled_date TEXT,
                 page_id        TEXT
             )",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Cohort timestamps: the restore op targets the cohort deleted at
        // `ref_ms`; a sibling was deleted one second later (a DIFFERENT
        // cohort) and must NOT be resurrected.
        let ref_ms: i64 = 1_767_225_600_000; // 2026-01-01T00:00:00Z
        let ref_rfc3339 = "2026-01-01T00:00:00.000Z";
        let other_ms: i64 = ref_ms + 1000;
        let other_rfc3339 = "2026-01-01T00:00:01.000Z";

        // root + child belong to the restored cohort; sibling is a separate
        // cohort tombstoned at a different time.
        let seed = |id: &'static str, parent: Option<&'static str>, deleted_at: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query(
                    "INSERT INTO blocks (id, block_type, content, parent_id, deleted_at) \
                     VALUES (?, 'content', '', ?, ?)",
                )
                .bind(id)
                .bind(parent)
                .bind(deleted_at)
                .execute(&pool)
                .await
                .unwrap();
            }
        };
        seed("root", None, ref_rfc3339).await;
        seed("child", Some("root"), ref_rfc3339).await;
        seed("sibling", None, other_rfc3339).await;
        let _ = other_ms; // documents the sibling's distinct cohort ms

        // A single restore_block op for `root`, carrying the cohort token in
        // epoch-ms (the era-independent payload shape).
        let payload = serde_json::json!({
            "block_id": "root",
            "deleted_at_ref": ref_ms,
        })
        .to_string();
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('dev', 1, NULL, 'h1', 'restore_block', ?, ?)",
        )
        .bind(&payload)
        .bind(ref_ms)
        .execute(&pool)
        .await
        .unwrap();

        // Drive recovery through the TEXT-era branch.
        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ false)
            .await
            .unwrap();
        drop(conn);

        let deleted_at = |id: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, Option<String>>(
                    "SELECT deleted_at FROM blocks WHERE id = ?",
                )
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };

        assert!(
            deleted_at("root").await.is_none(),
            "TEXT-era restore must un-delete the cohort root (julianday match)"
        );
        assert!(
            deleted_at("child").await.is_none(),
            "TEXT-era restore must cascade to the root's descendant"
        );
        assert!(
            deleted_at("sibling").await.is_some(),
            "TEXT-era restore must NOT resurrect a different cohort \
             (deleted_at parses to a different ms via julianday)"
        );
    }

    /// #1252: recovery must honor the new-scheme (#400/#603) `index`/`new_index`
    /// sibling-placement fields, not just the legacy `position`/`new_position`.
    ///
    /// Production `create_block` ops have carried only a 0-based `index` (with
    /// `position` OMITTED — `CreateBlockPayload.position` is
    /// `skip_serializing_if = "Option::is_none"`) since #400. The old recovery
    /// arm read only `payload["position"]`, so every recovered block got
    /// `position = NULL` and `ORDER BY position` collapsed siblings to ULID
    /// order. This seeds three siblings created in REVERSE id order at
    /// ascending `index` slots (and one moved via `new_index`), then asserts the
    /// recovered `ORDER BY position, id` matches the index order — NOT the ulid
    /// order. Fails on the pre-fix code (all positions NULL ⇒ id order).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_honors_new_scheme_index_for_sibling_order() {
        let (pool, _dir) = test_pool().await;

        // Seed a new-scheme `create_block` op carrying ONLY `index` (no
        // `position` key — exactly how production serializes #400 creates).
        let seed_create = |id: &'static str, index: i64, seq: i64| {
            let pool = pool.clone();
            async move {
                let payload = serde_json::json!({
                    "block_id": id,
                    "block_type": "content",
                    "parent_id": "parent",
                    "index": index,
                    "content": id,
                })
                .to_string();
                // Guard: the bug is that `position` is ABSENT on new-scheme ops.
                assert!(
                    !payload.contains("\"position\""),
                    "new-scheme create payload must omit the legacy position key"
                );
                sqlx::query(
                    "INSERT INTO op_log \
                     (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                     VALUES ('dev', ?, NULL, ?, 'create_block', ?, ?)",
                )
                .bind(seq)
                .bind(format!("h{seq}"))
                .bind(&payload)
                .bind(1_767_225_600_000_i64 + seq)
                .execute(&pool)
                .await
                .unwrap();
            }
        };

        // The parent itself, then three children created at slots 0,1,2 — but
        // in REVERSE id order, so an id/ULID-collapse would invert them.
        seed_create("parent", 0, 1).await;
        seed_create("ccc", 0, 2).await;
        seed_create("bbb", 1, 3).await;
        seed_create("aaa", 2, 4).await;

        // A new-scheme `move_block` carrying ONLY `new_index` (mirrors the
        // breadcrumb `new_position`, but recovery must route on `new_index`).
        // Move "aaa" to slot 0 — it should sort first after recovery.
        let move_payload = serde_json::json!({
            "block_id": "aaa",
            "new_parent_id": "parent",
            "new_position": 1, // stale breadcrumb; new_index is authoritative
            "new_index": 0,
        })
        .to_string();
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('dev', 5, NULL, 'h5', 'move_block', ?, ?)",
        )
        .bind(&move_payload)
        .bind(1_767_225_600_005_i64)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // Recovered sibling order by the canonical key. Pre-fix: all positions
        // NULL ⇒ id order [aaa, bbb, ccc]. Post-fix: index order, with the
        // moved "aaa" at slot 0 ⇒ position 1, then ccc (idx0→pos1 on create but
        // unmoved), bbb (idx1→pos2)... assert the moved node sorts first and
        // the create-index order is preserved among the others.
        let order: Vec<String> = sqlx::query_scalar::<_, String>(
            "SELECT id FROM blocks WHERE parent_id = 'parent' \
             ORDER BY position ASC, id ASC",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        // Verify no sibling has a NULL position (the core defect).
        let null_positions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE parent_id = 'parent' AND position IS NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            null_positions, 0,
            "recovery must derive a position from `index`/`new_index`, not write NULL (#1252)"
        );

        // "aaa" was moved to new_index 0 ⇒ provisional position 1 ⇒ sorts
        // first; this must NOT be the id-order coincidence, so also assert the
        // unmoved siblings keep their create-index order relative to each other.
        assert_eq!(
            order.first().map(String::as_str),
            Some("aaa"),
            "moved-to-slot-0 block must sort first by recovered position, got {order:?}"
        );
        let ccc = order.iter().position(|id| id == "ccc").unwrap();
        let bbb = order.iter().position(|id| id == "bbb").unwrap();
        assert!(
            ccc < bbb,
            "create-index order must be preserved (ccc@idx0 before bbb@idx1), got {order:?}"
        );
    }

    /// #1536: a corrupted op_log carrying two `create_block` ops for the SAME
    /// id must not silently flatten. ULIDs make a real collision impossible, so
    /// the duplicate is corruption. Recovery stays idempotent — `OR IGNORE`
    /// tolerates the second create (no abort, first row intact) — but the
    /// `rows_affected == 0` arm logs a warn so the drop is observable. This
    /// asserts the recovery completes and the FIRST create wins (its content is
    /// preserved, the colliding second is ignored).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_duplicate_create_block_keeps_first_and_does_not_abort() {
        let (pool, _dir) = test_pool().await;

        // Two create_block ops sharing id "dup", distinct content. The second
        // is the corrupting duplicate; under OR IGNORE it is dropped.
        let seed_create = |content: &'static str, seq: i64| {
            let pool = pool.clone();
            async move {
                let payload = serde_json::json!({
                    "block_id": "dup",
                    "block_type": "content",
                    "index": 0,
                    "content": content,
                })
                .to_string();
                sqlx::query(
                    "INSERT INTO op_log \
                     (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                     VALUES ('dev', ?, NULL, ?, 'create_block', ?, ?)",
                )
                .bind(seq)
                .bind(format!("h{seq}"))
                .bind(&payload)
                .bind(1_767_225_600_000_i64 + seq)
                .execute(&pool)
                .await
                .unwrap();
            }
        };
        seed_create("first-wins", 1).await;
        seed_create("second-ignored", 2).await;

        // Recovery must NOT abort on the duplicate (idempotent OR IGNORE).
        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // Exactly one row, and the FIRST create's content is intact.
        let rows: Vec<String> =
            sqlx::query_scalar::<_, String>("SELECT content FROM blocks WHERE id = 'dup'")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            rows,
            vec!["first-wins".to_string()],
            "duplicate create_block must leave exactly the first row intact (#1536)"
        );
    }

    /// #2052(1a): the iterative `page_id` reconstruction loop in
    /// [`recover_blocks_from_op_log`] must converge for multi-level
    /// `page > content > content` nesting. A page self-references
    /// (`page_id = id`); each content block inherits its nearest page
    /// ancestor's `page_id` from its parent. Because a deep child's parent has
    /// no `page_id` yet on the first pass, the fixed-point loop has to make
    /// MULTIPLE passes (one per nesting level) before every content block
    /// resolves — a single pass would leave the grandchild NULL. This drives a
    /// page > L1 > L2 chain from an op-log and asserts BOTH content blocks land
    /// the page's id (the loop iterated to convergence, not just once).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_reconstructs_page_id_for_multi_level_nesting() {
        let (pool, _dir) = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS blocks")
            .execute(&pool)
            .await
            .unwrap();
        // Constraint-free temp recovery table (the at-head INTEGER era).
        sqlx::query(
            "CREATE TABLE blocks (
                 id TEXT NOT NULL PRIMARY KEY, block_type TEXT NOT NULL DEFAULT 'content',
                 content TEXT, parent_id TEXT, position INTEGER, deleted_at INTEGER,
                 todo_state TEXT, priority TEXT, due_date TEXT, scheduled_date TEXT, page_id TEXT
             )",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Op-log: page "pg" → content "l1" (child of pg) → content "l2" (child
        // of l1). Replay order is `created_at, device_id, seq`.
        let seed =
            |id: &'static str, block_type: &'static str, parent: Option<&'static str>, seq: i64| {
                let pool = pool.clone();
                async move {
                    let mut payload = serde_json::json!({
                        "block_id": id,
                        "block_type": block_type,
                        "index": 0,
                        "content": id,
                    });
                    if let Some(p) = parent {
                        payload["parent_id"] = serde_json::Value::String(p.to_string());
                    }
                    sqlx::query(
                        "INSERT INTO op_log \
                     (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                     VALUES ('dev', ?, NULL, ?, 'create_block', ?, ?)",
                    )
                    .bind(seq)
                    .bind(format!("h{seq}"))
                    .bind(payload.to_string())
                    .bind(1_767_225_600_000_i64 + seq)
                    .execute(&pool)
                    .await
                    .unwrap();
                }
            };
        seed("pg", "page", None, 1).await;
        seed("l1", "content", Some("pg"), 2).await;
        seed("l2", "content", Some("l1"), 3).await;

        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        let page_id = |id: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, Option<String>>("SELECT page_id FROM blocks WHERE id = ?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };

        assert_eq!(
            page_id("pg").await.as_deref(),
            Some("pg"),
            "a page self-references its own id"
        );
        assert_eq!(
            page_id("l1").await.as_deref(),
            Some("pg"),
            "the direct child content inherits the page id (first loop pass)"
        );
        assert_eq!(
            page_id("l2").await.as_deref(),
            Some("pg"),
            "the grandchild content must ALSO resolve to the page id — the \
             iterative loop has to converge over multiple passes (#2052)"
        );
    }

    /// #2052(1b): a block whose `parent_id` points at a cross-device id absent
    /// from the local op_log is an ORPHAN. [`recover_blocks_from_op_log`] NULLs
    /// such dangling parents before computing `page_id`, so migration 0073's
    /// `INSERT INTO _new_blocks` (which re-validates the `parent_id REFERENCES
    /// blocks(id)` self-FK) does not abort. This test:
    ///   1. replays a `create_block` whose parent is an absent cross-device id,
    ///   2. asserts the recovered row's `parent_id` is NULLed, then
    ///   3. runs the REAL migration 0073 SQL (extracted from the live migrator)
    ///      against the recovered table and asserts it COMMITS — i.e. the
    ///      rebuilt `blocks` accepts the recovered rows and 0073's
    ///      `page_id_self_for_pages` CHECK is satisfied.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_nulls_cross_device_orphan_parent_and_migration_0073_accepts() {
        let (pool, _dir) = test_pool().await;
        // Reproduce the recovery temp table verbatim (the live `blocks` after a
        // partial 0073 DROP): no FK, no CHECK. We rebuild it so the orphan
        // parent can be seeded without the FK rejecting it up front.
        sqlx::query("DROP TABLE IF EXISTS blocks")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE blocks (
                 id TEXT NOT NULL PRIMARY KEY, block_type TEXT NOT NULL DEFAULT 'content',
                 content TEXT, parent_id TEXT, position INTEGER, deleted_at INTEGER,
                 todo_state TEXT, priority TEXT, due_date TEXT, scheduled_date TEXT, page_id TEXT
             )",
        )
        .execute(&pool)
        .await
        .unwrap();

        // A page present locally, plus an orphan content block whose parent
        // ("remote-parent") was created on another device and is NOT in the
        // local op_log. A self-page row keeps a page present so the 0073 CHECK
        // arm (`block_type = 'page' OR page_id = id`) is exercised on real data.
        let seed_create =
            |id: &'static str, block_type: &'static str, parent: Option<&'static str>, seq: i64| {
                let pool = pool.clone();
                async move {
                    let mut payload = serde_json::json!({
                        "block_id": id, "block_type": block_type, "index": 0, "content": id,
                    });
                    if let Some(p) = parent {
                        payload["parent_id"] = serde_json::Value::String(p.to_string());
                    }
                    sqlx::query(
                        "INSERT INTO op_log \
                         (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                         VALUES ('dev', ?, NULL, ?, 'create_block', ?, ?)",
                    )
                    .bind(seq)
                    .bind(format!("h{seq}"))
                    .bind(payload.to_string())
                    .bind(1_767_225_600_000_i64 + seq)
                    .execute(&pool)
                    .await
                    .unwrap();
                }
            };
        seed_create("pg", "page", None, 1).await;
        seed_create("orphan", "content", Some("remote-parent"), 2).await;

        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // (2) the dangling cross-device parent is NULLed.
        let orphan_parent =
            sqlx::query_scalar::<_, Option<String>>("SELECT parent_id FROM blocks WHERE id = ?")
                .bind("orphan")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            orphan_parent, None,
            "a parent absent from the local op_log (cross-device id) must be NULLed (#2052)"
        );
        // The page row self-references (page_id = id), satisfying 0073's CHECK.
        let pg_page_id =
            sqlx::query_scalar::<_, Option<String>>("SELECT page_id FROM blocks WHERE id = ?")
                .bind("pg")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            pg_page_id.as_deref(),
            Some("pg"),
            "the page self-references"
        );

        // (3) run the REAL migration 0073 against the recovered table. Its
        // `INSERT INTO _new_blocks SELECT * FROM blocks` re-validates the
        // self-FK (NULLed orphan parents pass) and fires the
        // `page_id_self_for_pages` CHECK (the page row passes). A surviving
        // dangling parent or a `page_id != id` page would abort here.
        let migrator = sqlx::migrate!("./migrations");
        let sql_0073 = migrator
            .iter()
            .find(|m| m.version == 73 && m.migration_type.is_up_migration())
            .expect("migration 0073 exists")
            .sql
            .as_str()
            .to_owned();
        sqlx::query(sqlx::AssertSqlSafe(sql_0073))
            .execute(&pool)
            .await
            .expect(
                "migration 0073 must accept the recovered rows — the orphan parent was NULLed \
                 and every page self-references, so its self-FK re-validation and \
                 page_id_self_for_pages CHECK both pass (#2052)",
            );

        // Post-migration the rows survive in the rebuilt (CHECK-bearing) table.
        let orphan_after =
            sqlx::query_scalar::<_, Option<String>>("SELECT parent_id FROM blocks WHERE id = ?")
                .bind("orphan")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            orphan_after, None,
            "the orphan row survives the rebuild with a NULL parent"
        );
        let count: i64 = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 2, "both recovered rows survive the 0073 rebuild");
    }

    /// #1536 control: a single, non-colliding `create_block` recovers cleanly —
    /// the `rows_affected == 0` warn arm is NOT taken (the insert affects one
    /// row), and the block materializes as expected.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_single_create_block_no_duplicate_warn() {
        let (pool, _dir) = test_pool().await;

        let payload = serde_json::json!({
            "block_id": "solo",
            "block_type": "content",
            "index": 0,
            "content": "hello",
        })
        .to_string();
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('dev', 1, NULL, 'h1', 'create_block', ?, ?)",
        )
        .bind(&payload)
        .bind(1_767_225_600_001_i64)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        let content: String =
            sqlx::query_scalar::<_, String>("SELECT content FROM blocks WHERE id = 'solo'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(content, "hello", "single create_block must recover cleanly");
    }

    /// #2504: [`persisted_engine_snapshot_count`] counts only `loro_doc_state`
    /// rows that carry an actual snapshot blob — the recoverable engine state
    /// the op-log rebuild would drop. An absent table, an empty table, and an
    /// empty-blob row all read as "nothing to lose".
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn persisted_engine_snapshot_count_counts_only_real_snapshots_2504() {
        let (pool, _dir) = test_pool().await;

        // Empty (but migrated) table ⇒ 0.
        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(
            persisted_engine_snapshot_count(&mut conn).await.unwrap(),
            0,
            "no engine snapshots ⇒ 0"
        );
        drop(conn);

        // A real snapshot row ⇒ counted; an empty-blob row ⇒ ignored.
        sqlx::query(
            "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) \
             VALUES ('space-real', ?, 0, 1)",
        )
        .bind(vec![1_u8, 2, 3, 4])
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) \
             VALUES ('space-empty', X'', 0, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(
            persisted_engine_snapshot_count(&mut conn).await.unwrap(),
            1,
            "only the non-empty snapshot row counts as recoverable engine state"
        );
    }

    /// #2504 (pins the disaster-path gap): [`recover_blocks_from_op_log`]
    /// rebuilds from the strictly device-local op_log, so it reconstructs ONLY
    /// locally-authored content. Remote-authored content lives solely in the
    /// per-space Loro engine snapshots (`loro_doc_state`) and is NOT reprojected
    /// by this replay — it is silently dropped on recovery.
    ///
    /// This test pins the CURRENT (known-incomplete) behavior: a device holds a
    /// synced engine snapshot plus one locally-authored op; after recovery the
    /// local block survives, the engine snapshot is left untouched (never
    /// consulted), and no remote-authored block is reconstructed. When the
    /// engine-first reprojection lands (#2503 / #2504), recovery should instead
    /// reproject the engine state and the "remote content survives" assertion in
    /// the issue's acceptance criteria flips — at which point this test is
    /// updated to assert survival rather than the gap.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_blocks_from_op_log_is_device_local_only_2504() {
        let (pool, _dir) = test_pool().await;

        // A synced device: the engine holds convergent state (stands in for
        // remote-authored content) in `loro_doc_state`, but the op_log carries
        // ONLY the block this device authored locally — remote ops never land in
        // the op_log (#490-M1), so there is deliberately no op for "remote-b".
        sqlx::query(
            "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) \
             VALUES ('space-1', ?, 0, 7)",
        )
        .bind(vec![9_u8, 9, 9, 9])
        .execute(&pool)
        .await
        .unwrap();

        let payload = serde_json::json!({
            "block_id": "local-a",
            "block_type": "content",
            "index": 0,
            "content": "authored here",
        })
        .to_string();
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('this-device', 1, NULL, 'h1', 'create_block', ?, ?)",
        )
        .bind(&payload)
        .bind(1_767_225_600_000_i64)
        .execute(&pool)
        .await
        .unwrap();

        // The migrated `blocks` table is empty at boot; recovery replays into it.
        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // Locally-authored content survives.
        let local: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'local-a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(local, 1, "op-log recovery must reconstruct local content");

        // The gap: remote-authored content held only in the engine snapshot is
        // NOT reconstructed by op-log replay.
        let remote: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'remote-b'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            remote, 0,
            "#2504 gap: op-log rebuild cannot see remote-authored content in the engine"
        );

        // The convergent engine state is still present — untouched by this
        // rebuild — which is exactly what an engine-first reprojection would
        // consume to recover the dropped remote content.
        let engine_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM loro_doc_state WHERE space_id = 'space-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            engine_rows, 1,
            "engine snapshot survives, unread by the op-log rebuild (recoverable via #2503/#2504)"
        );
    }

    /// #2504 (acceptance): the engine-first rebuild restores remote-authored
    /// content that the device-local op-log replay drops.
    ///
    /// Setup mirrors the issue's acceptance criterion: device B holds synced
    /// content authored on device A (a real Loro snapshot in `loro_doc_state`),
    /// plus one locally-authored op in the (device-local) op_log. B's `blocks`
    /// table is corrupt/empty at boot.
    ///
    /// The test proves BOTH halves in one flow against a real engine snapshot:
    ///   1. `recover_blocks_from_op_log` (the pre-#2504 path) rebuilds ONLY the
    ///      local block — the remote block is absent (pre-fix failure).
    ///   2. `reproject_blocks_from_engine` (the fix) then reprojects the engine
    ///      state — the remote block, its property, and its tag are restored,
    ///      and the local block still survives.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_reprojects_remote_content_from_engine_2504() {
        // Canonical uppercase ULID-shaped ids so `BlockId::from_trusted`'s
        // `to_ascii_uppercase()` normalization round-trips them unchanged
        // (production ids are already uppercase Crockford base32).
        const REMOTE_PAGE: &str = "01HZ0000000000000000000P01";
        const REMOTE_B: &str = "01HZ0000000000000000000B01";
        const TAG_X: &str = "01HZ0000000000000000000T0X";
        const LOCAL_A: &str = "01HZ0000000000000000000L0A";

        let (pool, _dir) = test_pool().await;

        // Device A authors a "remote" page + a content child under it (+ a
        // property and a tag) into a real per-space Loro engine, and B persists
        // A's snapshot in `loro_doc_state`. The content child lives UNDER the
        // page so its `page_id` is derivable (a parentless block would resolve
        // to NULL and could not exercise the derived-cache rebuild). Remote ops
        // never reach B's op_log (#490-M1), so there is deliberately no op_log
        // row for the remote content.
        let snapshot = {
            let mut engine =
                agaric_engine::loro::engine::LoroEngine::with_peer_id("device-A").unwrap();
            engine
                .apply_create_block(REMOTE_PAGE, "page", "Remote Page", None, 0)
                .unwrap();
            engine
                .apply_create_block(REMOTE_B, "content", "authored on A", Some(REMOTE_PAGE), 0)
                .unwrap();
            engine
                .apply_set_property(REMOTE_B, "flavour", Some("vanilla"))
                .unwrap();
            // A tag edge needs the tag block to exist as a `blocks` row (FK), so
            // create it too; Pass A upserts every live block before Pass B.
            engine
                .apply_create_block(TAG_X, "tag", "important", None, 1)
                .unwrap();
            engine.apply_add_tag(REMOTE_B, TAG_X).unwrap();
            engine.export_snapshot().unwrap()
        };
        sqlx::query(
            "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) \
             VALUES ('space-1', ?, 0, 3)",
        )
        .bind(snapshot)
        .execute(&pool)
        .await
        .unwrap();

        // One locally-authored block lives in the device-local op_log.
        let payload = serde_json::json!({
            "block_id": LOCAL_A,
            "block_type": "content",
            "index": 0,
            "content": "authored here",
        })
        .to_string();
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('device-B', 1, NULL, 'h1', 'create_block', ?, ?)",
        )
        .bind(&payload)
        .bind(1_767_225_600_000_i64)
        .execute(&pool)
        .await
        .unwrap();

        // Phase 1 — the pre-#2504 op-log rebuild: local survives, remote absent.
        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        let remote_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(REMOTE_B)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            remote_before, 0,
            "pre-fix: the device-local op-log rebuild cannot see remote-authored content"
        );

        // Phase 2 — the #2504 engine-first reprojection restores remote content.
        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(
            fired,
            "engine reprojection must fire when a snapshot is present"
        );

        let remote_content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(REMOTE_B)
            .fetch_one(&pool)
            .await
            .expect("remote-authored block must be restored from the engine");
        assert_eq!(remote_content, "authored on A");

        let remote_prop: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'flavour'",
        )
        .bind(REMOTE_B)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(remote_prop, 1, "remote-authored property must be restored");

        let remote_tag: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(REMOTE_B)
                .bind(TAG_X)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(remote_tag, 1, "remote-authored tag edge must be restored");

        // The local block still survives the engine pass (engine upserts add the
        // remote content; the op-log-recovered local block is untouched).
        let local: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(LOCAL_A)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(local, 1, "locally-authored content must still survive");

        // The reprojected remote content must be VISIBLE, not just present:
        // the engine reproject rebuilds the visibility-critical derived caches
        // (page_id / FTS) inline, since the live inbound-sync materializer
        // fan-out is unreachable at init time. Without that, the restored block
        // would land with NULL page_id (invisible to page-scoped reads) and no
        // FTS row (unsearchable) — recovered-but-invisible.

        // page_id: the remote content child resolves to its remote page, so
        // every `WHERE page_id = ?` page-scoped read sees it.
        let remote_page_id: Option<String> =
            sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
                .bind(REMOTE_B)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            remote_page_id.as_deref(),
            Some(REMOTE_PAGE),
            "reprojected remote block must have its page_id backfilled (page-scoped-visible)"
        );

        // FTS: the remote block is indexed in `fts_blocks`, so it is searchable.
        let fts_indexed: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?")
                .bind(REMOTE_B)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            fts_indexed, 1,
            "reprojected remote block must be indexed in fts_blocks (searchable)"
        );
        // And it is actually returned by a trigram search on its content.
        let fts_hit: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM fts_blocks WHERE block_id = ? AND stripped MATCH 'authored'",
        )
        .bind(REMOTE_B)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            fts_hit, 1,
            "reprojected remote block must match a full-text search on its content"
        );
    }

    /// #2504: with no persisted engine snapshots (a device that never synced, or
    /// an ancient DB) the engine reprojection is a no-op returning `false`, so
    /// the caller keeps the op-log pass's local-only content — the documented
    /// fallback that is correct when local content is already complete.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reproject_blocks_from_engine_no_snapshots_is_noop_2504() {
        let (pool, _dir) = test_pool().await;
        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(
            !fired,
            "no engine snapshots ⇒ engine reprojection does nothing and the op-log path stands"
        );
    }

    // Uppercase ids so `BlockId::from_trusted`'s `to_ascii_uppercase()` round-trips
    // them unchanged (same convention as the #2504 tests above).
    async fn insert_snapshot(pool: &SqlitePool, space_id: &str, bytes: Vec<u8>) {
        sqlx::query(
            "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) \
             VALUES (?, ?, 0, 1)",
        )
        .bind(space_id)
        .bind(bytes)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn marker_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_settings WHERE key = ?")
            .bind(ENGINE_REPROJECT_PENDING_KEY)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// #2920: a single un-projectable block must NOT `?`-abort the shared boot
    /// transaction and roll back the spaces/blocks that projected cleanly.
    ///
    /// Space-1 holds a valid page + a valid content child PLUS one block whose
    /// `block_type` the local schema's `block_type_valid` CHECK rejects — a
    /// faithful "un-projectable remote block" (an unrecognised type authored by a
    /// peer). Space-2 is fully valid. After reprojection the good page/child AND
    /// the whole other space must be committed, the bad block skipped, and the
    /// retry marker armed (so a next boot re-attempts) — the pre-fix behaviour
    /// rolled the entire boot back and then silently never retried.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engine_reproject_tolerates_bad_block_commits_good_content_and_arms_retry_2920() {
        const PAGE: &str = "PAGE-2920";
        const GOOD_CHILD: &str = "GOODCHILD-2920";
        const BAD_BLOCK: &str = "BADBLOCK-2920";
        const OTHER_SPACE_BLK: &str = "OTHERBLK-2920";

        let (pool, _dir) = test_pool().await;

        let snap1 = {
            let mut engine =
                agaric_engine::loro::engine::LoroEngine::with_peer_id("device-A").unwrap();
            engine
                .apply_create_block(PAGE, "page", "Good Page", None, 0)
                .unwrap();
            engine
                .apply_create_block(GOOD_CHILD, "content", "good content", Some(PAGE), 0)
                .unwrap();
            // Unrecognised `block_type` ⇒ the STRICT `blocks.block_type_valid`
            // CHECK (migration 0085/0089) aborts THIS block's Pass A INSERT.
            engine
                .apply_create_block(BAD_BLOCK, "garbage", "unprojectable", None, 1)
                .unwrap();
            engine.export_snapshot().unwrap()
        };
        let snap2 = {
            let mut engine =
                agaric_engine::loro::engine::LoroEngine::with_peer_id("device-A").unwrap();
            engine
                .apply_create_block(OTHER_SPACE_BLK, "content", "other space content", None, 0)
                .unwrap();
            engine.export_snapshot().unwrap()
        };
        insert_snapshot(&pool, "space-1", snap1).await;
        insert_snapshot(&pool, "space-2", snap2).await;

        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(fired, "reprojection fires when valid snapshots are present");

        // Good content in space-1 committed despite the sibling bad block.
        let page: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(PAGE)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            page, 1,
            "the valid page must commit even though a sibling block failed"
        );
        let child: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(GOOD_CHILD)
            .fetch_one(&pool)
            .await
            .expect("the valid content child must be projected");
        assert_eq!(child, "good content");

        // The bad block is skipped — not committed — and did not abort the tx.
        let bad: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BAD_BLOCK)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(bad, 0, "the un-projectable block is skipped, not committed");

        // A fully-valid OTHER space still commits (one bad block in space-1 must
        // not roll back the whole shared transaction).
        let other: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(OTHER_SPACE_BLK)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(other, 1, "a fully-valid OTHER space must still commit");

        // Partial failure ⇒ retry marker armed so a subsequent boot re-attempts.
        assert_eq!(
            marker_count(&pool).await,
            1,
            "a partial reprojection must ARM the engine-reproject retry marker"
        );
        assert!(
            engine_reproject_pending(&pool).await.unwrap(),
            "the boot gate must report a pending retry after a partial reprojection"
        );
    }

    /// #2920: a fully-clean reprojection CLEARS the retry marker (so the
    /// all-clean path does not retry forever). Pre-arm the marker to simulate a
    /// prior partial boot, then reproject a fully-valid snapshot.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engine_reproject_clean_clears_retry_marker_2920() {
        const BLK: &str = "CLEANBLK-2920";
        let (pool, _dir) = test_pool().await;

        // Simulate a prior partial boot that armed the retry marker.
        set_engine_reproject_pending(&pool, true).await.unwrap();
        assert!(engine_reproject_pending(&pool).await.unwrap());

        let snap = {
            let mut engine =
                agaric_engine::loro::engine::LoroEngine::with_peer_id("device-A").unwrap();
            engine
                .apply_create_block(BLK, "content", "all good", None, 0)
                .unwrap();
            engine.export_snapshot().unwrap()
        };
        insert_snapshot(&pool, "space-1", snap).await;

        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(fired);
        let blk: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BLK)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(blk, 1, "the valid block projects");

        assert_eq!(
            marker_count(&pool).await,
            0,
            "a fully-clean reprojection must CLEAR the retry marker"
        );
        assert!(!engine_reproject_pending(&pool).await.unwrap());
    }

    /// #2920: the existing corrupt-PER-SPACE tolerance still holds AND now arms
    /// the retry marker. Space-1 is valid, space-2's snapshot bytes are
    /// undecodable — the valid space still commits and the skipped space arms the
    /// retry.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engine_reproject_tolerates_corrupt_space_and_arms_retry_2920() {
        const GOOD: &str = "GOODSPACE-2920";
        let (pool, _dir) = test_pool().await;

        let snap = {
            let mut engine =
                agaric_engine::loro::engine::LoroEngine::with_peer_id("device-A").unwrap();
            engine
                .apply_create_block(GOOD, "content", "survives", None, 0)
                .unwrap();
            engine.export_snapshot().unwrap()
        };
        insert_snapshot(&pool, "space-1", snap).await;
        // Undecodable snapshot bytes for space-2.
        insert_snapshot(&pool, "space-2", vec![0xDE, 0xAD, 0xBE, 0xEF]).await;

        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(
            fired,
            "the valid space still reprojects despite the corrupt sibling snapshot"
        );
        let good: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(GOOD)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            good, 1,
            "the valid space's content commits despite a corrupt-per-space snapshot"
        );
        assert_eq!(
            marker_count(&pool).await,
            1,
            "a skipped corrupt space must ARM the retry marker"
        );
    }

    /// #2920: when EVERY snapshot fails to decode the reprojection returns
    /// `Ok(false)` (op-log local content stands) but STILL arms the retry marker
    /// — the pre-fix silent-permanent-loss trap re-attempted nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engine_reproject_all_snapshots_corrupt_returns_false_and_arms_retry_2920() {
        let (pool, _dir) = test_pool().await;
        insert_snapshot(&pool, "space-1", vec![0x00, 0x01, 0x02]).await;

        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(
            !fired,
            "all snapshots undecodable ⇒ Ok(false); the op-log pass's local content stands"
        );
        assert_eq!(
            marker_count(&pool).await,
            1,
            "an all-decode-failure must still arm the retry marker (no silent permanent loss)"
        );
    }
}

#[cfg(test)]
#[path = "recovery_kernel_parity_tests.rs"]
mod recovery_kernel_parity_tests;
