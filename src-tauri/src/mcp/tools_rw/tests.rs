use super::*;
use crate::commands::{create_block_inner, restore_block_inner};
use crate::db::init_pool;
use crate::materializer::Materializer;
use crate::mcp::actor::Actor;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tempfile::TempDir;

const DEV: &str = "test-mcp-rw-dev";

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

fn test_ctx_agent() -> ActorContext {
    ActorContext {
        actor: Actor::Agent {
            name: "test-agent".to_string(),
        },
        request_id: "req-rw".to_string(),
    }
}

async fn mk_tools() -> (ReadWriteTools, Materializer, SqlitePool, TempDir) {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let tools = ReadWriteTools::new(pool.clone(), mat.clone(), DEV.to_string());
    (tools, mat, pool, dir)
}

async fn settle(mat: &Materializer) {
    mat.flush_background().await.unwrap();
}

// -------------------------------------------------------------------
// list_tools — snapshot of the 6-tool wire contract
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tools_advertises_six_tools() {
    let (tools, _mat, _pool, _dir) = mk_tools().await;
    let descs = tools.list_tools();
    let names: Vec<&str> = descs.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(
        names.len(),
        6,
        "ReadWriteTools exposes exactly six v2 tools"
    );
    assert_eq!(
        names,
        vec![
            "append_block",
            "update_block_content",
            "set_property",
            "add_tag",
            "create_page",
            "delete_block",
        ],
        "tool order is part of the wire contract — do not re-order",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_tool_descriptions() {
    let (tools, _mat, _pool, _dir) = mk_tools().await;
    let descs = tools.list_tools();
    let wire: Value = serde_json::to_value(&descs).unwrap();
    insta::assert_yaml_snapshot!("tool_descriptions_rw", wire);
}

// -------------------------------------------------------------------
// append_block
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_happy_path() {
    let (tools, mat, pool, _dir) = mk_tools().await;
    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Parent".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "append_block",
            json!({"parent_id": parent.id.clone(), "content": "hello"}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["block_type"], "content");
    assert_eq!(result["parent_id"], parent.id);
    assert_eq!(result["content"], "hello");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_rejects_unknown_field() {
    let (tools, _mat, _pool, _dir) = mk_tools().await;
    let err = tools
        .call_tool("append_block", json!({"bogus": 1}), &test_ctx_agent())
        .await
        .expect_err("must reject unknown field");
    assert!(
        matches!(err, AppError::Validation(_)),
        "unknown-field must surface as Validation (→ -32602), got {err:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_missing_parent_id_returns_not_found() {
    let (tools, _mat, _pool, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "append_block",
            json!({"parent_id": "NONEXISTENT_PARENT_ULID", "content": "x"}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("unknown parent must error");
    assert!(
        matches!(err, AppError::NotFound(_)),
        "missing parent must surface as NotFound (→ -32001), got {err:?}",
    );
}

// -------------------------------------------------------------------
// update_block_content
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_block_content_happy_path() {
    let (tools, mat, pool, _dir) = mk_tools().await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "before".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "update_block_content",
            json!({"block_id": block.id.clone(), "content": "after"}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["id"], block.id);
    assert_eq!(result["content"], "after");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_block_content_missing_block_returns_not_found() {
    let (tools, _mat, _pool, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "update_block_content",
            json!({"block_id": "NOPE", "content": "x"}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("missing block");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_block_content_rejects_unknown_field() {
    let (tools, _mat, _pool, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "update_block_content",
            json!({"block_id": "A", "content": "b", "extra": true}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("unknown field");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

// -------------------------------------------------------------------
// set_property
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_happy_path() {
    let (tools, mat, pool, _dir) = mk_tools().await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // `assignee` is a text-typed built-in property (migration 0014)
    // — using it avoids conflating set_property dispatch with the
    // per-definition type validation.
    let result = tools
        .call_tool(
            "set_property",
            json!({
                "block_id": block.id.clone(),
                "key": "assignee",
                "value_text": "alice",
            }),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["id"], block.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_missing_block_returns_not_found() {
    let (tools, _mat, _pool, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "set_property",
            json!({"block_id": "NOPE", "key": "assignee", "value_text": "alice"}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("missing block");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_rejects_multiple_value_fields() {
    let (tools, mat, pool, _dir) = mk_tools().await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "set_property",
            json!({
                "block_id": block.id,
                "key": "assignee",
                "value_text": "alice",
                "value_num": 3.0,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("exactly one value must be set");
    assert!(
        matches!(err, AppError::Validation(_)),
        "double-value must surface as Validation, got {err:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_rejects_zero_value_fields() {
    let (tools, mat, pool, _dir) = mk_tools().await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "set_property",
            json!({"block_id": block.id, "key": "assignee"}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("zero values must error");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

// -------------------------------------------------------------------
// add_tag
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_happy_path() {
    let (tools, mat, pool, _dir) = mk_tools().await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "c".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let tag = create_block_inner(&pool, DEV, &mat, "tag".into(), "work".into(), None, None)
        .await
        .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "add_tag",
            json!({"block_id": block.id.clone(), "tag_id": tag.id.clone()}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["block_id"], block.id);
    assert_eq!(result["tag_id"], tag.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_missing_tag_returns_not_found() {
    let (tools, mat, pool, _dir) = mk_tools().await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "c".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "add_tag",
            json!({"block_id": block.id, "tag_id": "NONEXISTENT_TAG"}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("missing tag");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_non_tag_target_is_invalid_operation() {
    // Pass a content block as tag_id — must surface InvalidOperation,
    // confirming the tool does NOT create tags.
    let (tools, mat, pool, _dir) = mk_tools().await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "c".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let other = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "not-a-tag".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "add_tag",
            json!({"block_id": block.id, "tag_id": other.id}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("non-tag block as tag_id");
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "non-tag target must surface as InvalidOperation, got {err:?}",
    );
}

// -------------------------------------------------------------------
// create_page
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_page_happy_path_sets_block_type_page() {
    let (tools, _mat, _pool, _dir) = mk_tools().await;
    let result = tools
        .call_tool(
            "create_page",
            json!({"title": "My New Page"}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(
        result["block_type"], "page",
        "create_page must always produce a page block",
    );
    assert_eq!(result["content"], "My New Page");
    assert!(
        result["parent_id"].is_null(),
        "pages created via MCP are top-level (parent_id = null)",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_page_rejects_unknown_field() {
    let (tools, _mat, _pool, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "create_page",
            json!({"title": "X", "parent_id": "Y"}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("parent_id is not a valid field for create_page");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

// -------------------------------------------------------------------
// delete_block
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_happy_path() {
    let (tools, mat, pool, _dir) = mk_tools().await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "doomed".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "delete_block",
            json!({"block_id": block.id.clone()}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["block_id"], block.id);
    assert!(
        result["deleted_at"].is_string(),
        "delete_block must return a deleted_at timestamp for the restore ref",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_missing_returns_not_found() {
    let (tools, _mat, _pool, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "delete_block",
            json!({"block_id": "NOPE"}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("unknown block");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_already_deleted_is_invalid_operation() {
    let (tools, mat, pool, _dir) = mk_tools().await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "doomed".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    // First delete — should succeed.
    tools
        .call_tool(
            "delete_block",
            json!({"block_id": block.id.clone()}),
            &test_ctx_agent(),
        )
        .await
        .expect("first delete");
    // Second delete — InvalidOperation.
    let err = tools
        .call_tool(
            "delete_block",
            json!({"block_id": block.id}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("double delete must fail");
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "double-delete must surface as InvalidOperation, got {err:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_is_reversible_via_restore() {
    // The whole FEAT-4h contract hinges on "agents only get
    // reversible ops" — pin that every delete_block output can be
    // fed straight back to `restore_block_inner` to recover the
    // block.
    let (tools, mat, pool, _dir) = mk_tools().await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "recoverable".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let deleted = tools
        .call_tool(
            "delete_block",
            json!({"block_id": block.id.clone()}),
            &test_ctx_agent(),
        )
        .await
        .expect("delete");
    let deleted_at = deleted["deleted_at"]
        .as_str()
        .expect("deleted_at timestamp")
        .to_string();

    let restore = restore_block_inner(&pool, DEV, &mat, block.id.clone(), deleted_at).await;
    assert!(
        restore.is_ok(),
        "delete_block output must be usable as a restore ref: {restore:?}",
    );
}

// -------------------------------------------------------------------
// Unknown tool name → NotFound
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_tool_returns_not_found() {
    let (tools, _mat, _pool, _dir) = mk_tools().await;
    let err = tools
        .call_tool("no_such_tool", json!({}), &test_ctx_agent())
        .await
        .expect_err("unknown tool");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

// -------------------------------------------------------------------
// End-to-end attribution — FEAT-4h slice 1 + slice 2 integration
// -------------------------------------------------------------------

/// The whole point of slice 2: a write-tool invocation against an
/// agent ActorContext must land an `origin = 'agent:<name>'` row in
/// `op_log`. Removing this test drops the attribution guarantee on
/// the floor.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_stamps_origin_agent_in_op_log() {
    let (tools, mat, pool, _dir) = mk_tools().await;
    // Seed a parent page via the direct backend path — writes
    // origin='user' for that op.
    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "ParentPage".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Invoke the MCP write tool under an agent-scoped context.
    tools
        .call_tool(
            "append_block",
            json!({"parent_id": parent.id, "content": "agent-authored"}),
            &test_ctx_agent(),
        )
        .await
        .expect("agent append");

    // The most recent create_block op must be attributed to the
    // agent. An ORDER BY seq DESC avoids races with the seeded
    // parent op by picking the last write.
    let origin: String = sqlx::query_scalar(
        "SELECT origin FROM op_log WHERE op_type = 'create_block' ORDER BY seq DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        origin, "agent:test-agent",
        "agent-invoked append_block must stamp op_log.origin='agent:<clientInfo.name>'",
    );
}

/// Mirror for `delete_block` — the reversible delete path must also
/// stamp agent origin so activity-feed Undo can filter by it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_stamps_origin_agent_in_op_log() {
    let (tools, mat, pool, _dir) = mk_tools().await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "doomed".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    tools
        .call_tool(
            "delete_block",
            json!({"block_id": block.id.clone()}),
            &test_ctx_agent(),
        )
        .await
        .expect("agent delete");

    let origin: String = sqlx::query_scalar(
        "SELECT origin FROM op_log WHERE op_type = 'delete_block' ORDER BY seq DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        origin, "agent:test-agent",
        "agent-invoked delete_block must stamp op_log.origin='agent:<name>'",
    );
}

/// FEAT-4h slice 3: every RW-tool-written op must populate the
/// `LAST_APPEND` task-local so the dispatch layer can attach an
/// `OpRef` to the emitted `mcp:activity` entry. This test pins the
/// invariant by driving `append_block` inside an explicit
/// `LAST_APPEND.scope(...)` and draining the captured list after
/// the call.
///
/// L-114: today `append_block` is a single-op tool, so the drained
/// list contains exactly one entry. The test asserts the `len ==
/// 1` shape directly so a future regression that drops appends
/// (or doubles them) is caught here, not in the dispatch layer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_populates_last_append_inside_scope() {
    use crate::task_locals::{take_appends, LAST_APPEND};
    use std::cell::RefCell;

    let (tools, mat, pool, _dir) = mk_tools().await;
    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Parent".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let captured = LAST_APPEND
        .scope(RefCell::new(Vec::new()), async {
            tools
                .call_tool(
                    "append_block",
                    json!({"parent_id": parent.id.clone(), "content": "hello"}),
                    &test_ctx_agent(),
                )
                .await
                .expect("happy path");
            take_appends()
        })
        .await;

    assert_eq!(
        captured.len(),
        1,
        "append_block is a single-op tool — expected exactly one OpRef, got {captured:?}",
    );
    let op_ref = &captured[0];
    assert_eq!(
        op_ref.device_id, DEV,
        "op_ref.device_id must match the tools' configured device id",
    );
    assert!(
        op_ref.seq > 0,
        "op_ref.seq must be > 0 for a real append, got {}",
        op_ref.seq,
    );
}

// -------------------------------------------------------------------
// L-124: MCP-level concurrent-write stress test
//
// The RW handlers are 1:1 with `*_inner` calls, each opening its
// own `BEGIN IMMEDIATE` transaction. The inner-test level exercises
// `BEGIN IMMEDIATE` correctness, but no test interleaves multiple
// agent connections across `append_block` / `add_tag` / `delete_block`
// AT THE MCP BOUNDARY. This stress test fills that gap so a future
// refactor that bypassed the inner — or added an MCP-side cache that
// subverted `BEGIN IMMEDIATE` — would surface as duplicate-seq
// failures or FK violations under contention.
//
// Closes REVIEW-LATER L-124.
// -------------------------------------------------------------------

/// 4 agent connections × 6 iterations × `append_block + add_tag` plus
/// a single frontend-side writer doing 12 `create_block_inner` calls.
/// Total expected blocks: 4×6 (agent appends) + 12 (frontend) = 36.
/// All ops must succeed; final block count must match exactly; no FK
/// violations on the agent-tag join.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_rw_clients_serialize_correctly_l124() {
    use std::sync::Arc;

    let (tools, mat, pool, _dir) = mk_tools().await;

    // Seed: one page (parent_id for every append) + one tag.
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "L-124 stress page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let tag = create_block_inner(
        &pool,
        DEV,
        &mat,
        "tag".into(),
        "stress-tag".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let tools = Arc::new(tools);
    const AGENTS: usize = 4;
    const ITERS_PER_AGENT: usize = 6;
    const FRONTEND_ITERS: usize = 12;

    // Per-agent task: append a block, then add the seeded tag.
    let mut agent_handles = Vec::with_capacity(AGENTS);
    for agent_idx in 0..AGENTS {
        let tools = tools.clone();
        let parent_id = page.id.clone();
        let tag_id = tag.id.clone();
        agent_handles.push(tokio::spawn(async move {
            for iter in 0..ITERS_PER_AGENT {
                let ctx = ActorContext {
                    actor: Actor::Agent {
                        name: format!("stress-agent-{agent_idx}"),
                    },
                    request_id: format!("a{agent_idx}-i{iter}"),
                };
                let append_resp = tools
                    .call_tool(
                        "append_block",
                        json!({
                            "parent_id": parent_id,
                            "content": format!("agent {agent_idx} block {iter}"),
                        }),
                        &ctx,
                    )
                    .await
                    .unwrap_or_else(|e| {
                        panic!("append_block failed (agent {agent_idx}, iter {iter}): {e:?}")
                    });
                let block_id = append_resp["id"].as_str().unwrap().to_string();
                tools
                    .call_tool(
                        "add_tag",
                        json!({"block_id": block_id, "tag_id": tag_id}),
                        &ctx,
                    )
                    .await
                    .unwrap_or_else(|e| {
                        panic!("add_tag failed (agent {agent_idx}, iter {iter}): {e:?}")
                    });
            }
        }));
    }

    // Concurrent frontend writer (uses *_inner directly, simulating
    // the Tauri command path). Mirrors the pattern in
    // `concurrent_appends_same_device_serialize_correctly`.
    let frontend_handle = {
        let pool = pool.clone();
        let mat = mat.clone();
        let parent_id = page.id.clone();
        tokio::spawn(async move {
            for iter in 0..FRONTEND_ITERS {
                create_block_inner(
                    &pool,
                    DEV,
                    &mat,
                    "content".into(),
                    format!("frontend block {iter}"),
                    Some(parent_id.clone()),
                    Some((iter + 100) as i64),
                )
                .await
                .unwrap_or_else(|e| panic!("frontend create failed (iter {iter}): {e:?}"));
            }
        })
    };

    for h in agent_handles {
        h.await.expect("agent task joined");
    }
    frontend_handle.await.expect("frontend task joined");
    settle(&mat).await;

    // Assert exact final block count: 1 page + 1 tag + 4×6 agent blocks
    // + 12 frontend blocks = 38.
    let total_blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    let expected = 2 + AGENTS * ITERS_PER_AGENT + FRONTEND_ITERS;
    assert_eq!(
        total_blocks as usize, expected,
        "concurrent agent + frontend writes must produce exact block count \
         (1 page + 1 tag + {AGENTS}×{ITERS_PER_AGENT} agent + {FRONTEND_ITERS} frontend = {expected})",
    );

    // Assert every agent-created block has the seeded tag — proves
    // `add_tag` was not lost under contention. Frontend blocks have
    // no tag, so we count agent-created blocks via a pattern match
    // on content.
    let agent_blocks_with_tag: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tags bt \
         JOIN blocks b ON b.id = bt.block_id \
         WHERE bt.tag_id = ? AND b.content LIKE 'agent %'",
    )
    .bind(&tag.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        agent_blocks_with_tag as usize,
        AGENTS * ITERS_PER_AGENT,
        "every agent block must carry the seeded tag — add_tag must not be lost under contention",
    );

    // Assert no FK violations or orphan rows: every block_tags row
    // references real blocks.
    let orphan_tag_refs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tags bt \
         WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.id = bt.block_id)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        orphan_tag_refs, 0,
        "no block_tags rows may reference missing blocks (FK invariant)"
    );

    // op_log monotonicity: every (device_id, seq) pair is unique.
    let dup_ops: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM (\
            SELECT device_id, seq, COUNT(*) c FROM op_log \
            GROUP BY device_id, seq HAVING c > 1\
         )",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        dup_ops, 0,
        "op_log must contain no duplicate (device_id, seq) pairs under contention"
    );
}
