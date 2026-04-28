//! Read-write [`ToolRegistry`] impl — the v2 MCP write tool surface (FEAT-4h slice 2).
//!
//! Where `tools_ro.rs` exposes read paths, this module exposes the narrow
//! set of **reversible** mutations that external agents may perform. Every
//! tool is a thin wrapper around an existing `*_inner` command handler so
//! the op-log / CQRS / sqlx-compile-time-query invariants of the frontend
//! path apply verbatim to agent calls (AGENTS.md §Key Architectural
//! Invariants).
//!
//! # Tool surface
//!
//! | Tool | Backing `*_inner` | Notes |
//! |------|-------------------|-------|
//! | `append_block` | [`create_block_inner`](crate::commands::create_block_inner) | `block_type` hard-coded to `"content"`. `parent_id` required. |
//! | `update_block_content` | [`edit_block_inner`](crate::commands::edit_block_inner) | |
//! | `set_property` | [`set_property_inner`](crate::commands::set_property_inner) | Exactly one of `value_*` must be provided. |
//! | `add_tag` | [`add_tag_inner`](crate::commands::add_tag_inner) | Tag block must already exist — no tag creation. |
//! | `create_page` | [`create_block_inner`](crate::commands::create_block_inner) | `block_type = "page"`, `parent_id = None`. |
//! | `delete_block` | [`delete_block_inner`](crate::commands::delete_block_inner) | Soft delete. Reversible via `reverse.rs`. |
//!
//! # Actor scoping
//!
//! Each call is wrapped in [`ACTOR::scope`](crate::mcp::actor::ACTOR) so
//! downstream `append_local_op_in_tx` stamps `origin = 'agent:<name>'`
//! (FEAT-4h slice 1). The server dispatcher already wraps outer
//! `call_tool` invocations; scoping again here is idempotent and keeps
//! direct `ReadWriteTools::call_tool` calls (tests, diagnostics) honest.
//!
//! # What is deliberately NOT exposed
//!
//! - `purge_block` / `delete_attachment` (non-reversible)
//! - Tag creation (blocks with `block_type = 'tag'`)
//! - Property-definition mutation
//! - Conflict resolution, compaction, recovery
//! - Anything that touches sync peers or the device id
//!
//! If an agent needs one of these, the user runs it from the UI.

use std::future::Future;

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;

use super::actor::ActorContext;
use super::dispatch::{scoped_dispatch, unknown_tool_error};
use super::handler_utils::{normalize_ulid_arg, parse_args, to_tool_result};
use super::registry::{
    ToolDescription, ToolRegistry, TOOL_ADD_TAG, TOOL_APPEND_BLOCK, TOOL_CREATE_PAGE,
    TOOL_DELETE_BLOCK, TOOL_SET_PROPERTY, TOOL_UPDATE_BLOCK_CONTENT,
};
use crate::commands::{
    add_tag_inner, create_block_inner, delete_block_inner, edit_block_inner, set_property_inner,
};
use crate::error::AppError;
use crate::materializer::Materializer;

// ---------------------------------------------------------------------------
// Typed argument structs (one per tool)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AppendBlockArgs {
    parent_id: String,
    content: String,
    #[serde(default)]
    position: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateBlockContentArgs {
    block_id: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SetPropertyArgs {
    block_id: String,
    key: String,
    #[serde(default)]
    value_text: Option<String>,
    #[serde(default)]
    value_num: Option<f64>,
    #[serde(default)]
    value_date: Option<String>,
    #[serde(default)]
    value_ref: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AddTagArgs {
    block_id: String,
    tag_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreatePageArgs {
    title: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteBlockArgs {
    block_id: String,
}

// ---------------------------------------------------------------------------
// ReadWriteTools
// ---------------------------------------------------------------------------

/// Read-write MCP tool registry. Holds the **write pool**, a
/// [`Materializer`] handle, and this device's `device_id` so every
/// mutation lands with the correct attribution.
///
/// The struct shape mirrors [`crate::mcp::tools_ro::ReadOnlyTools`] so the
/// wiring in `mod.rs` can share helpers. The only material difference is
/// the pool the caller passes in: RW must receive the writer pool, never
/// the reader pool.
pub struct ReadWriteTools {
    pool: SqlitePool,
    materializer: Materializer,
    device_id: String,
}

impl ReadWriteTools {
    /// Construct a read-write registry. `pool` must be the *writer* pool
    /// — the six tools all mutate.
    pub fn new(pool: SqlitePool, materializer: Materializer, device_id: String) -> Self {
        Self {
            pool,
            materializer,
            device_id,
        }
    }
}

/// Static tool-description list for the read-write MCP surface.
///
/// Lifted out of [`ToolRegistry::list_tools`] so callers that need the
/// names without a constructed registry (notably the privacy-guard test
/// in `summarise.rs`, MAINT-136) can drive iteration from the live
/// metadata. The `&self` impl below just delegates here.
pub(crate) fn list_tool_descriptions() -> Vec<ToolDescription> {
    vec![
        tool_desc_append_block(),
        tool_desc_update_block_content(),
        tool_desc_set_property(),
        tool_desc_add_tag(),
        tool_desc_create_page(),
        tool_desc_delete_block(),
    ]
}

impl ToolRegistry for ReadWriteTools {
    fn list_tools(&self) -> Vec<ToolDescription> {
        list_tool_descriptions()
    }

    fn call_tool(
        &self,
        name: &str,
        args: Value,
        ctx: &ActorContext,
    ) -> impl Future<Output = Result<Value, AppError>> + Send {
        // MAINT-150 (h): ACTOR scope + name-clone boilerplate is
        // shared with `tools_ro` via `super::dispatch::scoped_dispatch`.
        let pool = self.pool.clone();
        let materializer = self.materializer.clone();
        let device_id = self.device_id.clone();
        scoped_dispatch(ctx, name, move |name| async move {
            match name.as_str() {
                TOOL_APPEND_BLOCK => {
                    handle_append_block(&pool, &materializer, &device_id, args).await
                }
                TOOL_UPDATE_BLOCK_CONTENT => {
                    handle_update_block_content(&pool, &materializer, &device_id, args).await
                }
                TOOL_SET_PROPERTY => {
                    handle_set_property(&pool, &materializer, &device_id, args).await
                }
                TOOL_ADD_TAG => handle_add_tag(&pool, &materializer, &device_id, args).await,
                TOOL_CREATE_PAGE => {
                    handle_create_page(&pool, &materializer, &device_id, args).await
                }
                TOOL_DELETE_BLOCK => {
                    handle_delete_block(&pool, &materializer, &device_id, args).await
                }
                other => Err(unknown_tool_error(other)),
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Tool descriptions (static metadata)
// ---------------------------------------------------------------------------

fn tool_desc_append_block() -> ToolDescription {
    ToolDescription {
        name: TOOL_APPEND_BLOCK.to_string(),
        description: "Append a content block under an existing parent. The block_type is \
                      always `content` — agents cannot create pages or tags through this tool."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["parent_id", "content"],
            "properties": {
                "parent_id": {
                    "type": "string",
                    "description": "ULID of the parent block (required — no orphan blocks).",
                },
                "content": {
                    "type": "string",
                    "description": "Markdown content for the new block.",
                },
                "position": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional 1-based sibling position. Defaults to append (end).",
                },
            },
        }),
    }
}

fn tool_desc_update_block_content() -> ToolDescription {
    ToolDescription {
        name: TOOL_UPDATE_BLOCK_CONTENT.to_string(),
        description: "Replace the content of an existing block. Reversible via page history."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id", "content"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the block to edit." },
                "content": { "type": "string", "description": "New Markdown content." },
            },
        }),
    }
}

fn tool_desc_set_property() -> ToolDescription {
    ToolDescription {
        name: TOOL_SET_PROPERTY.to_string(),
        description: "Set (upsert) a typed property on a block. Exactly one of value_text / \
                      value_num / value_date / value_ref must be provided."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id", "key"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the target block." },
                "key":      { "type": "string", "description": "Property key (see list_property_defs)." },
                "value_text": { "type": "string", "description": "Text value (exactly one value_* must be set)." },
                "value_num":  { "type": "number", "description": "Numeric value (exactly one value_* must be set)." },
                "value_date": { "type": "string", "description": "ISO-8601 date (exactly one value_* must be set)." },
                "value_ref":  { "type": "string", "description": "Block ULID reference (exactly one value_* must be set)." },
            },
        }),
    }
}

fn tool_desc_add_tag() -> ToolDescription {
    ToolDescription {
        name: TOOL_ADD_TAG.to_string(),
        description: "Apply an existing tag to a block. Does NOT create tags — the tag block \
                      must already exist (create tags from the UI)."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id", "tag_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the block to tag." },
                "tag_id":   { "type": "string", "description": "ULID of an existing tag block." },
            },
        }),
    }
}

fn tool_desc_create_page() -> ToolDescription {
    ToolDescription {
        name: TOOL_CREATE_PAGE.to_string(),
        description: "Create a new top-level page with the given title. The page has no parent \
                      (pages are always top-level in Agaric's model)."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["title"],
            "properties": {
                "title": { "type": "string", "description": "Page title (becomes the page's content)." },
            },
        }),
    }
}

fn tool_desc_delete_block() -> ToolDescription {
    ToolDescription {
        name: TOOL_DELETE_BLOCK.to_string(),
        description: "Soft-delete a block and its descendants. Reversible via page history \
                      (agents never get the non-reversible purge path)."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the block to soft-delete." },
            },
        }),
    }
}

// ---------------------------------------------------------------------------
// Handler implementations
//
// Each handler: (1) parse args, (2) domain-level validation beyond serde,
// (3) delegate to `*_inner`, (4) serialise response to
// `serde_json::Value`. Errors from `*_inner` propagate as `AppError` — the
// server translates them to JSON-RPC codes the same way as the RO path.
// ---------------------------------------------------------------------------

async fn handle_append_block(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: AppendBlockArgs = parse_args(TOOL_APPEND_BLOCK, args)?;
    // L-121: normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let parent_id = normalize_ulid_arg(&args.parent_id);
    let resp = create_block_inner(
        pool,
        device_id,
        materializer,
        "content".to_string(),
        args.content,
        Some(parent_id),
        args.position,
    )
    .await?;
    to_tool_result(&resp)
}

async fn handle_update_block_content(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: UpdateBlockContentArgs = parse_args(TOOL_UPDATE_BLOCK_CONTENT, args)?;
    // L-121: normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let block_id = normalize_ulid_arg(&args.block_id);
    let resp = edit_block_inner(pool, device_id, materializer, block_id, args.content).await?;
    to_tool_result(&resp)
}

async fn handle_set_property(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: SetPropertyArgs = parse_args(TOOL_SET_PROPERTY, args)?;
    // L-121: normalise ULID-shaped IDs to uppercase at the MCP boundary
    // (block_id is required, value_ref is optional and only meaningful
    // when the property is a ref-typed value).
    let block_id = normalize_ulid_arg(&args.block_id);
    let value_ref = args.value_ref.as_deref().map(normalize_ulid_arg);
    // L-122: the exactly-one-value invariant is enforced inside
    // `set_property_inner` when a `caller_context` is supplied — passing
    // `Some(TOOL_SET_PROPERTY)` keeps the agent-facing error message
    // naming the tool, without duplicating the precheck at this boundary.
    let resp = set_property_inner(
        pool,
        device_id,
        materializer,
        block_id,
        args.key,
        args.value_text,
        args.value_num,
        args.value_date,
        value_ref,
        Some(TOOL_SET_PROPERTY),
    )
    .await?;
    to_tool_result(&resp)
}

async fn handle_add_tag(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: AddTagArgs = parse_args(TOOL_ADD_TAG, args)?;
    // L-121: normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let block_id = normalize_ulid_arg(&args.block_id);
    let tag_id = normalize_ulid_arg(&args.tag_id);
    let resp = add_tag_inner(pool, device_id, materializer, block_id, tag_id).await?;
    to_tool_result(&resp)
}

async fn handle_create_page(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: CreatePageArgs = parse_args(TOOL_CREATE_PAGE, args)?;
    let resp = create_block_inner(
        pool,
        device_id,
        materializer,
        "page".to_string(),
        args.title,
        None,
        None,
    )
    .await?;
    to_tool_result(&resp)
}

async fn handle_delete_block(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: DeleteBlockArgs = parse_args(TOOL_DELETE_BLOCK, args)?;
    // L-121: normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let block_id = normalize_ulid_arg(&args.block_id);
    let resp = delete_block_inner(pool, device_id, materializer, block_id).await?;
    to_tool_result(&resp)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
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
    /// `LAST_APPEND.scope(...)` and checking the cell after the call.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn append_block_populates_last_append_inside_scope() {
        use crate::task_locals::LAST_APPEND;
        use std::cell::Cell;

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
            .scope(Cell::new(None), async {
                tools
                    .call_tool(
                        "append_block",
                        json!({"parent_id": parent.id.clone(), "content": "hello"}),
                        &test_ctx_agent(),
                    )
                    .await
                    .expect("happy path");
                LAST_APPEND.with(Cell::take)
            })
            .await;

        let op_ref = captured.expect("append_block must populate LAST_APPEND with its OpRef");
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
}
