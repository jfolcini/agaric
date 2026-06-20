use sqlx::SqlitePool;

use super::codec::decode_snapshot;
use super::types::SnapshotData;
use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};

/// (d): single inventory of cache tables paired with their rebuild
/// task. The wipe loop iterates over `.0` to issue `DELETE FROM <table>`;
/// the rebuild loop iterates over `.1` to enqueue the materializer task
/// that repopulates the same table. Co-locating both sides means a new
/// cache table cannot be wiped without a matching rebuild (or vice-versa)
/// — adding it requires a single edit to this list.
///
/// Note: `RebuildPageIds` is intentionally NOT in this list — it has no
/// dedicated cache table (it backfills `blocks.page_id` instead) and must
/// Be enqueued ahead of agenda rebuilds. It is enqueued separately
/// at the head of the rebuild fan-out below.
///
/// `block_tag_refs` is the inline-tag-ref cache and is wiped
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
    // Inline `#[ULID]` tag-ref cache. Purely derived — repopulated
    // by `RebuildBlockTagRefsCache` below.
    ("block_tag_refs", MaterializeTask::RebuildBlockTagRefsCache),
    // #617/#794: the page-level link roll-up (migration 0065). Both of its
    // columns carry `REFERENCES blocks(id) ON DELETE CASCADE`, so the
    // `DELETE FROM blocks` below wiped it IMPLICITLY — defeating this
    // inventory's "a cache table cannot be wiped without a matching
    // rebuild" guarantee: after a RESET the links/backlinks UI stayed
    // empty until an unrelated delete/restore/purge triggered the next
    // full fan-out. Listing it here makes the wipe explicit (idempotent
    // with the cascade) and pairs it with its rebuild task. The rebuild
    // consults `blocks.page_id`, which is why `RebuildPageIds` is
    // enqueued ahead of this list (see the note above).
    ("page_link_cache", MaterializeTask::RebuildPageLinkCache),
];

/// Apply a snapshot (RESET path). Wipes all core + cache tables, inserts
/// snapshot data, then enqueues the full cache-rebuild set on the
/// materializer so the UI doesn't see empty agenda / tag list / page
/// List / search until the next unrelated op.
///
/// Uses `BEGIN IMMEDIATE` (F04) to acquire the write lock upfront and
/// `PRAGMA defer_foreign_keys = ON` (F02) so that block inserts succeed
/// regardless of parent/child ordering in the snapshot data.
///
/// Cache rebuild tasks are enqueued via the awaiting `enqueue_background`
/// Variant: it blocks until queue space is available, so no rebuild
/// is dropped on a saturated channel. The only failure mode is
/// channel-closed (shutdown-in-progress), which is logged at `error!` and
/// does not abort the restore — the snapshot itself is already durable at
/// this point. Callers that need a synchronous guarantee can
/// `flush_background()` on the materializer after this returns.
///
/// # Caller responsibility: anchor the post-restore hash chain
///
/// The caller is responsible for anchoring the post-restore hash chain via
/// [`peer_refs::update_on_sync`](crate::peer_refs::update_on_sync) (or
/// equivalent) — `apply_snapshot` itself commits the new state but does
/// NOT persist `up_to_hash` as the local device's most-recent-seq-and-hash.
/// Without this follow-up, the next local op's `prev_hash` will not chain
/// correctly to the snapshot, and peer-side hash-chain validation will
/// Diverge. See for context.
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
/// - `log_snapshots` — wiped (#793). Local snapshots taken before the RESET
///   describe the pre-reset lineage; left in place,
///   `try_offer_snapshot_catchup` would keep serving them via
///   `get_latest_snapshot`, and a third device still on the OLD lineage
///   Passes the covering check — so this device could re-ship the
///   pre-reset vault AFTER itself moving to the new lineage. A post-reset
///   device has nothing valid to offer until it snapshots its new state.
/// - `app_settings['loro.peer_id_epoch']` — **bumped, not wiped** (#792).
///   Post-reset engines restart op counters at 0; reusing the old
///   deterministic PeerID would fork the (peer, counter) space against this
///   device's pre-reset ops still held by peers (silent outbound op drop +
///   loro-internal causal corruption on inbound import). The epoch bump
///   retires the old peer id atomically with the CRDT wipe; see
///   [`crate::loro::peer_epoch`].
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
    // The reader is consumed entirely inside `decode_snapshot`
    // (zstd-streaming + ciborium) before we acquire the write lock,
    // so the only memory in flight from this point on is the parsed
    // `SnapshotData` itself — never the compressed bytes nor the
    // decompressed CBOR. Production callers feed a `std::fs::File`
    // opened on a temp file the binary stream was written into;
    // tests still pass `&bytes[..]` (slice impls `Read`).
    let data = decode_snapshot(compressed_reader)?;

    // F04: BEGIN IMMEDIATE — acquire write lock upfront (consistent with
    // Every other write path in the codebase). route through
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

    // (d): wipe every cache table from the single inventory.
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
    // #793: stale local snapshots must die with the lineage they describe.
    // `try_offer_snapshot_catchup` serves `get_latest_snapshot` to any
    // Behind peer, and the covering check only compares the
    // requester's heads against the snapshot's `up_to_seqs` — a third
    // device still on the OLD lineage is "covered" by a pre-reset
    // snapshot, so leaving these rows in place lets this device re-ship
    // the pre-reset vault after it has itself moved to the new lineage.
    // Wiped in the SAME tx as the core swap: a rollback keeps the old
    // snapshots offerable alongside the old data (consistent), a commit
    // leaves nothing to offer until this device snapshots the new state.
    sqlx::query!("DELETE FROM log_snapshots")
        .execute(&mut *tx)
        .await?;
    // #792: retire the device's deterministic Loro PeerID atomically with
    // the CRDT wipe above. Post-reset engines reload EMPTY and restart op
    // counters at 0 — under the SAME peer id they would fork the
    // (peer, counter) space against this device's pre-reset ops still held
    // by peers (outbound: peers silently drop the new ops; inbound:
    // importing peer history into the forked doc corrupts loro-internal's
    // causal state). Bumping the persisted epoch in THIS tx means a crash
    // anywhere after commit still boots onto the new epoch, and a rollback
    // keeps epoch and loro_doc_state consistent. The caller's mandatory
    // `reload_registry_from_db` re-reads the epoch before rehydrating.
    let new_peer_epoch = crate::loro::peer_epoch::bump_peer_epoch(&mut tx).await?;
    tracing::info!(
        new_peer_epoch,
        "apply_snapshot: peer-id epoch bumped (#792); post-reset engines \
         will mint ops under a fresh Loro PeerID"
    );
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

    // Surface dropped drafts via a warn line.
    //
    // RESET is invoked by snapshot-driven catch-up. Any draft a
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
            "apply_snapshot: dropping unflushed drafts — RESET wipes block_drafts; \
             any draft saved after the snapshot was taken is silently lost without this warning"
        );
    }
    sqlx::query!("DELETE FROM block_drafts")
        .execute(&mut *tx)
        .await?;
    // blocks last (parent of all FK references)
    sqlx::query!("DELETE FROM blocks").execute(&mut *tx).await?;

    // (a): batch-INSERT each table via the `batch_insert_snapshot_rows!`
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

    // #1567: defensively repair `block_properties`, `block_links`, and
    // `page_aliases` BEFORE inserting them so a single bad row cannot abort the
    // whole COMMIT with an opaque, offending-row-less FK / CHECK error and wedge
    // snapshot catch-up.
    //
    // The RESET path binds snapshot rows verbatim into the live post-0088
    // schema. Two classes of bad row exist in legacy / foreign snapshots:
    //
    //   1. A `block_properties` row whose `key` is column-backed
    //      (`todo_state`/`priority`/`due_date`/`scheduled_date`/`space`). Those
    //      keys live in their dedicated `blocks` column, never as a property
    //      row, and migration 0088's `key_not_reserved` CHECK rejects them. The
    //      CHECK is IMMEDIATE (not deferred like the FKs), so such a row aborts
    //      at INSERT time — it must be filtered out, not inserted-then-deleted.
    //   2. A dangling reference: `block_properties.value_ref`,
    //      `block_links.{source_id,target_id}`, or `page_aliases.page_id`
    //      pointing at a block id absent from this snapshot's `blocks` set.
    //      Under `defer_foreign_keys = ON` these don't fail until COMMIT, where
    //      SQLite reports one opaque `FOREIGN KEY constraint failed` with no
    //      offending row — failing the entire restore over one stale edge.
    //
    // The set of valid block ids is exactly the snapshot's `blocks` rows (the
    // sole parent for every FK repaired here). We pre-filter against it rather
    // than mutating `data` so the returned `SnapshotData` still reflects the
    // snapshot as received. `block_tags` is intentionally NOT repaired — a
    // dangling tag edge is a harder corruption signal and the existing
    // `apply_snapshot_rejects_fk_violation` contract pins that it still aborts.
    use std::collections::HashSet;
    let known_block_ids: HashSet<&str> = data.tables.blocks.iter().map(|b| b.id.as_str()).collect();

    // (1) reserved-key + (2) dangling-value_ref repair for block_properties.
    let mut dropped_reserved_key = 0usize;
    let mut nulled_value_ref = 0usize;
    let repaired_block_properties: Vec<_> = data
        .tables
        .block_properties
        .iter()
        .filter(|bp| {
            // Mirror 0088's `key_not_reserved` CHECK via the canonical
            // predicate (the four reserved keys + `space`). Drop offenders.
            if crate::op::is_column_backed_property_key(&bp.key) {
                dropped_reserved_key += 1;
                return false;
            }
            true
        })
        .filter(|bp| {
            // A `value_ref`-typed row whose target block is absent from the
            // snapshot set is a dangling FK. A property row carries exactly one
            // non-NULL value (the `exactly_one_value` CHECK), so NULLing the
            // ref would leave zero values and violate that CHECK — drop the
            // whole row instead. Only value_ref rows are affected.
            match &bp.value_ref {
                Some(target) if !known_block_ids.contains(target.as_str()) => {
                    nulled_value_ref += 1;
                    false
                }
                _ => true,
            }
        })
        .collect();
    if dropped_reserved_key > 0 {
        tracing::warn!(
            rows = dropped_reserved_key,
            "apply_snapshot: dropped block_properties rows with column-backed \
             reserved keys (#1567); migration 0088's key_not_reserved CHECK \
             would otherwise abort the whole restore"
        );
    }
    if nulled_value_ref > 0 {
        tracing::warn!(
            rows = nulled_value_ref,
            "apply_snapshot: dropped block_properties rows whose value_ref \
             pointed at a block absent from the snapshot (#1567); the dangling \
             FK would otherwise abort the whole restore at COMMIT"
        );
    }

    batch_insert_snapshot_rows!(
        table: "block_properties",
        columns: [
            "block_id", "key", "value_text", "value_num", "value_date", "value_ref", "value_bool",
        ],
        rows: repaired_block_properties,
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

    // #708: the `block_properties` batch above re-populated the `spaces`
    // registry via the 0089 `spaces_register_is_space` trigger (the wipe's
    // `DELETE FROM blocks` cascade emptied it). A snapshot produced by an
    // older build — or one carrying a historically mis-stamped membership
    // (the #612 class) — can still hold `blocks.space_id` values that point
    // at a block with no `is_space` flag; under the 0089 FK
    // (`space_id REFERENCES spaces(id)`, checked at COMMIT because of the
    // F02 `defer_foreign_keys` above) those rows would abort the whole
    // restore. NULL them instead — the every-boot `pages_without_space`
    // Backfill reassigns the affected pages to Personal.
    let repaired = sqlx::query!(
        "UPDATE blocks SET space_id = NULL \
         WHERE space_id IS NOT NULL \
           AND space_id NOT IN (SELECT id FROM spaces)"
    )
    .execute(&mut *tx)
    .await?;
    if repaired.rows_affected() > 0 {
        tracing::warn!(
            rows = repaired.rows_affected(),
            "apply_snapshot: NULLed space_id values pointing at unregistered \
             spaces (#708); the boot backfill will reassign them"
        );
    }

    // #1567: drop `block_links` edges whose source OR target block is absent
    // from the snapshot set. Both columns carry `REFERENCES blocks(id)`
    // (migration 0061), so a single dangling edge would fail the deferred-FK
    // COMMIT for the whole restore.
    let mut dropped_block_links = 0usize;
    let repaired_block_links: Vec<_> = data
        .tables
        .block_links
        .iter()
        .filter(|bl| {
            let ok = known_block_ids.contains(bl.source_id.as_str())
                && known_block_ids.contains(bl.target_id.as_str());
            if !ok {
                dropped_block_links += 1;
            }
            ok
        })
        .collect();
    if dropped_block_links > 0 {
        tracing::warn!(
            rows = dropped_block_links,
            "apply_snapshot: dropped block_links edges referencing a block \
             absent from the snapshot (#1567); the dangling FK would otherwise \
             abort the whole restore at COMMIT"
        );
    }
    batch_insert_snapshot_rows!(
        table: "block_links",
        columns: ["source_id", "target_id"],
        rows: repaired_block_links,
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

    // #1567: drop `page_aliases` rows whose `page_id` is absent from the
    // snapshot set. `page_aliases.page_id REFERENCES blocks(id)` (migration
    // 0015), so a single dangling alias would fail the deferred-FK COMMIT for
    // the whole restore.
    let mut dropped_page_aliases = 0usize;
    let repaired_page_aliases: Vec<_> = data
        .tables
        .page_aliases
        .iter()
        .filter(|pa| {
            let ok = known_block_ids.contains(pa.page_id.as_str());
            if !ok {
                dropped_page_aliases += 1;
            }
            ok
        })
        .collect();
    if dropped_page_aliases > 0 {
        tracing::warn!(
            rows = dropped_page_aliases,
            "apply_snapshot: dropped page_aliases rows referencing a page block \
             absent from the snapshot (#1567); the dangling FK would otherwise \
             abort the whole restore at COMMIT"
        );
    }
    batch_insert_snapshot_rows!(
        table: "page_aliases",
        columns: ["page_id", "alias"],
        rows: repaired_page_aliases,
        bind: |q, pa| { q.bind(&pa.page_id).bind(&pa.alias) },
    );

    // #1567: final safety net. After the targeted repairs above, run
    // `PRAGMA foreign_key_check` while still inside the tx (before COMMIT) so
    // any residual deferred-FK violation is DIAGNOSABLE — SQLite's COMMIT-time
    // failure is a single opaque "FOREIGN KEY constraint failed" with no
    // offending row. `foreign_key_check` instead enumerates each violation as
    // `(table, rowid, parent, fkid)`. We log every offender at `warn!` and let
    // the COMMIT proceed: the targeted repairs cover the known classes
    // (reserved-key block_properties + dangling value_ref/block_links/
    // page_aliases), and `block_tags` is intentionally left to fail the COMMIT
    // (its FK contract is asserted by `apply_snapshot_rejects_fk_violation`).
    // The log lines turn a future opaque COMMIT abort into a specific
    // "table X rowid Y -> parent Z" trail for support.
    // dynamic-sql: PRAGMA foreign_key_check has no macro form (#646).
    let fk_violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *tx)
        .await?;
    if !fk_violations.is_empty() {
        use sqlx::Row;
        for row in &fk_violations {
            // Columns: "table" (TEXT), "rowid" (INTEGER, NULL for WITHOUT
            // ROWID tables), "parent" (TEXT), "fkid" (INTEGER).
            let table: String = row.try_get("table").unwrap_or_default();
            let rowid: Option<i64> = row.try_get("rowid").ok();
            let parent: String = row.try_get("parent").unwrap_or_default();
            tracing::warn!(
                table = %table,
                rowid = ?rowid,
                parent = %parent,
                "apply_snapshot: residual foreign-key violation survives the \
                 defensive repairs (#1567); the COMMIT below will abort with an \
                 opaque FK error — this row identifies the offender"
            );
        }
    }

    tx.commit().await?;

    // Enqueue the full cache-rebuild set. Without this, the UI
    // sees empty agenda / tag list / page list / search until the next
    // unrelated op triggers rebuilds by side-effect.
    //
    // Use the awaiting `enqueue_background` variant. The previous
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
    // `RebuildPageIds` MUST be enqueued first so it is processed
    // before `RebuildAgendaCache` / `RebuildProjectedAgendaCache`. Both
    // Agenda rebuilds consult `b.page_id` to apply the
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
