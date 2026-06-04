use super::super::*;
use super::common::*;

// ======================================================================
// get_block_history
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_history_returns_ops_for_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "updated".into())
        .await
        .unwrap();

    let resp = get_block_history_inner(&pool, created.id.into_string(), None, None, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "create + edit = 2 ops");
    // Newest first (seq DESC)
    assert_eq!(
        resp.items[0].op_type, "edit_block",
        "newest op should be edit_block"
    );
    assert_eq!(
        resp.items[1].op_type, "create_block",
        "oldest op should be create_block"
    );
}

// ======================================================================
// compute_edit_diff_inner
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_compute_edit_diff_inner_happy_path() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block with initial content
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello world".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Edit the block to change its content
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone(),
        "hello universe".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Find the edit_block op in the op_log
    let op_row = sqlx::query!(
        "SELECT device_id, seq FROM op_log \
         WHERE op_type = 'edit_block' \
         ORDER BY seq DESC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let diff = compute_edit_diff_inner(&pool, op_row.device_id, op_row.seq)
        .await
        .unwrap();

    let spans = diff.expect("diff should be Some for an edit_block op");
    assert!(!spans.is_empty(), "diff should contain at least one span");

    // The diff should contain a Delete for "world" and an Insert for "universe"
    use crate::word_diff::DiffTag;
    let has_delete = spans.iter().any(|s| s.tag == DiffTag::Delete);
    let has_insert = spans.iter().any(|s| s.tag == DiffTag::Insert);
    assert!(
        has_delete,
        "diff should have a Delete span for the old word"
    );
    assert!(
        has_insert,
        "diff should have an Insert span for the new word"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_compute_edit_diff_inner_same_text_produces_equal_spans() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block — this is the first (and only) op for this block
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "initial text".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Edit the block once — the prior text comes from create_block
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "initial text".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Grab the edit_block op
    let op_row = sqlx::query!(
        "SELECT device_id, seq FROM op_log \
         WHERE op_type = 'edit_block' \
         ORDER BY seq DESC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let diff = compute_edit_diff_inner(&pool, op_row.device_id, op_row.seq)
        .await
        .unwrap();

    let spans = diff.expect("diff should be Some for an edit_block op");
    // Editing with the same text should yield all-Equal spans (no changes)
    use crate::word_diff::DiffTag;
    assert!(
        spans.iter().all(|s| s.tag == DiffTag::Equal),
        "diff should contain only Equal spans when text is unchanged, got: {spans:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_compute_edit_diff_inner_invalid_op_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    // Call with a device_id/seq that doesn't exist in the op_log
    let result = compute_edit_diff_inner(&pool, "nonexistent-device".into(), 999999).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "should return NotFound for a nonexistent op, got: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_undo_page_op_inner_rejects_undo_depth_exceeding_max() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = undo_page_op_inner(&pool, DEV, &mat, "some-page".into(), 1001).await;

    assert!(
        matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("undo_depth exceeds maximum of 1000")),
        "should return Validation error for undo_depth > 1000, got: {result:?}"
    );
}

// ======================================================================
// compute_block_vs_current_diff_inner (PEND-17 Part B)
// ======================================================================
//
// The "block-vs-current" diff feeds the in-panel restore preview: given
// `historical_seq` (the op the user is hovering on) and the live
// `blocks.content`, it returns the word-level changes a restore would
// undo. Direction is `historical → current`, so `Insert` spans = "would
// be removed if you restore" and `Delete` spans = "would be brought back".

/// Modified block: live content differs from the historical version
/// produced by `historical_seq`. We must see at least one Delete + one
/// Insert span (the change between the two snapshots) and the
/// reconstructed live content (Equal + Insert spans) must equal the
/// current `blocks.content`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_block_vs_current_diff_returns_spans_for_modified_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // create + edit + edit — three ops, three snapshots.
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello world".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone(),
        "hello universe".into(),
    )
    .await
    .unwrap();
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        created.id.clone(),
        "goodbye universe".into(),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Pick the FIRST edit's seq as `historical_seq` so the diff is
    // "hello universe" → "goodbye universe" (current).
    let first_edit = sqlx::query!(
        "SELECT created_at, seq FROM op_log WHERE op_type = 'edit_block' ORDER BY seq ASC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let spans = compute_block_vs_current_diff_inner(
        &pool,
        created.id,
        first_edit.created_at,
        first_edit.seq,
    )
    .await
    .unwrap();

    use crate::word_diff::DiffTag;
    assert!(
        spans.iter().any(|s| s.tag == DiffTag::Delete),
        "modified block must have a Delete span (text removed since historical), got: {spans:?}"
    );
    assert!(
        spans.iter().any(|s| s.tag == DiffTag::Insert),
        "modified block must have an Insert span (text added since historical), got: {spans:?}"
    );

    // Reconstruct the `current` side (Equal + Insert spans) and confirm
    // it matches the live `blocks.content` — guards against the diff
    // direction silently flipping.
    let reconstructed: String = spans
        .iter()
        .filter(|s| s.tag != DiffTag::Delete)
        .map(|s| s.value.as_str())
        .collect();
    assert_eq!(reconstructed, "goodbye universe");
}

/// Unmodified block: the live content is byte-identical to the
/// historical version. The word-diff helper documents that identical
/// inputs collapse to all-Equal spans (or empty when both are ""), so
/// the response must contain zero Insert/Delete spans — what the UI
/// reads as "no changes since this version".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_block_vs_current_diff_returns_no_spans_for_unmodified_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "stable text".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    // No further edits — current matches the create_block payload.
    mat.flush_background().await.unwrap();

    let create_op = sqlx::query!(
        "SELECT created_at, seq FROM op_log WHERE op_type = 'create_block' ORDER BY seq DESC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let spans =
        compute_block_vs_current_diff_inner(&pool, created.id, create_op.created_at, create_op.seq)
            .await
            .unwrap();

    use crate::word_diff::DiffTag;
    assert!(
        spans.iter().all(|s| s.tag == DiffTag::Equal),
        "unmodified block must produce only Equal spans, got: {spans:?}"
    );
}

/// Block deleted (soft-deleted) since `historical_seq`: the live row is
/// excluded by the `deleted_at IS NULL` filter. We surface this as a
/// `NotFound` error rather than fabricating an "all-removed" diff —
/// the UI's preview is meaningless for trashed blocks (the restore
/// flow there is "restore from trash", not "restore to historical
/// version") and the existing single-step `compute_edit_diff` remains
/// available as a fallback. This pins that contract.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_block_vs_current_diff_returns_not_found_for_soft_deleted_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "to be trashed".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    delete_block_inner(&pool, DEV, &mat, created.id.as_str().into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let create_op = sqlx::query!(
        "SELECT created_at, seq FROM op_log WHERE op_type = 'create_block' ORDER BY seq DESC LIMIT 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let result =
        compute_block_vs_current_diff_inner(&pool, created.id, create_op.created_at, create_op.seq)
            .await;

    assert!(
        matches!(result, Err(AppError::NotFound(ref msg)) if msg.contains("soft-deleted")),
        "soft-deleted block must yield NotFound with a 'soft-deleted' diagnostic, got: {result:?}"
    );
}

/// MAINT-218: When two devices have `edit_block` ops at the same `seq`
/// value for the same block, `compute_block_vs_current_diff_inner` must
/// pick the latest-`created_at` op (cross-device tie-break) rather than
/// leaving the `LIMIT 1` winner undefined.
///
/// Without the fix (`ORDER BY seq DESC` alone), SQLite tie-breaks ties
/// by insertion-order / rowid, so the *older* op (dev1, inserted first)
/// wins — which doesn't match the user's mental model of "most recent
/// change".  With the fix (`ORDER BY created_at DESC, seq DESC`), the
/// newer op (dev2) always wins regardless of insertion order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_block_vs_current_diff_picks_latest_created_at_on_seq_tie() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "current text".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Synthetic op_log rows: two `edit_block` ops on the same block, same
    // `seq` value (the op_log PK is `(device_id, seq)`, so duplicates
    // across devices are valid), with deliberately divergent
    // `created_at` to force the tie-break path.
    //
    // dev1 inserted first (smaller rowid, *earlier* wall-clock time);
    // dev2 inserted second (larger rowid, *later* wall-clock time).
    // The query target is `seq <= 5` which matches both.
    let block_id_upper = created.id.as_str().to_string();
    sqlx::query(
        "INSERT INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
    )
    .bind("dev1")
    .bind(5_i64)
    .bind("hash-dev1")
    .bind("edit_block")
    .bind(format!(
        r#"{{"block_id":"{block_id_upper}","to_text":"from dev1 (older)"}}"#
    ))
    .bind(4_102_444_800_100_i64)
    .bind(&block_id_upper)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
    )
    .bind("dev2")
    .bind(5_i64)
    .bind("hash-dev2")
    .bind("edit_block")
    .bind(format!(
        r#"{{"block_id":"{block_id_upper}","to_text":"from dev2 (newer)"}}"#
    ))
    .bind(4_102_444_800_500_i64)
    .bind(&block_id_upper)
    .execute(&pool)
    .await
    .unwrap();

    // Reconstruct the historical-side text from the diff spans (Delete +
    // Equal). With the fix, this must be dev2's text — proving the
    // ORDER BY `created_at DESC, seq DESC` tie-break picked the newer
    // op even though dev1 was inserted first.
    //
    // #382: the selected point is dev2's `(created_at, seq) =
    // (4_102_444_800_500, 5)`. dev1's op (smaller created_at) clears the
    // `created_at < ?c` arm; dev2's op clears `created_at = ?c AND
    // seq <= ?s`. Both are in range, and the canonical ORDER BY tie-break
    // picks dev2.
    let spans =
        compute_block_vs_current_diff_inner(&pool, block_id_upper.into(), 4_102_444_800_500, 5)
            .await
            .unwrap();
    use crate::word_diff::DiffTag;
    let historical: String = spans
        .iter()
        .filter(|s| s.tag != DiffTag::Insert)
        .map(|s| s.value.as_str())
        .collect();
    assert_eq!(
        historical, "from dev2 (newer)",
        "tie-break on seq must pick the later-created_at op (dev2's text), \
         not the earlier-inserted op (dev1's text). spans: {spans:?}"
    );
}

/// #382 (sub-fix A): the historical lookup must bound on the canonical
/// `(created_at, seq)` keyset, not bare per-device `seq`. `seq` is a
/// PER-DEVICE counter, so a cross-device op with a numerically SMALLER
/// seq but a LATER `created_at` must NOT leak past the selected point.
///
/// Seed: the SELECTED point is dev1's op `(created_at=1000, seq=10)`.
/// dev2 has an op `(created_at=2000, seq=3)` — smaller seq, later
/// wall-clock. Under the OLD `seq <= ?` bound, dev2's seq=3 passed the
/// filter and, sorted by `created_at DESC`, won the LIMIT 1 — returning
/// content NEWER than the point the user selected. Under the canonical
/// `(created_at < ?c OR (created_at = ?c AND seq <= ?s))` bound, dev2's
/// later `created_at` is excluded, so dev1's selected text wins.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_block_vs_current_diff_bounds_by_created_at_not_bare_seq() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "current text".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let block_id_upper = created.id.as_str().to_string();

    // dev1: the SELECTED historical point — seq=10, created_at=1000.
    sqlx::query(
        "INSERT INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
    )
    .bind("dev1")
    .bind(10_i64)
    .bind("hash-dev1-sel")
    .bind("edit_block")
    .bind(format!(
        r#"{{"block_id":"{block_id_upper}","to_text":"SELECTED dev1"}}"#
    ))
    .bind(4_102_444_800_000_i64)
    .bind(&block_id_upper)
    .execute(&pool)
    .await
    .unwrap();

    // dev2: smaller seq=3 but LATER created_at=2000. A bare-`seq <= 10`
    // bound would wrongly include this and, under `created_at DESC`,
    // surface it as the winner.
    sqlx::query(
        "INSERT INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
    )
    .bind("dev2")
    .bind(3_i64)
    .bind("hash-dev2-future")
    .bind("edit_block")
    .bind(format!(
        r#"{{"block_id":"{block_id_upper}","to_text":"FUTURE dev2 (must not win)"}}"#
    ))
    .bind(4_102_444_800_900_i64)
    .bind(&block_id_upper)
    .execute(&pool)
    .await
    .unwrap();

    // Selected point = dev1's (created_at=…000, seq=10).
    let spans =
        compute_block_vs_current_diff_inner(&pool, block_id_upper.into(), 4_102_444_800_000, 10)
            .await
            .unwrap();

    use crate::word_diff::DiffTag;
    let historical: String = spans
        .iter()
        .filter(|s| s.tag != DiffTag::Insert)
        .map(|s| s.value.as_str())
        .collect();
    assert_eq!(
        historical, "SELECTED dev1",
        "bound must be the canonical (created_at, seq) keyset: dev2's smaller-seq \
         but later-created_at op must NOT leak past the selected point. spans: {spans:?}"
    );
}

// ======================================================================
// find_undo_group_inner (PEND-35 Tier 4.4)
// ======================================================================
//
// `find_undo_group_inner` collapses the FE's growing-window
// `list_page_history` re-fetch (executed after every Ctrl+Z) into a
// single recursive-CTE query that returns the count of consecutive
// same-device, within-window ops starting at the Nth-most-recent
// undoable op for a page. The tests below cover the four boundary
// conditions the FE previously implemented in JS:
//   1. isolated op (no neighbors within window) → 1
//   2. consecutive same-device ops within window → N
//   3. device-id boundary stops the group at the head segment
//   4. window-gap stops the group before the over-window op
//   5. depth > 0 — group is computed starting at the (depth+1)-th op

/// Helper: seed a page block plus a child block, then append `n`
/// `EditBlock` ops on the child with the supplied `(device_id,
/// timestamp_ms)` pairs (relative to a fixed base). Returns the page id
/// so the caller can pass it to `find_undo_group_inner`. Each op is
/// appended via `op_log::append_local_op_at` so the indexed
/// `op_log.block_id` column is populated automatically (matching the
/// real ingestion path).
async fn seed_page_with_ops(
    pool: &SqlitePool,
    mat: &Materializer,
    ops: &[(&str, i64)], // (device_id, offset_ms_from_base)
) -> (String, String) {
    let page = create_block_inner(
        pool,
        DEV,
        mat,
        "page".into(),
        "Test Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let child = create_block_inner(
        pool,
        DEV,
        mat,
        "content".into(),
        "child".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Base timestamp far in the future so the test ops sort after the
    // synthetic create_block ops above (whose `created_at = now_rfc3339`).
    let base_secs: i64 = 4_102_444_800; // 2100-01-01T00:00:00Z

    for (i, (device_id, offset_ms)) in ops.iter().enumerate() {
        // Build a unique "edited" content per op so each op is a
        // distinct row (op_log PK is `(device_id, seq)` so duplicates
        // on the same device would collide anyway, but this also keeps
        // the test readable).
        let payload = OpPayload::EditBlock(crate::op::EditBlockPayload {
            block_id: child.id.clone(),
            to_text: format!("edit-{i}"),
            prev_edit: None,
        });
        // #109 Phase 2: op_log.created_at is INTEGER epoch-ms; pass the
        // millisecond value directly (numeric ordering replaces the old
        // lex-monotonic RFC3339 invariant L-98).
        let total_ms = base_secs * 1000 + offset_ms;
        op_log::append_local_op_at(pool, device_id, payload, total_ms)
            .await
            .unwrap();
    }

    (page.id.into_string(), child.id.into_string())
}

/// Single op, no neighbors → group of 1.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_undo_group_returns_one_for_isolated_op() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, _child_id) = seed_page_with_ops(&pool, &mat, &[("dev1", 0)]).await;

    let group = find_undo_group_inner(&pool, &page_id, 0, 500)
        .await
        .unwrap();
    // Note: the create_block ops for page+child also count toward the
    // page's undoable history (and they're authored by DEV, not dev1).
    // The most-recent op is dev1's edit, so the seed is dev1; the next
    // older op is DEV's create_child, which breaks the device match.
    assert_eq!(group, 1, "isolated op should yield a group of 1");
}

/// Five consecutive same-device ops within window → group of 5.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_undo_group_groups_consecutive_same_device() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // 5 ops at 0, 100, 200, 300, 400 ms — all by dev1, all within 500 ms.
    let (page_id, _child_id) = seed_page_with_ops(
        &pool,
        &mat,
        &[
            ("dev1", 0),
            ("dev1", 100),
            ("dev1", 200),
            ("dev1", 300),
            ("dev1", 400),
        ],
    )
    .await;

    let group = find_undo_group_inner(&pool, &page_id, 0, 500)
        .await
        .unwrap();
    assert_eq!(group, 5, "5 consecutive same-device ops → group of 5");
}

/// Same-device ops separated by a foreign-device op → only the head
/// segment counts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_undo_group_stops_at_device_boundary() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Newest first: dev1@400, dev1@300, dev2@200, dev1@100, dev1@0.
    // Group at depth=0 = dev1@400, dev1@300 (then dev2 breaks).
    let (page_id, _child_id) = seed_page_with_ops(
        &pool,
        &mat,
        &[
            ("dev1", 0),
            ("dev1", 100),
            ("dev2", 200),
            ("dev1", 300),
            ("dev1", 400),
        ],
    )
    .await;

    let group = find_undo_group_inner(&pool, &page_id, 0, 500)
        .await
        .unwrap();
    assert_eq!(
        group, 2,
        "device boundary should end the group at the head segment"
    );
}

/// One op falls outside the window → group ends before that op.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_undo_group_stops_at_window_gap() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Newest first: dev1@1000, dev1@900, dev1@100, dev1@0.
    // Walk: 1000 → 900 (Δ=100, in-window) → 100 (Δ=800, OUT of 500ms
    // window) → STOP. Group = 2.
    let (page_id, _child_id) = seed_page_with_ops(
        &pool,
        &mat,
        &[("dev1", 0), ("dev1", 100), ("dev1", 900), ("dev1", 1000)],
    )
    .await;

    let group = find_undo_group_inner(&pool, &page_id, 0, 500)
        .await
        .unwrap();
    assert_eq!(
        group, 2,
        "window gap should stop the group before the over-window op"
    );
}

/// `depth = 2` — group is computed starting at the 3rd-most-recent op.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_undo_group_at_nonzero_depth() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Newest first (offsets in ms):
    //   rn=1: dev2@500   ← depth=0 seed (excluded for depth=2)
    //   rn=2: dev2@400   ← depth=1 seed (excluded for depth=2)
    //   rn=3: dev1@300   ← depth=2 seed
    //   rn=4: dev1@200   ← Δ=100, in-window, same device → include
    //   rn=5: dev1@100   ← Δ=100, in-window, same device → include
    //   rn=6: dev1@0     ← Δ=100, in-window, same device → include
    //   rn=7: DEV   (synthetic create_child) ← device differs → STOP
    // Expected group at depth=2 = 4.
    let (page_id, _child_id) = seed_page_with_ops(
        &pool,
        &mat,
        &[
            ("dev1", 0),
            ("dev1", 100),
            ("dev1", 200),
            ("dev1", 300),
            ("dev2", 400),
            ("dev2", 500),
        ],
    )
    .await;

    let group = find_undo_group_inner(&pool, &page_id, 2, 500)
        .await
        .unwrap();
    assert_eq!(
        group, 4,
        "depth=2 should seed at the 3rd-most-recent op and walk forward (older)"
    );
}

/// Negative `depth` is rejected with a `Validation` error.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_undo_group_rejects_negative_depth() {
    let (pool, _dir) = test_pool().await;
    let result = find_undo_group_inner(&pool, "any-page", -1, 500).await;
    assert!(
        matches!(result, Err(AppError::Validation(ref m)) if m.contains("depth")),
        "expected Validation error for negative depth, got: {result:?}"
    );
}

/// Negative `window_ms` is rejected with a `Validation` error.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_undo_group_rejects_negative_window_ms() {
    let (pool, _dir) = test_pool().await;
    let result = find_undo_group_inner(&pool, "any-page", 0, -1).await;
    assert!(
        matches!(result, Err(AppError::Validation(ref m)) if m.contains("window_ms")),
        "expected Validation error for negative window_ms, got: {result:?}"
    );
}

/// Returns 0 when the seed depth exceeds the page's undoable-op count
/// (no row at rn = depth+1). FE uses this signal to fall back to a
/// single undo.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_undo_group_returns_zero_when_seed_missing() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (page_id, _child_id) = seed_page_with_ops(&pool, &mat, &[("dev1", 0)]).await;

    let group = find_undo_group_inner(&pool, &page_id, 999, 500)
        .await
        .unwrap();
    assert_eq!(group, 0, "depth beyond the page's op count should return 0");
}

/// `op_type LIKE 'undo_%'` / `'redo_%'` rows are NOT counted as
/// undoable — they're reverse ops as recognised by the FE filter. The
/// real backend `undo_page_op_inner` / `redo_page_op_inner` paths
/// store the reverse using its bare `op_type` (e.g. `edit_block`), so
/// production data does not actually contain `undo_*`-prefixed op
/// types. This test inserts a synthetic `undo_edit_block` row directly
/// so the SQL filter is exercised end-to-end — and adds a regression
/// guard against a future change that DOES start writing prefixed
/// op_types (e.g. for richer history-panel UX).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_undo_group_skips_undo_and_redo_ops() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Two consecutive same-device user edits forming a group of 2.
    let (page_id, child_id) = seed_page_with_ops(&pool, &mat, &[("dev1", 0), ("dev1", 100)]).await;

    // Now insert a synthetic `undo_edit_block` row authored by `dev2`
    // newer than both user edits. Without the SQL filter, depth=0 would
    // seed at THIS row (op_type=undo_edit_block, device=dev2) and the
    // group would collapse to 1 (the next op is dev1 → device break).
    // With the filter, the synthetic row is excluded; depth=0 seeds at
    // the dev1@100 user edit and the group is 2.
    sqlx::query(
        "INSERT INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
    )
    .bind("dev2")
    .bind(1_i64)
    .bind("synthetic-hash")
    .bind("undo_edit_block")
    .bind(format!(r#"{{"block_id":"{child_id}","to_text":"x"}}"#))
    .bind(4_102_444_800_500_i64) // newer than both user edits
    .bind(&child_id)
    .execute(&pool)
    .await
    .unwrap();

    let group = find_undo_group_inner(&pool, &page_id, 0, 500)
        .await
        .unwrap();
    assert_eq!(
        group, 2,
        "undo_*-prefixed rows must be filtered out — group should be \
         the 2 user edits, not collapsed by the synthetic undo row"
    );
}
