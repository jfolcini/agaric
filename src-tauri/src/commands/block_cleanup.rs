//! Shared subtree-cleanup helpers (#664).
//!
//! Two SQL chains used to be hand-duplicated across the block command
//! handlers, and the duplication had already drifted:
//!
//! * The ~13-table **physical purge** chain (every `DELETE FROM
//!   <satellite>` for a subtree's block ids) appeared three times in
//!   `commands/blocks/crud.rs` — the `purge_descendants_table!` macro
//!   variant (`purge_block_inner`), the `query!` variant
//!   (`purge_all_deleted_inner`), and the `format!("{cte}…")` variant
//!   (`purge_blocks_by_ids_inner`). Adding a new satellite table meant
//!   hand-editing all three; this is the exact bug class #417/#446/#533
//!   kept patching.
//! * The **`page_id` + `space_id` rederive** CTE appeared four times
//!   (`move_ops.rs`, `crud.rs` restore, and the two reverse arms in
//!   `history.rs`). The two `history.rs` arms had drifted to rederive
//!   only `page_id` and skip `space_id` (the #533 step), so a moved /
//!   restored subtree read stale space membership after an undo until
//!   the async `RebuildPageIds` chain landed.
//!
//! Collapsing every call site onto [`rederive_page_and_space_ids`] makes
//! the complete (both-column) behaviour structurally impossible to drift
//! again, and [`purge_subtree_tables`] gives the satellite-table list one
//! home.
//!
//! Both helpers operate on a borrowed `&mut SqliteConnection` (obtained by
//! the callers via `&mut **tx` from their existing `CommandTx` /
//! `Transaction`). They open no transaction of their own — they run inside
//! the caller's IMMEDIATE tx, preserving the #110 raw-write-tx convention.

use sqlx::SqliteConnection;

use agaric_core::error::AppError;

/// Run the full satellite-table purge chain for a subtree of `blocks`.
///
/// `member_subquery` is the SQL that yields the set of block ids to purge
/// (it is referenced by every per-table `DELETE … IN (<member_subquery>)`),
/// and `cte_prefix` is an optional `WITH RECURSIVE …` prefix that defines
/// the relation `member_subquery` selects from. `bind` is the single value
/// bound to the `?` / `?1` placeholder in `cte_prefix` (the seed block id,
/// or the JSON id array for the multi-root variant); pass `None` for the
/// "all soft-deleted" variant, whose member set carries no placeholder.
///
/// The table list, order, and per-table column predicates are byte-for-byte
/// the chains they replace (block_tags → block_tag_inherited → two
/// block_properties sweeps → block_links → agenda_cache → tags_cache →
/// pages_cache → attachments → block_drafts → fts_blocks → page_aliases →
/// projected_agenda_cache → blocks). FK checks must already be deferred by
/// the caller (`PRAGMA defer_foreign_keys = ON`) — the chain assumes it.
///
/// Returns a [`PurgeSubtreeCounts`]: how many `attachments` rows the chain
/// deleted (a hint the caller uses to decide whether a byte-reclamation GC
/// pass is worth enqueuing) and the row count of the final `blocks` DELETE.
///
/// # Byte reclamation is NOT done here (#3259)
///
/// This helper used to `SELECT fs_path FROM attachments WHERE block_id IN
/// (<member>)` before the DELETE and hand those paths back for a post-commit
/// `remove_file`. Since the #1993 content-hash dedup landed, N `attachments`
/// rows legitimately SHARE one canonical file (`add_attachment_inner` reuses
/// an existing `attachment_blobs.on_disk_path`, and
/// `backfill_attachment_blobs` repoints duplicate-hash rows onto one canonical
/// path at boot), so that unfiltered capture unlinked bytes surviving rows on
/// non-purged blocks still referenced — a live data-loss bug.
///
/// Bytes are therefore reclaimed exactly the way `delete_attachment_inner` and
/// the dedup branch of `add_attachment_inner` already reclaim them: by
/// `cleanup_orphaned_attachments`, which unlinks a walked file only when NO
/// `attachments` row references its path — its authoritative write-pool
/// membership re-check sits immediately before the `remove_file`, so the
/// decision cannot be invalidated across a commit boundary the way a
/// capture-inside-the-tx / unlink-after-commit scheme is (there, ANY
/// concurrent same-bytes ingest deduping onto the path in between silently
/// turns the unlink into data loss) — and then prunes any
/// `attachment_blobs` row whose `on_disk_path` is likewise unreferenced. The
/// callers enqueue that GC pass post-commit when `attachment_rows > 0`, so
/// reclamation stays prompt.
///
/// All SQL here is genuinely dynamic — the same chain is emitted against
/// three different membership shapes (single-root recursive CTE, multi-root
/// `json_each` CTE, and the flat `deleted_at IS NOT NULL` set) — so the
/// runtime `sqlx::query(...)` form is required; the macro form cannot take a
/// runtime-assembled query string.
pub async fn purge_subtree_tables(
    conn: &mut SqliteConnection,
    cte_prefix: &str,
    member_subquery: &str,
    bind: Option<&str>,
) -> Result<PurgeSubtreeCounts, AppError> {
    // #2895 slice 1: the store-owned satellite / derived-cache purge (block_tags,
    // block_tag_inherited, block_properties×2, block_links, agenda_cache,
    // tags_cache, pages_cache, fts_blocks, page_aliases, projected_agenda_cache)
    // now lives behind the owning crate's
    // `agaric_store::cache::purge_block_satellite_caches`, threading the SAME
    // borrowed connection so the caller's IMMEDIATE tx is preserved. FK checks
    // remain deferred by the caller; `blocks` is deleted last (below).
    agaric_store::cache::purge_block_satellite_caches(conn, cte_prefix, member_subquery, bind)
        .await?;

    // attachments (keyed on block_id) — app-owned, fs-backed satellite. Only
    // the ROWS go here: the bytes they point at may be shared with rows on
    // blocks outside the member set (#1993 dedup), so unlinking them is the
    // GC's refcount-aware job (#3259 — see the doc comment above). The
    // rows-affected count is returned purely as a "was any attachment
    // involved?" hint so the caller can skip the GC enqueue on the common
    // attachment-free purge.
    let attachment_rows = exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM attachments \
             WHERE block_id IN ({member_subquery})"
        ),
    )
    .await?;

    // block_drafts (keyed on block_id) — device-local, never synced/snapshotted.
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM block_drafts \
             WHERE block_id IN ({member_subquery})"
        ),
    )
    .await?;

    // blocks themselves (keyed on id; deferred FK lets the single DELETE sweep
    // the whole subtree). #2895 slice 1: the engine owns the `blocks`
    // projection, so the final delete lives behind
    // `agaric_engine::block_ops::delete_blocks_in_subtree`.
    let rows =
        agaric_engine::block_ops::delete_blocks_in_subtree(conn, cte_prefix, member_subquery, bind)
            .await?;

    Ok(PurgeSubtreeCounts {
        attachment_rows,
        blocks: rows,
    })
}

/// Row counts produced by one [`purge_subtree_tables`] run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PurgeSubtreeCounts {
    /// `attachments` rows deleted for the member set. Non-zero means the
    /// purge may have orphaned bytes on disk, so the caller enqueues a
    /// `CleanupOrphanedAttachments` pass post-commit; zero means there is
    /// nothing for the GC to reclaim and the enqueue is skipped.
    ///
    /// Deliberately a COUNT, not the list of `fs_path`s: a path list would
    /// invite the caller to unlink it, which is exactly the #3259 data-loss
    /// bug (those paths may be shared with surviving rows).
    pub attachment_rows: u64,
    /// Rows affected by the final `blocks` DELETE — the purge's headline
    /// "how many blocks did this remove" count.
    pub blocks: u64,
}

/// Execute one dynamic `DELETE`, optionally binding a single placeholder.
async fn exec(conn: &mut SqliteConnection, bind: Option<&str>, sql: &str) -> Result<u64, AppError> {
    // dynamic-sql: #664 — one purge chain emitted against three runtime
    // membership shapes (single-root CTE / json_each CTE / flat
    // deleted-set); the macro form cannot take a runtime query string.
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()));
    if let Some(b) = bind {
        q = q.bind(b.to_string());
    }
    Ok(q.execute(conn).await?.rows_affected())
}

// #2621 (THE INVERSION): `rederive_page_and_space_ids` is pure `blocks`-table
// SQL (recursive descendant CTEs with the depth-100 cap), so it lives in
// `agaric-store` beside the other block-descendant CTE helpers
// (`agaric_store::block_descendants`); call sites reference it there directly
// (#2897).
