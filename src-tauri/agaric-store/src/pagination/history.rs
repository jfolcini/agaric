use sqlx::SqlitePool;

use super::{Cursor, HistoryEntry, PageRequest, PageResponse, build_page_response};
use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;

/// List op-log history for a specific block, paginated.
///
/// Returns all ops whose payload contains the given `block_id`, ordered by
/// `(seq DESC, device_id DESC)` (newest first).  The cursor stores `seq` and
/// `device_id` (in the `id` field) for correct keyset pagination across
/// multiple devices — the op_log PK is `(device_id, seq)` and `seq` alone
/// is not globally unique.
///
/// B.2: queries the native `block_id` column (migration 0030)
/// directly, replacing the old `LIKE` pre-filter + `json_extract`
/// fallback. The `idx_op_log_block_id` index makes this O(log N) instead
/// of a full op_log scan with per-row JSON parsing.
///
/// Optional `op_type_filter` pushes the FE-side
/// `op_type` filter into SQL, mirroring `list_page_history`. Without
/// this the FE applied the filter post-pagination, so a 50-row cursor
/// page could yield 0 visible rows and "Load more" would appear empty.
///
/// Note: When `op_type_filter` is `None`, this queries ALL op types for
/// a block (create, edit, add_tag, remove_tag, move, set_property, etc.).
///
/// # Cursor seq invariant
///
/// `op_log.seq` is auto-incremented per device starting at **1** (see
/// `op_log::append_local_op_in_tx`'s `COALESCE(MAX(seq), 0) + 1`
/// computation); seq `0` never appears in real rows.
/// The keyset predicate is short-circuited via `?2 IS NULL` when no
/// cursor is supplied, so the `cursor_seq = 0` sentinel used in the
/// no-cursor branch never participates in row comparison. If a future
/// change introduces seq `0` as a per-device sentinel op, this default
/// would silently treat it as already-seen — switch `cursor_seq` to
/// `Option<i64>` and bind it directly at that point.
pub async fn list_block_history(
    pool: &SqlitePool,
    block_id: &BlockId,
    op_type_filter: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let fetch_limit = page.limit + 1;

    // #663 — the canonical (uppercase) ULID. `op_log.block_id` is always
    // stored canonical, so a lowercase caller id is normalised here via the
    // `BlockId` newtype rather than missing every row.
    let block_id = block_id.as_str();

    // `id` in the cursor stores `device_id` for history queries — it is the
    // tie-breaker because the op_log PK is `(device_id, seq)`. The
    // `cursor_seq = 0` sentinel in the no-cursor branch is safe per the
    // Doc-block above (op_log seq starts at 1).
    let (cursor_flag, cursor_seq, cursor_device_id): (Option<i64>, i64, &str) =
        match page.after.as_ref() {
            Some(c) => (Some(1), c.seq.unwrap_or(0), &c.id),
            None => (None, 0, ""),
        };

    let rows = sqlx::query_as!(
        HistoryEntry,
        "SELECT device_id, seq, op_type, payload, created_at, \
                is_replicated AS \"is_replicated!: bool\" \
         FROM op_log \
         WHERE block_id = ?1 \
           AND (?6 IS NULL OR op_type = ?6) \
           AND (?2 IS NULL OR (\
                seq < ?3 OR (seq = ?3 AND device_id < ?5))) \
         ORDER BY seq DESC, device_id DESC \
         LIMIT ?4",
        block_id,         // ?1
        cursor_flag,      // ?2
        cursor_seq,       // ?3
        fetch_limit,      // ?4
        cursor_device_id, // ?5
        op_type_filter,   // ?6
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| {
        // device_id as tie-breaker
        Cursor::for_history_seq(last.device_id.clone(), last.seq)
    })
}

/// List op-log history for all blocks descended from a page, paginated.
///
/// Uses a recursive CTE to find all block IDs in the page subtree, then
/// queries the op_log for ops touching those blocks. Ordered by
/// `(created_at DESC, seq DESC)` (newest first). Optionally filters by
/// `op_type`.
///
/// The cursor stores `created_at` (in the `deleted_at` field, reused for
/// this timestamp purpose) and `seq` for correct keyset pagination.
///
/// Phase 8 — when `page_id == "__all__"` and `space_id` is `Some`,
/// the global query is additionally filtered to only ops whose
/// `payload.block_id` belongs to the requested space (via the
/// `blocks.space_id` column — #533). When `space_id` is `None`, behaviour
/// is identical
/// to before — every op in `op_log` is returned. When `page_id` is a real
/// ULID (per-page mode), `space_id` is ignored: a page is itself
/// space-bound, so the existing recursive CTE already scopes correctly.
///
/// # Attachment ops (#4277)
///
/// `delete_attachment` and `rename_attachment` carry no `block_id` in
/// their payload (`OpPayload::block_id()` returns `None` for both), so the
/// indexed `op_log.block_id` column is NULL on those rows and neither the
/// per-page `page_blocks` predicate nor the space-scoped `blocks.space_id`
/// predicate can ever match them. Before this fix both branches simply
/// omitted every attachment delete/rename from the History view.
///
/// Both branches therefore carry the SAME two-probe disjunct #4278 added
/// to the three positional-undo queries (`undo_page_op_inner`,
/// `find_undo_group_inner`, `undo_page_group_inner`), scoped to whichever
/// block set that branch already uses:
///
///   1. the live-`attachments` probe, which resolves a
///      `rename_attachment`'s owning block from the row it renamed;
///   2. the paired-`add_attachment` probe over the indexed
///      `op_log.attachment_id` column (migration 0064), which resolves a
///      `delete_attachment`'s owning block WITHOUT the row — the delete
///      hard-DELETEs it inside the transaction that appends the op.
///
/// The idiom is deliberately identical, including the
/// `ol.op_type = 'delete_attachment'` gate INSIDE the outer
/// `op_type IN (...)` predicate and the `src_add.is_replicated = 0`
/// filter. Both matter:
///
///   * the inner gate keeps an ORPHANED rename (`add → rename → delete`,
///     row already gone) out — #4278 narrowed the probe for exactly that
///     reason and the same reasoning holds here: the rename's live-row
///     probe is correct whenever the row exists, and the orphan self-heals
///     the moment the delete is undone;
///   * keeping the predicate byte-identical to the undo sites is what
///     makes the two admitted sets agree. `undoDeleteOfImpl`
///     (`src/stores/undo.ts`) feeds an index from THIS list straight into
///     `undo_page_op`'s `undo_depth`, so any row one query admits and the
///     other does not shifts that positional mapping by one. Divergence
///     here is not cosmetic — it makes swipe-delete undo mis-target.
///
/// Known caveat, tracked as option 1 in #4247/#4278: if `compact_op_log`
/// has reclaimed the paired `add_attachment`, the owning page is NOT
/// recoverable from the delete alone — `DeleteAttachmentPayload` carries
/// no `block_id` to fall back on. Both probes are then false and the row
/// is simply omitted. That degradation is deliberate and safe: the op
/// disappears from the list rather than being attributed to an arbitrary
/// page, which is why the second probe resolves the owner instead of
/// guessing one.
///
/// A second shape of the SAME caveat, and on a synced vault likely the
/// COMMONER one: deleting, on this device, an attachment that was ADDED on
/// a peer device. Nothing reclaimed the paired `add_attachment` — it is
/// still sitting in `op_log` — but it got there via replication, so it
/// carries `is_replicated = 1` here. `src_add.is_replicated = 0` in probe 2
/// is then false for it, and probe 1 has no row to find either, because the
/// local `delete_attachment` already removed it. Both probes false, row
/// omitted, same degrade-to-invisible outcome — but reachable on the FIRST
/// local delete of a peer-added attachment, with no `compact_op_log` sweep
/// (a maintenance operation, not a routine one) required first.
///
/// This is deliberate, not a second gap to close: `src_add.is_replicated =
/// 0` is the same filter the three undo queries carry (see above), and
/// widening this probe by dropping it would break the byte-identity the
/// `undoDeleteOfImpl` index mapping depends on — reintroducing the exact
/// mis-targeted-undo bug this predicate exists to prevent. Omitting the row
/// from history is the price paid to keep swipe-delete undo pointed at the
/// right op; letting it through and mismatching the undo query would be
/// worse than that trade.
///
/// Residual divergence NOT closed here (out of scope, positional mapping
/// unchanged): this query has no `is_undo = 0` / `is_replicated = 0`
/// filter while the three undo queries do, so reverse ops and foreign
/// audit rows (migration 0099) are listed but not undoable. That skew
/// predates #4277 and is independent of attachments.
pub async fn list_page_history(
    pool: &SqlitePool,
    page_id: &str,
    op_type_filter: Option<&str>,
    space_id: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let fetch_limit = page.limit + 1;

    // Cursor: reuse `deleted_at` field for `created_at` and `seq` + `id` for device_id
    // #109 Phase 2: `op_log.created_at` is INTEGER epoch-ms. The opaque
    // `Cursor.deleted_at` slot still carries it as a String (see Cursor
    // docs); parse it back to i64 here before binding against the
    // INTEGER column.
    let (cursor_flag, cursor_created_at, cursor_seq, cursor_device_id): (
        Option<i64>,
        i64,
        i64,
        &str,
    ) = match page.after.as_ref() {
        Some(c) => {
            let created_at_str = c.deleted_at.as_deref().ok_or_else(|| {
                AppError::validation("cursor missing created_at for page history query".into())
            })?;
            let created_at = created_at_str.parse::<i64>().map_err(|e| {
                AppError::validation(format!("cursor created_at not an integer: {e}"))
            })?;
            (Some(1), created_at, c.seq.unwrap_or(0), &c.id)
        }
        None => (None, 0, 0, ""),
    };

    if page_id == "__all__" {
        // Global history: query all ops without page-scoping CTE.
        // Phase 8 — when `space_id` is `Some`, narrow to ops whose
        // `payload.block_id` belongs to the requested space (matching the
        // pattern used in `pagination/hierarchy.rs:113-134`).
        //
        // Compile-time SQL check via `query_as!` (AGENTS.md
        // invariant #6). The previous dynamic `query_as::<_, _>` form
        // bypassed `cargo sqlx prepare` validation; this branch is
        // entirely static SQL with `?N IS NULL` short-circuits, so the
        // macro form fits without losing any flexibility.
        //
        // IX2 (#349) — EQP-verified (5 000-row op_log seed, ANALYZE'd):
        // a candidate composite `idx_op_log(created_at, seq)` was NOT
        // added, and no migration ships in this group. The `ORDER BY
        // ol.created_at DESC, ol.seq DESC, ol.device_id DESC` here plans
        // as `SCAN ol` + `USE TEMP B-TREE FOR ORDER BY` today. With the
        // candidate index it became `SCAN ol USING INDEX
        // idx_op_log_created_seq` + `USE TEMP B-TREE FOR LAST TERM OF
        // ORDER BY` — i.e. it is STILL a full scan (the keyset
        // `created_at < ?3 OR (… seq < ?4) OR (…)` OR-chain is not a
        // bounded range the planner can seek, and the no-cursor branch
        // binds NULL sentinels) and STILL needs a temp B-tree (only the
        // trailing `device_id` term is removed from it). The win is
        // marginal — one fewer sort key on an already-small LIMIT 51
        // page — while the index adds write amplification on the
        // hot-path op_log insert. The existing single-column
        // `idx_op_log_created` already covers the per-`created_at`
        // lookups that matter. Conclusion: not worth it; left out.
        let rows = sqlx::query_as!(
            HistoryEntry,
            "SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at, \
                    ol.is_replicated AS \"is_replicated!: bool\" \
             FROM op_log ol \
             WHERE (?1 IS NULL OR ol.op_type = ?1) \
               AND (?2 IS NULL OR ( \
                    ol.created_at < ?3 \
                    OR (ol.created_at = ?3 AND ol.seq < ?4) \
                    OR (ol.created_at = ?3 AND ol.seq = ?4 AND ol.device_id < ?6))) \
               AND (?7 IS NULL OR ( \
                    ol.block_id IN (SELECT id FROM blocks WHERE space_id = ?7) \
                    OR ( \
                        ol.op_type IN ('delete_attachment', 'rename_attachment') \
                        AND ( \
                            EXISTS ( \
                                SELECT 1 FROM attachments a \
                                WHERE a.id = json_extract(ol.payload, '$.attachment_id') \
                                AND a.block_id IN (SELECT id FROM blocks WHERE space_id = ?7) \
                            ) \
                            OR ( \
                                ol.op_type = 'delete_attachment' \
                                AND EXISTS ( \
                                    SELECT 1 FROM op_log src_add \
                                    WHERE src_add.op_type = 'add_attachment' \
                                    AND src_add.attachment_id = json_extract(ol.payload, '$.attachment_id') \
                                    AND src_add.is_replicated = 0 \
                                    AND src_add.block_id IN (SELECT id FROM blocks WHERE space_id = ?7) \
                                ) \
                            ) \
                        ) \
                    ) \
                )) \
             ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC \
             LIMIT ?5",
            op_type_filter,    // ?1
            cursor_flag,       // ?2
            cursor_created_at, // ?3
            cursor_seq,        // ?4
            fetch_limit,       // ?5
            cursor_device_id,  // ?6
            space_id,          // ?7
        )
        .fetch_all(pool)
        .await?;

        return build_page_response(rows, page.limit, |last| {
            Cursor::for_history_full(
                last.device_id.clone(),
                last.created_at.to_string(),
                last.seq,
            )
        });
    }

    // Recursive CTE with `depth < 100` to bound the walk against
    // runaway recursion on corrupted data (invariant #9).
    // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
    let rows = sqlx::query_as!(
        HistoryEntry,
        "WITH RECURSIVE page_blocks(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ?1 \
             UNION ALL \
             SELECT b.id, pb.depth + 1 FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
             WHERE pb.depth < 100 \
         ) \
         SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at, \
                ol.is_replicated AS \"is_replicated!: bool\" \
         FROM op_log ol \
         WHERE ( \
             ol.block_id IN (SELECT id FROM page_blocks) \
             OR ( \
                 ol.op_type IN ('delete_attachment', 'rename_attachment') \
                 AND ( \
                     EXISTS ( \
                         SELECT 1 FROM attachments a \
                         WHERE a.id = json_extract(ol.payload, '$.attachment_id') \
                         AND a.block_id IN (SELECT id FROM page_blocks) \
                     ) \
                     OR ( \
                         ol.op_type = 'delete_attachment' \
                         AND EXISTS ( \
                             SELECT 1 FROM op_log src_add \
                             WHERE src_add.op_type = 'add_attachment' \
                             AND src_add.attachment_id = json_extract(ol.payload, '$.attachment_id') \
                             AND src_add.is_replicated = 0 \
                             AND src_add.block_id IN (SELECT id FROM page_blocks) \
                         ) \
                     ) \
                 ) \
             ) \
         ) \
           AND (?2 IS NULL OR ol.op_type = ?2) \
           AND (?3 IS NULL OR ( \
                ol.created_at < ?4 \
                OR (ol.created_at = ?4 AND ol.seq < ?5) \
                OR (ol.created_at = ?4 AND ol.seq = ?5 AND ol.device_id < ?7))) \
         ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC \
         LIMIT ?6",
        page_id,           // ?1
        op_type_filter,    // ?2
        cursor_flag,       // ?3
        cursor_created_at, // ?4
        cursor_seq,        // ?5
        fetch_limit,       // ?6
        cursor_device_id,  // ?7
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| {
        // reuse deleted_at slot for created_at — see Cursor docs
        Cursor::for_history_full(
            last.device_id.clone(),
            last.created_at.to_string(),
            last.seq,
        )
    })
}
