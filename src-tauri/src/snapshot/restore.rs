use sqlx::SqlitePool;

use super::codec::decode_snapshot;
use super::types::SnapshotData;
use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};

/// MAINT-152(d): single inventory of cache tables paired with their rebuild
/// task. The wipe loop iterates over `.0` to issue `DELETE FROM <table>`;
/// the rebuild loop iterates over `.1` to enqueue the materializer task
/// that repopulates the same table. Co-locating both sides means a new
/// cache table cannot be wiped without a matching rebuild (or vice-versa)
/// — adding it requires a single edit to this list.
///
/// Note: `RebuildPageIds` is intentionally NOT in this list — it has no
/// dedicated cache table (it backfills `blocks.page_id` instead) and must
/// be enqueued ahead of agenda rebuilds (M-15). It is enqueued separately
/// at the head of the rebuild fan-out below.
///
/// `block_tag_refs` is the UX-250 inline-tag-ref cache and is wiped
/// alongside the other caches (the wipe used to be inline among the core
/// tables purely as a sequencing artifact; FK ordering does not matter
/// because `PRAGMA defer_foreign_keys = ON` is set at the top of the
/// transaction).
const CACHE_TABLES: &[(&str, MaterializeTask)] = &[
    ("agenda_cache", MaterializeTask::RebuildAgendaCache),
    ("pages_cache", MaterializeTask::RebuildPagesCache),
    ("tags_cache", MaterializeTask::RebuildTagsCache),
    (
        "block_tag_inherited",
        MaterializeTask::RebuildTagInheritanceCache,
    ),
    (
        "projected_agenda_cache",
        MaterializeTask::RebuildProjectedAgendaCache,
    ),
    ("fts_blocks", MaterializeTask::RebuildFtsIndex),
    // UX-250: inline `#[ULID]` tag-ref cache. Purely derived — repopulated
    // by `RebuildBlockTagRefsCache` below.
    ("block_tag_refs", MaterializeTask::RebuildBlockTagRefsCache),
];

/// Apply a snapshot (RESET path). Wipes all core + cache tables, inserts
/// snapshot data, then enqueues the full cache-rebuild set on the
/// materializer so the UI doesn't see empty agenda / tag list / page
/// list / search until the next unrelated op (BUG-42).
///
/// Uses `BEGIN IMMEDIATE` (F04) to acquire the write lock upfront and
/// `PRAGMA defer_foreign_keys = ON` (F02) so that block inserts succeed
/// regardless of parent/child ordering in the snapshot data.
///
/// Cache rebuild tasks are enqueued via `try_enqueue_background`; failures
/// are logged at `warn!` but do not abort the restore (the snapshot itself
/// is already durable at this point). Callers that need a synchronous
/// guarantee can `flush_background()` on the materializer after this
/// returns.
pub async fn apply_snapshot(
    pool: &SqlitePool,
    materializer: &Materializer,
    compressed_data: &[u8],
) -> Result<SnapshotData, AppError> {
    let data = decode_snapshot(compressed_data)?;

    // F04: BEGIN IMMEDIATE — acquire write lock upfront (consistent with
    // every other write path in the codebase). L-7: route through
    // `begin_immediate_logged` so a stalled writer surfaces as a `warn`
    // instead of disappearing into the 5s busy_timeout — restore is a
    // long-running write that any other writer will visibly stall on.
    let mut tx = crate::db::begin_immediate_logged(pool, "snapshot_restore").await?;

    // F02: Defer FK checks until COMMIT — snapshot block order is arbitrary,
    // so a child block may be inserted before its parent. All FK references
    // will be satisfied by commit time.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;

    // MAINT-152(d): wipe every cache table from the single inventory.
    // FK ordering is moot under `defer_foreign_keys = ON`; iteration order
    // matches `CACHE_TABLES` for reviewability.
    for (table, _rebuild_task) in CACHE_TABLES {
        let sql = format!("DELETE FROM {table}");
        sqlx::query(&sql).execute(&mut *tx).await?;
    }

    // Wipe core tables (children before parents purely for reviewability —
    // `defer_foreign_keys = ON` would let any order succeed).
    sqlx::query("DELETE FROM block_links")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM block_properties")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM block_tags")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM attachments")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM page_aliases")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM property_definitions")
        .execute(&mut *tx)
        .await?;
    // H-13: the BEFORE DELETE trigger on op_log (migration 0036) blocks bare
    // DELETEs. Although `apply_snapshot` is technically the RESET path
    // rather than compaction, it is the other documented "controlled
    // wholesale op_log wipe" in the system (the AGENTS.md invariant says
    // "except compaction" but the snapshot-driven RESET is an equivalently
    // intentional mutation). Surface this finding in REVIEW-LATER if the
    // wording needs tightening; for now we extend the same bypass mechanism
    // here so sync RESET continues to function.
    crate::op_log::enable_op_log_mutation_bypass(&mut tx).await?;
    sqlx::query("DELETE FROM op_log").execute(&mut *tx).await?;
    crate::op_log::disable_op_log_mutation_bypass(&mut tx).await?;

    // M-66 — surface dropped drafts via a warn line.
    //
    // RESET is invoked by FEAT-6 snapshot-driven catch-up. Any draft a
    // peer saved AFTER the snapshot was taken (because it was mid-edit
    // when the snapshot fired or when the catch-up arrived) is silently
    // discarded by the wipe-and-restore. Pre-fix this happened with no
    // log line, no count returned, and no test asserting the drop —
    // making "where did my typing go?" a true mystery to debug.
    //
    // We sample up to 8 block_ids alongside the count so a support
    // session has at least an entry point to look at. The cap bounds
    // log size on a pathological peer with hundreds of unflushed
    // drafts; the count itself is unbounded.
    let dropped_count: i64 = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_drafts")
        .fetch_one(&mut *tx)
        .await?;
    if dropped_count > 0 {
        let sample_ids: Vec<String> =
            sqlx::query_scalar::<_, String>("SELECT block_id FROM block_drafts LIMIT 8")
                .fetch_all(&mut *tx)
                .await?;
        tracing::warn!(
            dropped_count,
            ?sample_ids,
            "apply_snapshot: dropping unflushed drafts (M-66) — RESET wipes block_drafts; \
             any draft saved after the snapshot was taken is silently lost without this warning"
        );
    }
    sqlx::query("DELETE FROM block_drafts")
        .execute(&mut *tx)
        .await?;
    // blocks last (parent of all FK references)
    sqlx::query("DELETE FROM blocks").execute(&mut *tx).await?;

    // MAINT-152(a): batch-INSERT each table via the `batch_insert_snapshot_rows!`
    // macro. The macro hides the placeholder string, the chunk-size derivation
    // (`MAX_SQL_PARAMS / num_columns`), the `format!`-driven INSERT, and the
    // bind loop — leaving the column list, row source, and per-row binding
    // closure as the only varying inputs.
    //
    // MAINT-133: `conflict_type` joined the `blocks` column list at
    // SCHEMA_VERSION = 3. Older v1/v2 snapshots decode it as `None` (via
    // `serde(default)` on the struct field), which is exactly what
    // `merge/resolve.rs` writes for non-conflict blocks anyway, so the
    // INSERT below is safe for both cases.

    macro_rules! batch_insert_snapshot_rows {
        (
            table: $table:literal,
            columns: [$($col:literal),+ $(,)?],
            rows: $rows:expr,
            bind: |$query:ident, $row:ident| $bind:block $(,)?
        ) => {{
            const COLUMNS: &[&str] = &[$($col),+];
            const COLS: usize = COLUMNS.len();
            const CHUNK: usize = MAX_SQL_PARAMS / COLS;
            // One-row placeholder string `(?, ?, ?, ...)` reused per chunk.
            let row_placeholder: String = {
                let mut s = String::with_capacity(2 + COLS * 3);
                s.push('(');
                for i in 0..COLS {
                    if i > 0 {
                        s.push_str(", ");
                    }
                    s.push('?');
                }
                s.push(')');
                s
            };
            for chunk in $rows.chunks(CHUNK) {
                let placeholders: Vec<&str> =
                    chunk.iter().map(|_| row_placeholder.as_str()).collect();
                let sql = format!(
                    "INSERT INTO {} ({}) VALUES {}",
                    $table,
                    COLUMNS.join(", "),
                    placeholders.join(", "),
                );
                let mut $query = sqlx::query(&sql);
                for $row in chunk {
                    $query = $bind;
                }
                $query.execute(&mut *tx).await?;
            }
        }};
    }

    batch_insert_snapshot_rows!(
        table: "blocks",
        columns: [
            "id", "block_type", "content", "parent_id", "position",
            "deleted_at", "is_conflict", "conflict_source", "conflict_type",
            "todo_state", "priority", "due_date", "scheduled_date",
        ],
        rows: data.tables.blocks,
        bind: |q, b| {
            q.bind(&b.id)
                .bind(&b.block_type)
                .bind(&b.content)
                .bind(&b.parent_id)
                .bind(b.position)
                .bind(&b.deleted_at)
                .bind(b.is_conflict)
                .bind(&b.conflict_source)
                .bind(&b.conflict_type)
                .bind(&b.todo_state)
                .bind(&b.priority)
                .bind(&b.due_date)
                .bind(&b.scheduled_date)
        },
    );

    batch_insert_snapshot_rows!(
        table: "block_tags",
        columns: ["block_id", "tag_id"],
        rows: data.tables.block_tags,
        bind: |q, bt| { q.bind(&bt.block_id).bind(&bt.tag_id) },
    );

    batch_insert_snapshot_rows!(
        table: "block_properties",
        columns: [
            "block_id", "key", "value_text", "value_num", "value_date", "value_ref",
        ],
        rows: data.tables.block_properties,
        bind: |q, bp| {
            q.bind(&bp.block_id)
                .bind(&bp.key)
                .bind(&bp.value_text)
                .bind(bp.value_num)
                .bind(&bp.value_date)
                .bind(&bp.value_ref)
        },
    );

    batch_insert_snapshot_rows!(
        table: "block_links",
        columns: ["source_id", "target_id"],
        rows: data.tables.block_links,
        bind: |q, bl| { q.bind(&bl.source_id).bind(&bl.target_id) },
    );

    batch_insert_snapshot_rows!(
        table: "attachments",
        columns: [
            "id", "block_id", "mime_type", "filename", "size_bytes",
            "fs_path", "created_at", "deleted_at",
        ],
        rows: data.tables.attachments,
        bind: |q, a| {
            // Gate every attachment row at the trust boundary: a malformed
            // snapshot must not be able to seed `..`/absolute paths into the
            // attachments table even though later reads/writes would catch
            // them (defense in depth — we want the invariant "no bad rows
            // in attachments" to hold).
            crate::sync_files::check_attachment_fs_path_shape(&a.fs_path)?;
            q.bind(&a.id)
                .bind(&a.block_id)
                .bind(&a.mime_type)
                .bind(&a.filename)
                .bind(a.size_bytes)
                .bind(&a.fs_path)
                .bind(&a.created_at)
                .bind(&a.deleted_at)
        },
    );

    batch_insert_snapshot_rows!(
        table: "property_definitions",
        columns: ["key", "value_type", "options", "created_at"],
        rows: data.tables.property_definitions,
        bind: |q, pd| {
            q.bind(&pd.key)
                .bind(&pd.value_type)
                .bind(&pd.options)
                .bind(&pd.created_at)
        },
    );

    batch_insert_snapshot_rows!(
        table: "page_aliases",
        columns: ["page_id", "alias"],
        rows: data.tables.page_aliases,
        bind: |q, pa| { q.bind(&pa.page_id).bind(&pa.alias) },
    );

    tx.commit().await?;

    // BUG-42: Enqueue the full cache-rebuild set. Without this, the UI
    // sees empty agenda / tag list / page list / search until the next
    // unrelated op triggers rebuilds by side-effect. `try_enqueue_background`
    // silently drops if the queue is saturated (`warn!` logged), which is
    // acceptable — the worst case is a slightly delayed rebuild on an
    // overloaded system, not data loss.
    //
    // M-15: `RebuildPageIds` MUST be enqueued first so it is processed
    // before `RebuildAgendaCache` / `RebuildProjectedAgendaCache`. Both
    // agenda rebuilds consult `b.page_id` to apply the FEAT-5a
    // template-page exclusion (`NOT EXISTS (... tp.block_id = b.page_id
    // AND tp.key = 'template')`). The background consumer processes
    // tasks sequentially in enqueue order, so enqueuing it ahead of
    // `CACHE_TABLES` guarantees the agenda sees populated `page_id`s on
    // first rebuild — otherwise template-tagged pages' blocks would
    // leak into the agenda until something else triggered another
    // rebuild. (`RebuildPageIds` has no dedicated cache table, so it
    // does not appear in `CACHE_TABLES`.)
    if let Err(e) = materializer.try_enqueue_background(MaterializeTask::RebuildPageIds) {
        tracing::warn!(
            task = "RebuildPageIds",
            error = %e,
            "failed to enqueue cache rebuild task after apply_snapshot"
        );
    }
    for (table, task) in CACHE_TABLES {
        if let Err(e) = materializer.try_enqueue_background(task.clone()) {
            tracing::warn!(
                cache_table = table,
                error = %e,
                "failed to enqueue cache rebuild task after apply_snapshot"
            );
        }
    }

    Ok(data)
}
