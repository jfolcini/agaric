use super::*;
use crate::db::init_pool;
use crate::loro::shared::LoroState;
use crate::op::OpPayload;
use crate::space::SpaceId;
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use tempfile::TempDir;

const PAGE_ID: &str = "01HZ00000000000000000603PG";
const SPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const DEVICE_ID: &str = "device-sibling-order-603";
// Creation (and therefore ULID/lexicographic) order: A < B < C. The
// expected FINAL sibling order is the reverse, [C, B, A], so any
// legacy-path convergence toward ULID order trips the assertions.
const BLOCK_A: &str = "01HZ00000000000000000603QA";
const BLOCK_B: &str = "01HZ00000000000000000603QB";
const BLOCK_C: &str = "01HZ00000000000000000603QC";

async fn fresh_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("sibling_order_603.db");
    let pool = init_pool(&db_path).await.expect("init_pool");
    (pool, dir)
}

/// Seed SQL with the space block + an empty page whose
/// `blocks.space_id` resolves to `SPACE` (#533 column-only
/// membership), and seed the engine with the same page so create
/// ops can anchor on it.
async fn seed_page(pool: &SqlitePool, state: &LoroState) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
    )
    .bind(SPACE)
    .execute(pool)
    .await
    .expect("seed space block");
    // #708: `blocks.space_id` REFERENCES spaces(id) since migration 0089 —
    // register the space before stamping memberships.
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SPACE)
        .execute(pool)
        .await
        .expect("register space");
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, \
                                 space_id) \
             VALUES (?, 'page', 'P', NULL, 0, ?, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .bind(SPACE)
    .execute(pool)
    .await
    .expect("seed page");

    let space = SpaceId::from_trusted(SPACE);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    guard
        .engine_mut()
        .apply_create_block(PAGE_ID, "page", "P", None, 0)
        .expect("seed engine page");
}

/// Append `payload` to op_log and drive it through the FULL
/// `apply_op` path — in-tx engine apply, cursor advance, commit,
/// post-commit fanout — exactly like the production consumer.
async fn apply(pool: &SqlitePool, payload: OpPayload) {
    let record = std::sync::Arc::new(
        crate::op_log::append_local_op(pool, DEVICE_ID, payload)
            .await
            .expect("append op_log"),
    );
    let dirty_sink: OnceLock<std::sync::Arc<dyn DirtySink + Send + Sync>> = OnceLock::new();
    super::apply_op(pool, &record, &dirty_sink)
        .await
        .expect("apply_op");
}

fn new_scheme_create(block_id: &str, index: i64) -> OpPayload {
    OpPayload::CreateBlock(crate::op::CreateBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        block_type: "content".into(),
        parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        position: None,
        index: Some(index),
        content: "c".into(),
    })
}

fn engine_children(state: &LoroState) -> Vec<String> {
    let space = SpaceId::from_trusted(SPACE);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    guard
        .engine_mut()
        .children_ordered_block_ids(Some(PAGE_ID))
        .expect("children_ordered_block_ids")
}

async fn sql_children(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_as::<_, (String,)>(
        "SELECT id FROM blocks WHERE parent_id = ? ORDER BY position, id",
    )
    .bind(PAGE_ID)
    .fetch_all(pool)
    .await
    .expect("sql children")
    .into_iter()
    .map(|(id,)| id)
    .collect()
}

/// ≥2 new-scheme creates plus a new-scheme move through the FULL
/// `apply_op` path. After every step the engine sibling order must
/// equal SQL `ORDER BY position`, and the final order must be the
/// user's order ([C, B, A] — the reverse of ULID order).
///
/// NOTE (verified empirically): this lockstep test does NOT fail on
/// the pre-#603 code by itself — in this fresh-apply harness the
/// created rows carry no `page_id`/`space_id` at post-commit
/// re-dispatch time, so the old `dispatch_for_record` skipped the
/// creates on space resolution (the same skip-equivalence that
/// justifies its removal), and the legacy move re-apply is harmless
/// when siblings carry no legacy position meta. The pre-fix-failing
/// regression net for #603 is
/// `recovery::tests::boot_replay_preserves_new_scheme_sibling_order_603`
/// (rows pre-stamped, re-dispatch resolved and scrambled) plus the
/// `engine_apply` routing unit tests in `merge::apply`. This test
/// guards the invariant going forward: engine order == SQL order
/// through the full production apply path.
#[tokio::test]
async fn full_apply_op_keeps_engine_and_sql_sibling_order_in_lockstep() {
    let (pool, _dir) = fresh_pool().await;
    let state = crate::loro::shared::install_for_test();
    seed_page(&pool, state).await;

    // A appended at slot 0.
    apply(&pool, new_scheme_create(BLOCK_A, 0)).await;
    // B inserted ABOVE A (insert-above) → [B, A].
    apply(&pool, new_scheme_create(BLOCK_B, 0)).await;
    assert_eq!(
        engine_children(state),
        vec![BLOCK_B.to_string(), BLOCK_A.to_string()],
        "after 2 new-scheme creates the engine must hold the user's \
             order, not ULID order",
    );
    // C inserted between → [B, C, A].
    apply(&pool, new_scheme_create(BLOCK_C, 1)).await;
    assert_eq!(
        engine_children(state),
        vec![
            BLOCK_B.to_string(),
            BLOCK_C.to_string(),
            BLOCK_A.to_string()
        ],
    );
    assert_eq!(
        engine_children(state),
        sql_children(&pool).await,
        "engine order and SQL ORDER BY position must agree after creates",
    );

    // Stamp `page_id`/`space_id` on the created children: the apply
    // projection inserts neither (#533 space propagation runs
    // outside this path), and the MoveBlock below anchors space
    // resolution on the moved block itself. Mirrors the stamping
    // the engine-path tests do for the same reason.
    for id in [BLOCK_A, BLOCK_B, BLOCK_C] {
        sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
            .bind(PAGE_ID)
            .bind(SPACE)
            .bind(id)
            .execute(&pool)
            .await
            .expect("stamp page_id/space_id");
    }

    // Move C to the top (new-scheme `new_index`; the legacy
    // `new_position` breadcrumb is junk on purpose so any code
    // path routing on it is caught) → [C, B, A].
    apply(
        &pool,
        OpPayload::MoveBlock(crate::op::MoveBlockPayload {
            block_id: BlockId::from_trusted(BLOCK_C),
            new_parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            new_position: 99,
            new_index: Some(0),
        }),
    )
    .await;

    let expected = vec![
        BLOCK_C.to_string(),
        BLOCK_B.to_string(),
        BLOCK_A.to_string(),
    ];
    assert_eq!(
        engine_children(state),
        expected,
        "engine must hold the user's final order (reverse of ULID order)",
    );
    assert_eq!(
        sql_children(&pool).await,
        expected,
        "SQL ORDER BY position must match the engine's final order",
    );
}
