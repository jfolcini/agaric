use super::*;
use crate::db::init_pool;
use sqlx::SqlitePool;
use tempfile::TempDir;

// -- Helpers --

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

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
    use crate::ulid::BlockId;
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
    use crate::ulid::BlockId;
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
    use crate::ulid::BlockId;
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
