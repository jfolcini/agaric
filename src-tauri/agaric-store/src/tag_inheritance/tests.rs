use super::*;
use crate::test_support::test_pool;
use sqlx::SqlitePool;

// -- Helpers --

async fn insert_block(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    content: &str,
    parent_id: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, ?, ?, ?, 1)",
    )
    .bind(id)
    .bind(block_type)
    .bind(content)
    .bind(parent_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_tag_assoc(pool: &SqlitePool, block_id: &str, tag_id: &str) {
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .unwrap();
}

async fn get_inherited(pool: &SqlitePool) -> Vec<(String, String, String)> {
    sqlx::query_as::<_, (String, String, String)>(
        "SELECT block_id, tag_id, inherited_from \
         FROM block_tag_inherited ORDER BY block_id, tag_id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn soft_delete(pool: &SqlitePool, id: &str) {
    sqlx::query("UPDATE blocks SET deleted_at = 1735689600000 WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

// ======================================================================
// Apply_op_tag_inheritance — consolidated dispatcher
// ======================================================================

#[tokio::test]
async fn apply_op_tag_inheritance_dispatches_add_tag() {
    use crate::op::{AddTagPayload, OpPayload};
    use agaric_core::ulid::BlockId;
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG_APP", "tag", "tag", None).await;
    insert_block(&pool, "PAGE_APP", "page", "page", None).await;
    insert_block(&pool, "C_APP", "content", "child", Some("PAGE_APP")).await;
    insert_tag_assoc(&pool, "PAGE_APP", "TAG_APP").await;

    let payload = OpPayload::AddTag(AddTagPayload {
        block_id: BlockId::from_trusted("PAGE_APP"),
        tag_id: BlockId::from_trusted("TAG_APP"),
    });

    let mut conn = pool.acquire().await.unwrap();
    apply_op_tag_inheritance(&mut conn, &payload).await.unwrap();
    drop(conn);

    let rows = get_inherited(&pool).await;
    assert_eq!(
        rows.len(),
        1,
        "AddTag dispatch must produce exactly one inherited row"
    );
    assert!(
        rows.contains(&("C_APP".into(), "TAG_APP".into(), "PAGE_APP".into())),
        "AddTag dispatch must propagate to descendants: expected (C_APP, TAG_APP, PAGE_APP), got {rows:?}"
    );
}

#[tokio::test]
async fn apply_op_tag_inheritance_dispatches_create_block() {
    use crate::op::{CreateBlockPayload, OpPayload};
    use agaric_core::ulid::BlockId;
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG_CB", "tag", "tag", None).await;
    insert_block(&pool, "PAR_CB", "page", "parent", None).await;
    insert_tag_assoc(&pool, "PAR_CB", "TAG_CB").await;

    // Simulate the materializer having inserted a row for the new block
    // already (materializer order: INSERT blocks row → inherit_parent_tags).
    insert_block(&pool, "CHILD_CB", "content", "child", Some("PAR_CB")).await;

    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted("CHILD_CB"),
        block_type: "content".into(),
        parent_id: Some(BlockId::from_trusted("PAR_CB")),
        position: Some(1),
        index: None,
        content: "hi".into(),
    });
    let mut conn = pool.acquire().await.unwrap();
    apply_op_tag_inheritance(&mut conn, &payload).await.unwrap();
    drop(conn);

    let rows = get_inherited(&pool).await;
    assert_eq!(
        rows.len(),
        1,
        "CreateBlock dispatch must produce exactly one inherited row"
    );
    assert!(
        rows.contains(&("CHILD_CB".into(), "TAG_CB".into(), "PAR_CB".into())),
        "CreateBlock dispatch must inherit parent tags: expected (CHILD_CB, TAG_CB, PAR_CB), got {rows:?}"
    );
}

#[tokio::test]
async fn apply_op_tag_inheritance_noop_for_edit_and_set_property() {
    use crate::op::{EditBlockPayload, OpPayload, SetPropertyPayload};
    use agaric_core::ulid::BlockId;
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "B_NOOP", "content", "hi", None).await;

    let edit = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::from_trusted("B_NOOP"),
        to_text: "bye".into(),
        prev_edit: None,
    });
    let sp = OpPayload::SetProperty(SetPropertyPayload {
        block_id: BlockId::from_trusted("B_NOOP"),
        key: "x".into(),
        value_text: Some("y".into()),
        value_num: None,
        value_date: None,
        value_ref: None,
        value_bool: None,
    });

    let mut conn = pool.acquire().await.unwrap();
    apply_op_tag_inheritance(&mut conn, &edit).await.unwrap();
    apply_op_tag_inheritance(&mut conn, &sp).await.unwrap();
    drop(conn);

    // No inheritance changes should occur.
    let rows = get_inherited(&pool).await;
    assert!(
        rows.is_empty(),
        "EditBlock / SetProperty dispatch must be no-op for inheritance"
    );
}

// ======================================================================
// propagate_tag_to_descendants
// ======================================================================

#[tokio::test]
async fn propagate_basic() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "PAGE_A", "page", "page a", None).await;
    insert_block(&pool, "CHILD1", "content", "child 1", Some("PAGE_A")).await;
    insert_block(&pool, "CHILD2", "content", "child 2", Some("PAGE_A")).await;

    insert_tag_assoc(&pool, "PAGE_A", "TAG").await;

    let mut conn = pool.acquire().await.unwrap();
    propagate_tag_to_descendants(&mut conn, "PAGE_A", "TAG")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;
    assert_eq!(rows.len(), 2);
    assert!(rows.contains(&("CHILD1".into(), "TAG".into(), "PAGE_A".into())));
    assert!(rows.contains(&("CHILD2".into(), "TAG".into(), "PAGE_A".into())));
}

#[tokio::test]
async fn propagate_multi_level() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "PAGE", "page", "page", None).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;
    insert_block(&pool, "GRANDCHILD", "content", "grandchild", Some("CHILD")).await;

    insert_tag_assoc(&pool, "PAGE", "TAG").await;

    let mut conn = pool.acquire().await.unwrap();
    propagate_tag_to_descendants(&mut conn, "PAGE", "TAG")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;
    assert_eq!(rows.len(), 2);
    assert!(rows.contains(&("CHILD".into(), "TAG".into(), "PAGE".into())));
    assert!(rows.contains(&("GRANDCHILD".into(), "TAG".into(), "PAGE".into())));
}

#[tokio::test]
async fn propagate_skips_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "PAGE", "page", "page", None).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;
    insert_block(&pool, "GRANDCHILD", "content", "grandchild", Some("CHILD")).await;

    soft_delete(&pool, "CHILD").await;
    insert_tag_assoc(&pool, "PAGE", "TAG").await;

    let mut conn = pool.acquire().await.unwrap();
    propagate_tag_to_descendants(&mut conn, "PAGE", "TAG")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;
    assert!(
        rows.is_empty(),
        "Deleted subtree should not get inherited entries, got: {rows:?}"
    );
}

#[tokio::test]
async fn propagate_idempotent() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "PAGE", "page", "page", None).await;
    insert_block(&pool, "CHILD1", "content", "child 1", Some("PAGE")).await;
    insert_block(&pool, "CHILD2", "content", "child 2", Some("PAGE")).await;

    insert_tag_assoc(&pool, "PAGE", "TAG").await;

    let mut conn = pool.acquire().await.unwrap();
    propagate_tag_to_descendants(&mut conn, "PAGE", "TAG")
        .await
        .unwrap();
    // Second call — INSERT OR IGNORE should be a no-op.
    propagate_tag_to_descendants(&mut conn, "PAGE", "TAG")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;
    assert_eq!(
        rows.len(),
        2,
        "Idempotent call should not create duplicates"
    );
}

// ======================================================================
// remove_inherited_tag
// ======================================================================

#[tokio::test]
async fn remove_inherited_basic() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "PAGE", "page", "page", None).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;

    insert_tag_assoc(&pool, "PAGE", "TAG").await;

    let mut conn = pool.acquire().await.unwrap();
    propagate_tag_to_descendants(&mut conn, "PAGE", "TAG")
        .await
        .unwrap();
    assert_eq!(get_inherited(&pool).await.len(), 1);

    // Simulate removing the tag from PAGE.
    sqlx::query("DELETE FROM block_tags WHERE block_id = 'PAGE' AND tag_id = 'TAG'")
        .execute(&pool)
        .await
        .unwrap();
    remove_inherited_tag(&mut conn, "PAGE", "TAG")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;
    assert!(
        rows.is_empty(),
        "All inherited entries should be removed when no ancestor has the tag"
    );
}

#[tokio::test]
async fn remove_inherited_reattributes_to_grandparent() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "GRAND", "page", "grand", None).await;
    insert_block(&pool, "PARENT", "content", "parent", Some("GRAND")).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PARENT")).await;

    // Both GRAND and PARENT have TAG directly.
    insert_tag_assoc(&pool, "GRAND", "TAG").await;
    insert_tag_assoc(&pool, "PARENT", "TAG").await;

    let mut conn = pool.acquire().await.unwrap();

    // Propagate PARENT first so CHILD gets inherited_from = PARENT.
    propagate_tag_to_descendants(&mut conn, "PARENT", "TAG")
        .await
        .unwrap();
    // Propagate GRAND — PARENT gets (PARENT, TAG, GRAND);
    // CHILD already has (CHILD, TAG) so INSERT OR IGNORE keeps PARENT.
    propagate_tag_to_descendants(&mut conn, "GRAND", "TAG")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;
    assert_eq!(rows.len(), 2);
    assert!(rows.contains(&("PARENT".into(), "TAG".into(), "GRAND".into())));
    assert!(rows.contains(&("CHILD".into(), "TAG".into(), "PARENT".into())));

    // Remove TAG from PARENT — CHILD should re-attribute to GRAND.
    sqlx::query("DELETE FROM block_tags WHERE block_id = 'PARENT' AND tag_id = 'TAG'")
        .execute(&pool)
        .await
        .unwrap();
    remove_inherited_tag(&mut conn, "PARENT", "TAG")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;
    assert_eq!(rows.len(), 2);
    assert!(rows.contains(&("PARENT".into(), "TAG".into(), "GRAND".into())));
    assert!(rows.contains(&("CHILD".into(), "TAG".into(), "GRAND".into())));
}

/// #675 GAP: a direct tagger lives INSIDE the removed subtree.
///
/// Tree: P → C → GC, and P → SIBLING.
/// P holds TAG directly and inherits it to {C, GC, SIBLING}.
/// C ALSO holds TAG directly (so GC could inherit from either P or C; with the
/// `(block_id, tag_id)` PK and P-then-C propagation order, GC's row points at
/// P). When TAG is removed from P:
///   * SIBLING (only inheriting from P) must LOSE the tag, and
///   * C and GC must KEEP it, re-attributed to the in-subtree tagger C.
///     (C keeps its DIRECT tag in block_tags; GC re-inherits inherited_from = C.)
///
/// Before the fix, step 1 wiped all `inherited_from = P` rows and step 2 only
/// re-attributed from ancestors ABOVE P, so GC silently lost the tag.
#[tokio::test]
async fn remove_inherited_reattributes_to_intra_subtree_tagger() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "P", "page", "p", None).await;
    insert_block(&pool, "C", "content", "c", Some("P")).await;
    insert_block(&pool, "GC", "content", "gc", Some("C")).await;
    insert_block(&pool, "SIBLING", "content", "sibling", Some("P")).await;

    // P and C both hold TAG directly.
    insert_tag_assoc(&pool, "P", "TAG").await;
    insert_tag_assoc(&pool, "C", "TAG").await;

    let mut conn = pool.acquire().await.unwrap();

    // Propagate C first, then P. C gives GC (GC, TAG, C). P then propagates to
    // {C, GC, SIBLING}; GC already has a row so INSERT OR IGNORE keeps C, but
    // C and SIBLING get inherited_from = P. Force the worst case (GC -> P) by
    // propagating P first instead, mirroring real add-order ambiguity.
    propagate_tag_to_descendants(&mut conn, "P", "TAG")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;
    assert_eq!(rows.len(), 3, "expected C, GC, SIBLING to inherit from P");
    assert!(rows.contains(&("C".into(), "TAG".into(), "P".into())));
    assert!(rows.contains(&("GC".into(), "TAG".into(), "P".into())));
    assert!(rows.contains(&("SIBLING".into(), "TAG".into(), "P".into())));

    // Remove TAG from P.
    sqlx::query("DELETE FROM block_tags WHERE block_id = 'P' AND tag_id = 'TAG'")
        .execute(&pool)
        .await
        .unwrap();
    remove_inherited_tag(&mut conn, "P", "TAG").await.unwrap();

    let rows = get_inherited(&pool).await;
    // SIBLING and C lose their inherited-from-P rows (C still has its DIRECT
    // tag in block_tags, which is NOT stored in block_tag_inherited). GC must be
    // re-attributed to the in-subtree direct tagger C.
    assert_eq!(
        rows.len(),
        1,
        "only GC should remain in block_tag_inherited, got: {rows:?}"
    );
    assert!(
        rows.contains(&("GC".into(), "TAG".into(), "C".into())),
        "GC must re-inherit from the intra-subtree tagger C, got: {rows:?}"
    );

    // C still holds the tag directly.
    let direct: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = 'C' AND tag_id = 'TAG'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(direct, 1, "C must keep its direct tag");
}

// ======================================================================
// recompute_subtree_inheritance
// ======================================================================

#[tokio::test]
async fn recompute_subtree_after_move() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "PAGE1", "page", "page 1", None).await;
    insert_block(&pool, "PAGE2", "page", "page 2", None).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PAGE1")).await;

    insert_tag_assoc(&pool, "PAGE1", "TAG").await;

    let mut conn = pool.acquire().await.unwrap();
    propagate_tag_to_descendants(&mut conn, "PAGE1", "TAG")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;
    assert_eq!(rows, vec![("CHILD".into(), "TAG".into(), "PAGE1".into())]);

    // Move CHILD to PAGE2 (which has no tags).
    sqlx::query("UPDATE blocks SET parent_id = 'PAGE2' WHERE id = 'CHILD'")
        .execute(&pool)
        .await
        .unwrap();

    recompute_subtree_inheritance(&mut conn, "CHILD")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;
    assert!(
        rows.is_empty(),
        "CHILD should not inherit after moving to untagged parent, got: {rows:?}"
    );
}

// ======================================================================
// inherit_parent_tags
// ======================================================================

#[tokio::test]
async fn inherit_parent_tags_basic() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "PAGE", "page", "page", None).await;
    insert_tag_assoc(&pool, "PAGE", "TAG").await;

    // Create a new child block.
    insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;

    let mut conn = pool.acquire().await.unwrap();
    inherit_parent_tags(&mut conn, "CHILD", Some("PAGE"))
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;
    assert_eq!(rows, vec![("CHILD".into(), "TAG".into(), "PAGE".into())]);
}

#[tokio::test]
async fn inherit_parent_tags_none_for_root() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLOCK", "page", "block", None).await;

    let mut conn = pool.acquire().await.unwrap();
    inherit_parent_tags(&mut conn, "BLOCK", None).await.unwrap();

    let rows = get_inherited(&pool).await;
    assert!(rows.is_empty(), "Root blocks should not inherit any tags");
}

// ======================================================================
// remove_subtree_inherited
// ======================================================================

#[tokio::test]
async fn remove_subtree_basic() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "PAGE", "page", "page", None).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;
    insert_block(&pool, "GRANDCHILD", "content", "grandchild", Some("CHILD")).await;

    insert_tag_assoc(&pool, "PAGE", "TAG").await;

    let mut conn = pool.acquire().await.unwrap();
    propagate_tag_to_descendants(&mut conn, "PAGE", "TAG")
        .await
        .unwrap();
    assert_eq!(get_inherited(&pool).await.len(), 2);

    // Remove the subtree rooted at CHILD.
    remove_subtree_inherited(&mut conn, "CHILD").await.unwrap();

    let rows = get_inherited(&pool).await;
    assert!(
        rows.is_empty(),
        "All inherited entries for the deleted subtree should be removed"
    );
}

// ======================================================================
// rebuild_all
// ======================================================================

#[tokio::test]
async fn rebuild_all_matches_propagation() {
    let (pool, _dir) = test_pool().await;

    // Tree: ROOT -> PAGE_A -> CHILD_A
    //            -> PAGE_B -> CHILD_B
    insert_block(&pool, "TAG1", "tag", "tag1", None).await;
    insert_block(&pool, "TAG2", "tag", "tag2", None).await;
    insert_block(&pool, "ROOT", "page", "root", None).await;
    insert_block(&pool, "PAGE_A", "page", "page a", Some("ROOT")).await;
    insert_block(&pool, "PAGE_B", "page", "page b", Some("ROOT")).await;
    insert_block(&pool, "CHILD_A", "content", "child a", Some("PAGE_A")).await;
    insert_block(&pool, "CHILD_B", "content", "child b", Some("PAGE_B")).await;

    // ROOT has TAG1, PAGE_B has TAG2.
    insert_tag_assoc(&pool, "ROOT", "TAG1").await;
    insert_tag_assoc(&pool, "PAGE_B", "TAG2").await;

    rebuild_all(&pool).await.unwrap();

    let rows = get_inherited(&pool).await;

    // TAG1 from ROOT propagates to all 4 descendants.
    assert!(rows.contains(&("PAGE_A".into(), "TAG1".into(), "ROOT".into())));
    assert!(rows.contains(&("PAGE_B".into(), "TAG1".into(), "ROOT".into())));
    assert!(rows.contains(&("CHILD_A".into(), "TAG1".into(), "ROOT".into())));
    assert!(rows.contains(&("CHILD_B".into(), "TAG1".into(), "ROOT".into())));

    // TAG2 from PAGE_B propagates only to CHILD_B.
    assert!(rows.contains(&("CHILD_B".into(), "TAG2".into(), "PAGE_B".into())));

    assert_eq!(rows.len(), 5);
}

/// #1546: the full rebuild and the incremental path must produce IDENTICAL
/// `inherited_from` attribution for every block in a multi-tagger chain.
///
/// Scenario: GRAND -> PARENT -> CHILD, where GRAND **and** PARENT both hold
/// TAG directly. `block_tag_inherited` has PK `(block_id, tag_id)`, so CHILD
/// keeps exactly one `inherited_from`. The canonical rule is the **nearest
/// tagging ancestor**: CHILD -> PARENT (depth 1), not GRAND (depth 2). This
/// is the attribution the incremental path converges on (and the remove path
/// deliberately re-establishes — see `remove_inherited_reattributes_to_grandparent`).
///
/// Before the fix the full rebuild inserted straight from the recursive
/// `descendant_tags` walk with `INSERT OR IGNORE`, so the survivor per
/// `(block_id, tag_id)` was recursion-ordering-dependent and could land on
/// GRAND — disagreeing with the incremental path for CHILD until a later
/// remove self-healed it. The fix collapses the rebuild walk to the MIN-depth
/// row per `(block_id, tag_id)` (`tag_inh_rebuild_nearest!`), so both paths
/// now agree deterministically.
#[tokio::test]
async fn rebuild_matches_incremental_for_multi_tagger_chain() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "GRAND", "page", "grand", None).await;
    insert_block(&pool, "PARENT", "content", "parent", Some("GRAND")).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PARENT")).await;

    // Both GRAND and PARENT hold TAG directly.
    insert_tag_assoc(&pool, "GRAND", "TAG").await;
    insert_tag_assoc(&pool, "PARENT", "TAG").await;

    // --- Incremental path: converge on the canonical nearest-ancestor state.
    // Propagating PARENT before GRAND lands CHILD on its nearest tagger PARENT
    // (the same end-state the remove path re-establishes); this is the
    // attribution the rebuild must match.
    {
        let mut conn = pool.acquire().await.unwrap();
        propagate_tag_to_descendants(&mut conn, "PARENT", "TAG")
            .await
            .unwrap();
        propagate_tag_to_descendants(&mut conn, "GRAND", "TAG")
            .await
            .unwrap();
    }
    let incremental_rows = get_inherited(&pool).await;

    // Sanity: the incremental path produced the canonical nearest attribution.
    assert!(
        incremental_rows.contains(&("CHILD".into(), "TAG".into(), "PARENT".into())),
        "precondition: incremental path must attribute CHILD to nearest ancestor PARENT, got: {incremental_rows:?}"
    );

    // --- Full rebuild path: recompute the whole cache from scratch. ---
    rebuild_all(&pool).await.unwrap();
    let rebuild_rows = get_inherited(&pool).await;

    // Parity: the two strategies must agree row-for-row (the #1546 fix).
    assert_eq!(
        incremental_rows, rebuild_rows,
        "full rebuild and incremental propagation must produce identical \
         inherited_from for every block (#1546)\nincremental: {incremental_rows:?}\nrebuild: {rebuild_rows:?}"
    );

    // And the rebuild must use the canonical nearest-ancestor attribution.
    assert!(
        rebuild_rows.contains(&("CHILD".into(), "TAG".into(), "PARENT".into())),
        "CHILD must inherit TAG from the NEAREST tagging ancestor PARENT (not GRAND), got: {rebuild_rows:?}"
    );
    assert!(
        rebuild_rows.contains(&("PARENT".into(), "TAG".into(), "GRAND".into())),
        "PARENT must inherit TAG from GRAND, got: {rebuild_rows:?}"
    );
    assert_eq!(
        rebuild_rows.len(),
        2,
        "only PARENT and CHILD inherit, got: {rebuild_rows:?}"
    );
}

// ======================================================================
// recompute_subtree_inheritance: skips deleted blocks
// ======================================================================

#[tokio::test]
async fn recompute_subtree_skips_deleted() {
    let (pool, _dir) = test_pool().await;

    // grandparent -> parent -> child -> grandchild
    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "GPARENT", "page", "grandparent", None).await;
    insert_block(&pool, "PARENT", "content", "parent", Some("GPARENT")).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PARENT")).await;
    insert_block(&pool, "GCHILD", "content", "grandchild", Some("CHILD")).await;

    insert_tag_assoc(&pool, "GPARENT", "TAG").await;

    // Soft-delete the child — breaks the chain between parent and grandchild
    soft_delete(&pool, "CHILD").await;

    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "PARENT")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;

    // PARENT should inherit TAG from GPARENT
    assert!(
        rows.contains(&("PARENT".into(), "TAG".into(), "GPARENT".into())),
        "PARENT should inherit TAG from GPARENT, got: {rows:?}"
    );
    // GRANDCHILD should NOT inherit (CHILD is deleted, breaking the chain)
    assert!(
        !rows.iter().any(|(bid, _, _)| bid == "GCHILD"),
        "GRANDCHILD should not inherit because CHILD is deleted, got: {rows:?}"
    );
    // CHILD itself should not inherit (it's deleted)
    assert!(
        !rows.iter().any(|(bid, _, _)| bid == "CHILD"),
        "Deleted CHILD should not have inherited entries, got: {rows:?}"
    );
}

// ======================================================================
// recompute_subtree_inheritance: multi-tag propagation
// ======================================================================

#[tokio::test]
async fn recompute_subtree_multi_tag() {
    let (pool, _dir) = test_pool().await;

    // root -> parent -> child
    insert_block(&pool, "TAG1", "tag", "tag1", None).await;
    insert_block(&pool, "TAG2", "tag", "tag2", None).await;
    insert_block(&pool, "TAG3", "tag", "tag3", None).await;
    insert_block(&pool, "ROOT", "page", "root", None).await;
    insert_block(&pool, "PARENT", "content", "parent", Some("ROOT")).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PARENT")).await;

    // Root has TAG1 and TAG2, parent has TAG3
    insert_tag_assoc(&pool, "ROOT", "TAG1").await;
    insert_tag_assoc(&pool, "ROOT", "TAG2").await;
    insert_tag_assoc(&pool, "PARENT", "TAG3").await;

    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "PARENT")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;

    // PARENT inherits TAG1 and TAG2 from ROOT
    assert!(
        rows.contains(&("PARENT".into(), "TAG1".into(), "ROOT".into())),
        "PARENT should inherit TAG1 from ROOT, got: {rows:?}"
    );
    assert!(
        rows.contains(&("PARENT".into(), "TAG2".into(), "ROOT".into())),
        "PARENT should inherit TAG2 from ROOT, got: {rows:?}"
    );
    // PARENT should NOT inherit TAG3 (it has it directly)
    assert!(
        !rows
            .iter()
            .any(|(bid, tid, _)| bid == "PARENT" && tid == "TAG3"),
        "PARENT should not inherit TAG3 (it has it directly), got: {rows:?}"
    );

    // CHILD inherits TAG1, TAG2 from ROOT and TAG3 from PARENT
    assert!(
        rows.contains(&("CHILD".into(), "TAG1".into(), "ROOT".into())),
        "CHILD should inherit TAG1 from ROOT, got: {rows:?}"
    );
    assert!(
        rows.contains(&("CHILD".into(), "TAG2".into(), "ROOT".into())),
        "CHILD should inherit TAG2 from ROOT, got: {rows:?}"
    );
    assert!(
        rows.contains(&("CHILD".into(), "TAG3".into(), "PARENT".into())),
        "CHILD should inherit TAG3 from PARENT, got: {rows:?}"
    );
}

// ======================================================================
// remove_subtree_inherited: cleans inherited_from references
// ======================================================================

#[tokio::test]
async fn remove_subtree_cleans_inherited_from() {
    let (pool, _dir) = test_pool().await;

    // root -> parent -> child1, child2
    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "ROOT", "page", "root", None).await;
    insert_block(&pool, "PARENT", "content", "parent", Some("ROOT")).await;
    insert_block(&pool, "CHILD1", "content", "child1", Some("PARENT")).await;
    insert_block(&pool, "CHILD2", "content", "child2", Some("PARENT")).await;

    insert_tag_assoc(&pool, "ROOT", "TAG").await;

    let mut conn = pool.acquire().await.unwrap();
    propagate_tag_to_descendants(&mut conn, "ROOT", "TAG")
        .await
        .unwrap();

    // Verify propagation worked: PARENT, CHILD1, CHILD2 all inherit from ROOT
    let rows_before = get_inherited(&pool).await;
    assert_eq!(rows_before.len(), 3);
    assert!(rows_before.contains(&("PARENT".into(), "TAG".into(), "ROOT".into())));
    assert!(rows_before.contains(&("CHILD1".into(), "TAG".into(), "ROOT".into())));
    assert!(rows_before.contains(&("CHILD2".into(), "TAG".into(), "ROOT".into())));

    // Remove the subtree rooted at PARENT
    remove_subtree_inherited(&mut conn, "PARENT").await.unwrap();

    let rows_after = get_inherited(&pool).await;

    // All inherited entries for PARENT, CHILD1, CHILD2 should be gone
    assert!(
        !rows_after.iter().any(|(bid, _, _)| bid == "PARENT"),
        "PARENT inherited entries should be removed, got: {rows_after:?}"
    );
    assert!(
        !rows_after.iter().any(|(bid, _, _)| bid == "CHILD1"),
        "CHILD1 inherited entries should be removed, got: {rows_after:?}"
    );
    assert!(
        !rows_after.iter().any(|(bid, _, _)| bid == "CHILD2"),
        "CHILD2 inherited entries should be removed, got: {rows_after:?}"
    );

    // Also verify no entries reference PARENT as inherited_from
    assert!(
        !rows_after.iter().any(|(_, _, from)| from == "PARENT"),
        "No entries should reference PARENT as inherited_from, got: {rows_after:?}"
    );
}

// ======================================================================
// rebuild_all: idempotent
// ======================================================================

#[tokio::test]
async fn rebuild_all_idempotent() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "PAGE", "page", "page", None).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;
    insert_block(&pool, "GRANDCHILD", "content", "grandchild", Some("CHILD")).await;

    insert_tag_assoc(&pool, "PAGE", "TAG").await;

    // First rebuild
    rebuild_all(&pool).await.unwrap();
    let rows_first = get_inherited(&pool).await;

    // Second rebuild
    rebuild_all(&pool).await.unwrap();
    let rows_second = get_inherited(&pool).await;

    assert_eq!(
        rows_first, rows_second,
        "rebuild_all should be idempotent: first={rows_first:?}, second={rows_second:?}"
    );
    // Sanity check: should have 2 inherited entries (CHILD and GRANDCHILD)
    assert_eq!(rows_first.len(), 2);
}

// ======================================================================
// rebuild_all: empty database
// ======================================================================

#[tokio::test]
async fn rebuild_all_empty_db() {
    let (pool, _dir) = test_pool().await;

    // No blocks, no tags — just call rebuild_all and ensure it doesn't crash
    rebuild_all(&pool).await.unwrap();

    let rows = get_inherited(&pool).await;
    assert!(
        rows.is_empty(),
        "Empty database should produce no inherited entries, got: {rows:?}"
    );
}

// ======================================================================
// rebuild_all_split
// ======================================================================

#[tokio::test]
async fn rebuild_all_split_matches_rebuild_all() {
    let (pool, _dir) = test_pool().await;

    // Tree: PAGE -> CHILD -> GRANDCHILD
    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "PAGE", "page", "page", None).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;
    insert_block(&pool, "GRANDCHILD", "content", "grandchild", Some("CHILD")).await;

    insert_tag_assoc(&pool, "PAGE", "TAG").await;

    // Use the same pool for both read and write (single-pool test)
    rebuild_all_split(&pool, &pool).await.unwrap();

    let rows = get_inherited(&pool).await;
    assert_eq!(rows.len(), 2, "CHILD and GRANDCHILD should inherit TAG");
    assert!(rows.contains(&("CHILD".into(), "TAG".into(), "PAGE".into())));
    assert!(rows.contains(&("GRANDCHILD".into(), "TAG".into(), "PAGE".into())));
}

#[tokio::test]
async fn rebuild_all_split_idempotent() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "PAGE", "page", "page", None).await;
    insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;

    insert_tag_assoc(&pool, "PAGE", "TAG").await;

    // First rebuild
    rebuild_all_split(&pool, &pool).await.unwrap();
    let rows_first = get_inherited(&pool).await;

    // Second rebuild
    rebuild_all_split(&pool, &pool).await.unwrap();
    let rows_second = get_inherited(&pool).await;

    assert_eq!(
        rows_first, rows_second,
        "rebuild_all_split should be idempotent: first={rows_first:?}, second={rows_second:?}"
    );
    assert_eq!(rows_first.len(), 1);
}

#[tokio::test]
async fn rebuild_all_split_multi_tag() {
    let (pool, _dir) = test_pool().await;

    // Tree: ROOT -> PAGE_A -> CHILD_A
    //            -> PAGE_B -> CHILD_B
    insert_block(&pool, "TAG1", "tag", "tag1", None).await;
    insert_block(&pool, "TAG2", "tag", "tag2", None).await;
    insert_block(&pool, "ROOT", "page", "root", None).await;
    insert_block(&pool, "PAGE_A", "page", "page a", Some("ROOT")).await;
    insert_block(&pool, "PAGE_B", "page", "page b", Some("ROOT")).await;
    insert_block(&pool, "CHILD_A", "content", "child a", Some("PAGE_A")).await;
    insert_block(&pool, "CHILD_B", "content", "child b", Some("PAGE_B")).await;

    insert_tag_assoc(&pool, "ROOT", "TAG1").await;
    insert_tag_assoc(&pool, "PAGE_B", "TAG2").await;

    rebuild_all_split(&pool, &pool).await.unwrap();

    let rows = get_inherited(&pool).await;

    // TAG1 from ROOT propagates to all 4 descendants.
    assert!(rows.contains(&("PAGE_A".into(), "TAG1".into(), "ROOT".into())));
    assert!(rows.contains(&("PAGE_B".into(), "TAG1".into(), "ROOT".into())));
    assert!(rows.contains(&("CHILD_A".into(), "TAG1".into(), "ROOT".into())));
    assert!(rows.contains(&("CHILD_B".into(), "TAG1".into(), "ROOT".into())));

    // TAG2 from PAGE_B propagates only to CHILD_B.
    assert!(rows.contains(&("CHILD_B".into(), "TAG2".into(), "PAGE_B".into())));

    assert_eq!(rows.len(), 5);
}

// ======================================================================
// Depth limit doesn't break shallow trees
// ======================================================================

#[tokio::test]
async fn depth_limit_shallow_tree_works() {
    let (pool, _dir) = test_pool().await;

    // Build a chain of depth 5: ROOT -> L1 -> L2 -> L3 -> L4 -> LEAF
    insert_block(&pool, "TAG", "tag", "tag-name", None).await;
    insert_block(&pool, "ROOT", "page", "root", None).await;
    insert_block(&pool, "L1", "content", "level 1", Some("ROOT")).await;
    insert_block(&pool, "L2", "content", "level 2", Some("L1")).await;
    insert_block(&pool, "L3", "content", "level 3", Some("L2")).await;
    insert_block(&pool, "L4", "content", "level 4", Some("L3")).await;
    insert_block(&pool, "LEAF", "content", "leaf", Some("L4")).await;

    insert_tag_assoc(&pool, "ROOT", "TAG").await;

    let mut conn = pool.acquire().await.unwrap();
    propagate_tag_to_descendants(&mut conn, "ROOT", "TAG")
        .await
        .unwrap();

    let rows = get_inherited(&pool).await;

    // All 5 descendants should inherit the tag despite the depth limit
    assert_eq!(
        rows.len(),
        5,
        "All 5 descendants in a shallow tree should inherit TAG, got: {rows:?}"
    );
    assert!(rows.contains(&("L1".into(), "TAG".into(), "ROOT".into())));
    assert!(rows.contains(&("L2".into(), "TAG".into(), "ROOT".into())));
    assert!(rows.contains(&("L3".into(), "TAG".into(), "ROOT".into())));
    assert!(rows.contains(&("L4".into(), "TAG".into(), "ROOT".into())));
    assert!(rows.contains(&("LEAF".into(), "TAG".into(), "ROOT".into())));
}

// ======================================================================
// `rebuild_all_split` is now a single BEGIN IMMEDIATE tx
// ======================================================================

/// Parity oracle: `rebuild_all_split` must produce a byte-identical
/// `block_tag_inherited` row set to the unified `rebuild_all`. This
/// is the proof that the split variant is functionally equivalent
/// After the fix collapsed it onto the same recursive-CTE
/// `INSERT … SELECT` shape.
#[tokio::test]
async fn rebuild_all_split_matches_unified_rebuild_all() {
    let (pool, _dir) = test_pool().await;

    // Mixed fixture: two tag roots, two pages, varying depth, one
    // soft-deleted descendant (which neither rebuild path should
    // include in the inherited set — invariant #9).
    insert_block(&pool, "TAG1", "tag", "tag1", None).await;
    insert_block(&pool, "TAG2", "tag", "tag2", None).await;
    insert_block(&pool, "ROOT", "page", "root", None).await;
    insert_block(&pool, "PAGE_A", "page", "page a", Some("ROOT")).await;
    insert_block(&pool, "PAGE_B", "page", "page b", Some("ROOT")).await;
    insert_block(&pool, "CHILD_A", "content", "child a", Some("PAGE_A")).await;
    insert_block(&pool, "CHILD_B", "content", "child b", Some("PAGE_B")).await;
    insert_block(&pool, "GRAND_A", "content", "grand a", Some("CHILD_A")).await;
    insert_block(&pool, "GHOST", "content", "soft-deleted", Some("PAGE_A")).await;
    soft_delete(&pool, "GHOST").await;

    insert_tag_assoc(&pool, "ROOT", "TAG1").await;
    insert_tag_assoc(&pool, "PAGE_B", "TAG2").await;

    // Snapshot the unified output.
    rebuild_all(&pool).await.unwrap();
    let unified_rows = get_inherited(&pool).await;
    assert!(
        !unified_rows.is_empty(),
        "fixture must produce at least one inherited row to make parity meaningful"
    );

    // Wipe and run the split variant on the same pool — same as
    // production wiring when no read pool is configured (and
    // identical when one is, because the split variant now ignores
    // the read pool argument).
    sqlx::query("DELETE FROM block_tag_inherited")
        .execute(&pool)
        .await
        .unwrap();
    rebuild_all_split(&pool, &pool).await.unwrap();
    let split_rows = get_inherited(&pool).await;

    assert_eq!(
        unified_rows, split_rows,
        "rebuild_all_split must produce byte-identical rows to rebuild_all"
    );
}

/// Prove correctness on a fixture that crosses the previous
/// 500-row chunking threshold. Before the fix the split variant
/// issued one `INSERT` per row inside a single tx; after the fix it
/// issues one `INSERT … SELECT`. This test exercises the path with
/// > 500 expected inherited rows and asserts parity with the
/// unified rebuild on the same fixture.
#[tokio::test]
async fn rebuild_all_split_large_fixture_matches_unified() {
    let (pool, _dir) = test_pool().await;

    // 1 root + 600 children, all inheriting one tag from the root.
    // Each child contributes one inherited row → 600 rows total,
    // comfortably past the old 500-row chunk boundary.
    const N_CHILDREN: usize = 600;
    insert_block(&pool, "BIG_TAG", "tag", "big-tag", None).await;
    insert_block(&pool, "BIG_ROOT", "page", "big-root", None).await;
    insert_tag_assoc(&pool, "BIG_ROOT", "BIG_TAG").await;
    for i in 0..N_CHILDREN {
        let id = format!("BIG_CHILD_{i:04}");
        insert_block(&pool, &id, "content", "child", Some("BIG_ROOT")).await;
    }

    rebuild_all(&pool).await.unwrap();
    let unified_rows = get_inherited(&pool).await;
    assert_eq!(
        unified_rows.len(),
        N_CHILDREN,
        "unified rebuild should produce one inherited row per child"
    );

    sqlx::query("DELETE FROM block_tag_inherited")
        .execute(&pool)
        .await
        .unwrap();
    rebuild_all_split(&pool, &pool).await.unwrap();
    let split_rows = get_inherited(&pool).await;

    assert_eq!(
        unified_rows, split_rows,
        "rebuild_all_split must match rebuild_all on > 500-row fixtures"
    );
}

/// When an incremental `apply_op_tag_inheritance(AddTag)`
/// runs concurrently with `rebuild_all_split`, the AddTag's effect
/// must be observable in `block_tag_inherited` after both
/// operations complete — regardless of which one wins the writer
/// lock first.
///
/// Before the fix, the split variant's read-then-DELETE-then-INSERT
/// shape could silently swallow an AddTag whose effect committed
/// between the read and the DELETE. The new implementation opens
/// `BEGIN IMMEDIATE` on `write_pool`, so the rebuild and the
/// concurrent AddTag serialise: either the AddTag commits first
/// (and the rebuild's recursive CTE picks it up), or the rebuild
/// commits first (and the AddTag propagates onto the freshly-built
/// table). Both orderings produce the same correct final state.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rebuild_all_split_serialises_with_concurrent_add_tag() {
    let (pool, _dir) = test_pool().await;

    // Tree with a pre-existing tag on ROOT (TAG_OLD). The race
    // partner will add a *second* tag (TAG_NEW) to ROOT mid-rebuild.
    insert_block(&pool, "TAG_OLD", "tag", "tag-old", None).await;
    insert_block(&pool, "TAG_NEW", "tag", "tag-new", None).await;
    insert_block(&pool, "RACE_ROOT", "page", "race root", None).await;
    insert_block(&pool, "RACE_CHILD", "content", "child", Some("RACE_ROOT")).await;
    insert_block(
        &pool,
        "RACE_GRAND",
        "content",
        "grandchild",
        Some("RACE_CHILD"),
    )
    .await;
    insert_tag_assoc(&pool, "RACE_ROOT", "TAG_OLD").await;

    // Race partner: simulate the materializer's `AddTag` path —
    // INSERT into block_tags + propagate inheritance, atomically in
    // one transaction. This mirrors the production `apply_op` shape
    // for `OpType::AddTag` (handlers.rs ~line 113 opens a tx, runs
    // the INSERT, then dispatches `apply_op_tag_inheritance`).
    let pool_for_add = pool.clone();
    let add_tag_handle = tokio::spawn(async move {
        let mut tx = pool_for_add.begin().await.unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind("RACE_ROOT")
            .bind("TAG_NEW")
            .execute(&mut *tx)
            .await
            .unwrap();
        propagate_tag_to_descendants(&mut tx, "RACE_ROOT", "TAG_NEW")
            .await
            .unwrap();
        tx.commit().await.unwrap();
    });

    // Race partner: full rebuild via the split variant.
    let pool_for_rebuild = pool.clone();
    let rebuild_handle = tokio::spawn(async move {
        rebuild_all_split(&pool_for_rebuild, &pool_for_rebuild)
            .await
            .unwrap();
    });

    // Both must complete; if BEGIN IMMEDIATE serialisation is
    // working, the second writer waits on the first via SQLite's
    // busy_timeout instead of failing.
    let (a, b) = tokio::join!(add_tag_handle, rebuild_handle);
    a.unwrap();
    b.unwrap();

    let rows = get_inherited(&pool).await;

    // TAG_OLD must be present for both descendants — this is the
    // pre-existing inheritance that rebuild_all_split rebuilds from
    // block_tags.
    assert!(
        rows.contains(&("RACE_CHILD".into(), "TAG_OLD".into(), "RACE_ROOT".into())),
        "TAG_OLD must inherit to RACE_CHILD after concurrent rebuild + AddTag, got: {rows:?}",
    );
    assert!(
        rows.contains(&("RACE_GRAND".into(), "TAG_OLD".into(), "RACE_ROOT".into())),
        "TAG_OLD must inherit to RACE_GRAND after concurrent rebuild + AddTag, got: {rows:?}",
    );

    // TAG_NEW must also be present for both descendants — this is
    // The regression test. With the old read-then-DELETE-then-
    // INSERT shape, a schedule existed where the AddTag's
    // propagated rows were wiped by the rebuild's DELETE.
    assert!(
        rows.contains(&("RACE_CHILD".into(), "TAG_NEW".into(), "RACE_ROOT".into())),
        "TAG_NEW must inherit to RACE_CHILD after concurrent rebuild + AddTag, got: {rows:?}",
    );
    assert!(
        rows.contains(&("RACE_GRAND".into(), "TAG_NEW".into(), "RACE_ROOT".into())),
        "TAG_NEW must inherit to RACE_GRAND after concurrent rebuild + AddTag, got: {rows:?}",
    );

    // No spurious extra rows: 2 descendants × 2 tags = 4 rows.
    assert_eq!(
        rows.len(),
        4,
        "expected exactly 4 inherited rows (2 descendants × 2 tags), got: {rows:?}",
    );
}

// ======================================================================
// #2669 — the per-op incremental keeps `block_tag_inherited` correct
// WITHOUT the redundant whole-vault RebuildTagInheritanceCache task.
//
// These tests are the evidence behind the dispatch-table change: they
// exercise `apply_op_tag_inheritance` (which routes to the exact in-tx
// helpers the apply path runs — `recompute_subtree_inheritance` for
// MoveBlock, `remove_inherited_tag` for RemoveTag,
// `propagate_tag_to_descendants` for AddTag) and compare the resulting
// cache to a from-scratch `rebuild_all`.
// ======================================================================

/// #2669 — MoveBlock: `recompute_subtree_inheritance` reproduces the full
/// rebuild byte-for-byte (block_id, tag_id AND inherited_from) after a
/// cross-page move that changes the moved subtree's inherited tags. This
/// justifies dropping the redundant `RebuildTagInheritanceCache` from the
/// MoveBlock dispatch arm.
#[tokio::test]
async fn move_block_incremental_matches_full_rebuild_2669() {
    use crate::op::{MoveBlockPayload, OpPayload};
    use agaric_core::ulid::BlockId;
    let (pool, _dir) = test_pool().await;

    // P1 tagged T1, P2 tagged T2; subtree M->X starts under P1.
    insert_block(&pool, "T1", "tag", "t1", None).await;
    insert_block(&pool, "T2", "tag", "t2", None).await;
    insert_block(&pool, "P1", "page", "p1", None).await;
    insert_block(&pool, "P2", "page", "p2", None).await;
    insert_block(&pool, "MM", "content", "m", Some("P1")).await;
    insert_block(&pool, "XX", "content", "x", Some("MM")).await;
    insert_tag_assoc(&pool, "P1", "T1").await;
    insert_tag_assoc(&pool, "P2", "T2").await;
    rebuild_all(&pool).await.unwrap();

    // Project the move (parent_id flip), then run the incremental the apply
    // path runs — WITHOUT any subsequent full rebuild.
    sqlx::query("UPDATE blocks SET parent_id = 'P2' WHERE id = 'MM'")
        .execute(&pool)
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    apply_op_tag_inheritance(
        &mut conn,
        &OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted("MM"),
            new_parent_id: Some(BlockId::from_trusted("P2")),
            new_position: 1,
            new_index: Some(0),
        }),
    )
    .await
    .unwrap();
    drop(conn);

    let incremental = get_inherited(&pool).await;
    // The moved subtree must now inherit T2 and have lost T1.
    assert!(incremental.contains(&("MM".into(), "T2".into(), "P2".into())));
    assert!(incremental.contains(&("XX".into(), "T2".into(), "P2".into())));
    assert!(!incremental.iter().any(|(_, t, _)| t == "T1"));

    // Equivalence to the whole-vault rebuild (the task we removed).
    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;
    assert_eq!(
        incremental, rebuilt,
        "MoveBlock incremental must equal the full rebuild (#2669)"
    );
}

/// #2669 — RemoveTag: `remove_inherited_tag` reproduces the full rebuild
/// byte-for-byte, including nearest-ancestor re-attribution. Nested case:
/// A and B both directly tag T (A above B above D); removing T from B must
/// re-attribute D's inherited row from B up to A — exactly what the full
/// rebuild computes. This justifies dropping `RebuildTagInheritanceCache`
/// from the RemoveTag path.
///
/// #3923 — the fixture originally stopped at `DD`, a descendant that holds no
/// tag of its own. That is a HALF-COVERED PAIR: the property (incremental ==
/// rebuild) was right, but the generator could not produce the input that
/// falsifies it, so the convergence this test is cited for was never shown for
/// the case that actually diverged. `EE` (a descendant that holds `TG`
/// DIRECTLY) and `FF` (a plain descendant of `EE`, pinning step 2's in-subtree
/// re-attribution) close that gap:
///
/// ```text
/// AA[#TG]
///  └── BB[#TG]        ← RemoveTag(BB, TG)
///       ├── DD        → re-attributes BB → AA (the original coverage)
///       └── EE[#TG]   → must STILL inherit TG from AA (#3923: step 3's
///            │          `NOT IN block_tags` exclusion used to drop this row,
///            │          and RemoveTag has NO rebuild backstop to heal it)
///            └── FF   → keeps inheriting from the in-subtree tagger EE
/// ```
#[tokio::test]
async fn remove_tag_incremental_matches_full_rebuild_2669() {
    use crate::op::{OpPayload, RemoveTagPayload};
    use agaric_core::ulid::BlockId;
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TG", "tag", "tag", None).await;
    insert_block(&pool, "AA", "page", "a", None).await;
    insert_block(&pool, "BB", "content", "b", Some("AA")).await;
    insert_block(&pool, "DD", "content", "d", Some("BB")).await;
    // #3923: a descendant that holds the tag DIRECTLY as well as inheriting it.
    insert_block(&pool, "EE", "content", "e", Some("BB")).await;
    insert_block(&pool, "FF", "content", "f", Some("EE")).await;
    insert_tag_assoc(&pool, "AA", "TG").await;
    insert_tag_assoc(&pool, "BB", "TG").await;
    insert_tag_assoc(&pool, "EE", "TG").await;
    rebuild_all(&pool).await.unwrap();

    // Project the remove (drop the block_tags edge), then run the
    // incremental the apply path runs — WITHOUT a subsequent full rebuild.
    sqlx::query("DELETE FROM block_tags WHERE block_id = 'BB' AND tag_id = 'TG'")
        .execute(&pool)
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    apply_op_tag_inheritance(
        &mut conn,
        &OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::from_trusted("BB"),
            tag_id: BlockId::from_trusted("TG"),
        }),
    )
    .await
    .unwrap();
    drop(conn);

    let incremental = get_inherited(&pool).await;
    // D re-attributes to A (nearest remaining tagger); B inherits from A.
    assert!(incremental.contains(&("DD".into(), "TG".into(), "AA".into())));
    assert!(incremental.contains(&("BB".into(), "TG".into(), "AA".into())));
    // #3923: EE holds TG directly AND inherited it from BB; once BB loses the
    // tag, EE must re-attribute up to AA exactly like DD does. The direct
    // `block_tags` row is irrelevant to the inheritance relation.
    assert!(
        incremental.contains(&("EE".into(), "TG".into(), "AA".into())),
        "#3923: a descendant that holds TG DIRECTLY must still re-attribute its \
         inherited row to AA; got: {incremental:?}"
    );
    // FF's provenance is the in-subtree tagger EE and is untouched by the removal.
    assert!(incremental.contains(&("FF".into(), "TG".into(), "EE".into())));

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;
    assert_eq!(
        incremental, rebuilt,
        "RemoveTag incremental must equal the full rebuild (#2669)"
    );
}

/// #3923 — the issue's own fixture, minimal: `A[#T] > B[#T] > C[#T]`, remove
/// `#T` from `B`. `C` must inherit `#T` from `A`.
///
/// `remove_inherited_tag` used to refuse the `(C, T, A)` row because `C` holds
/// `T` directly (`WHERE d.id NOT IN (SELECT block_id FROM block_tags WHERE
/// tag_id = ?2)` in step 3). Unlike the restore path of #3876, RemoveTag's
/// materializer fan-out carries NO `RebuildTagInheritanceCache` (#2669 dropped
/// it — see `invalidations_for_op`'s `AddTag | RemoveTag` arm, which pushes the
/// rebuild only `if matches!(op_type, OpType::AddTag)`), so nothing heals the
/// missing row: it is durable wrong state, not a transient disagreement.
#[tokio::test]
async fn remove_tag_keeps_direct_holder_descendant_inheriting_3923() {
    use crate::op::{OpPayload, RemoveTagPayload};
    use agaric_core::ulid::BlockId;
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TP", "tag", "t", None).await;
    insert_block(&pool, "PA", "page", "a", None).await;
    insert_block(&pool, "PB", "content", "b", Some("PA")).await;
    insert_block(&pool, "PC", "content", "c", Some("PB")).await;
    insert_tag_assoc(&pool, "PA", "TP").await;
    insert_tag_assoc(&pool, "PB", "TP").await;
    insert_tag_assoc(&pool, "PC", "TP").await;
    rebuild_all(&pool).await.unwrap();

    // Project the remove, then run only the incremental maintenance.
    sqlx::query("DELETE FROM block_tags WHERE block_id = 'PB' AND tag_id = 'TP'")
        .execute(&pool)
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    apply_op_tag_inheritance(
        &mut conn,
        &OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::from_trusted("PB"),
            tag_id: BlockId::from_trusted("TP"),
        }),
    )
    .await
    .unwrap();
    drop(conn);

    let incremental = get_inherited(&pool).await;
    assert!(
        incremental.contains(&("PC".into(), "TP".into(), "PA".into())),
        "#3923: C must inherit #T from A after B loses it, even though C also \
         holds #T directly; got: {incremental:?}"
    );

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;
    assert_eq!(
        incremental, rebuilt,
        "#3923: RemoveTag incremental must equal the full rebuild — RemoveTag \
         has no RebuildTagInheritanceCache backstop, so a divergence here is \
         DURABLE wrong state"
    );
}

/// #2669 — AddTag: single-tagger propagation across a subtree matches the
/// full rebuild. This is the common case and confirms the incremental is
/// effective-tag-complete for a fresh tag add.
#[tokio::test]
async fn add_tag_incremental_matches_full_rebuild_simple_2669() {
    use crate::op::{AddTagPayload, OpPayload};
    use agaric_core::ulid::BlockId;
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TG", "tag", "tag", None).await;
    insert_block(&pool, "PG", "page", "p", None).await;
    insert_block(&pool, "C1", "content", "c1", Some("PG")).await;
    insert_block(&pool, "C2", "content", "c2", Some("C1")).await;
    insert_tag_assoc(&pool, "PG", "TG").await;

    let mut conn = pool.acquire().await.unwrap();
    apply_op_tag_inheritance(
        &mut conn,
        &OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::from_trusted("PG"),
            tag_id: BlockId::from_trusted("TG"),
        }),
    )
    .await
    .unwrap();
    drop(conn);

    let incremental = get_inherited(&pool).await;
    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;
    assert_eq!(
        incremental, rebuilt,
        "AddTag single-tagger incremental must equal the full rebuild (#2669)"
    );
}

/// #2669 GAP — AddTag: `propagate_tag_to_descendants` is a plain
/// `INSERT OR IGNORE` and does NOT re-attribute an existing inherited row
/// to a newly-added CLOSER ancestor. When A (above B above D) is tagged
/// first and B is tagged second, the full rebuild attributes D's inherited
/// row to the nearer B, but the incremental keeps the original A. The
/// EFFECTIVE tag set is identical (D still inherits T) — only the
/// `inherited_from` provenance differs — but because the state is NOT
/// byte-identical to the full rebuild, the AddTag dispatch arm KEEPS its
/// `RebuildTagInheritanceCache` (unlike RemoveTag / MoveBlock). This test
/// pins the divergence so the rationale can't silently rot.
#[tokio::test]
async fn add_tag_nested_diverges_from_rebuild_provenance_only_2669() {
    use crate::op::{AddTagPayload, OpPayload};
    use agaric_core::ulid::BlockId;
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TG", "tag", "tag", None).await;
    insert_block(&pool, "AA", "page", "a", None).await;
    insert_block(&pool, "BB", "content", "b", Some("AA")).await;
    insert_block(&pool, "DD", "content", "d", Some("BB")).await;

    let mut conn = pool.acquire().await.unwrap();
    insert_tag_assoc(&pool, "AA", "TG").await;
    apply_op_tag_inheritance(
        &mut conn,
        &OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::from_trusted("AA"),
            tag_id: BlockId::from_trusted("TG"),
        }),
    )
    .await
    .unwrap();
    insert_tag_assoc(&pool, "BB", "TG").await;
    apply_op_tag_inheritance(
        &mut conn,
        &OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::from_trusted("BB"),
            tag_id: BlockId::from_trusted("TG"),
        }),
    )
    .await
    .unwrap();
    drop(conn);

    let incremental = get_inherited(&pool).await;
    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    // Effective (block_id, tag_id) membership is identical...
    let eff = |v: &[(String, String, String)]| {
        let mut m: Vec<(String, String)> =
            v.iter().map(|(b, t, _)| (b.clone(), t.clone())).collect();
        m.sort();
        m
    };
    assert_eq!(
        eff(&incremental),
        eff(&rebuilt),
        "effective tag membership must match the rebuild even in the nested case"
    );
    // ...but the `inherited_from` provenance differs: incremental keeps AA,
    // the rebuild picks the nearer BB. THIS is why the AddTag arm keeps the
    // full rebuild.
    assert!(
        incremental.contains(&("DD".into(), "TG".into(), "AA".into())),
        "incremental keeps the original (farther) attribution AA, got {incremental:?}"
    );
    assert!(
        rebuilt.contains(&("DD".into(), "TG".into(), "BB".into())),
        "full rebuild picks the nearer attribution BB, got {rebuilt:?}"
    );
    assert_ne!(
        incremental, rebuilt,
        "the nested AddTag incremental must (still) differ from the full rebuild in provenance"
    );
}

// ======================================================================
// #3876 — `rebuild_all` and `recompute_subtree_inheritance` must converge
// ======================================================================
//
// For a block that holds a tag BOTH directly (`block_tags`) and by
// inheritance from an ancestor, the two maintenance paths used to disagree:
// `rebuild_all` kept the inherited row, `recompute_subtree_inheritance`
// (move / restore) dropped it. So the contents of `block_tag_inherited`
// depended on which path last touched the block.
//
// The settled definition is `rebuild_all`'s — the inheritance relation is
// true independently of whether a direct tag also exists, and a consumer
// that wants "inherited but not direct" subtracts (`useBlockTags` already
// does exactly that, and `list_inherited_tags_for_block` documents the
// overlap). The tests below drive BOTH paths over the same fixture and
// assert they land on the same rows.

/// Fixture for the #3876 convergence tests.
///
/// ```text
/// TAG3876 (tag)
/// SRC3876 (page, untagged)
/// DST3876 (page)  ── holds TAG3876 directly
/// MOV3876 (content, child of `mover_parent`) ── holds TAG3876 directly
///   └── LEAF3876
/// ```
///
/// When `MOV3876` sits under `DST3876` it holds `TAG3876` **directly and by
/// inheritance** — the exact shape the two paths used to disagree about.
async fn seed_3876(pool: &SqlitePool, mover_parent: &str) {
    insert_block(pool, "TAG3876", "tag", "tag", None).await;
    insert_block(pool, "SRC3876", "page", "src", None).await;
    insert_block(pool, "DST3876", "page", "dst", None).await;
    insert_block(pool, "MOV3876", "content", "mover", Some(mover_parent)).await;
    insert_block(pool, "LEAF3876", "content", "leaf", Some("MOV3876")).await;

    insert_tag_assoc(pool, "DST3876", "TAG3876").await;
    insert_tag_assoc(pool, "MOV3876", "TAG3876").await;
}

/// Move path: `recompute_subtree_inheritance` after a move must leave
/// `block_tag_inherited` byte-identical to a full `rebuild_all`.
#[tokio::test]
async fn move_recompute_converges_with_rebuild_3876() {
    let (pool, _dir) = test_pool().await;
    seed_3876(&pool, "SRC3876").await;

    // Canonical starting state.
    rebuild_all(&pool).await.unwrap();

    // Move MOV3876 under DST3876, which holds the same tag directly.
    sqlx::query("UPDATE blocks SET parent_id = 'DST3876' WHERE id = 'MOV3876'")
        .execute(&pool)
        .await
        .unwrap();

    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "MOV3876")
        .await
        .unwrap();
    drop(conn);

    let incremental = get_inherited(&pool).await;
    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    assert_eq!(
        incremental, rebuilt,
        "#3876: the move-path recompute must converge with the full rebuild"
    );
    assert!(
        incremental.contains(&("MOV3876".into(), "TAG3876".into(), "DST3876".into())),
        "#3876: a block holding the tag directly still INHERITS it from the \
         ancestor that also holds it, got: {incremental:?}"
    );
}

/// Restore path: soft-delete the subtree (sweeping its rows the way
/// `delete_block` does), restore it, then `recompute_subtree_inheritance`.
/// The result must equal a full `rebuild_all`.
#[tokio::test]
async fn restore_recompute_converges_with_rebuild_3876() {
    let (pool, _dir) = test_pool().await;
    seed_3876(&pool, "DST3876").await;

    rebuild_all(&pool).await.unwrap();

    // Soft-delete the subtree, then sweep its inherited rows (the
    // `DeleteBlock` arm of `apply_op_tag_inheritance`).
    soft_delete(&pool, "MOV3876").await;
    soft_delete(&pool, "LEAF3876").await;
    let mut conn = pool.acquire().await.unwrap();
    remove_subtree_inherited(&mut conn, "MOV3876")
        .await
        .unwrap();
    drop(conn);

    // Restore the subtree, then recompute (the `RestoreBlock` arm).
    sqlx::query("UPDATE blocks SET deleted_at = NULL WHERE id IN ('MOV3876', 'LEAF3876')")
        .execute(&pool)
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "MOV3876")
        .await
        .unwrap();
    drop(conn);

    let incremental = get_inherited(&pool).await;
    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    assert_eq!(
        incremental, rebuilt,
        "#3876: the restore-path recompute must converge with the full rebuild"
    );
    assert!(
        incremental.contains(&("MOV3876".into(), "TAG3876".into(), "DST3876".into())),
        "#3876: the restored block must regain the inherited row it holds \
         alongside its direct tag, got: {incremental:?}"
    );
}

// ======================================================================
// #3926 — a walk must not pass THROUGH a soft-deleted block
// ======================================================================
//
// `rebuild_all` propagates a tag down a chain of LIVE blocks only
// (`tag_inh_descendant_tags_full!` filters `deleted_at IS NULL` on the
// tagger and on every descendant step). The incremental maintainers walk
// the same edge in the opposite direction via `tag_inh_ancestors_walk!`,
// which used to climb through tombstones — so for `A[#T] > X(deleted) > R`
// the incremental path attributed `#T` to `R` and a full rebuild did not.
//
// The disagreement was not only with the rebuild. `recompute_subtree_
// inheritance` contains BOTH directions: its subtree walk has always
// stopped at a deleted intermediate (`recompute_subtree_skips_deleted`
// asserts exactly that), while its step-3 ancestor walk did not. The same
// fixture therefore gave opposite answers depending on which end you
// recomputed from. The two tests below pin the ancestor direction for both
// affected helpers, and assert the rebuild's own answer explicitly rather
// than only asserting the two agree — otherwise a change that broke
// `rebuild_all` in the same direction would keep them green.

/// #3926 — `recompute_subtree_inheritance` rooted BELOW a soft-deleted
/// ancestor must not pull a tag across it.
///
/// The fixture is `recompute_subtree_skips_deleted`'s, recomputed from the
/// other end: that test recomputes at `PARENT` and asserts `GCHILD` gets
/// nothing because `CHILD` is deleted. Recomputing at `GCHILD` must reach
/// the same state.
#[tokio::test]
async fn recompute_subtree_stops_at_soft_deleted_ancestor_3926() {
    let (pool, _dir) = test_pool().await;

    // GP3926[#T] > PA3926 > CH3926 (soft-deleted) > GC3926
    insert_block(&pool, "TG3926", "tag", "tag", None).await;
    insert_block(&pool, "GP3926", "page", "grandparent", None).await;
    insert_block(&pool, "PA3926", "content", "parent", Some("GP3926")).await;
    insert_block(&pool, "CH3926", "content", "child", Some("PA3926")).await;
    insert_block(&pool, "GC3926", "content", "grandchild", Some("CH3926")).await;
    insert_tag_assoc(&pool, "GP3926", "TG3926").await;
    soft_delete(&pool, "CH3926").await;

    // Canonical starting state. The arbiter's own answer is pinned here,
    // independently of the convergence assertion below: PA3926 inherits and
    // nothing below the tombstone does.
    rebuild_all(&pool).await.unwrap();
    let canonical = get_inherited(&pool).await;
    assert_eq!(
        canonical,
        vec![(
            "PA3926".to_string(),
            "TG3926".to_string(),
            "GP3926".to_string()
        )],
        "#3926: rebuild_all propagates through LIVE blocks only, so only \
         PA3926 inherits; got: {canonical:?}"
    );

    // Recomputing the subtree rooted BELOW the tombstone must be a no-op.
    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "GC3926")
        .await
        .unwrap();
    drop(conn);
    let incremental = get_inherited(&pool).await;

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    assert!(
        !incremental.iter().any(|(bid, _, _)| bid == "GC3926"),
        "#3926: GC3926 must not inherit TG3926 across the soft-deleted \
         CH3926; got: {incremental:?}"
    );
    assert_eq!(
        incremental, rebuilt,
        "#3926: the ancestor walk must stop at the soft-deleted CH3926 the \
         same way the descendant walk does — `recompute_subtree_skips_deleted` \
         asserts this fixture from ABOVE, and it must hold from BELOW too"
    );
}

/// #3926 — `remove_inherited_tag`'s re-attribution walk (its
/// `nearest_ancestor` CTE, used at two call-sites) must likewise refuse to
/// climb past a tombstone.
///
/// This path matters more than the recompute one: RemoveTag's materializer
/// fan-out carries no `RebuildTagInheritanceCache` (#2669), so a row
/// invented here is durable.
#[tokio::test]
async fn remove_tag_stops_at_soft_deleted_ancestor_3926() {
    let (pool, _dir) = test_pool().await;

    // GR3926[#T] > MD3926 (soft-deleted) > PR3926[#T] > KD3926
    insert_block(&pool, "TR3926", "tag", "tag", None).await;
    insert_block(&pool, "GR3926", "page", "grand", None).await;
    insert_block(&pool, "MD3926", "content", "mid", Some("GR3926")).await;
    insert_block(&pool, "PR3926", "content", "parent", Some("MD3926")).await;
    insert_block(&pool, "KD3926", "content", "kid", Some("PR3926")).await;
    insert_tag_assoc(&pool, "GR3926", "TR3926").await;
    insert_tag_assoc(&pool, "PR3926", "TR3926").await;
    soft_delete(&pool, "MD3926").await;

    rebuild_all(&pool).await.unwrap();
    let canonical = get_inherited(&pool).await;
    assert_eq!(
        canonical,
        vec![(
            "KD3926".to_string(),
            "TR3926".to_string(),
            "PR3926".to_string()
        )],
        "precondition: only KD3926 inherits — GR3926's tag cannot cross the \
         soft-deleted MD3926; got: {canonical:?}"
    );

    // Project the remove, then run only the incremental maintenance.
    sqlx::query("DELETE FROM block_tags WHERE block_id = 'PR3926' AND tag_id = 'TR3926'")
        .execute(&pool)
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    remove_inherited_tag(&mut conn, "PR3926", "TR3926")
        .await
        .unwrap();
    drop(conn);
    let incremental = get_inherited(&pool).await;

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    assert!(
        rebuilt.is_empty(),
        "#3926: with PR3926's direct tag gone nothing inherits — GR3926 is \
         unreachable through the tombstone; got: {rebuilt:?}"
    );
    assert_eq!(
        incremental, rebuilt,
        "#3926: re-attribution must not resurrect KD3926/PR3926 from GR3926 \
         by climbing past the soft-deleted MD3926 — RemoveTag has no rebuild \
         backstop, so such a row is DURABLE wrong state"
    );
}

// ======================================================================
// #3925 — nearest-ancestor provenance must be ranked, not emitted
// ======================================================================
//
// Both recompute steps insert from a walk that emits one row per tagging
// ancestor and let `INSERT OR IGNORE` plus the `(block_id, tag_id)` PK keep
// the first. Which row is "first" is a query-planner property, not
// something the SQL states — so `inherited_from` was decided by emission
// order. Neither `*_converges_with_rebuild_3876` fixture has two tagging
// ancestors, so nothing exercised the ranking.
//
// The two fixtures below each place two taggers on one chain, which is the
// minimum shape that can tell "attributed to the nearest" from "attributed
// to the furthest". Step 3 was demonstrably picking the FURTHEST.

/// #3925 — two taggers ABOVE the recompute subtree (step 3). The subtree
/// must be attributed to the nearer one, as `rebuild_all` is.
#[tokio::test]
async fn recompute_subtree_ranks_nearest_ancestor_above_subtree_3925() {
    let (pool, _dir) = test_pool().await;

    // TP3925[#T] > MD3925[#T]; the mover starts under an untagged page.
    insert_block(&pool, "TG3925", "tag", "tag", None).await;
    insert_block(&pool, "TP3925", "page", "top", None).await;
    insert_block(&pool, "MD3925", "content", "mid", Some("TP3925")).await;
    insert_block(&pool, "SR3925", "page", "src", None).await;
    insert_block(&pool, "RT3925", "content", "root", Some("SR3925")).await;
    insert_block(&pool, "LF3925", "content", "leaf", Some("RT3925")).await;
    insert_tag_assoc(&pool, "TP3925", "TG3925").await;
    insert_tag_assoc(&pool, "MD3925", "TG3925").await;

    rebuild_all(&pool).await.unwrap();

    // Move RT3925 under MD3925, so its subtree now has TWO tagging
    // ancestors: MD3925 (nearer) and TP3925 (further).
    sqlx::query("UPDATE blocks SET parent_id = 'MD3925' WHERE id = 'RT3925'")
        .execute(&pool)
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "RT3925")
        .await
        .unwrap();
    drop(conn);
    let incremental = get_inherited(&pool).await;

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    let expected = vec![
        (
            "LF3925".to_string(),
            "TG3925".to_string(),
            "MD3925".to_string(),
        ),
        (
            "MD3925".to_string(),
            "TG3925".to_string(),
            "TP3925".to_string(),
        ),
        (
            "RT3925".to_string(),
            "TG3925".to_string(),
            "MD3925".to_string(),
        ),
    ];
    assert_eq!(
        rebuilt, expected,
        "#3925: the arbiter attributes the moved subtree to the NEAREST \
         tagging ancestor MD3925; got: {rebuilt:?}"
    );
    assert_eq!(
        incremental, rebuilt,
        "#3925: step 3 must rank ancestors by depth — attributing RT3925 / \
         LF3925 to the further TP3925 is what the unranked CROSS JOIN did"
    );
}

/// #3925 — two taggers INSIDE the recompute subtree (step 2). Same rule,
/// same failure mode, on the other insert.
///
/// **What this test does and does not pin.** Unlike the step-3 fixture
/// above, step 2 was NOT wrong before the fix: this fixture passes on the
/// pre-fix code too. Mutation-checked, the test reddens when the collapse
/// keeps the WRONG row (`MIN(td2.depth)` → `MAX`), so it does pin the
/// ranking RULE; it does NOT redden if `tag_inh_subtree_nearest!` is
/// deleted outright and the insert reads `tagged_descendants` directly.
/// No fixture can make it: SQLite's recursive-CTE queue is FIFO, so
/// `tagged_descendants` is emitted in non-decreasing `depth` and a bare
/// scan of the materialised CTE hands `INSERT OR IGNORE` the MIN-depth row
/// first anyway. That FIFO reliance is precisely what #3925 asks to be
/// removed — the collapse makes step 2 correct by construction rather than
/// by planner behaviour — so the guard against dropping it is
/// `the_two_nearest_collapses_differ_only_in_cte_names`, not this test.
#[tokio::test]
async fn recompute_subtree_ranks_nearest_tagger_inside_subtree_3925() {
    let (pool, _dir) = test_pool().await;

    // Recompute from TW3925, so BOTH taggers sit inside the subtree.
    insert_block(&pool, "TX3925", "tag", "tag", None).await;
    insert_block(&pool, "TW3925", "page", "top", None).await;
    insert_block(&pool, "MW3925", "content", "mid", Some("TW3925")).await;
    insert_block(&pool, "LW3925", "content", "leaf", Some("MW3925")).await;
    insert_tag_assoc(&pool, "TW3925", "TX3925").await;
    insert_tag_assoc(&pool, "MW3925", "TX3925").await;

    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "TW3925")
        .await
        .unwrap();
    drop(conn);
    let incremental = get_inherited(&pool).await;

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    let expected = vec![
        (
            "LW3925".to_string(),
            "TX3925".to_string(),
            "MW3925".to_string(),
        ),
        (
            "MW3925".to_string(),
            "TX3925".to_string(),
            "TW3925".to_string(),
        ),
    ];
    assert_eq!(
        rebuilt, expected,
        "#3925: the arbiter attributes LW3925 to the NEAREST tagger MW3925; \
         got: {rebuilt:?}"
    );
    assert_eq!(
        incremental, rebuilt,
        "#3925: step 2 must collapse `tagged_descendants` to the MIN-depth \
         row — inserting straight from the walk let the recursive-CTE \
         emission order decide LW3925's provenance"
    );
}

// ======================================================================
// #3944 — a walk must not START at a soft-deleted block either
// ======================================================================
//
// #3919/#3925/#3926 covered the deleted ANCESTOR and the deleted
// DESCENDANT. This is the deleted SUBJECT: the block the incremental
// maintenance is rooted at. Both wrong writes came from
// `tag_inh_ancestors_walk!`, which seeded `SELECT parent_id FROM blocks
// WHERE id = ?1` with no check on `?1` —
//
//   * `recompute_subtree_inheritance(R)` on a soft-deleted `R` climbed to
//     `R`'s tagging ancestors and cross-joined them onto `R`'s whole
//     subtree, writing a row FOR the tombstone and re-deriving its live
//     descendants' rows from an ancestor chain that is broken at `R`;
//   * `remove_inherited_tag(R, T)` on a soft-deleted `R` likewise found
//     `R`'s ancestors and re-attributed `R`'s live descendants to them.
//
// `rebuild_all` — the arbiter — does neither: `tag_inh_descendant_tags_full!`
// propagates only through LIVE blocks, so nothing enters or crosses a
// tombstone in either direction.
//
// The fix is ONE seed filter, on `tag_inh_ancestors_walk!` — the CTE that
// feeds INSERTs only. `tag_inh_subtree_active!`'s seed keeps admitting a
// tombstoned `?1` on purpose: it also scopes step 1's two DELETEs, and
// emptying it makes a recompute rooted at a tombstone a no-op that strands
// rows (`recompute_at_tombstone_after_structural_change_below_matches_rebuild_3944`
// is the test that fails if someone "completes" the symmetry).
//
// Reachability is the remote/replay path, not the local command: the local
// move guards (`move_block_inner` probes `deleted_at IS NULL` before
// appending the op), but `OpType::MoveBlock` → `apply_move_block_via_loro` /
// `apply_move_block_sql_only` call `recompute_subtree_inheritance(block_id)`
// unconditionally, and `project_move_block_to_sql` has no `deleted_at`
// filter — so a concurrent delete-on-A / move-on-B lands a recompute rooted
// at a tombstone. `RemoveTag` carries no `RebuildTagInheritanceCache`
// (#2669), so rows written on that path are DURABLE, not self-healing.

/// #3944 — a recompute rooted at a soft-deleted block must equal
/// `rebuild_all`'s answer, which is "nothing for the tombstone".
///
/// The issue's PROBE-E: `AP3944[#TG3944] > RQ3944(deleted)`. Step 3's
/// ancestor walk found the live, tagged `AP3944` from a tombstoned seed and
/// cross-joined it onto the subtree, inserting `(RQ3944, TG3944, AP3944)` —
/// a row `rebuild_all` refuses. Reverting `tag_inh_ancestors_walk!(0)`'s
/// #3944 seed filter reddens this test.
#[tokio::test]
async fn recompute_rooted_at_soft_deleted_block_matches_rebuild_3944() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TG3944", "tag", "tag", None).await;
    insert_block(&pool, "AP3944", "page", "apex", None).await;
    insert_block(&pool, "RQ3944", "content", "root", Some("AP3944")).await;
    insert_tag_assoc(&pool, "AP3944", "TG3944").await;
    soft_delete(&pool, "RQ3944").await;

    // The arbiter's own answer, pinned independently of the convergence
    // assertion: a tombstone inherits nothing.
    rebuild_all(&pool).await.unwrap();
    let canonical = get_inherited(&pool).await;
    assert!(
        canonical.is_empty(),
        "#3944: rebuild_all propagates through LIVE blocks only, so the \
         soft-deleted RQ3944 inherits nothing; got: {canonical:?}"
    );

    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "RQ3944")
        .await
        .unwrap();
    drop(conn);
    let incremental = get_inherited(&pool).await;

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    assert!(
        !incremental.iter().any(|(bid, _, _)| bid == "RQ3944"),
        "#3944: a recompute rooted at the soft-deleted RQ3944 must not write \
         an inherited row FOR it; got: {incremental:?}"
    );
    assert_eq!(
        incremental, rebuilt,
        "#3944: the recompute's subtree seed must reject a soft-deleted root \
         the same way `rebuild_all`'s descendant walk does"
    );
}

/// #3944 (maintainer's widening) — `remove_inherited_tag` rooted at a
/// soft-deleted block must likewise equal `rebuild_all`.
///
/// `AR3944[#TR3944] > RR3944(deleted, #TR3944) > DS3944(live)`. `rebuild_all`
/// yields nothing: `AR3944`'s child `RR3944` is filtered out as a descendant,
/// and `RR3944` fails `tagged.deleted_at IS NULL` as a tagger. But
/// `remove_inherited_tag(RR3944, TR3944)` still reached `DS3944` via
/// `descendants_active` and `AR3944` via `tag_inh_ancestors_walk!`'s
/// unchecked seed, writing `(DS3944, …, AR3944)` at site 2 and
/// `(RR3944, …, AR3944)` at site 3.
///
/// #3948 hardened the rest of that walk (the climb no longer passes THROUGH a
/// tombstone) and left the seed alone; #3948's note that step 2's `anc` CTE is
/// safe unfiltered rests on `taggers ⊆ descendants` forcing an all-live climb,
/// an argument specific to `anc` that does not extend to either seed.
#[tokio::test]
async fn remove_tag_rooted_at_soft_deleted_block_matches_rebuild_3944() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TR3944", "tag", "tag", None).await;
    insert_block(&pool, "AR3944", "page", "anc", None).await;
    insert_block(&pool, "RR3944", "content", "root", Some("AR3944")).await;
    insert_block(&pool, "DS3944", "content", "desc", Some("RR3944")).await;
    insert_tag_assoc(&pool, "AR3944", "TR3944").await;
    insert_tag_assoc(&pool, "RR3944", "TR3944").await;
    soft_delete(&pool, "RR3944").await;

    rebuild_all(&pool).await.unwrap();
    let canonical = get_inherited(&pool).await;
    assert!(
        canonical.is_empty(),
        "#3944: nothing crosses the soft-deleted RR3944 in either direction, \
         so the arbiter's answer is empty; got: {canonical:?}"
    );

    // Project the remove (drop the direct edge), then run only the
    // incremental maintenance the RemoveTag apply path runs.
    sqlx::query("DELETE FROM block_tags WHERE block_id = 'RR3944' AND tag_id = 'TR3944'")
        .execute(&pool)
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    remove_inherited_tag(&mut conn, "RR3944", "TR3944")
        .await
        .unwrap();
    drop(conn);
    let incremental = get_inherited(&pool).await;

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    assert!(
        rebuilt.is_empty(),
        "precondition: with RR3944's direct tag gone the arbiter still yields \
         nothing; got: {rebuilt:?}"
    );
    assert_eq!(
        incremental, rebuilt,
        "#3944: `remove_inherited_tag` rooted at the soft-deleted RR3944 must \
         not re-attribute DS3944 (site 2) or RR3944 itself (site 3) to \
         AR3944 — RemoveTag has no RebuildTagInheritanceCache backstop \
         (#2669), so such a row is DURABLE wrong state"
    );
}

/// #3944 — tombstone root, all four `tag_inh_subtree_active!` call-sites at
/// once: step 1's two DELETEs still sweep the tombstone's LIVE subtree, and
/// steps 2 and 3 re-derive exactly what the arbiter computes for it.
///
/// `AX3944[#T1] > RB3944(deleted) > DL3944(live)[#T2] > EL3944(live)`.
///
/// A live descendant under a tombstone is exactly the shape the remote move
/// path produces. The arbiter says `(EL3944, T2, DL3944)` and nothing else:
/// `T1` cannot cross `RB3944`, and `DL3944`'s own tag still propagates
/// downward through live blocks. Step 1 deletes that row and step 2 puts it
/// straight back (`tagged_descendants` seeds from the live, in-subtree tagger
/// `DL3944`); the divergence was step 3 ALSO cross-joining `T1` onto the whole
/// subtree from above, which the ancestor walk's seed filter now prevents.
#[tokio::test]
async fn recompute_at_tombstone_keeps_live_descendant_inheritance_3944() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "T13944", "tag", "t1", None).await;
    insert_block(&pool, "T23944", "tag", "t2", None).await;
    insert_block(&pool, "AX3944", "page", "apex", None).await;
    insert_block(&pool, "RB3944", "content", "root", Some("AX3944")).await;
    insert_block(&pool, "DL3944", "content", "live-desc", Some("RB3944")).await;
    insert_block(&pool, "EL3944", "content", "leaf", Some("DL3944")).await;
    insert_tag_assoc(&pool, "AX3944", "T13944").await;
    insert_tag_assoc(&pool, "DL3944", "T23944").await;
    soft_delete(&pool, "RB3944").await;

    rebuild_all(&pool).await.unwrap();
    let canonical = get_inherited(&pool).await;
    assert_eq!(
        canonical,
        vec![(
            "EL3944".to_string(),
            "T23944".to_string(),
            "DL3944".to_string()
        )],
        "#3944: T13944 cannot cross the tombstone, but DL3944's own tag still \
         reaches EL3944 through live blocks; got: {canonical:?}"
    );

    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "RB3944")
        .await
        .unwrap();
    drop(conn);
    let incremental = get_inherited(&pool).await;

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    assert!(
        !incremental.iter().any(|(_, tag, _)| tag == "T13944"),
        "#3944: no block in the tombstoned root's subtree may inherit T13944 \
         from above the tombstone; got: {incremental:?}"
    );
    assert_eq!(
        incremental, rebuilt,
        "#3944: narrowing step 1's DELETE for a tombstoned root must leave the \
         subtree's INTERNAL inheritance exactly as the arbiter computes it"
    );
}

/// #3944 — DELETE-scope matrix, LIVE root: both of step 1's DELETEs must
/// still sweep the WHOLE subtree, not merely the root itself.
///
/// The stale rows here sit on blocks OTHER than `?1` deliberately. An earlier
/// draft of this test put both of them on the recompute root, which made it
/// pass with each DELETE reduced to `... = ?1`: it asserted nothing about the
/// `IN (SELECT id FROM subtree)` scope it claimed to pin. The fixture below
/// fails if either subtree clause is dropped.
///
/// `OP3944[#T3] > { SB3944, MV3944 }`, `MV3944 > KD3944[#T4] > GC3944`, plus
/// the untagged page `NP3944`. Then two structural changes are projected —
/// `GC3944` moves out of the subtree (to `SB3944`) and `MV3944` moves under
/// `NP3944` — and only the recompute rooted at the LIVE `MV3944` runs:
///
/// * site 1a (`block_id IN subtree`) must drop `(KD3944, T3, OP3944)` — a
///   stale row on a DESCENDANT of the root, which `block_id = ?1` cannot see;
/// * site 1b (`inherited_from IN subtree AND block_id NOT IN subtree`) must
///   drop `(GC3944, T4, KD3944)` — attributed to a descendant of the root,
///   which `inherited_from = ?1` cannot see either.
///
/// `(GC3944, T3, OP3944)` must SURVIVE: it is outside the subtree in both
/// roles and still correct, so it also guards against over-deleting.
#[tokio::test]
async fn recompute_delete_scope_sweeps_the_whole_subtree_3944() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "T33944", "tag", "t3", None).await;
    insert_block(&pool, "T43944", "tag", "t4", None).await;
    insert_block(&pool, "OP3944", "page", "old-parent", None).await;
    insert_block(&pool, "NP3944", "page", "new-parent", None).await;
    insert_block(&pool, "SB3944", "content", "sibling", Some("OP3944")).await;
    insert_block(&pool, "MV3944", "content", "mover", Some("OP3944")).await;
    insert_block(&pool, "KD3944", "content", "kid", Some("MV3944")).await;
    insert_block(&pool, "GC3944", "content", "grandkid", Some("KD3944")).await;
    insert_tag_assoc(&pool, "OP3944", "T33944").await;
    insert_tag_assoc(&pool, "KD3944", "T43944").await;

    rebuild_all(&pool).await.unwrap();
    let before = get_inherited(&pool).await;
    assert!(
        before.contains(&("KD3944".into(), "T33944".into(), "OP3944".into())),
        "precondition: the kid — a DESCENDANT of the recompute root — inherits \
         T3 from the root's old parent; got: {before:?}"
    );
    assert!(
        before.contains(&("GC3944".into(), "T43944".into(), "KD3944".into())),
        "precondition: the grandkid inherits T4 from the kid, i.e. from a \
         block INSIDE the recompute root's subtree; got: {before:?}"
    );

    // Project both structural changes, then run only the recompute rooted at
    // the (live) mover — the shape `TagScope::Subtrees` dedupes to.
    sqlx::query("UPDATE blocks SET parent_id = 'SB3944' WHERE id = 'GC3944'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET parent_id = 'NP3944' WHERE id = 'MV3944'")
        .execute(&pool)
        .await
        .unwrap();

    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "MV3944")
        .await
        .unwrap();
    drop(conn);
    let incremental = get_inherited(&pool).await;

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    assert!(
        !incremental.contains(&("KD3944".into(), "T33944".into(), "OP3944".into())),
        "#3944 site 1a: the DESCENDANT's stale T3 row must be swept by \
         `block_id IN subtree`, which `block_id = ?1` would miss; \
         got: {incremental:?}"
    );
    assert!(
        !incremental.contains(&("GC3944".into(), "T43944".into(), "KD3944".into())),
        "#3944 site 1b: the row attributed to an in-subtree DESCENDANT must be \
         swept by `inherited_from IN subtree`, which `inherited_from = ?1` \
         would miss; got: {incremental:?}"
    );
    assert!(
        incremental.contains(&("GC3944".into(), "T33944".into(), "OP3944".into())),
        "#3944: the grandkid's row from OUTSIDE the subtree in both roles is \
         still correct and must not be swept; got: {incremental:?}"
    );
    assert_eq!(
        incremental, rebuilt,
        "#3944: a LIVE root's DELETE scope is unchanged, and still equals the \
         arbiter"
    );
}

/// #3944 — DELETE-scope matrix, tombstone root: step 1 must still sweep the
/// TOMBSTONE'S OWN rows.
///
/// A row whose `block_id` is a soft-deleted block, or whose `inherited_from`
/// is one, is never in `rebuild_all`'s output — the arbiter propagates only
/// through live blocks in both roles. Such a row is therefore unconditionally
/// stale and needs no re-insert, and step 1 sweeps it because
/// `tag_inh_subtree_active!`'s seed still admits a tombstoned `?1`. Filtering
/// that seed empties `subtree` and this test goes red — it is one of the two
/// pins on the negative half of the #3944 rule.
///
/// This is not hypothetical: `(RS3944, TS3944, AS3944)` is exactly the row
/// pre-#3944 code wrote (the issue's PROBE-E), and `(OU3944, TS3944, RS3944)`
/// the mirror one attributed to the tombstone. A vault upgraded past this fix
/// still has them, and the next recompute rooted there heals both rather than
/// leaving them for a whole-vault rebuild.
#[tokio::test]
async fn recompute_at_tombstone_sweeps_the_tombstones_own_rows_3944() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TS3944", "tag", "ts", None).await;
    insert_block(&pool, "AS3944", "page", "apex", None).await;
    insert_block(&pool, "RS3944", "content", "root", Some("AS3944")).await;
    insert_block(&pool, "OU3944", "page", "outside", None).await;
    insert_tag_assoc(&pool, "AS3944", "TS3944").await;
    soft_delete(&pool, "RS3944").await;

    // Legacy rows of exactly the two shapes pre-#3944 code could leave behind:
    // one ON the tombstone, one attributed TO it.
    sqlx::query(
        "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         VALUES ('RS3944', 'TS3944', 'AS3944'), ('OU3944', 'TS3944', 'RS3944')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "RS3944")
        .await
        .unwrap();
    drop(conn);
    let incremental = get_inherited(&pool).await;

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    assert!(
        rebuilt.is_empty(),
        "precondition: the arbiter emits neither a row ON a tombstone nor one \
         attributed TO it; got: {rebuilt:?}"
    );
    assert_eq!(
        incremental, rebuilt,
        "#3944: step 1 must still sweep the tombstoned root's own rows once \
         the seed filter empties `subtree` — they are unconditionally stale \
         and nothing re-inserts them"
    );
}

/// #3944 — the counter-test: `tag_inh_subtree_active!`'s seed must NOT filter
/// `?1`, or a recompute rooted at a tombstone strands rows and the
/// incremental path yields MORE than `rebuild_all`.
///
/// The symmetric-looking change — "make BOTH root-seeded walks refuse a
/// soft-deleted `?1`" — is wrong, and wrong in a way no other test in this
/// file catches. `tag_inh_subtree_active!` is not only an INSERT source: it
/// scopes `recompute_subtree_inheritance`'s two step-1 DELETEs. Filtering its
/// seed empties `subtree` for a tombstoned root, which turns the whole helper
/// into a no-op — and a no-op is not the arbiter's answer, because the helper
/// is a from-scratch REPAIR PASS over the root's subtree, and a tombstone can
/// have a LIVE descendant subtree whose rows a structural change strictly
/// BELOW it has invalidated.
///
/// `AX3944B[#T1] > RB3944B(deleted) > DL3944B(live)[#T2] > EL3944B(live)`,
/// converged at `(EL3944B, T2, DL3944B)`. Then `EL3944B` moves out from under
/// the tagged `DL3944B` to directly under the tombstone, so the arbiter's
/// answer becomes empty — and only a recompute rooted at `RB3944B` can sweep
/// the row, because `loro_sync`'s `TagScope::Subtrees` dedupes a batch's
/// structural roots to the TOP-MOST one.
///
/// Measured on the three variants:
///   * pre-#3944:                      incremental = 3 wrong rows  (AGREE=false)
///   * with the `subtree_active` seed filtered: 1 stranded row     (AGREE=false)
///   * shipped (ancestor seed only):   incremental = []            (AGREE=true)
#[tokio::test]
async fn recompute_at_tombstone_after_structural_change_below_matches_rebuild_3944() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "T13944B", "tag", "t1", None).await;
    insert_block(&pool, "T23944B", "tag", "t2", None).await;
    insert_block(&pool, "AX3944B", "page", "apex", None).await;
    insert_block(&pool, "RB3944B", "content", "root", Some("AX3944B")).await;
    insert_block(&pool, "DL3944B", "content", "live-desc", Some("RB3944B")).await;
    insert_block(&pool, "EL3944B", "content", "leaf", Some("DL3944B")).await;
    insert_tag_assoc(&pool, "AX3944B", "T13944B").await;
    insert_tag_assoc(&pool, "DL3944B", "T23944B").await;
    soft_delete(&pool, "RB3944B").await;

    rebuild_all(&pool).await.unwrap();
    let converged = get_inherited(&pool).await;
    assert_eq!(
        converged,
        vec![(
            "EL3944B".to_string(),
            "T23944B".to_string(),
            "DL3944B".to_string()
        )],
        "precondition: the tombstone's live subtree is converged with the \
         arbiter before the move; got: {converged:?}"
    );

    // A structural change strictly BELOW the tombstone: the leaf leaves the
    // tagged DL3944B and reattaches directly under the tombstoned root. Its
    // inherited row is now stale and NOTHING else will sweep it — RemoveTag
    // and MoveBlock carry no `RebuildTagInheritanceCache` fan-out (#2669).
    sqlx::query("UPDATE blocks SET parent_id = 'RB3944B' WHERE id = 'EL3944B'")
        .execute(&pool)
        .await
        .unwrap();

    let mut conn = pool.acquire().await.unwrap();
    recompute_subtree_inheritance(&mut conn, "RB3944B")
        .await
        .unwrap();
    drop(conn);
    let incremental = get_inherited(&pool).await;

    rebuild_all(&pool).await.unwrap();
    let rebuilt = get_inherited(&pool).await;

    assert!(
        rebuilt.is_empty(),
        "precondition: with the leaf out from under the only reachable tagger, \
         the arbiter yields nothing; got: {rebuilt:?}"
    );
    assert_eq!(
        incremental, rebuilt,
        "#3944: a recompute rooted at a TOMBSTONE must still sweep its LIVE \
         subtree — filtering `tag_inh_subtree_active!`'s seed makes this a \
         no-op and strands the leaf's stale row, which is a divergence in the \
         opposite direction to the one #3944 closed"
    );
}
