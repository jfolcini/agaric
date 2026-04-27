use sqlx::SqlitePool;

use super::codec::decode_snapshot;
use super::types::SnapshotData;
use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};

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
    // every other write path in the codebase).
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // F02: Defer FK checks until COMMIT — snapshot block order is arbitrary,
    // so a child block may be inserted before its parent. All FK references
    // will be satisfied by commit time.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;

    // Wipe all tables (order matters for FK constraints — children first)
    // Cache tables
    sqlx::query("DELETE FROM agenda_cache")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM pages_cache")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM tags_cache")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM block_tag_inherited")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM projected_agenda_cache")
        .execute(&mut *tx)
        .await?;
    // FTS5
    sqlx::query("DELETE FROM fts_blocks")
        .execute(&mut *tx)
        .await?;
    // Core tables (children before parents due to FK)
    sqlx::query("DELETE FROM block_links")
        .execute(&mut *tx)
        .await?;
    // UX-250: inline `#[ULID]` tag-ref cache. Purely derived — repopulated
    // by `RebuildBlockTagRefsCache` in the rebuild task set below.
    sqlx::query("DELETE FROM block_tag_refs")
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

    // Insert snapshot data using multi-row INSERT batches.
    // Each table uses a chunk size derived from MAX_SQL_PARAMS / num_columns
    // to stay within SQLite's bind-parameter limit.

    // -- blocks (13 columns) --
    // MAINT-133: `conflict_type` joined the column list at SCHEMA_VERSION = 3.
    // Older v1/v2 snapshots decode it as `None` (via `serde(default)` on the
    // struct field), which is exactly what `merge/resolve.rs` writes for
    // non-conflict blocks anyway, so the INSERT below is safe for both cases.
    const BLOCKS_COLS: usize = 13;
    const BLOCKS_CHUNK: usize = MAX_SQL_PARAMS / BLOCKS_COLS; // 76
    for chunk in data.tables.blocks.chunks(BLOCKS_CHUNK) {
        let placeholders: Vec<&str> = chunk
            .iter()
            .map(|_| "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .collect();
        let sql = format!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, \
             deleted_at, is_conflict, conflict_source, conflict_type, \
             todo_state, priority, due_date, scheduled_date) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for b in chunk {
            query = query
                .bind(&b.id)
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
                .bind(&b.scheduled_date);
        }
        query.execute(&mut *tx).await?;
    }

    // -- block_tags (2 columns) --
    const BLOCK_TAGS_COLS: usize = 2;
    const BLOCK_TAGS_CHUNK: usize = MAX_SQL_PARAMS / BLOCK_TAGS_COLS; // 499
    for chunk in data.tables.block_tags.chunks(BLOCK_TAGS_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "INSERT INTO block_tags (block_id, tag_id) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for bt in chunk {
            query = query.bind(&bt.block_id).bind(&bt.tag_id);
        }
        query.execute(&mut *tx).await?;
    }

    // -- block_properties (6 columns) --
    const BLOCK_PROPS_COLS: usize = 6;
    const BLOCK_PROPS_CHUNK: usize = MAX_SQL_PARAMS / BLOCK_PROPS_COLS; // 166
    for chunk in data.tables.block_properties.chunks(BLOCK_PROPS_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?, ?, ?)").collect();
        let sql = format!(
            "INSERT INTO block_properties (block_id, key, value_text, value_num, \
             value_date, value_ref) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for bp in chunk {
            query = query
                .bind(&bp.block_id)
                .bind(&bp.key)
                .bind(&bp.value_text)
                .bind(bp.value_num)
                .bind(&bp.value_date)
                .bind(&bp.value_ref);
        }
        query.execute(&mut *tx).await?;
    }

    // -- block_links (2 columns) --
    const BLOCK_LINKS_COLS: usize = 2;
    const BLOCK_LINKS_CHUNK: usize = MAX_SQL_PARAMS / BLOCK_LINKS_COLS; // 499
    for chunk in data.tables.block_links.chunks(BLOCK_LINKS_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "INSERT INTO block_links (source_id, target_id) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for bl in chunk {
            query = query.bind(&bl.source_id).bind(&bl.target_id);
        }
        query.execute(&mut *tx).await?;
    }

    // -- attachments (8 columns) --
    const ATTACH_COLS: usize = 8;
    const ATTACH_CHUNK: usize = MAX_SQL_PARAMS / ATTACH_COLS; // 124
    for chunk in data.tables.attachments.chunks(ATTACH_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?, ?, ?, ?, ?)").collect();
        let sql = format!(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, \
             fs_path, created_at, deleted_at) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for a in chunk {
            // Gate every attachment row at the trust boundary: a malformed snapshot
            // must not be able to seed `..`/absolute paths into the attachments
            // table even though later reads/writes would catch them (defense in
            // depth — we want the invariant "no bad rows in attachments" to hold).
            crate::sync_files::check_attachment_fs_path_shape(&a.fs_path)?;
            query = query
                .bind(&a.id)
                .bind(&a.block_id)
                .bind(&a.mime_type)
                .bind(&a.filename)
                .bind(a.size_bytes)
                .bind(&a.fs_path)
                .bind(&a.created_at)
                .bind(&a.deleted_at);
        }
        query.execute(&mut *tx).await?;
    }

    // -- property_definitions (4 columns) --
    const PROP_DEFS_COLS: usize = 4;
    const PROP_DEFS_CHUNK: usize = MAX_SQL_PARAMS / PROP_DEFS_COLS; // 249
    for chunk in data.tables.property_definitions.chunks(PROP_DEFS_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?)").collect();
        let sql = format!(
            "INSERT INTO property_definitions (key, value_type, options, created_at) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for pd in chunk {
            query = query
                .bind(&pd.key)
                .bind(&pd.value_type)
                .bind(&pd.options)
                .bind(&pd.created_at);
        }
        query.execute(&mut *tx).await?;
    }

    // -- page_aliases (2 columns) --
    const PAGE_ALIASES_COLS: usize = 2;
    const PAGE_ALIASES_CHUNK: usize = MAX_SQL_PARAMS / PAGE_ALIASES_COLS; // 499
    for chunk in data.tables.page_aliases.chunks(PAGE_ALIASES_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "INSERT INTO page_aliases (page_id, alias) VALUES {}",
            placeholders.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for pa in chunk {
            query = query.bind(&pa.page_id).bind(&pa.alias);
        }
        query.execute(&mut *tx).await?;
    }

    tx.commit().await?;

    // BUG-42: Enqueue the full cache-rebuild set. Without this, the UI
    // sees empty agenda / tag list / page list / search until the next
    // unrelated op triggers rebuilds by side-effect. `try_enqueue_background`
    // silently drops if the queue is saturated (`warn!` logged), which is
    // acceptable — the worst case is a slightly delayed rebuild on an
    // overloaded system, not data loss.
    // M-15: `RebuildPageIds` MUST be enqueued first so it is processed
    // before `RebuildAgendaCache` / `RebuildProjectedAgendaCache`. Both
    // agenda rebuilds consult `b.page_id` to apply the FEAT-5a
    // template-page exclusion (`NOT EXISTS (... tp.block_id = b.page_id
    // AND tp.key = 'template')`). The background consumer processes
    // tasks sequentially in enqueue order, so ordering this array
    // guarantees the agenda sees populated `page_id`s on first
    // rebuild — otherwise template-tagged pages' blocks would leak into
    // the agenda until something else triggered another rebuild.
    let rebuild_tasks = [
        ("RebuildPageIds", MaterializeTask::RebuildPageIds),
        ("RebuildTagsCache", MaterializeTask::RebuildTagsCache),
        ("RebuildPagesCache", MaterializeTask::RebuildPagesCache),
        ("RebuildAgendaCache", MaterializeTask::RebuildAgendaCache),
        (
            "RebuildProjectedAgendaCache",
            MaterializeTask::RebuildProjectedAgendaCache,
        ),
        (
            "RebuildTagInheritanceCache",
            MaterializeTask::RebuildTagInheritanceCache,
        ),
        ("RebuildFtsIndex", MaterializeTask::RebuildFtsIndex),
        // UX-250: repopulate inline tag-ref cache scanning the restored
        // block content. Ordering within this array does not matter
        // for agenda correctness — the background consumer processes
        // each task independently.
        (
            "RebuildBlockTagRefsCache",
            MaterializeTask::RebuildBlockTagRefsCache,
        ),
    ];
    for (label, task) in rebuild_tasks {
        if let Err(e) = materializer.try_enqueue_background(task) {
            tracing::warn!(
                task = label,
                error = %e,
                "failed to enqueue cache rebuild task after apply_snapshot"
            );
        }
    }

    Ok(data)
}
