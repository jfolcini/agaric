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
/// Cache rebuild tasks are enqueued via the awaiting `enqueue_background`
/// variant (M-67): it blocks until queue space is available, so no rebuild
/// is dropped on a saturated channel. The only failure mode is
/// channel-closed (shutdown-in-progress), which is logged at `error!` and
/// does not abort the restore — the snapshot itself is already durable at
/// this point. Callers that need a synchronous guarantee can
/// `flush_background()` on the materializer after this returns.
///
/// # Caller responsibility: anchor the post-restore hash chain (M-70)
///
/// The caller is responsible for anchoring the post-restore hash chain via
/// [`peer_refs::update_on_sync`](crate::peer_refs::update_on_sync) (or
/// equivalent) — `apply_snapshot` itself commits the new state but does
/// NOT persist `up_to_hash` as the local device's most-recent-seq-and-hash.
/// Without this follow-up, the next local op's `prev_hash` will not chain
/// correctly to the snapshot, and peer-side hash-chain validation will
/// diverge. See M-70 for context.
///
/// The known production caller — `sync_daemon::snapshot_transfer::
/// try_receive_snapshot_catchup` — performs this anchor immediately after
/// `apply_snapshot` returns by calling `peer_refs::upsert_peer_ref` followed
/// by `peer_refs::update_on_sync(pool, peer_id, &up_to_hash, "")`. Future
/// callers MUST follow the same pattern.
///
/// # Loro sidecar state is wiped in the same transaction (#607 / #779)
///
/// The RESET clears the CRDT sidecar tables atomically with the core-table
/// swap:
///
/// - `loro_doc_state` — the persisted per-space engine snapshots reflect the
///   pre-reset lineage. Left in place, the next boot's `rehydrate_registry`
///   would restore the OLD vault into the engines while SQL holds the peer
///   snapshot, and the next outbound `prepare_outgoing` would re-ship
///   pre-reset content to peers (#779).
/// - `loro_sync_inbox` — leftover write-ahead slots hold pre-reset peer
///   bytes; boot recovery (`replay_sync_inbox`) would replay them into the
///   post-reset engines.
/// - `materializer_apply_cursor` — zeroed. `op_log` is empty after the wipe
///   (the snapshot carries table data, not ops), so any surviving non-zero
///   cursor points past the end of the log; the `MAX()`-gated per-op advance
///   would then hold the cursor above freshly minted seqs and the H-4 boot
///   clamp is the only thing that would ever correct it.
///
/// # Caller responsibility: reload the in-memory Loro engines (#607)
///
/// `apply_snapshot` takes no engine registry, so the in-memory engines still
/// hold pre-reset state when this returns — and there is NO process restart
/// after a snapshot catch-up (`try_receive_snapshot_catchup` applies and
/// returns; an earlier revision of this doc claimed otherwise). Even a real
/// restart would not heal on its own: the `RunEvent::Exit` handler's
/// `save_all_engines` would persist the pre-reset engines back into the
/// freshly wiped `loro_doc_state`. Callers MUST therefore follow this call
/// with [`crate::loro::snapshot::reload_registry_from_db`] (drop every
/// engine, rehydrate from the now-empty `loro_doc_state`) so the live
/// registry matches SQL. The production caller
/// (`try_receive_snapshot_catchup`) performs this reload immediately after
/// `apply_snapshot` returns. Post-reset engines are intentionally EMPTY —
/// the snapshot format carries no CRDT state, and rebuilding a Loro doc
/// from snapshot SQL would mint a fresh history whose tree nodes duplicate
/// the peer's on the next loro-sync merge; an empty engine instead imports
/// the peer's full CRDT state cleanly on the next session.
pub async fn apply_snapshot<R: std::io::Read>(
    pool: &SqlitePool,
    materializer: &Materializer,
    compressed_reader: R,
) -> Result<SnapshotData, AppError> {
    // L-67: the reader is consumed entirely inside `decode_snapshot`
    // (zstd-streaming + ciborium) before we acquire the write lock,
    // so the only memory in flight from this point on is the parsed
    // `SnapshotData` itself — never the compressed bytes nor the
    // decompressed CBOR. Production callers feed a `std::fs::File`
    // opened on a temp file the binary stream was written into;
    // tests still pass `&bytes[..]` (slice impls `Read`).
    let data = decode_snapshot(compressed_reader)?;

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
        sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
            .execute(&mut *tx)
            .await?;
    }

    // Wipe core tables (children before parents purely for reviewability —
    // `defer_foreign_keys = ON` would let any order succeed).
    sqlx::query!("DELETE FROM block_links")
        .execute(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM block_properties")
        .execute(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM block_tags")
        .execute(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM attachments")
        .execute(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM page_aliases")
        .execute(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM property_definitions")
        .execute(&mut *tx)
        .await?;
    // H-13: the BEFORE DELETE trigger on op_log (migration 0036) blocks bare
    // DELETEs. Although `apply_snapshot` is technically the RESET path
    // rather than compaction, it is the other documented "controlled
    // wholesale op_log wipe" in the system (the AGENTS.md invariant says
    // "except compaction" but the snapshot-driven RESET is an equivalently
    // intentional mutation). The wording may need tightening in the future;
    // for now we extend the same bypass mechanism
    // here so sync RESET continues to function.
    crate::op_log::enable_op_log_mutation_bypass(&mut tx).await?;
    sqlx::query!("DELETE FROM op_log").execute(&mut *tx).await?;
    crate::op_log::disable_op_log_mutation_bypass(&mut tx).await?;

    // #607 / #779: wipe the Loro sidecar state in the SAME tx as the core
    // swap (see the function docs). `loro_doc_state` would otherwise
    // rehydrate the pre-reset engines at next boot; `loro_sync_inbox`
    // would replay pre-reset peer bytes into them; a non-zero apply
    // cursor over an empty op_log is the H-4 impossible state. The
    // in-memory engines are the caller's responsibility
    // (`crate::loro::snapshot::reload_registry_from_db`).
    sqlx::query!("DELETE FROM loro_doc_state")
        .execute(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM loro_sync_inbox")
        .execute(&mut *tx)
        .await?;
    let cursor_reset_at = crate::db::now_ms();
    sqlx::query!(
        "UPDATE materializer_apply_cursor \
         SET materialized_through_seq = 0, \
             updated_at = ? \
         WHERE id = 1",
        cursor_reset_at,
    )
    .execute(&mut *tx)
    .await?;

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
    let dropped_count: i64 =
        sqlx::query_scalar!(r#"SELECT COUNT(*) AS "count!" FROM block_drafts"#)
            .fetch_one(&mut *tx)
            .await?;
    if dropped_count > 0 {
        let sample_ids: Vec<String> =
            sqlx::query_scalar!("SELECT block_id FROM block_drafts LIMIT 8")
                .fetch_all(&mut *tx)
                .await?;
        tracing::warn!(
            dropped_count,
            ?sample_ids,
            "apply_snapshot: dropping unflushed drafts (M-66) — RESET wipes block_drafts; \
             any draft saved after the snapshot was taken is silently lost without this warning"
        );
    }
    sqlx::query!("DELETE FROM block_drafts")
        .execute(&mut *tx)
        .await?;
    // blocks last (parent of all FK references)
    sqlx::query!("DELETE FROM blocks").execute(&mut *tx).await?;

    // MAINT-152(a): batch-INSERT each table via the `batch_insert_snapshot_rows!`
    // macro. The macro hides the placeholder string, the chunk-size derivation
    // (`MAX_SQL_PARAMS / num_columns`), the `format!`-driven INSERT, and the
    // bind loop — leaving the column list, row source, and per-row binding
    // closure as the only varying inputs.
    //
    macro_rules! batch_insert_snapshot_rows {
        (
            table: $table:literal,
            columns: [$($col:literal),+ $(,)?],
            rows: $rows:expr_2021,
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
                let mut $query = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
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
            "deleted_at",
            "todo_state", "priority", "due_date", "scheduled_date",
            "space_id",
        ],
        rows: data.tables.blocks,
        bind: |q, b| {
            q.bind(&b.id)
                .bind(&b.block_type)
                .bind(&b.content)
                .bind(&b.parent_id)
                .bind(b.position)
                .bind(b.deleted_at)
                .bind(&b.todo_state)
                .bind(&b.priority)
                .bind(&b.due_date)
                .bind(&b.scheduled_date)
                // #533: round-trip space membership (FK-safe under
                // `defer_foreign_keys = ON` — the space block is in this
                // same blocks batch, validated at commit).
                .bind(&b.space_id)
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
            "block_id", "key", "value_text", "value_num", "value_date", "value_ref", "value_bool",
        ],
        rows: data.tables.block_properties,
        bind: |q, bp| {
            q.bind(&bp.block_id)
                .bind(&bp.key)
                .bind(&bp.value_text)
                .bind(bp.value_num)
                .bind(&bp.value_date)
                .bind(&bp.value_ref)
                .bind(bp.value_bool)
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
                .bind(a.created_at)
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
    // unrelated op triggers rebuilds by side-effect.
    //
    // M-67: use the awaiting `enqueue_background` variant. The previous
    // `try_enqueue_background` shed tasks when the bounded background
    // channel was saturated (a `warn!` was emitted but otherwise lost) —
    // and this is exactly the moment when stale caches matter most:
    // there is no boot-time recheck, so any dropped task left FTS /
    // agenda_cache / pages_cache / tags_cache empty until an unrelated
    // edit triggered the next rebuild. The awaiting variant blocks until
    // queue space is available, ensuring no rebuild is dropped. Its only
    // error mode is channel-closed (shutdown-in-progress); we log at
    // `error!` ("should never happen" at this point — the materializer
    // is by definition alive, we just used it) and continue so the
    // caller still sees the durable `SnapshotData`.
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
    if let Err(e) = materializer
        .enqueue_background(MaterializeTask::RebuildPageIds)
        .await
    {
        tracing::error!(
            task = "RebuildPageIds",
            error = %e,
            "failed to enqueue cache rebuild task after apply_snapshot \
             (channel closed; shutdown-in-progress?). snapshot applied but \
             cache rebuilds could not be enqueued; restart the app to repair caches"
        );
    }
    for (table, task) in CACHE_TABLES {
        if let Err(e) = materializer.enqueue_background(task.clone()).await {
            tracing::error!(
                cache_table = table,
                error = %e,
                "failed to enqueue cache rebuild task after apply_snapshot \
                 (channel closed; shutdown-in-progress?). snapshot applied but \
                 cache rebuilds could not be enqueued; restart the app to repair caches"
            );
        }
    }

    // #417: recompute the two `pages_cache` count columns AFTER
    // `RebuildPagesCache` has re-inserted every page row. The RESET wipe
    // above leaves both columns at DEFAULT 0, and the per-op count
    // maintenance that ordinary edits rely on never fires here (a snapshot
    // apply is not an op fan-out). This is the ONLY production path that
    // enqueues `RebuildPagesCacheCounts` — gating it out of the per-op
    // `RebuildPagesCache` (the redundant O(pages) correlated-subquery pass)
    // is exactly issue #417.
    //
    // Ordering: enqueued separately at the TAIL (mirroring how
    // `RebuildPageIds` is enqueued separately at the HEAD) so the count
    // recompute observes the freshly-rebuilt `pages_cache` rows. The
    // background consumer processes tasks in strict enqueue order, so this
    // runs strictly after `RebuildPagesCache` from the `CACHE_TABLES` loop.
    // (Dedup keys global tasks by discriminant — `RebuildPagesCache` and
    // `RebuildPagesCacheCounts` are distinct discriminants, so neither
    // collapses the other and the relative order is preserved.)
    if let Err(e) = materializer
        .enqueue_background(MaterializeTask::RebuildPagesCacheCounts)
        .await
    {
        tracing::error!(
            task = "RebuildPagesCacheCounts",
            error = %e,
            "failed to enqueue cache rebuild task after apply_snapshot \
             (channel closed; shutdown-in-progress?). snapshot applied but \
             pages_cache counts could not be enqueued; restart the app to repair caches"
        );
    }

    Ok(data)
}
