use sqlx::{Row, SqlitePool};

use super::pool::now_ms;

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
) -> Result<bool, crate::error::AppError> {
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

/// Replay block-level ops from `op_log` into an existing (temporary)
/// `blocks` table.  Called by [`ensure_blocks_table_exists`] inside a
/// transaction so the rebuild is atomic.
///
/// `deleted_at_is_ms` (#618) selects the era-correct encoding the delete arm
/// writes into `deleted_at`: INTEGER epoch-ms once `_sqlx_migrations` shows
/// 0080 applied (nothing converts after 0080 — the 0085/0089 rebuilds copy
/// RAW into a STRICT INTEGER column), rfc3339 TEXT before that (0080's
/// julianday() backfill is the designated converter).
async fn recover_blocks_from_op_log(
    executor: &mut sqlx::SqliteConnection,
    deleted_at_is_ms: bool,
) -> Result<(), crate::error::AppError> {
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
            serde_json::from_str(&payload_str).map_err(crate::error::AppError::Json)?;

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
                            .map(crate::pagination::index_to_provisional_position)
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
                    sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
                        .bind(to_text)
                        .bind(block_id)
                        .execute(&mut *executor)
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
                    .map(crate::pagination::index_to_provisional_position)
                    .or_else(|| {
                        payload
                            .get("new_position")
                            .and_then(serde_json::Value::as_i64)
                    });

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
                // #613: a `restore_block` op encodes ONLY the root, but the
                // production path (`apply_restore_block_sql_only` /
                // `project_restore_block_to_sql`, `collect_restore_cohort`)
                // un-deletes the whole `(seed, deleted_at_ref)` cohort —
                // every descendant tombstoned by the SAME delete op. The
                // previous root-only UPDATE left every descendant tombstoned
                // after a delete(root)+restore(root) replay, and ignored the
                // cohort token entirely (a root deleted independently earlier
                // would get resurrected by a later unrelated restore op).
                //
                // Mirror the #429 delete-arm cascade, keyed on the cohort
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

/// Map a reserved property key to the `blocks` column that is its single
/// source of truth (#534 / migration 0088). Returns `None` for non-reserved
/// keys, which live in `block_properties`. The returned name is a fixed
/// internal literal — never user input — so it is safe to interpolate into
/// the recovery `UPDATE` statements.
pub(crate) fn reserved_key_blocks_column(key: &str) -> Option<&'static str> {
    // #589: membership is decided by the single source of truth
    // (`op::COLUMN_BACKED_PROPERTY_KEYS`); this function only adds the
    // per-key column-name mapping. The four `RESERVED_PROPERTY_KEYS` map to
    // same-named `blocks` columns; `space` maps to `space_id`.
    if !crate::op::is_column_backed_property_key(key) {
        return None;
    }
    match key {
        "todo_state" => Some("todo_state"),
        "priority" => Some("priority"),
        "due_date" => Some("due_date"),
        "scheduled_date" => Some("scheduled_date"),
        "space" => Some("space_id"),
        // A key added to COLUMN_BACKED_PROPERTY_KEYS without a mapping arm
        // here falls through to None. That drift is caught by
        // `reserved_key_blocks_column_covers_column_backed_set_589`; at
        // runtime the un-mapped write would route to `block_properties`,
        // where the migration-0088 CHECK rejects it loudly rather than
        // silently corrupting state.
        _ => None,
    }
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
) -> Result<(), crate::error::AppError> {
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
                serde_json::from_str(&payload_str).map_err(crate::error::AppError::Json)?;

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
                        .map(|b| if b { 1i64 } else { 0i64 });

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
                    // CHECK constraint. Route the set to the dedicated `blocks` column,
                    // mirroring `project_set_property_to_sql`, instead of inserting
                    // a (now-rejected) property row. Skip if the owning block is
                    // absent (purged / never reached this device) to avoid clobber.
                    if let Some(col) = reserved_key_blocks_column(key) {
                        // `space` is value_ref-typed; the date/text keys carry their
                        // value in value_date / value_text respectively. Pick the
                        // payload field that matches the column's storage.
                        let col_value: Option<&str> = match key {
                            "due_date" | "scheduled_date" => value_date,
                            crate::op::SPACE_PROPERTY_KEY => value_ref,
                            _ => value_text,
                        };
                        if key == crate::op::SPACE_PROPERTY_KEY {
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

                    // #534: reserved keys clear the dedicated `blocks` column
                    // (single source of truth); non-reserved keys delete the
                    // `block_properties` row. Mirrors `project_delete_property_to_sql`.
                    if let Some(col) = reserved_key_blocks_column(key) {
                        // `col` is a fixed internal literal from the allowlist in
                        // `reserved_key_blocks_column`, never user input. `space`
                        // fans out to the whole owning-page group, like
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
                    } else {
                        sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
                            .bind(block_id)
                            .bind(key)
                            .execute(&mut *tx)
                            .await?;
                    }
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

                    sqlx::query("DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?")
                        .bind(block_id)
                        .bind(tag_id)
                        .execute(&mut *tx)
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
                    let filename = payload["filename"].as_str().unwrap_or("");
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
                    let new_filename = payload["new_filename"].as_str().unwrap_or("");

                    if !new_filename.is_empty() {
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
}
