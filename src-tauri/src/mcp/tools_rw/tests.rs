use super::*;
use crate::commands::{
    create_block_inner, create_block_inner_with_space, create_space_inner, restore_block_inner,
};
use crate::db::init_pool;
use crate::materializer::Materializer;
use agaric_store::space::{SpaceId, SpaceScope};
use agaric_store::task_locals::Actor;
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

/// +C2: create a fresh space and return its ULID. Every rw
/// tool now requires a `space_id` argument, so the per-test fixture
/// seeds at least one real space block (with `is_space = 'true'`) so
/// the helper's `validate_block_in_space` lookup has something to
/// match.
async fn mk_space(pool: &SqlitePool, name: &str) -> String {
    let materializer = Materializer::new(pool.clone());
    create_space_inner(pool, DEV, &materializer, name.into(), None)
        .await
        .expect("create_space must succeed")
        .into_string()
}

/// Shorthand for the per-test fixture. Returns
/// `(tools, materializer, pool, space_id, tempdir)` so every test
/// can thread a real space ULID through the rw tool calls.
async fn mk_tools() -> (ReadWriteTools, Materializer, SqlitePool, String, TempDir) {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let tools = ReadWriteTools::new(pool.clone(), pool.clone(), mat.clone(), DEV.to_string());
    let space_id = mk_space(&pool, " test space").await;
    (tools, mat, pool, space_id, dir)
}

async fn settle(mat: &Materializer) {
    mat.flush_background().await.unwrap();
}

// -------------------------------------------------------------------
// list_tools — snapshot of the wire contract
// -------------------------------------------------------------------

/// The write tools in their order, then every read-only tool in RO's order,
/// each name once (#5379).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tools_advertises_the_rw_tools() {
    let (tools, _mat, _pool, _space, _dir) = mk_tools().await;
    let descs = tools.list_tools();
    let names: Vec<&str> = descs.iter().map(|d| d.name.as_str()).collect();
    let ro = crate::mcp::tools_ro::list_tool_descriptions();
    let mut expected = vec![
        "append_block",
        "update_block_content",
        "set_property",
        "add_tag",
        "create_page",
        "delete_block",
        "append_markdown",
        "move_page_to_space",
        "create_tag",
        "delete_property",
        "undo",
        "capture",
        "move_blocks",
        "remove_tag",
        "restore_block",
        "batch",
        "edit_page_markdown",
        "set_page_aliases",
    ];
    expected.extend(ro.iter().map(|d| d.name.as_str()));
    assert_eq!(
        names, expected,
        "tool order is part of the wire contract: write tools, then the read-only ones",
    );
    let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
    assert_eq!(
        unique.len(),
        names.len(),
        "a tool is listed twice: {names:?}"
    );
}

#[test]
fn snapshot_tool_descriptions() {
    // The read tools' descriptions are `tools_ro`'s snapshot.
    let descs = write_tool_descriptions();
    let wire: Value = serde_json::to_value(&descs).unwrap();
    insta::assert_yaml_snapshot!("tool_descriptions_rw", wire);
}

// -------------------------------------------------------------------
// append_block
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_happy_path() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let parent = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Parent".into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(&space)),
        // #2849 PR2: server-generated id (test).
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "append_block",
            json!({"parent_id": parent.id.clone(), "content": "hello", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["block_type"], "content");
    assert_eq!(result["parent_id"], parent.id.as_str());
    assert_eq!(result["content"], "hello");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_rejects_unknown_field() {
    let (tools, _mat, _pool, _space, _dir) = mk_tools().await;
    let err = tools
        .call_tool("append_block", json!({"bogus": 1}), &test_ctx_agent())
        .await
        .expect_err("must reject unknown field");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "unknown-field must surface as Validation (→ -32602), got {err:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_missing_parent_id_returns_not_found() {
    let (tools, _mat, _pool, space, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "append_block",
            json!({"parent_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "content": "x", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("unknown parent must error");
    assert!(
        matches!(err, AppError::NotFound(_)),
        "missing parent must surface as NotFound (→ -32001), got {err:?}",
    );
}

/// #1606: the schema declares `position` `minimum: 1`, but serde does not
/// honour JSON-Schema constraints. `position: 0` must now be rejected loudly
/// with a Validation error (→ -32602) instead of being silently clamped to
/// the first child.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_position_zero_rejected() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let parent = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Parent".into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(&space)),
        // #2849 PR2: server-generated id (test).
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "append_block",
            json!({"parent_id": parent.id.clone(), "content": "x", "position": 0, "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("position 0 must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "position 0 must surface as Validation (→ -32602), got {err:?}",
    );
}

/// #1606: a negative `position` (e.g. an LLM agent emitting -5) must also be
/// rejected loudly rather than clamped, and never reaches the `saturating_sub`
/// underflow backstop.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_negative_position_rejected() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let parent = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Parent".into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(&space)),
        // #2849 PR2: server-generated id (test).
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "append_block",
            json!({"parent_id": parent.id.clone(), "content": "x", "position": -5, "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("negative position must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "negative position must surface as Validation (→ -32602), got {err:?}",
    );
}

/// #1606: `position: 1` is the smallest valid 1-based position and must still
/// succeed, mapping to index 0 (the first child).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_position_one_maps_to_first_child() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let parent = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Parent".into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(&space)),
        // #2849 PR2: server-generated id (test).
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "append_block",
            json!({"parent_id": parent.id.clone(), "content": "first", "position": 1, "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("position 1 must succeed");
    assert_eq!(result["parent_id"], parent.id.as_str());
    assert_eq!(result["content"], "first");
}

// -------------------------------------------------------------------
// append_markdown (#5376)
// -------------------------------------------------------------------

/// The live children of `parent`, as their content, in order.
async fn child_contents(pool: &SqlitePool, parent: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT content FROM blocks WHERE parent_id = ? AND deleted_at IS NULL \
         ORDER BY position, id",
    )
    .bind(parent)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_markdown_lands_the_outline_at_its_position() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let page = mk_page(&pool, &mat, &space, "Page").await;
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "last".into(),
        Some(BlockId::from_trusted(&page)),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "append_markdown",
            json!({
                "parent_id": page.to_lowercase(),
                "markdown": "# Head\n\n- item\n",
                "position": 1,
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    settle(&mat).await;

    let blocks = result["blocks"].as_array().expect("blocks array");
    assert_eq!(blocks.len(), 2, "the heading and its item, got {blocks:?}");
    assert_eq!(blocks[0]["parent_id"], page.as_str());
    assert_eq!(
        blocks[1]["parent_id"], blocks[0]["id"],
        "the item nests under the heading"
    );
    assert_eq!(
        child_contents(&pool, &page).await,
        ["# Head", "last"],
        "position 1 lands the outline before the existing child"
    );
    assert_eq!(emitter.blocks_changed(), vec![vec![page.clone()]]);

    let err = tools
        .call_tool(
            "append_markdown",
            json!({"parent_id": page, "markdown": "- x", "position": 0, "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("position 0 must be rejected");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_markdown_cross_space_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let page_b = mk_page(&pool, &mat, &space_b, "PageB").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "append_markdown",
            json!({"parent_id": page_b, "markdown": "- x", "space_id": space_a}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("cross-space append must be denied");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "cross-space append must surface as Validation (→ -32602), got {err:?}",
    );
    assert!(
        child_contents(&pool, &page_b).await.is_empty(),
        "nothing was appended"
    );
}

// -------------------------------------------------------------------
// update_block_content
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_block_content_happy_path() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    // Edited block lives under a page in the test space so its
    // owning page carries `space = <space>` per validate_block_in_space.
    let parent = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "ParentPage".into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(&space)),
        // #2849 PR2: server-generated id (test).
        None,
    )
    .await
    .unwrap();
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "before".into(),
        Some(parent.id),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "update_block_content",
            json!({"block_id": block.id.clone(), "content": "after", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["id"], block.id.as_str());
    assert_eq!(result["content"], "after");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_block_content_missing_block_returns_not_found() {
    let (tools, _mat, _pool, space, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "update_block_content",
            json!({"block_id": "NOPE", "content": "x", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("missing block");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_block_content_rejects_unknown_field() {
    let (tools, _mat, _pool, space, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "update_block_content",
            json!({"block_id": "A", "content": "b", "space_id": space, "extra": true}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("unknown field");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

// -------------------------------------------------------------------
// set_property
// -------------------------------------------------------------------

/// Helper that creates a parent page in `space` and a content
/// block under it, returning the content block's row. Used by every
/// set_property / delete_block test that needs an in-space target.
async fn mk_in_space_content_block(
    pool: &SqlitePool,
    mat: &Materializer,
    space: &str,
    content: &str,
) -> agaric_store::pagination::BlockRow {
    let parent = create_block_inner_with_space(
        pool,
        DEV,
        mat,
        "page".into(),
        "ParentPage".into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(space)),
        // #2849 PR2: server-generated id (test).
        None,
    )
    .await
    .unwrap();
    create_block_inner(
        pool,
        DEV,
        mat,
        "content".into(),
        content.into(),
        Some(parent.id),
        Some(1),
    )
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_happy_path() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "task").await;
    settle(&mat).await;

    // `assignee` is a text-typed default definition (migration 0014)
    // — using it avoids conflating set_property dispatch with the
    // per-definition type validation.
    let result = tools
        .call_tool(
            "set_property",
            json!({
                "block_id": block.id.clone(),
                "key": "assignee",
                "value_text": "alice",
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["id"], block.id.as_str());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_missing_block_returns_not_found() {
    let (tools, _mat, _pool, space, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "set_property",
            json!({"block_id": "NOPE", "key": "assignee", "value_text": "alice", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("missing block");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_rejects_multiple_value_fields() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "task").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "set_property",
            json!({
                "block_id": block.id,
                "key": "assignee",
                "value_text": "alice",
                "value_num": 3.0,
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("exactly one value must be set");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "double-value must surface as Validation, got {err:?}",
    );
}

/// #697 happy path: `value_bool` is accepted at the MCP boundary and
/// threads through to a `value_type = 'boolean'` definition. Before
/// The fix, `deny_unknown_fields` rejected the very slot the
/// error message told the agent to use.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_accepts_value_bool_697() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "task").await;
    // Boolean-typed definition so the value lands in value_bool.
    crate::commands::create_property_def_inner(
        &pool,
        DEV,
        &mat,
        &space,
        "archived".into(),
        "boolean".into(),
        None,
    )
    .await
    .expect("boolean property def");
    settle(&mat).await;

    let result = tools
        .call_tool(
            "set_property",
            json!({
                "block_id": block.id.clone(),
                "key": "archived",
                "value_bool": true,
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect("#697: value_bool must be accepted at the MCP boundary");
    assert_eq!(result["id"], block.id.as_str());
    settle(&mat).await;

    let stored: Option<bool> = sqlx::query_scalar(
        "SELECT value_bool FROM block_properties WHERE block_id = ? AND key = 'archived'",
    )
    .bind(block.id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, Some(true), "value_bool must land in the bool slot");
}

/// #697 schema/message coherence: the error for a zero-value call
/// advertises value_bool — assert the advertised slot now parses (i.e.
/// the schema lists it and serde accepts it alongside the other four).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_error_message_slots_match_schema_697() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "task").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "set_property",
            json!({"block_id": block.id.clone(), "key": "assignee", "space_id": &space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("zero values must error");
    let AppError::Validation { message: msg, .. } = err else {
        panic!("expected Validation");
    };
    assert!(
        msg.contains("value_bool"),
        " message advertises value_bool: {msg}"
    );

    // Every slot named in the message must be a schema property —
    // an agent that follows the error must not hit a parse failure.
    let desc = tool_desc_set_property();
    let props = desc.input_schema["properties"]
        .as_object()
        .expect("schema properties");
    for slot in [
        "value_text",
        "value_num",
        "value_date",
        "value_ref",
        "value_bool",
    ] {
        assert!(
            msg.contains(slot),
            " message must advertise `{slot}`: {msg}"
        );
        assert!(
            props.contains_key(slot),
            "schema must accept advertised slot `{slot}` (#697)"
        );
    }
}

/// #697: providing value_bool alongside another slot still trips the
/// exactly-one invariant (value_bool participates in the count).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_value_bool_counts_toward_exactly_one_697() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "task").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "set_property",
            json!({
                "block_id": block.id,
                "key": "assignee",
                "value_text": "alice",
                "value_bool": true,
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("two slots must error");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

// -------------------------------------------------------------------
// #699 — value_text size cap at the MCP boundary
// -------------------------------------------------------------------

/// #699: value_text larger than MAX_CONTENT_LENGTH (the cap the IPC
/// layer enforces on block content) is rejected with a Validation
/// error naming the cap, BEFORE any DB work.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_rejects_oversized_value_text_699() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "task").await;
    settle(&mat).await;

    let oversized = "x".repeat(crate::commands::MAX_CONTENT_LENGTH + 1);
    let err = tools
        .call_tool(
            "set_property",
            json!({
                "block_id": block.id,
                "key": "assignee",
                "value_text": oversized,
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("oversized value_text must be rejected (#699)");
    match err {
        AppError::Validation { message: msg, .. } => {
            assert!(
                msg.contains("value_text length"),
                "message names the field: {msg}"
            );
            assert!(
                msg.contains(&crate::commands::MAX_CONTENT_LENGTH.to_string()),
                "message names the cap: {msg}"
            );
        }
        other => panic!("expected Validation, got {other:?}"),
    }
}

/// #699 boundary: a value_text of exactly MAX_CONTENT_LENGTH bytes
/// passes the boundary check (parity with the block-content cap, which
/// is exclusive at `> MAX_CONTENT_LENGTH`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_accepts_value_text_at_cap_699() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "task").await;
    settle(&mat).await;

    let at_cap = "x".repeat(crate::commands::MAX_CONTENT_LENGTH);
    let result = tools
        .call_tool(
            "set_property",
            json!({
                "block_id": block.id.clone(),
                "key": "assignee",
                "value_text": at_cap,
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect("value_text at exactly the cap must pass the boundary check");
    assert_eq!(result["id"], block.id.as_str());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_rejects_zero_value_fields() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "task").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "set_property",
            json!({"block_id": block.id, "key": "assignee", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("zero values must error");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

// -------------------------------------------------------------------
// add_tag
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_happy_path() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "c").await;
    let tag = create_block_inner(&pool, DEV, &mat, "tag".into(), "work".into(), None, None)
        .await
        .unwrap();
    // Phase 2: tags must be in the same space as the source block
    set_property_inner(
        &pool,
        DEV,
        &mat,
        tag.id.as_str().into(),
        "space".into(),
        None,
        None,
        None,
        Some(space.clone()),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "add_tag",
            json!({"block_id": block.id.clone(), "tag_id": tag.id.clone(), "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["block_id"], block.id.as_str());
    assert_eq!(result["tag_id"], tag.id.as_str());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_missing_tag_returns_not_found() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "c").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "add_tag",
            json!({"block_id": block.id, "tag_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "space_id": space}),
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
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let parent = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "ParentPage".into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(&space)),
        // #2849 PR2: server-generated id (test).
        None,
    )
    .await
    .unwrap();
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "c".into(),
        Some(parent.id.clone()),
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
        Some(parent.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "add_tag",
            json!({"block_id": block.id, "tag_id": other.id, "space_id": space}),
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
    let (tools, _mat, _pool, space, _dir) = mk_tools().await;
    let result = tools
        .call_tool(
            "create_page",
            json!({"title": "My New Page", "space_id": space}),
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
    let (tools, _mat, _pool, space, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "create_page",
            json!({"title": "X", "space_id": space, "parent_id": "Y"}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("parent_id is not a valid field for create_page");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

// -------------------------------------------------------------------
// Create_page enforces space_id
// -------------------------------------------------------------------

/// Invoking `create_page` with no `space_id` argument must
/// fail at parse_args (`-32602 invalid params`) — `space_id` is a
/// required field on the wire schema.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_page_without_space_rejected() {
    let (tools, _mat, _pool, _space, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "create_page",
            json!({"title": "Spaceless"}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("missing space_id must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "missing space_id must surface as Validation (→ -32602), got {err:?}",
    );
}

/// The page row must carry its space after a successful
/// create_page call. The bug this regression-tests for is the MCP path
/// bypassing `create_block_inner_with_space` so the page landed without
/// its space membership and dropped out of every space-scoped query
/// downstream. Phase 2 (#533): space membership is the `blocks.space_id`
/// column (the sole source of truth; the `block_properties(key='space')`
/// row was retired), so assert the page's `space_id`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_page_writes_space_property() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let result = tools
        .call_tool(
            "create_page",
            json!({"title": "Stamped", "space_id": &space}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    settle(&mat).await;

    let page_id = result["id"].as_str().expect("id in response").to_string();
    let stamped: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
        .bind(&page_id)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert_eq!(
        stamped.as_deref(),
        Some(space.as_str()),
        "create_page must stamp the page with `space_id = <space_id>`",
    );
}

// -------------------------------------------------------------------
// delete_block
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_happy_path() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "doomed").await;
    settle(&mat).await;

    let result = tools
        .call_tool(
            "delete_block",
            json!({"block_id": block.id.clone(), "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["block_id"], block.id.as_str());
    assert!(
        result["deleted_at"].is_i64(),
        "delete_block must return a deleted_at timestamp (epoch-ms) for the restore ref",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_missing_returns_not_found() {
    let (tools, _mat, _pool, space, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "delete_block",
            json!({"block_id": "NOPE", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("unknown block");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_already_deleted_is_invalid_operation() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "doomed").await;
    settle(&mat).await;
    // First delete — should succeed.
    tools
        .call_tool(
            "delete_block",
            json!({"block_id": block.id.clone(), "space_id": &space}),
            &test_ctx_agent(),
        )
        .await
        .expect("first delete");
    // Second delete — InvalidOperation.
    let err = tools
        .call_tool(
            "delete_block",
            json!({"block_id": block.id, "space_id": space}),
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
    // The whole contract hinges on "agents only get
    // reversible ops" — pin that every delete_block output can be
    // fed straight back to `restore_block_inner` to recover the
    // block.
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "recoverable").await;
    settle(&mat).await;

    let deleted = tools
        .call_tool(
            "delete_block",
            json!({"block_id": block.id.clone(), "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("delete");
    let deleted_at = deleted["deleted_at"]
        .as_i64()
        .expect("deleted_at timestamp");

    let restore = restore_block_inner(&pool, DEV, &mat, block.id, deleted_at).await;
    assert!(
        restore.is_ok(),
        "delete_block output must be usable as a restore ref: {restore:?}",
    );
}

// -------------------------------------------------------------------
// #2728 — list_spaces on the RW registry (RW-only space discovery)
// -------------------------------------------------------------------

/// #2728 happy path: `list_spaces` dispatched through the RW registry
/// returns the same `{ id, name, is_default }` rows the RO surface
/// returns, proving the RW dispatcher reaches the shared
/// `list_spaces_registry_inner` data function rather than a stub. Also
/// pins the discovery loop the issue is about: an RW-only agent (no RO
/// socket) can take an id straight out of `list_spaces` and use it as the
/// `space_id` argument of a genuine write tool.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_spaces_happy_path_returns_spaces_with_default_flag() {
    // Use a bare pool (not `mk_tools`, which auto-seeds one space) so the
    // row count/order assertions below match the RO surface's equivalent
    // test exactly.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let tools = ReadWriteTools::new(pool.clone(), pool.clone(), mat.clone(), DEV.to_string());
    crate::spaces::bootstrap_spaces_for_test(&pool, DEV)
        .await
        .unwrap();

    let result = tools
        .call_tool("list_spaces", json!({}), &test_ctx_agent())
        .await
        .expect("happy path");
    let rows = result.as_array().expect("list_spaces returns a JSON array");
    assert_eq!(rows.len(), 2, "bootstrap seeds exactly two spaces");

    let names: Vec<&str> = rows
        .iter()
        .map(|r| r["name"].as_str().expect("name string"))
        .collect();
    assert_eq!(names, vec!["Personal", "Work"], "alphabetical by name");

    let personal = &rows[0];
    assert_eq!(
        personal["id"].as_str(),
        Some(crate::spaces::SPACE_PERSONAL_ULID),
        "Personal carries the reserved seeded ULID",
    );
    assert_eq!(
        personal["is_default"],
        json!(true),
        "Personal is the default space",
    );
    assert_eq!(
        rows[1]["is_default"],
        json!(false),
        "non-Personal spaces are not default",
    );

    // The bug this closes: before #2728, an agent connected solely to the
    // RW socket had no in-band way to learn a `space_id` at all. Prove the
    // id returned here is directly usable by a real write tool.
    let space_id = personal["id"].as_str().unwrap().to_string();
    let page = tools
        .call_tool(
            "create_page",
            json!({"title": "Discovered via RW list_spaces", "space_id": space_id}),
            &test_ctx_agent(),
        )
        .await
        .expect("a list_spaces id must satisfy a space_id-requiring RW tool");
    assert_eq!(page["block_type"], "page");
}

// -------------------------------------------------------------------
// Unknown tool name → NotFound
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_tool_returns_not_found() {
    let (tools, _mat, _pool, _space, _dir) = mk_tools().await;
    let err = tools
        .call_tool("no_such_tool", json!({}), &test_ctx_agent())
        .await
        .expect_err("unknown tool");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

// -------------------------------------------------------------------
// End-to-end attribution — slice 1 + slice 2 integration
// -------------------------------------------------------------------

/// The whole point of slice 2: a write-tool invocation against an
/// agent ActorContext must land an `origin = 'agent:<name>'` row in
/// `op_log`. Removing this test drops the attribution guarantee on
/// the floor.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_stamps_origin_agent_in_op_log() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    // Seed a parent page via the direct backend path — writes
    // origin='user' for that op.
    let parent = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "ParentPage".into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(&space)),
        // #2849 PR2: server-generated id (test).
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Invoke the MCP write tool under an agent-scoped context.
    tools
        .call_tool(
            "append_block",
            json!({"parent_id": parent.id, "content": "agent-authored", "space_id": space}),
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
        "agent-invoked append_block must stamp op_log.origin='agent:<name>'",
    );
}

/// Mirror for `delete_block` — the reversible delete path must also
/// stamp agent origin so activity-feed Undo can filter by it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_stamps_origin_agent_in_op_log() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "doomed").await;
    settle(&mat).await;

    tools
        .call_tool(
            "delete_block",
            json!({"block_id": block.id.clone(), "space_id": space}),
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

/// Slice 3: every RW-tool-written op must populate the
/// `LAST_APPEND` task-local so the dispatch layer can attach an
/// `OpRef` to the emitted `mcp:activity` entry. This test pins the
/// invariant by driving `append_block` inside an explicit
/// `LAST_APPEND.scope(...)` and draining the captured list after
/// the call.
///
/// Today `append_block` is a single-op tool, so the drained
/// list contains exactly one entry. The test asserts the `len ==
/// 1` shape directly so a future regression that drops appends
/// (or doubles them) is caught here, not in the dispatch layer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_populates_last_append_inside_scope() {
    use agaric_store::task_locals::{LAST_APPEND, take_appends};
    use std::cell::RefCell;

    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let parent = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Parent".into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(&space)),
        // #2849 PR2: server-generated id (test).
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let captured = LAST_APPEND
        .scope(RefCell::new(Vec::new()), async {
            tools
                .call_tool(
                    "append_block",
                    json!({"parent_id": parent.id.clone(), "content": "hello", "space_id": space}),
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
// MCP-level concurrent-write stress test
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
// Closes.
// -------------------------------------------------------------------

/// 4 agent connections × 6 iterations × `append_block + add_tag` plus
/// a single frontend-side writer doing 12 `create_block_inner` calls.
/// Total expected blocks: 4×6 (agent appends) + 12 (frontend) = 36.
/// All ops must succeed; final block count must match exactly; no FK
/// violations on the agent-tag join.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_rw_clients_serialize_correctly_l124() {
    use std::sync::Arc;

    let (tools, mat, pool, space, _dir) = mk_tools().await;

    // Seed: one page (parent_id for every append) + one tag. The page
    // must live in the test space so the per-agent `append_block`
    // calls pass `validate_block_in_space`.
    let page = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        " stress page".into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(&space)),
        // #2849 PR2: server-generated id (test).
        None,
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
    // Phase 2: tags must be in the same space as the source block
    set_property_inner(
        &pool,
        DEV,
        &mat,
        tag.id.as_str().into(),
        "space".into(),
        None,
        None,
        None,
        Some(space.clone()),
        None,
        None,
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
        let space_id = space.clone();
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
                            "space_id": space_id,
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
                        json!({"block_id": block_id, "tag_id": tag_id, "space_id": space_id}),
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
                    Some(parent_id.as_str().into()),
                    Some(i64::try_from(iter + 100).expect("test iteration index fits i64")),
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

    // Assert exact final block count: 1 space + 1 page + 1 tag + 4×6
    // agent blocks + 12 frontend blocks = 39. The space block comes
    // From `mk_space` (fixture seed).
    let total_blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    let expected = 3 + AGENTS * ITERS_PER_AGENT + FRONTEND_ITERS;
    assert_eq!(
        usize::try_from(total_blocks).expect("test row count is non-negative and fits usize"),
        expected,
        "concurrent agent + frontend writes must produce exact block count \
         (1 space + 1 page + 1 tag + {AGENTS}×{ITERS_PER_AGENT} agent + {FRONTEND_ITERS} frontend = {expected})",
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
        usize::try_from(agent_blocks_with_tag)
            .expect("test row count is non-negative and fits usize"),
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

// -------------------------------------------------------------------
// Cross-space write rejection
//
// One regression test per rw tool that takes a block ID input. Each
// test seeds two spaces (A and B), creates a target block in space B,
// then asks the tool to mutate it under `space_id = A`. Every call
// must surface `AppError::Validation` from the
// `validate_block_in_space` helper, BEFORE the inner reaches the op
// log. (`add_tag` doubles as the witness that the block_id arm
// fires; `tag_id` is intentionally not validated because tags are
// global.)
// -------------------------------------------------------------------

/// An agent scoped to space A must not be able to append
/// content under a parent block whose owning page lives in space B.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_cross_space_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    // Parent page lives in space B.
    let parent_b = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "ParentB".into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(&space_b)),
        // #2849 PR2: server-generated id (test).
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "append_block",
            // Agent claims to be in space A; parent lives in space B.
            json!({"parent_id": parent_b.id, "content": "x", "space_id": space_a}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("cross-space append must be denied");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "cross-space append must surface as Validation (→ -32602), got {err:?}",
    );
}

/// Agent in space A, target block in space B → reject.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_block_cross_space_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let block_b = mk_in_space_content_block(&pool, &mat, &space_b, "B-block").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "update_block_content",
            json!({"block_id": block_b.id, "content": "hijack", "space_id": space_a}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("cross-space update must be denied");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "cross-space update must surface as Validation, got {err:?}",
    );
}

/// Agent in space A, target block in space B → reject.
/// Pinned: validation must fire BEFORE the exactly-one-value check
/// inside `set_property_inner` (the latter would otherwise leak a
/// false-negative path where the cross-space write succeeded
/// silently).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_cross_space_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let block_b = mk_in_space_content_block(&pool, &mat, &space_b, "B-block").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "set_property",
            json!({
                "block_id": block_b.id,
                "key": "assignee",
                "value_text": "alice",
                "space_id": space_a,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("cross-space set_property must be denied");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "cross-space set_property must surface as Validation, got {err:?}",
    );
}

/// #3301 — `space` is the column-backed space-membership key, not a
/// content property: `set_property_in_tx_with_declaration` exempts it from
/// the cross-space ref guard and projects it as
/// `UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?`, i.e. the
/// canonical cross-space move of a page and every descendant.
/// `validate_block_in_space` cannot catch it — the block *is* still in the
/// declared space at check time. The tool must reject the key outright,
/// and the page must stay where it was.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_reserved_space_key_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let page_a = mk_page(&pool, &mat, &space_a, "PageA").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "set_property",
            json!({
                "block_id": page_a.clone(),
                "key": "space",
                "value_ref": space_b,
                "space_id": space_a.clone(),
            }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("the reserved `space` key must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "the reserved `space` key must surface as Validation, got {err:?}",
    );
    settle(&mat).await;

    let still: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
        .bind(&page_a)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        still.as_deref(),
        Some(space_a.as_str()),
        "the page must not have been re-homed into space B",
    );
}

/// #3301 — a malformed `value_ref` used to be stored verbatim. The
/// cross-space guard tolerates a target that resolves to no space, so
/// `set_property` answered Ok and the agent believed it had linked a block
/// that does not exist. The lowercase arm pins that the strict parse did not
/// cost the case-insensitivity `normalize_ulid_arg` used to provide.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_malformed_value_ref_errors_rather_than_dangling() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let page_a = mk_page(&pool, &mat, &space_a, "PageA").await;
    let target = mk_in_space_content_block(&pool, &mat, &space_a, "target").await;
    settle(&mat).await;

    for bad in ["NOT-A-VALID-ULID", "01ARZ3NDEKTSV4RRFFQ69G5FA", ""] {
        let err = tools
            .call_tool(
                "set_property",
                json!({
                    "block_id": page_a.clone(),
                    "key": "linked_page",
                    "value_ref": bad,
                    "space_id": space_a.clone(),
                }),
                &test_ctx_agent(),
            )
            .await
            .expect_err("a malformed value_ref must not be stored");
        assert!(
            matches!(err, AppError::Ulid(_)),
            "value_ref {bad:?} must surface as AppError::Ulid, got {err:?}",
        );
    }
    // A lowercase but well-formed ref still resolves.
    tools
        .call_tool(
            "set_property",
            json!({
                "block_id": page_a.clone(),
                "key": "linked_page",
                "value_ref": target.id.as_str().to_lowercase(),
                "space_id": space_a.clone(),
            }),
            &test_ctx_agent(),
        )
        .await
        .expect("a lowercase well-formed ref must still be accepted");
    settle(&mat).await;
    let saved: Option<String> = sqlx::query_scalar(
        "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'linked_page'",
    )
    .bind(&page_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        saved.as_deref(),
        Some(target.id.as_str()),
        "the lowercase ref must be stored in canonical uppercase form",
    );
}

/// Agent in space A, target block in space B, tag is
/// global → reject. Verifies the helper checks the *target* block
/// (`block_id`) and not the global `tag_id`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_cross_space_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let block_b = mk_in_space_content_block(&pool, &mat, &space_b, "B-block").await;
    let tag = create_block_inner(&pool, DEV, &mat, "tag".into(), "global".into(), None, None)
        .await
        .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "add_tag",
            json!({"block_id": block_b.id, "tag_id": tag.id, "space_id": space_a}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("cross-space add_tag must be denied");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "cross-space add_tag must surface as Validation, got {err:?}",
    );
}

/// Agent in space A, target block in space B → reject.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_cross_space_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let block_b = mk_in_space_content_block(&pool, &mat, &space_b, "B-doomed").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "delete_block",
            json!({"block_id": block_b.id, "space_id": space_a}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("cross-space delete must be denied");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "cross-space delete must surface as Validation, got {err:?}",
    );
}

// ===================================================================
// #2505 — view-change event emission (blocks:changed /
// block:properties-changed). Every RW tool must propagate its committed
// write to open views, not just to the mcp:activity feed. These tests
// inject a RecordingViewChangeEmitter and assert the emitted payloads.
// ===================================================================

use crate::mcp::view_notify::RecordingViewChangeEmitter;

/// `mk_tools` sibling that installs a recording view-change emitter so a
/// test can assert the `blocks:changed` / `block:properties-changed`
/// payloads each RW tool emits after it commits.
async fn mk_tools_recording() -> (
    ReadWriteTools,
    Materializer,
    SqlitePool,
    String,
    Arc<RecordingViewChangeEmitter>,
    TempDir,
) {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let emitter = Arc::new(RecordingViewChangeEmitter::new());
    let tools = ReadWriteTools::new(pool.clone(), pool.clone(), mat.clone(), DEV.to_string())
        .with_view_emitter(emitter.clone());
    let space_id = mk_space(&pool, " test space").await;
    (tools, mat, pool, space_id, emitter, dir)
}

/// Create a page in `space` and return its ULID, so the blocks:changed
/// tests can assert the resolved owning-page id.
async fn mk_page(pool: &SqlitePool, mat: &Materializer, space: &str, title: &str) -> String {
    create_block_inner_with_space(
        pool,
        DEV,
        mat,
        "page".into(),
        title.into(),
        None,
        Some(1),
        &SpaceScope::Active(SpaceId::from_trusted(space)),
        // #2849 PR2: server-generated id (test).
        None,
    )
    .await
    .unwrap()
    .id
    .into_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_emits_blocks_changed_for_owning_page() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let page_id = mk_page(&pool, &mat, &space, "Page").await;
    settle(&mat).await;

    tools
        .call_tool(
            "append_block",
            json!({"parent_id": page_id.clone(), "content": "hello", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("append happy path");

    // The appended block's owning page is `page_id` — the same set
    // `SyncEvent::Complete` would thread for a synced equivalent.
    assert_eq!(
        emitter.blocks_changed(),
        vec![vec![page_id]],
        "append_block must emit blocks:changed with the owning page id",
    );
    // Content-only write emits no property-changed event.
    assert!(emitter.property_changed().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_block_content_emits_blocks_changed_for_owning_page() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let page_id = mk_page(&pool, &mat, &space, "Page").await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "before".into(),
        Some(agaric_core::ulid::BlockId::from_trusted(&page_id)),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    tools
        .call_tool(
            "update_block_content",
            json!({"block_id": block.id.as_str(), "content": "after", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("update happy path");

    assert_eq!(
        emitter.blocks_changed(),
        vec![vec![page_id]],
        "update_block_content must emit blocks:changed with the owning page id",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_emits_blocks_changed_for_owning_page() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let page_id = mk_page(&pool, &mat, &space, "Page").await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "doomed".into(),
        Some(agaric_core::ulid::BlockId::from_trusted(&page_id)),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    tools
        .call_tool(
            "delete_block",
            json!({"block_id": block.id.as_str(), "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("delete happy path");

    // Soft-delete leaves the parent chain intact, so the owning page still
    // resolves and the page reloads to drop the block from its tree.
    assert_eq!(
        emitter.blocks_changed(),
        vec![vec![page_id]],
        "delete_block must emit blocks:changed with the owning page id",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_page_emits_blocks_changed_for_itself() {
    let (tools, _mat, _pool, space, emitter, _dir) = mk_tools_recording().await;

    let result = tools
        .call_tool(
            "create_page",
            json!({"title": "Fresh", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("create_page happy path");
    let new_page_id = result["id"].as_str().unwrap().to_string();

    // A page resolves to itself (page_id = id), so blocks:changed carries the
    // new page's own id.
    assert_eq!(
        emitter.blocks_changed(),
        vec![vec![new_page_id]],
        "create_page must emit blocks:changed with the new page's own id",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_emits_blocks_changed_for_owning_page() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let page_id = mk_page(&pool, &mat, &space, "Page").await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "taggable".into(),
        Some(agaric_core::ulid::BlockId::from_trusted(&page_id)),
        Some(1),
    )
    .await
    .unwrap();
    let tag = create_block_inner(&pool, DEV, &mat, "tag".into(), "global".into(), None, None)
        .await
        .unwrap();
    settle(&mat).await;

    tools
        .call_tool(
            "add_tag",
            json!({"block_id": block.id.as_str(), "tag_id": tag.id.as_str(), "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("add_tag happy path");

    assert_eq!(
        emitter.blocks_changed(),
        vec![vec![page_id]],
        "add_tag must emit blocks:changed with the tagged block's owning page id",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_emits_blocks_changed_and_property_changed() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let page_id = mk_page(&pool, &mat, &space, "Page").await;
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        Some(agaric_core::ulid::BlockId::from_trusted(&page_id)),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    tools
        .call_tool(
            "set_property",
            json!({
                "block_id": block.id.as_str(),
                "key": "assignee",
                "value_text": "alice",
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect("set_property happy path");

    // A property write emits BOTH the page-keyed blocks:changed AND the
    // existing block:properties-changed.
    assert_eq!(
        emitter.blocks_changed(),
        vec![vec![page_id]],
        "set_property must emit blocks:changed with the owning page id",
    );

    // Payload PARITY with the local `set_property` command: it emits
    // `emit_property_changed_event(app, block_id, vec![key])` →
    // `PropertyChangedEvent { block_id, changed_keys: [key] }`. The MCP write
    // must emit the byte-identical payload so the FE property-change dispatcher
    // needs no changes.
    let recorded = emitter.property_changed();
    assert_eq!(recorded.len(), 1, "exactly one property-changed emission");
    let (recorded_block_id, recorded_keys) = &recorded[0];
    assert_eq!(recorded_block_id.as_str(), block.id.as_str());
    assert_eq!(recorded_keys, &vec!["assignee".to_string()]);

    // Serialise the MCP-emitted payload and the local-command payload and
    // assert they are identical JSON — the concrete "payload-equal" evidence.
    use agaric_sync::sync_events::PropertyChangedEvent;
    let mcp_payload = serde_json::to_value(PropertyChangedEvent {
        block_id: recorded_block_id.clone(),
        changed_keys: recorded_keys.clone(),
    })
    .unwrap();
    let local_command_payload = serde_json::to_value(PropertyChangedEvent {
        block_id: block.id.as_str().to_string(),
        changed_keys: vec!["assignee".to_string()],
    })
    .unwrap();
    assert_eq!(
        mcp_payload, local_command_payload,
        "MCP set_property property-changed payload must equal the local command's",
    );
}

// -------------------------------------------------------------------
// move_page_to_space / create_tag / delete_property (#5378)
// -------------------------------------------------------------------

async fn space_of(pool: &SqlitePool, block_id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
        .bind(block_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_page_to_space_moves_page_and_descendants() {
    let (tools, mat, pool, space_a, emitter, _dir) = mk_tools_recording().await;
    let space_b = mk_space(&pool, " space B").await;
    let child = mk_in_space_content_block(&pool, &mat, &space_a, "child").await;
    let page_id = child.parent_id.clone().unwrap().into_string();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "move_page_to_space",
            json!({"page_id": page_id.clone(), "space_id": space_a, "target_space_id": space_b}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    settle(&mat).await;

    assert_eq!(
        result,
        json!({"page_id": page_id.clone(), "space_id": space_b.clone()})
    );
    assert_eq!(
        space_of(&pool, &page_id).await.as_deref(),
        Some(space_b.as_str())
    );
    assert_eq!(
        space_of(&pool, child.id.as_str()).await.as_deref(),
        Some(space_b.as_str()),
        "the page's blocks move with it",
    );
    assert_eq!(emitter.blocks_changed(), vec![vec![page_id]]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_page_to_space_cross_space_source_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let page_b = mk_page(&pool, &mat, &space_b, "PageB").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "move_page_to_space",
            json!({"page_id": page_b.clone(), "space_id": space_a.clone(), "target_space_id": space_a}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a page of another space must not move");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    assert_eq!(
        space_of(&pool, &page_b).await.as_deref(),
        Some(space_b.as_str())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_page_to_space_non_page_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let block = mk_in_space_content_block(&pool, &mat, &space_a, "c").await;
    let tag = create_block_inner_with_space(
        &pool,
        DEV,
        &mat,
        "tag".into(),
        "work".into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(&space_a)),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    for id in [block.id.as_str(), tag.id.as_str()] {
        let err = tools
            .call_tool(
                "move_page_to_space",
                json!({"page_id": id, "space_id": space_a.clone(), "target_space_id": space_b.clone()}),
                &test_ctx_agent(),
            )
            .await
            .expect_err("only a page moves");
        assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
        assert_eq!(space_of(&pool, id).await.as_deref(), Some(space_a.as_str()));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_page_to_space_target_not_a_live_space_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let page = mk_page(&pool, &mat, &space_a, "Page").await;
    let not_a_space = mk_page(&pool, &mat, &space_a, "Other").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "move_page_to_space",
            json!({"page_id": page.clone(), "space_id": space_a.clone(), "target_space_id": not_a_space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("the target must be a live space");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    assert_eq!(
        space_of(&pool, &page).await.as_deref(),
        Some(space_a.as_str())
    );
}

/// #6099 — a page whose title the target space holds stays put, and the agent
/// is told the clash in the words a rename gets.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_page_to_space_onto_a_taken_title_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let page = mk_page(&pool, &mat, &space_a, "Inbox").await;
    mk_page(&pool, &mat, &space_b, "Inbox").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "move_page_to_space",
            json!({"page_id": page.clone(), "space_id": space_a.clone(), "target_space_id": space_b}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("B already has an Inbox");
    assert!(
        matches!(&err, AppError::Validation { code: Some(ValidationCode::DuplicatePageTitle), message }
            if message == "a page titled 'Inbox' already exists in this space"),
        "got {err:?}"
    );
    assert_eq!(
        space_of(&pool, &page).await.as_deref(),
        Some(space_a.as_str())
    );
}

/// #5841 S0.6 — a page holding a value its target space defines another way
/// is refused until `acknowledge_property_loss` names the losses; the refusal
/// says which keys, how many values and what to pass, and passing it moves
/// the page and drops the value.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_page_to_space_refuses_a_lossy_move_until_acknowledged() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    crate::commands::create_property_def_inner(
        &pool,
        DEV,
        &mat,
        &space_b,
        "stage".into(),
        "number".into(),
        None,
    )
    .await
    .unwrap();
    let page = mk_page(&pool, &mat, &space_a, "Page").await;
    set_property_inner(
        &pool,
        DEV,
        &mat,
        page.as_str().into(),
        "stage".into(),
        Some("draft".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    let ctx = test_ctx_agent();
    let call = |ack: Option<Value>| {
        let mut args = json!({
            "page_id": page.clone(),
            "space_id": space_a.clone(),
            "target_space_id": space_b.clone(),
        });
        if let Some(ack) = ack {
            args["acknowledge_property_loss"] = ack;
        }
        tools.call_tool("move_page_to_space", args, &ctx)
    };

    for ack in [None, Some(json!({"stage": 2}))] {
        let err = call(ack.clone())
            .await
            .expect_err("an unacknowledged loss is refused");
        assert_eq!(
            err.validation_code(),
            Some(ValidationCode::UnacknowledgedPropertyLoss),
            "ack {ack:?}: {err:?}"
        );
        let message = err.to_string();
        assert!(
            message.contains("stage (1)")
                && message.contains(r#""acknowledge_property_loss": {"stage":1}"#),
            "the refusal names the loss and what to pass: {message}"
        );
        assert_eq!(
            space_of(&pool, &page).await.as_deref(),
            Some(space_a.as_str())
        );
    }

    call(Some(json!({"stage": 1})))
        .await
        .expect("an acknowledged move goes through");
    settle(&mat).await;
    assert_eq!(
        space_of(&pool, &page).await.as_deref(),
        Some(space_b.as_str())
    );
    let held: Option<String> = sqlx::query_scalar(
        "SELECT value_text FROM block_properties WHERE block_id = ? AND key = 'stage'",
    )
    .bind(&page)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(held, None, "the value the target types differently is gone");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_tag_creates_in_space_and_reuses_the_name() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;

    let first = tools
        .call_tool(
            "create_tag",
            json!({"name": "work", "space_id": space.clone()}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    settle(&mat).await;
    let tag_id = first["id"].as_str().unwrap().to_owned();
    assert_eq!(first["block_type"], "tag");
    assert_eq!(
        space_of(&pool, &tag_id).await.as_deref(),
        Some(space.as_str())
    );

    let again = tools
        .call_tool(
            "create_tag",
            json!({"name": "work", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("same name");
    assert_eq!(
        again["id"],
        tag_id.as_str(),
        "the space's tag is returned, not a second one"
    );
    // #6049 — a tag is on no page, so each call names the tag itself: the
    // empty set would reload every open page.
    assert_eq!(
        emitter.blocks_changed(),
        vec![vec![tag_id.clone()], vec![tag_id]],
        "create_tag must emit blocks:changed naming the tag",
    );
}

/// The space's tag names as `list_all_tags_in_space` reads them at the moment
/// `blocks:changed` goes out: what a `#` picker refilling on that event gets.
struct TagNamesAtEmit {
    pool: SqlitePool,
    space_id: String,
    seen: std::sync::Mutex<Vec<Vec<String>>>,
}

impl ViewChangeEmitter for TagNamesAtEmit {
    fn emit_blocks_changed(&self, _changed_page_ids: Vec<String>) {
        let tags = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(
                crate::commands::tags::list_all_tags_in_space_inner(&self.pool, &self.space_id),
            )
        })
        .expect("list the space's tags");
        self.seen
            .lock()
            .unwrap()
            .push(tags.into_iter().map(|tag| tag.name).collect());
    }

    fn emit_property_changed(&self, _block_id: String, _changed_keys: Vec<String>) {}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_tag_signals_once_the_tag_list_holds_the_tag_6049() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let space_id = mk_space(&pool, " test space").await;
    let emitter = Arc::new(TagNamesAtEmit {
        pool: pool.clone(),
        space_id: space_id.clone(),
        seen: std::sync::Mutex::default(),
    });
    let tools = ReadWriteTools::new(pool.clone(), pool.clone(), mat, DEV.to_string())
        .with_view_emitter(emitter.clone());

    tools
        .call_tool(
            "create_tag",
            json!({"name": "work", "space_id": space_id}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");

    assert_eq!(
        *emitter.seen.lock().unwrap(),
        vec![vec!["work".to_owned()]],
        "a picker refilled on the signal must list the new tag",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_cross_space_rejected() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let block = mk_in_space_content_block(&pool, &mat, &space_b, "task").await;
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        "assignee".into(),
        Some("alice".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "delete_property",
            json!({"block_id": block.id.as_str(), "key": "assignee", "space_id": space_a}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a block of another space must not lose a property");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    let kept: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'assignee'",
    )
    .bind(block.id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(kept, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_removes_the_property_and_notifies() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "task").await;
    let page_id = block.parent_id.clone().unwrap().into_string();
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        "assignee".into(),
        Some("alice".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "delete_property",
            json!({"block_id": block.id.as_str(), "key": "assignee", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");

    assert_eq!(
        result,
        json!({"block_id": block.id.as_str(), "key": "assignee"})
    );
    let left: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'assignee'",
    )
    .bind(block.id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(left, 0);
    assert_eq!(emitter.blocks_changed(), vec![vec![page_id]]);
    assert_eq!(
        emitter.property_changed(),
        vec![(block.id.as_str().to_owned(), vec!["assignee".to_owned()])],
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_space_key_rejected() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let page = mk_page(&pool, &mat, &space, "Page").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "delete_property",
            json!({"block_id": page.clone(), "key": "space", "space_id": space.clone()}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("the reserved `space` key must be rejected");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    settle(&mat).await;
    assert_eq!(
        space_of(&pool, &page).await.as_deref(),
        Some(space.as_str())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_system_managed_key_rejected() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "task").await;
    crate::commands::set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("DONE".into()),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "delete_property",
            json!({"block_id": block.id.as_str(), "key": "completed_at", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a system-managed key must be refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    let kept: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'completed_at'",
    )
    .bind(block.id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(kept, 1);
}

// -------------------------------------------------------------------
// undo (#5400) — the happy path, through the op refs a write returns, is
// `rmcp_adapter::tests::rw_undo_reverts_an_append_through_its_returned_op_refs_5400`.
// -------------------------------------------------------------------

/// The ref of the op that created `block_id`.
async fn create_op_ref(pool: &SqlitePool, block_id: &str) -> Value {
    let (device_id, seq): (String, i64) = sqlx::query_as(
        "SELECT device_id, seq FROM op_log WHERE block_id = ? AND op_type = 'create_block'",
    )
    .bind(block_id)
    .fetch_one(pool)
    .await
    .unwrap();
    json!({ "device_id": device_id, "seq": seq })
}

async fn is_live(pool: &SqlitePool, block_id: &str) -> bool {
    sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(block_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .is_none()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_refuses_an_op_the_user_wrote_5400() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    // Written outside any agent scope, so its origin is `user`.
    let block = mk_in_space_content_block(&pool, &mat, &space, "mine").await;
    settle(&mat).await;
    let op_ref = create_op_ref(&pool, block.id.as_str()).await;

    let err = tools
        .call_tool(
            "undo",
            json!({ "op_refs": [op_ref], "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a user op must be refused");
    assert!(
        matches!(&err, AppError::Validation { message, .. } if message.contains("only its own ops")),
        "got {err:?}"
    );
    assert!(is_live(&pool, block.id.as_str()).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_unknown_op_ref_is_not_found_5400() {
    let (tools, _mat, _pool, space, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "undo",
            json!({ "op_refs": [{ "device_id": DEV, "seq": 999_999 }], "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("an unknown ref must be refused");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_refuses_a_target_in_another_space_5400() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let other_space = mk_space(&pool, "other").await;
    let page = mk_page(&pool, &mat, &space, "P").await;
    settle(&mat).await;
    let appended = tools
        .call_tool(
            "append_block",
            json!({ "parent_id": page, "content": "agent text", "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .unwrap();
    let block_id = appended["id"].as_str().unwrap();
    let op_ref = create_op_ref(&pool, block_id).await;

    let err = tools
        .call_tool(
            "undo",
            json!({ "op_refs": [op_ref], "space_id": other_space }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a target in another space must be refused");
    assert!(
        matches!(&err, AppError::Validation { message, .. } if message.contains("belongs to space")),
        "got {err:?}"
    );
    assert!(is_live(&pool, block_id).await);
}

// -------------------------------------------------------------------
// capture (#5396)
// -------------------------------------------------------------------

fn day(s: &str) -> chrono::NaiveDate {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

/// The live journal page for `date` in `space`, if any.
async fn day_page(pool: &SqlitePool, space: &str, date: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT id FROM blocks WHERE block_type = 'page' AND content = ? AND space_id = ? \
         AND deleted_at IS NULL",
    )
    .bind(date)
    .bind(space)
    .fetch_optional(pool)
    .await
    .unwrap()
}

async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// A journal template in `space` holding one line.
async fn seed_journal_template(pool: &SqlitePool, mat: &Materializer, space: &str) {
    let template = mk_page(pool, mat, space, "Daily template").await;
    crate::commands::set_property_inner(
        pool,
        DEV,
        mat,
        agaric_core::ulid::ActiveBlockId::from(template.clone()),
        "journal-template".into(),
        Some("true".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    create_block_inner(
        pool,
        DEV,
        mat,
        "content".into(),
        "Template line".into(),
        Some(BlockId::from_trusted(&template)),
        None,
    )
    .await
    .unwrap();
}

/// A missing day is created with its template, the outline lands after the
/// template, a name creates its page in the day's space, and the call's op
/// refs, one activity entry's worth, undo all of it at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_creates_a_missing_day_with_its_template_in_one_undo_5396() {
    use agaric_store::task_locals::{LAST_APPEND, take_appends};
    use std::cell::RefCell;

    let (tools, mat, pool, space, _dir) = mk_tools().await;
    seed_journal_template(&pool, &mat, &space).await;
    settle(&mat).await;

    let (result, op_refs) = LAST_APPEND
        .scope(RefCell::new(Vec::new()), async {
            let result = tools
                .call_tool(
                    "capture",
                    json!({
                        "content": "- thought on [[Fresh idea]]",
                        "date": "2026-03-01",
                        "space_id": space.to_lowercase(),
                    }),
                    &test_ctx_agent(),
                )
                .await
                .expect("capture into a new day");
            (result, take_appends())
        })
        .await;
    settle(&mat).await;

    let page = day_page(&pool, &space, "2026-03-01")
        .await
        .expect("the day was created");
    assert_eq!(result["page"]["id"], page.as_str());
    let fresh = result["blocks"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        child_contents(&pool, &page).await,
        [
            "Template line".to_owned(),
            format!("thought on [[{fresh}]]")
        ],
        "the template first, the capture after it"
    );
    let fresh_space: Option<String> =
        sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(&fresh)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(fresh_space.as_deref(), Some(space.as_str()));

    let refs: Vec<Value> = op_refs
        .iter()
        .map(|r| json!({ "device_id": r.device_id, "seq": r.seq }))
        .collect();
    tools
        .call_tool(
            "undo",
            json!({ "op_refs": refs, "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect("the capture's own ops undo");
    settle(&mat).await;
    assert_eq!(
        day_page(&pool, &space, "2026-03-01").await,
        None,
        "one undo removes the day"
    );
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks WHERE (id = ?1 OR parent_id = ?1 OR id = ?2) \
         AND deleted_at IS NULL",
    )
    .bind(&page)
    .bind(&fresh)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        live, 0,
        "and with it the template copy, the capture and the page it created"
    );
}

/// An existing day gains the outline at its end; `today` and `yesterday`
/// resolve against the date the handler is given.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_appends_at_the_end_of_an_existing_day_5396() {
    let (_tools, mat, pool, space, _dir) = mk_tools().await;
    let page = crate::commands::journal_for_date_inner(&pool, DEV, &mat, day("2026-03-01"), &space)
        .await
        .unwrap()
        .id;
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "first".into(),
        Some(page.clone()),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let emitter = NoopViewChangeEmitter;
    for (args, today) in [
        (
            json!({ "content": "- second\n- third", "space_id": space }),
            "2026-03-01",
        ),
        (
            json!({ "content": "fourth", "date": "yesterday", "space_id": space }),
            "2026-03-02",
        ),
    ] {
        handle_capture(&pool, &mat, DEV, &emitter, args, day(today))
            .await
            .expect("capture into the existing day");
    }
    settle(&mat).await;

    assert_eq!(
        child_contents(&pool, page.as_str()).await,
        ["first", "second", "third", "fourth"],
        "each capture lands at the end of the one day"
    );
    assert_eq!(
        day_page(&pool, &space, "2026-03-02").await,
        None,
        "`yesterday` read from 2026-03-02 is 2026-03-01, not the clock's day"
    );
}

/// A bad date, an unknown space, and an outline refused after the day would
/// have been created all write nothing, the day included.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_refusals_write_nothing_5396() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    settle(&mat).await;
    let too_many: String = (0..=agaric_store::pagination::MAX_BATCH_BLOCK_IDS)
        .map(|i| format!("- line {i}\n"))
        .collect();
    let before = op_count(&pool).await;

    let unknown_space = BlockId::new().into_string();
    for (what, args) in [
        (
            "bad date",
            json!({ "content": "x", "date": "2026-02-30", "space_id": space }),
        ),
        (
            "unknown space",
            json!({ "content": "x", "date": "2026-03-01", "space_id": unknown_space }),
        ),
        (
            "over the op cap",
            json!({ "content": too_many, "date": "2026-03-01", "space_id": space }),
        ),
    ] {
        let err = tools
            .call_tool("capture", args, &test_ctx_agent())
            .await
            .expect_err(what);
        assert!(
            matches!(err, AppError::Validation { .. }),
            "{what} must be Validation, got {err:?}"
        );
    }
    settle(&mat).await;
    assert_eq!(op_count(&pool).await, before, "no op was written");
    assert_eq!(day_page(&pool, &space, "2026-03-01").await, None);
}

// -------------------------------------------------------------------
// move_blocks / remove_tag / restore_block (#5399)
// -------------------------------------------------------------------

async fn mk_child_of(pool: &SqlitePool, mat: &Materializer, parent: &str, text: &str) -> String {
    create_block_inner(
        pool,
        DEV,
        mat,
        "content".into(),
        text.into(),
        Some(BlockId::from_trusted(parent)),
        None,
    )
    .await
    .unwrap()
    .id
    .into_string()
}

async fn live_children(pool: &SqlitePool, parent: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT id FROM blocks WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, id",
    )
    .bind(parent)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn mk_tag_in(pool: &SqlitePool, mat: &Materializer, space: &str) -> String {
    create_block_inner_with_space(
        pool,
        DEV,
        mat,
        "tag".into(),
        "work".into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(space)),
        None,
    )
    .await
    .unwrap()
    .id
    .into_string()
}

async fn tags_of(pool: &SqlitePool, block_id: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT tag_id FROM block_tags WHERE block_id = ?")
        .bind(block_id)
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_keeps_ids_and_backlinks_5399() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let from = mk_page(&pool, &mat, &space, "From").await;
    let to = mk_page(&pool, &mat, &space, "To").await;
    let elsewhere = mk_page(&pool, &mat, &space, "Elsewhere").await;
    let x = mk_child_of(&pool, &mat, &from, "x").await;
    let x_child = mk_child_of(&pool, &mat, &x, "x child").await;
    let y = mk_child_of(&pool, &mat, &from, "y").await;
    let existing = mk_child_of(&pool, &mat, &to, "existing").await;
    let referrer = mk_child_of(&pool, &mat, &elsewhere, &format!("see (({x}))")).await;
    settle(&mat).await;

    let result = tools
        .call_tool(
            "move_blocks",
            json!({ "block_ids": [x, y], "parent_id": to, "position": 1, "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    settle(&mat).await;

    let moved: Vec<&str> = result["moves"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["block_id"].as_str().unwrap())
        .collect();
    assert_eq!(moved, vec![x.as_str(), y.as_str()]);
    assert_eq!(
        live_children(&pool, &to).await,
        vec![x.clone(), y, existing]
    );
    assert!(live_children(&pool, &from).await.is_empty());
    assert_eq!(live_children(&pool, &x).await, vec![x_child]);
    let backlinks = crate::commands::list_backlinks_grouped_inner(
        &pool,
        BlockId::from_trusted(&x),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(&space)),
        None,
    )
    .await
    .unwrap();
    let sources: Vec<&str> = backlinks
        .groups
        .iter()
        .flat_map(|g| g.blocks.iter().map(|b| b.id.as_str()))
        .collect();
    assert_eq!(sources, vec![referrer.as_str()]);
    let mut changed = emitter.blocks_changed();
    changed.iter_mut().for_each(|pages| pages.sort());
    let mut both = vec![from, to];
    both.sort();
    assert_eq!(changed, vec![both], "the old page and the new one reload");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_under_own_descendant_is_validation_5399() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let page = mk_page(&pool, &mat, &space, "P").await;
    let x = mk_child_of(&pool, &mat, &page, "x").await;
    let x_child = mk_child_of(&pool, &mat, &x, "x child").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "move_blocks",
            json!({ "block_ids": [x], "parent_id": x_child, "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a cycle must be refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    assert_eq!(live_children(&pool, &page).await, vec![x.clone()]);
    assert_eq!(live_children(&pool, &x).await, vec![x_child]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_position_zero_rejected_5399() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let page = mk_page(&pool, &mat, &space, "P").await;
    let first = mk_child_of(&pool, &mat, &page, "first").await;
    let last = mk_child_of(&pool, &mat, &page, "last").await;
    settle(&mat).await;

    let err = tools
        .call_tool(
            "move_blocks",
            json!({ "block_ids": [last], "parent_id": page, "position": 0, "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("position 0 must be refused, not clamped to the top");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    assert_eq!(live_children(&pool, &page).await, vec![first, last]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_cross_space_rejected_5399() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let page_a = mk_page(&pool, &mat, &space_a, "A").await;
    let page_b = mk_page(&pool, &mat, &space_b, "B").await;
    let block_a = mk_child_of(&pool, &mat, &page_a, "a").await;
    let block_b = mk_child_of(&pool, &mat, &page_b, "b").await;
    settle(&mat).await;

    for (block, parent) in [(&block_b, &page_a), (&block_a, &page_b)] {
        let err = tools
            .call_tool(
                "move_blocks",
                json!({ "block_ids": [block], "parent_id": parent, "space_id": space_a }),
                &test_ctx_agent(),
            )
            .await
            .expect_err("a block or parent of another space must be refused");
        assert!(
            matches!(&err, AppError::Validation { message, .. } if message.contains("belongs to space")),
            "got {err:?}"
        );
    }
    assert_eq!(live_children(&pool, &page_a).await, vec![block_a]);
    assert_eq!(live_children(&pool, &page_b).await, vec![block_b]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_removes_the_tag_5399() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "c").await;
    let tag = mk_tag_in(&pool, &mat, &space).await;
    add_tag_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        BlockId::from_trusted(&tag),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "remove_tag",
            json!({ "block_id": block.id.clone(), "tag_id": tag.clone(), "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(
        result,
        json!({ "block_id": block.id.as_str(), "tag_id": tag })
    );
    assert!(tags_of(&pool, block.id.as_str()).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_cross_space_rejected_5399() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let block_b = mk_in_space_content_block(&pool, &mat, &space_b, "b").await;
    let tag_b = mk_tag_in(&pool, &mat, &space_b).await;
    add_tag_inner(
        &pool,
        DEV,
        &mat,
        block_b.id.clone(),
        BlockId::from_trusted(&tag_b),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "remove_tag",
            json!({ "block_id": block_b.id.clone(), "tag_id": tag_b.clone(), "space_id": space_a }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a block of another space must be refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    assert_eq!(tags_of(&pool, block_b.id.as_str()).await, vec![tag_b]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_restores_the_deleted_subtree_5399() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let page = mk_page(&pool, &mat, &space, "P").await;
    let x = mk_child_of(&pool, &mat, &page, "x").await;
    let x_child = mk_child_of(&pool, &mat, &x, "x child").await;
    let deleted = delete_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&x))
        .await
        .unwrap();
    settle(&mat).await;
    assert!(!is_live(&pool, &x_child).await);

    let result = tools
        .call_tool(
            "restore_block",
            json!({ "block_id": x.clone(), "deleted_at": deleted.deleted_at, "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["restored_count"], 2);
    assert_eq!(live_children(&pool, &page).await, vec![x.clone()]);
    assert_eq!(live_children(&pool, &x).await, vec![x_child]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_cross_space_rejected_5399() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let block_b = mk_in_space_content_block(&pool, &mat, &space_b, "b").await;
    let deleted = delete_block_inner(&pool, DEV, &mat, block_b.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool(
            "restore_block",
            json!({ "block_id": block_b.id.clone(), "deleted_at": deleted.deleted_at, "space_id": space_a }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a block of another space must be refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    assert!(!is_live(&pool, block_b.id.as_str()).await);
}

// -------------------------------------------------------------------
// Names in place of ids, and in written content (#5397)
// -------------------------------------------------------------------

async fn tag_named(pool: &SqlitePool, space: &str, name: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT id FROM blocks WHERE block_type = 'tag' AND content = ? AND space_id = ? \
         AND deleted_at IS NULL",
    )
    .bind(name)
    .bind(space)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn backlink_sources(pool: &SqlitePool, space: &str, target: &str) -> Vec<String> {
    crate::commands::list_backlinks_grouped_inner(
        pool,
        BlockId::from_trusted(target),
        None,
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(space)),
        None,
    )
    .await
    .unwrap()
    .groups
    .iter()
    .flat_map(|g| g.blocks.iter().map(|b| b.id.as_str().to_owned()))
    .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_takes_its_parent_page_by_name_5397() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let page = mk_page(&pool, &mat, &space, "Project X").await;
    let dup_a = mk_page(&pool, &mat, &space, "Dup").await;
    let dup_b = mk_page(&pool, &mat, &space, "DUP").await;
    settle(&mat).await;

    let result = tools
        .call_tool(
            "append_block",
            json!({"parent_id": "project x", "content": "hello", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("a title in another case names the page");
    assert_eq!(result["parent_id"], page.as_str());
    assert!(result.get("warnings").is_none(), "no warnings, no key");

    let result = tools
        .call_tool(
            "append_block",
            json!({"parent_id": page, "content": "see [[dup]]", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("a tie in content is kept as text");
    assert_eq!(result["content"], "see [[dup]]");
    assert_eq!(
        result["warnings"],
        json!(["wiki-link '[[dup]]' matches multiple pages in this space; left as plain text"]),
    );

    let err = tools
        .call_tool(
            "append_block",
            json!({"parent_id": "dup", "content": "x", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a tie must be refused");
    let message = err.to_string();
    assert!(
        matches!(err, AppError::Validation { .. })
            && message.contains(&format!("{dup_a} (Dup)"))
            && message.contains(&format!("{dup_b} (DUP)")),
        "the error names each candidate with its id, got {message}"
    );

    let err = tools
        .call_tool(
            "append_block",
            json!({"parent_id": "Nowhere", "content": "x", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("an unknown name must be refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    assert!(child_contents(&pool, &dup_a).await.is_empty());
    assert!(child_contents(&pool, &dup_b).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn append_block_links_the_names_its_content_writes_5397() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let target = mk_page(&pool, &mat, &space, "Existing page").await;
    let inbox = mk_page(&pool, &mat, &space, "Inbox").await;
    settle(&mat).await;

    let result = tools
        .call_tool(
            "append_block",
            json!({
                "parent_id": inbox,
                "content": "see [[Existing page]] and #newtag",
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    settle(&mat).await;

    let tag = tag_named(&pool, &space, "newtag").await;
    assert_eq!(tag.len(), 1, "the tag is created once, in the space");
    let block = result["id"].as_str().unwrap().to_owned();
    assert_eq!(
        result["content"],
        format!("see [[{target}]] and #[{}]", tag[0]),
    );
    assert_eq!(
        backlink_sources(&pool, &space, &target).await,
        [block.as_str()]
    );
    let refs: Vec<String> =
        sqlx::query_scalar("SELECT tag_id FROM block_tag_refs WHERE source_id = ?")
            .bind(&block)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(refs, tag, "the tag is attached as an inline ref");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_block_content_links_names_but_keeps_a_title_as_written_5397() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let target = mk_page(&pool, &mat, &space, "Existing page").await;
    let block = mk_child_of(&pool, &mat, &target, "draft").await;
    let ideas = mk_page(&pool, &mat, &space, "Ideas").await;
    settle(&mat).await;

    let result = tools
        .call_tool(
            "update_block_content",
            json!({"block_id": block, "content": "about [[existing PAGE]]", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["content"], format!("about [[{target}]]"));

    let result = tools
        .call_tool(
            "update_block_content",
            json!({"block_id": ideas, "content": "Ideas #later", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("a page renames");
    assert_eq!(result["content"], "Ideas #later");
    assert!(tag_named(&pool, &space, "later").await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tag_tools_take_a_tag_by_name_5397() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "c").await;
    let tag = mk_tag_in(&pool, &mat, &space).await;
    settle(&mat).await;
    let block = block.id.into_string();

    tools
        .call_tool(
            "add_tag",
            json!({"block_id": block, "tag_id": "Work", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("add by name");
    assert_eq!(tags_of(&pool, &block).await, [tag]);

    tools
        .call_tool(
            "remove_tag",
            json!({"block_id": block, "tag_id": "work", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("remove by name");
    assert!(tags_of(&pool, &block).await.is_empty());

    let err = tools
        .call_tool(
            "add_tag",
            json!({"block_id": block, "tag_id": "play", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("an unknown tag name must be refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_tools_take_pages_by_name_5397() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let other = mk_space(&pool, " other").await;
    let from = mk_page(&pool, &mat, &space, "From").await;
    let to = mk_page(&pool, &mat, &space, "To").await;
    let x = mk_child_of(&pool, &mat, &from, "x").await;
    settle(&mat).await;

    tools
        .call_tool(
            "move_blocks",
            json!({"block_ids": [x], "parent_id": "to", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("move under a page by name");
    assert_eq!(live_children(&pool, &to).await, [x]);

    let result = tools
        .call_tool(
            "move_page_to_space",
            json!({"page_id": "From", "space_id": space, "target_space_id": other}),
            &test_ctx_agent(),
        )
        .await
        .expect("move a page by name");
    assert_eq!(result["page_id"], from.as_str());
}

/// A ULID argument stays an id in any case, so the space check sees the block
/// the write lands under.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lowercase_ulid_argument_is_still_the_id_5397() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let other = mk_space(&pool, " other").await;
    let page = mk_page(&pool, &mat, &space, "Here").await;
    let elsewhere = mk_page(&pool, &mat, &other, "There").await;
    settle(&mat).await;

    let result = tools
        .call_tool(
            "append_block",
            json!({"parent_id": page.to_lowercase(), "content": "x", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["parent_id"], page.as_str());

    let err = tools
        .call_tool(
            "append_block",
            json!({"parent_id": elsewhere.to_lowercase(), "content": "x", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a page of another space is refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    assert!(child_contents(&pool, &elsewhere).await.is_empty());
}

// -------------------------------------------------------------------
// One transaction per write (#5402)
// -------------------------------------------------------------------

/// `name`'s result, and how many `CommandTx`s the call opened.
async fn command_txs_of(tools: &ReadWriteTools, name: &str, args: Value) -> (Value, usize) {
    let (result, opened) =
        crate::db::count_command_tx_opens(Box::pin(tools.call_tool(name, args, &test_ctx_agent())))
            .await;
    (
        result.unwrap_or_else(|e| panic!("{name} must succeed: {e:?}")),
        opened,
    )
}

/// Every write tool that addresses an existing block checks its space inside
/// the write's own transaction, so a call opens exactly one; a `batch` checks
/// each op's in its one transaction.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_write_tool_opens_one_command_transaction_5402() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let target_space = mk_space(&pool, "target").await;
    let page = mk_page(&pool, &mat, &space, "P").await;
    let other_page = mk_page(&pool, &mat, &space, "Q").await;
    let block = mk_child_of(&pool, &mat, &page, "x").await;
    let batched = mk_child_of(&pool, &mat, &page, "z").await;
    let edited = mk_child_of(&pool, &mat, &page, "e").await;
    let tag = mk_tag_in(&pool, &mat, &space).await;
    settle(&mat).await;

    let mut opened = Vec::new();
    let (appended, n) = command_txs_of(
        &tools,
        "append_block",
        json!({ "parent_id": page, "content": "a", "space_id": space }),
    )
    .await;
    opened.push(("append_block", n));
    let deleted_at = {
        let calls = [
            (
                "append_markdown",
                json!({ "parent_id": page, "markdown": "- m", "space_id": space }),
            ),
            (
                "update_block_content",
                json!({ "block_id": block, "content": "y", "space_id": space }),
            ),
            (
                "set_property",
                json!({ "block_id": block, "key": "assignee", "value_text": "alice", "space_id": space }),
            ),
            (
                "delete_property",
                json!({ "block_id": block, "key": "assignee", "space_id": space }),
            ),
            (
                "add_tag",
                json!({ "block_id": block, "tag_id": tag, "space_id": space }),
            ),
            (
                "remove_tag",
                json!({ "block_id": block, "tag_id": tag, "space_id": space }),
            ),
            (
                "move_blocks",
                json!({ "block_ids": [block], "parent_id": other_page, "space_id": space }),
            ),
            (
                "delete_block",
                json!({ "block_id": block, "space_id": space }),
            ),
        ];
        let mut last = Value::Null;
        for (name, args) in calls {
            let (result, n) = command_txs_of(&tools, name, args).await;
            opened.push((name, n));
            last = result;
        }
        last["deleted_at"].clone()
    };
    let op_ref = create_op_ref(&pool, appended["id"].as_str().unwrap()).await;
    let calls = [
        (
            "restore_block",
            json!({ "block_id": block, "deleted_at": deleted_at, "space_id": space }),
        ),
        ("undo", json!({ "op_refs": [op_ref], "space_id": space })),
        (
            "move_page_to_space",
            json!({ "page_id": other_page, "space_id": space, "target_space_id": target_space }),
        ),
        (
            "batch",
            json!({
                "ops": [
                    { "op": "append_block", "parent_id": page, "content": "b" },
                    { "op": "update_block_content", "block_id": batched, "content": "z2" },
                    { "op": "set_property", "block_id": batched, "key": "assignee", "value_text": "bob" },
                    { "op": "add_tag", "block_id": batched, "tag_id": tag },
                    { "op": "delete_block", "block_id": batched },
                ],
                "space_id": space,
            }),
        ),
    ];
    for (name, args) in calls {
        let (_, n) = command_txs_of(&tools, name, args).await;
        opened.push((name, n));
    }
    settle(&mat).await;
    let base = editable_source(&pool, &mat, &page, &space).await;
    let (_, n) = command_txs_of(
        &tools,
        "edit_page_markdown",
        json!({
            "page_id": page,
            "markdown": with_bullet_moved_last(&base, &edited),
            "base": base,
            "space_id": space,
        }),
    )
    .await;
    opened.push(("edit_page_markdown", n));

    assert_eq!(
        opened,
        [
            ("append_block", 1),
            ("append_markdown", 1),
            ("update_block_content", 1),
            ("set_property", 1),
            ("delete_property", 1),
            ("add_tag", 1),
            ("remove_tag", 1),
            ("move_blocks", 1),
            ("delete_block", 1),
            ("restore_block", 1),
            ("undo", 1),
            ("move_page_to_space", 1),
            ("batch", 1),
            ("edit_page_markdown", 1),
        ],
        "each write opens one transaction, its space check inside it"
    );
}

/// `list_spaces` reads the reader pool, so it answers while every writer
/// connection is taken.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_spaces_answers_while_the_writers_are_busy_5402() {
    let dir = TempDir::new().unwrap();
    let pools = crate::db::init_pools(&dir.path().join("split.db"))
        .await
        .unwrap();
    let mat = Materializer::with_read_pool(pools.write.clone(), pools.read.clone());
    let tools = ReadWriteTools::new(
        pools.write.clone(),
        pools.read.clone(),
        mat.clone(),
        DEV.to_string(),
    );
    let space = mk_space(&pools.write, "Readable").await;
    settle(&mat).await;

    let _first = pools.write.acquire().await.unwrap();
    let _second = pools.write.acquire().await.unwrap();
    let spaces = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tools.call_tool("list_spaces", json!({}), &test_ctx_agent()),
    )
    .await
    .expect("list_spaces waited for a writer connection")
    .expect("list_spaces must succeed");
    let ids: Vec<&str> = spaces
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&space.as_str()), "got {spaces}");
}

/// A read tool on RW is RO's handler: the same call returns the same JSON on
/// both registries (#5379).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_through_rw_match_ro_5379() {
    let (rw, mat, pool, space, _dir) = mk_tools().await;
    let ro = crate::mcp::tools_ro::ReadOnlyTools::new(
        pool.clone(),
        pool.clone(),
        mat.clone(),
        DEV.to_string(),
    );
    let page = mk_page(&pool, &mat, &space, "Haystack").await;
    mk_child_of(&pool, &mat, &page, "needle in the haystack").await;
    settle(&mat).await;

    for (tool, args) in [
        ("get_page", json!({"page_id": page, "space_id": space})),
        ("search", json!({"query": "needle", "space_id": space})),
    ] {
        let via_rw = rw
            .call_tool(tool, args.clone(), &test_ctx_agent())
            .await
            .unwrap_or_else(|e| panic!("{tool} on RW: {e:?}"));
        let via_ro = ro
            .call_tool(tool, args, &test_ctx_agent())
            .await
            .unwrap_or_else(|e| panic!("{tool} on RO: {e:?}"));
        assert_eq!(via_rw, via_ro, "{tool} differs between RW and RO");
        if tool == "search" {
            assert_eq!(
                via_rw["items"].as_array().map(Vec::len),
                Some(1),
                "got {via_rw}"
            );
        }
    }
}

/// On split pools, a block RW writes is readable through RW's read tools
/// straight after (#5379).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rw_reads_its_own_write_5379() {
    let dir = TempDir::new().unwrap();
    let pools = crate::db::init_pools(&dir.path().join("split.db"))
        .await
        .unwrap();
    let mat = Materializer::with_read_pool(pools.write.clone(), pools.read.clone());
    let tools = ReadWriteTools::new(
        pools.write.clone(),
        pools.read.clone(),
        mat.clone(),
        DEV.to_string(),
    );
    let space = mk_space(&pools.write, "Readable").await;
    let page = mk_page(&pools.write, &mat, &space, "Page").await;
    settle(&mat).await;

    let written = tools
        .call_tool(
            "append_block",
            json!({"parent_id": page, "content": "written by RW", "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("append_block");
    let read = tools
        .call_tool(
            "get_block",
            json!({"block_id": written["id"], "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("get_block on RW");
    assert_eq!(read["content"], "written by RW");
}

/// The one read tool that writes: a day `journal_for_date` creates on RW is
/// created on the writer pool (the reader pool refuses writes), as the agent,
/// and reaches open views as it does on RO (#5379, #5314).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn journal_for_date_on_rw_creates_the_day_as_the_agent_5379() {
    let dir = TempDir::new().unwrap();
    let pools = crate::db::init_pools(&dir.path().join("split.db"))
        .await
        .unwrap();
    let mat = Materializer::with_read_pool(pools.write.clone(), pools.read.clone());
    let emitter = Arc::new(RecordingViewChangeEmitter::new());
    let tools = ReadWriteTools::new(
        pools.write.clone(),
        pools.read.clone(),
        mat.clone(),
        DEV.to_string(),
    )
    .with_view_emitter(emitter.clone());
    let space = mk_space(&pools.write, "Journal").await;
    let since = last_seq(&pools.write).await;
    let date = chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let created = tools
        .call_tool(
            "journal_for_date",
            json!({"date": date, "space_id": space}),
            &test_ctx_agent(),
        )
        .await
        .expect("journal_for_date creates on the writer pool");
    let page_id = created["id"].as_str().expect("id present").to_string();
    assert_eq!(emitter.blocks_changed(), vec![vec![page_id]]);
    let origins: Vec<String> =
        sqlx::query_scalar("SELECT origin FROM op_log WHERE op_type = 'create_block' AND seq > ?")
            .bind(since)
            .fetch_all(&pools.write)
            .await
            .unwrap();
    assert_eq!(origins, vec!["agent:test-agent"]);
}

// -------------------------------------------------------------------
// batch / edit_page_markdown (#5399). That a batch is one activity entry
// and one undo is `rmcp_adapter::tests::rw_batch_is_one_activity_entry_and_one_undo_5399`.
// -------------------------------------------------------------------

/// The newest op's `seq`, so a test can read what a call wrote after it.
async fn last_seq(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// The types of the ops written after `seq`, oldest first.
async fn op_types_after(pool: &SqlitePool, seq: i64) -> Vec<String> {
    sqlx::query_scalar("SELECT op_type FROM op_log WHERE seq > ? ORDER BY seq")
        .bind(seq)
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn property_count(pool: &SqlitePool, block_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM block_properties WHERE block_id = ?")
        .bind(block_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// `parent`'s children in `space`'s Loro engine, in order.
fn engine_children(mat: &Materializer, space: &str, parent: &str) -> Vec<String> {
    let space = SpaceId::from_trusted(space);
    let mut guard = mat
        .loro_state()
        .registry
        .for_space(&space, DEV)
        .expect("the space's engine");
    guard
        .engine_mut()
        .children_ordered_block_ids(Some(parent))
        .expect("the engine's children")
}

/// Whether `space`'s Loro engine holds `block` deleted.
fn engine_deleted(mat: &Materializer, space: &str, block: &str) -> bool {
    let space = SpaceId::from_trusted(space);
    let mut guard = mat
        .loro_state()
        .registry
        .for_space(&space, DEV)
        .expect("the space's engine");
    guard
        .engine_mut()
        .read_deleted(block)
        .expect("the engine holds the block")
}

/// Ops that wrote in the batch's transaction are rolled back with it when a
/// later op is refused: the refused op is one only running reveals, on the
/// block the op before it deleted. The engine takes each op as it runs, so it
/// is rewound too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_with_one_refused_op_writes_nothing_5399() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let page = mk_page(&pool, &mat, &space, "P").await;
    let a = mk_child_of(&pool, &mat, &page, "A").await;
    let b = mk_child_of(&pool, &mat, &page, "B").await;
    settle(&mat).await;
    let before = op_count(&pool).await;
    let properties_before = property_count(&pool, &a).await;
    assert_eq!(
        engine_children(&mat, &space, &page),
        [a.clone(), b.clone()],
        "the engine holds the page as the batch finds it"
    );

    let err = tools
        .call_tool(
            "batch",
            json!({
                "ops": [
                    { "op": "append_block", "parent_id": page, "content": "new" },
                    { "op": "update_block_content", "block_id": a, "content": "A2" },
                    { "op": "set_property", "block_id": a, "key": "assignee", "value_text": "alice" },
                    { "op": "delete_block", "block_id": b },
                    { "op": "update_block_content", "block_id": b, "content": "B2" },
                ],
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("an op on a block the batch deleted is refused");
    assert!(
        matches!(&err, AppError::NotFound(message) if message.starts_with("ops[4]: ")),
        "the refusal names the op, got {err:?}"
    );
    settle(&mat).await;

    assert_eq!(op_count(&pool).await, before, "no op was written");
    assert_eq!(child_contents(&pool, &page).await, ["A", "B"]);
    assert_eq!(property_count(&pool, &a).await, properties_before);
    assert_eq!(
        engine_children(&mat, &space, &page),
        [a.clone(), b.clone()],
        "the engine kept an op the batch rolled back"
    );
    assert!(
        !engine_deleted(&mat, &space, &b),
        "B is deleted in the engine"
    );
    assert!(emitter.blocks_changed().is_empty(), "nothing to reload");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_refuses_malformed_ops_5399() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let page = mk_page(&pool, &mat, &space, "P").await;
    let a = mk_child_of(&pool, &mat, &page, "A").await;
    settle(&mat).await;
    let before = op_count(&pool).await;
    let delete_a = json!({ "op": "delete_block", "block_id": a });
    let over_cap = vec![delete_a.clone(); agaric_store::pagination::MAX_BATCH_BLOCK_IDS + 1];

    for (what, ops, says) in [
        ("no ops", json!([]), "ops cannot be empty"),
        ("over the cap", json!(over_cap), "exceeds maximum"),
        ("no op name", json!([{ "block_id": a }]), "ops[0]: "),
        (
            "not a batch op",
            json!([delete_a, { "op": "create_page", "title": "x" }]),
            "ops[1]: tool `batch`: `create_page` is not a batch op",
        ),
        (
            "an argument its tool does not take",
            json!([{ "op": "delete_block", "block_id": a, "bogus": 1 }]),
            "ops[0]: tool `delete_block`",
        ),
    ] {
        let err = tools
            .call_tool(
                "batch",
                json!({ "ops": ops, "space_id": space }),
                &test_ctx_agent(),
            )
            .await
            .expect_err(what);
        assert!(
            matches!(&err, AppError::Validation { message, .. } if message.contains(says)),
            "{what}: got {err:?}"
        );
    }
    // A value_ref that is no ULID is `AppError::Ulid`, which names its op too.
    let err = tools
        .call_tool(
            "batch",
            json!({
                "ops": [
                    delete_a,
                    { "op": "set_property", "block_id": a, "key": "assignee", "value_ref": "nope" },
                ],
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a value_ref that is no ULID");
    assert!(
        matches!(&err, AppError::Ulid(message) if message.starts_with("ops[1]: ")),
        "got {err:?}"
    );
    assert_eq!(op_count(&pool).await, before, "no op was written");
    assert!(is_live(&pool, &a).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_op_on_another_space_is_refused_5399() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let other = mk_space(&pool, "other").await;
    let page = mk_page(&pool, &mat, &space, "Here").await;
    let elsewhere = mk_page(&pool, &mat, &other, "There").await;
    let a = mk_child_of(&pool, &mat, &page, "A").await;
    let x = mk_child_of(&pool, &mat, &elsewhere, "X").await;
    settle(&mat).await;
    let before = op_count(&pool).await;

    let err = tools
        .call_tool(
            "batch",
            json!({
                "ops": [
                    { "op": "update_block_content", "block_id": a, "content": "A2" },
                    { "op": "update_block_content", "block_id": x, "content": "X2" },
                ],
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a block of another space is refused");
    assert!(
        matches!(&err, AppError::Validation { message, .. }
            if message.starts_with("ops[1]: ") && message.contains("belongs to space")),
        "got {err:?}"
    );
    assert_eq!(op_count(&pool).await, before, "no op was written");
    assert_eq!(child_contents(&pool, &page).await, ["A"]);
    assert_eq!(child_contents(&pool, &elsewhere).await, ["X"]);
}

/// A batch that would write more ops than one undo reverts is refused: each
/// state change writes two (the state and its stamp), so the input cap alone
/// lets this one through.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_over_one_undo_is_refused_5399() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let page = mk_page(&pool, &mat, &space, "P").await;
    let a = mk_child_of(&pool, &mat, &page, "A").await;
    settle(&mat).await;
    let before = op_count(&pool).await;
    let ops: Vec<Value> = (0..agaric_store::pagination::MAX_BATCH_BLOCK_IDS)
        .map(|i| {
            let state = if i % 2 == 0 { "TODO" } else { "DONE" };
            json!({ "op": "set_property", "block_id": a, "key": "todo_state", "value_text": state })
        })
        .collect();

    let err = tools
        .call_tool(
            "batch",
            json!({ "ops": ops, "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("more ops than one undo reverts");
    assert!(
        matches!(&err, AppError::Validation { message, .. }
            if message.starts_with("ops[") && message.contains("ops length")),
        "got {err:?}"
    );
    assert_eq!(op_count(&pool).await, before, "no op was written");
}

/// A batch reloads what it wrote once, as its tools would each: the page a
/// block left, the page it landed on, and the property set on it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_notifies_the_pages_and_properties_it_wrote_5399() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let src = mk_page(&pool, &mat, &space, "Src").await;
    let dst = mk_page(&pool, &mat, &space, "Dst").await;
    let a = mk_child_of(&pool, &mat, &src, "A").await;
    settle(&mat).await;

    tools
        .call_tool(
            "batch",
            json!({
                "ops": [
                    { "op": "set_property", "block_id": a, "key": "assignee", "value_text": "alice" },
                    { "op": "move_blocks", "block_ids": [a], "parent_id": dst },
                ],
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect("a property and a move");

    let mut pages = emitter.blocks_changed();
    pages.iter_mut().for_each(|reloaded| reloaded.sort());
    let mut both = vec![src, dst];
    both.sort();
    assert_eq!(
        (pages, emitter.property_changed()),
        (vec![both], vec![(a, vec!["assignee".to_owned()])]),
    );
}

/// The delete's in-transaction apply reaches only the block it names; its
/// descendants leave the engine in the fan-out after the commit, which a
/// batch must run as a lone `delete_block` does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_delete_takes_the_descendants_out_of_the_engine_5399() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let page = mk_page(&pool, &mat, &space, "P").await;
    let parent = mk_child_of(&pool, &mat, &page, "X").await;
    let child = mk_child_of(&pool, &mat, &parent, "G").await;
    settle(&mat).await;
    assert!(
        !engine_deleted(&mat, &space, &child),
        "the engine holds G alive"
    );

    tools
        .call_tool(
            "batch",
            json!({
                "ops": [{ "op": "delete_block", "block_id": parent }],
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect("delete a block with a child");
    settle(&mat).await;

    assert!(
        !is_live(&pool, &child).await,
        "the cascade deleted G in SQL"
    );
    assert!(engine_deleted(&mat, &space, &parent));
    assert!(
        engine_deleted(&mat, &space, &child),
        "G is still alive in the engine"
    );
}

/// The page's source as the RO `get_page_markdown` hands an agent to edit.
async fn editable_source(pool: &SqlitePool, mat: &Materializer, page: &str, space: &str) -> String {
    let ro = crate::mcp::tools_ro::ReadOnlyTools::new(
        pool.clone(),
        pool.clone(),
        mat.clone(),
        DEV.to_string(),
    );
    let read = ro
        .call_tool(
            "get_page_markdown",
            json!({ "page_id": page, "editable": true, "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect("read the page's source");
    read["markdown"].as_str().unwrap().to_owned()
}

/// `source` with the line that ends with `block`'s anchor moved to the end.
fn with_bullet_moved_last(source: &str, block: &str) -> String {
    let anchor = format!("^{block}");
    let mut lines: Vec<&str> = source.trim_end_matches('\n').split('\n').collect();
    let at = lines
        .iter()
        .position(|line| line.ends_with(&anchor))
        .expect("the block's line");
    let line = lines.remove(at);
    lines.push(line);
    lines.join("\n") + "\n"
}

/// Read, move one bullet, write: one `MoveBlock`, and nothing else.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_page_markdown_round_trip_writes_one_move_5399() {
    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let page = mk_page(&pool, &mat, &space, "P").await;
    let linked = mk_page(&pool, &mat, &space, "Q").await;
    // A link the source writes as a name, which the save must not rewrite.
    let a = mk_child_of(&pool, &mat, &page, &format!("A [[{linked}]]")).await;
    let b = mk_child_of(&pool, &mat, &page, "B").await;
    let c = mk_child_of(&pool, &mat, &page, "C").await;
    settle(&mat).await;
    let base = editable_source(&pool, &mat, &page, &space).await;
    let since = last_seq(&pool).await;

    let result = tools
        .call_tool(
            "edit_page_markdown",
            json!({
                "page_id": "P",
                "markdown": with_bullet_moved_last(&base, &a),
                "base": base,
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect("save the moved bullet");
    settle(&mat).await;

    assert_eq!(result["page_id"], page.as_str());
    assert_eq!(result["moved"], 1);
    assert_eq!(op_types_after(&pool, since).await, ["move_block"]);
    assert_eq!(live_children(&pool, &page).await, [b, c, a]);
    assert_eq!(emitter.blocks_changed(), [vec![page]]);
}

/// A base the page has moved on from is refused as the app's source mode
/// refuses it, so the agent reads again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_page_markdown_stale_base_is_refused_5399() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let page = mk_page(&pool, &mat, &space, "P").await;
    let a = mk_child_of(&pool, &mat, &page, "A").await;
    let b = mk_child_of(&pool, &mat, &page, "B").await;
    settle(&mat).await;
    let base = editable_source(&pool, &mat, &page, &space).await;
    crate::commands::edit_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&b), "B2".into())
        .await
        .unwrap();
    settle(&mat).await;
    let before = op_count(&pool).await;

    let err = tools
        .call_tool(
            "edit_page_markdown",
            json!({
                "page_id": page,
                "markdown": with_bullet_moved_last(&base, &a),
                "base": base,
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a stale base is refused");
    assert_eq!(
        err.validation_code(),
        Some(agaric_core::error::ValidationCode::RequiresRefresh),
        "got {err:?}"
    );
    assert_eq!(op_count(&pool).await, before, "no op was written");
    assert_eq!(live_children(&pool, &page).await, [a, b]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_page_markdown_cross_space_refused_5399() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let other = mk_space(&pool, "other").await;
    let page = mk_page(&pool, &mat, &other, "There").await;
    let a = mk_child_of(&pool, &mat, &page, "A").await;
    let b = mk_child_of(&pool, &mat, &page, "B").await;
    settle(&mat).await;
    let base = editable_source(&pool, &mat, &page, &other).await;
    let before = op_count(&pool).await;

    let err = tools
        .call_tool(
            "edit_page_markdown",
            json!({
                "page_id": page,
                "markdown": with_bullet_moved_last(&base, &a),
                "base": base,
                "space_id": space,
            }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a page of another space is refused");
    assert!(
        matches!(&err, AppError::Validation { message, .. } if message.contains("belongs to space")),
        "got {err:?}"
    );
    assert_eq!(op_count(&pool).await, before, "no op was written");
    assert_eq!(live_children(&pool, &page).await, [a, b]);
}

// -------------------------------------------------------------------
// set_page_aliases (#5378)
// -------------------------------------------------------------------

async fn aliases_of(pool: &SqlitePool, page: &str) -> Vec<String> {
    crate::commands::get_page_aliases_inner(pool, page)
        .await
        .unwrap()
}

/// Seed `page`'s aliases as the user would, outside any agent scope.
async fn seed_aliases(pool: &SqlitePool, mat: &Materializer, page: &str, aliases: &[&str]) {
    let aliases = aliases.iter().map(|a| (*a).to_owned()).collect();
    crate::commands::set_page_aliases_inner(pool, DEV, mat, page, aliases)
        .await
        .unwrap();
    settle(mat).await;
}

/// The call replaces the list, and its op refs, the ones its one activity
/// entry carries, revert as the feed's Undo does to the list before it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_replaces_the_list_and_one_undo_restores_it_5378() {
    use agaric_store::task_locals::{LAST_APPEND, take_appends};
    use std::cell::RefCell;

    let (tools, mat, pool, space, emitter, _dir) = mk_tools_recording().await;
    let page = mk_page(&pool, &mat, &space, "Home").await;
    seed_aliases(&pool, &mat, &page, &["old", "keep"]).await;

    let (result, op_refs) = LAST_APPEND
        .scope(RefCell::new(Vec::new()), async {
            let result = tools
                .call_tool(
                    "set_page_aliases",
                    json!({ "page_id": page, "aliases": ["keep", " new "], "space_id": space }),
                    &test_ctx_agent(),
                )
                .await
                .expect("happy path");
            (result, take_appends())
        })
        .await;
    settle(&mat).await;

    assert_eq!(
        result,
        json!({ "page_id": page, "aliases": ["keep", "new"] })
    );
    assert_eq!(aliases_of(&pool, &page).await, ["keep", "new"]);
    assert_eq!(emitter.blocks_changed(), vec![vec![page.clone()]]);

    // The activity feed's Undo: `revert_ops` on the entry's refs, as the user.
    crate::commands::revert_ops_inner(&pool, DEV, &mat, op_refs)
        .await
        .expect("the call's ops revert");
    settle(&mat).await;
    assert_eq!(aliases_of(&pool, &page).await, ["keep", "old"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_unknown_page_is_not_found_5378() {
    let (tools, _mat, pool, space, _dir) = mk_tools().await;
    let missing = BlockId::new().into_string();
    let before = op_count(&pool).await;

    let err = tools
        .call_tool(
            "set_page_aliases",
            json!({ "page_id": missing, "aliases": ["a"], "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("no such page");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
    assert_eq!(op_count(&pool).await, before, "no op was written");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_non_page_is_not_found_5378() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let block = mk_in_space_content_block(&pool, &mat, &space, "c").await;
    settle(&mat).await;
    let before = op_count(&pool).await;

    let err = tools
        .call_tool(
            "set_page_aliases",
            json!({ "page_id": block.id.as_str(), "aliases": ["a"], "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("only a page has aliases");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
    assert_eq!(op_count(&pool).await, before, "no op was written");
    assert!(aliases_of(&pool, block.id.as_str()).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_cross_space_rejected_5378() {
    let (tools, mat, pool, space_a, _dir) = mk_tools().await;
    let space_b = mk_space(&pool, " space B").await;
    let page_b = mk_page(&pool, &mat, &space_b, "PageB").await;
    seed_aliases(&pool, &mat, &page_b, &["b1"]).await;

    let err = tools
        .call_tool(
            "set_page_aliases",
            json!({ "page_id": page_b, "aliases": ["a"], "space_id": space_a }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("a page of another space is refused");
    assert!(
        matches!(&err, AppError::Validation { message, .. } if message.contains("belongs to space")),
        "got {err:?}"
    );
    assert_eq!(aliases_of(&pool, &page_b).await, ["b1"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_alias_held_by_another_page_rejected_5378() {
    let (tools, mat, pool, space, _dir) = mk_tools().await;
    let page = mk_page(&pool, &mat, &space, "Mine").await;
    let other = mk_page(&pool, &mat, &space, "Theirs").await;
    seed_aliases(&pool, &mat, &page, &["mine"]).await;
    seed_aliases(&pool, &mat, &other, &["taken"]).await;
    let before = op_count(&pool).await;

    let err = tools
        .call_tool(
            "set_page_aliases",
            json!({ "page_id": page, "aliases": ["fresh", "taken"], "space_id": space }),
            &test_ctx_agent(),
        )
        .await
        .expect_err("another page holds `taken`");
    assert_eq!(
        err.validation_code(),
        Some(agaric_core::error::ValidationCode::DuplicatePageAlias),
        "got {err:?}"
    );
    assert_eq!(op_count(&pool).await, before, "nothing was written");
    assert_eq!(aliases_of(&pool, &page).await, ["mine"]);
    assert_eq!(aliases_of(&pool, &other).await, ["taken"]);
}
