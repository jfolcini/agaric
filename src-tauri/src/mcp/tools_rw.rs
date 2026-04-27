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

use super::actor::{ActorContext, ACTOR};
use super::registry::{ToolDescription, ToolRegistry};
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

/// Convert a serde-json deserialization error into an
/// `AppError::Validation` with the tool name embedded. Used for every
/// handler's arg parse so bad input maps to `-32602 invalid params` at
/// the JSON-RPC layer.
fn parse_args<T: serde::de::DeserializeOwned>(tool: &str, args: Value) -> Result<T, AppError> {
    serde_json::from_value::<T>(args)
        .map_err(|e| AppError::Validation(format!("tool `{tool}`: invalid arguments — {e}")))
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

impl ToolRegistry for ReadWriteTools {
    fn list_tools(&self) -> Vec<ToolDescription> {
        vec![
            tool_desc_append_block(),
            tool_desc_update_block_content(),
            tool_desc_set_property(),
            tool_desc_add_tag(),
            tool_desc_create_page(),
            tool_desc_delete_block(),
        ]
    }

    fn call_tool(
        &self,
        name: &str,
        args: Value,
        ctx: &ActorContext,
    ) -> impl Future<Output = Result<Value, AppError>> + Send {
        let scoped = ctx.clone();
        let pool = self.pool.clone();
        let materializer = self.materializer.clone();
        let device_id = self.device_id.clone();
        let name = name.to_string();
        async move {
            ACTOR
                .scope(scoped, async move {
                    match name.as_str() {
                        "append_block" => {
                            handle_append_block(&pool, &materializer, &device_id, args).await
                        }
                        "update_block_content" => {
                            handle_update_block_content(&pool, &materializer, &device_id, args)
                                .await
                        }
                        "set_property" => {
                            handle_set_property(&pool, &materializer, &device_id, args).await
                        }
                        "add_tag" => handle_add_tag(&pool, &materializer, &device_id, args).await,
                        "create_page" => {
                            handle_create_page(&pool, &materializer, &device_id, args).await
                        }
                        "delete_block" => {
                            handle_delete_block(&pool, &materializer, &device_id, args).await
                        }
                        other => Err(AppError::NotFound(format!("unknown tool `{other}`"))),
                    }
                })
                .await
        }
    }
}

// ---------------------------------------------------------------------------
// Tool descriptions (static metadata)
// ---------------------------------------------------------------------------

fn tool_desc_append_block() -> ToolDescription {
    ToolDescription {
        name: "append_block".to_string(),
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
        name: "update_block_content".to_string(),
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
        name: "set_property".to_string(),
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
        name: "add_tag".to_string(),
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
        name: "create_page".to_string(),
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
        name: "delete_block".to_string(),
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
    let args: AppendBlockArgs = parse_args("append_block", args)?;
    let resp = create_block_inner(
        pool,
        device_id,
        materializer,
        "content".to_string(),
        args.content,
        Some(args.parent_id),
        args.position,
    )
    .await?;
    Ok(serde_json::to_value(resp)?)
}

async fn handle_update_block_content(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: UpdateBlockContentArgs = parse_args("update_block_content", args)?;
    let resp = edit_block_inner(pool, device_id, materializer, args.block_id, args.content).await?;
    Ok(serde_json::to_value(resp)?)
}

async fn handle_set_property(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: SetPropertyArgs = parse_args("set_property", args)?;
    // Enforce the exactly-one-value invariant at the tool boundary so the
    // agent gets a structured error instead of relying on the backend's
    // inner validation (which surfaces the same AppError::Validation, but
    // with a message that does not mention the tool name).
    let provided = [
        args.value_text.is_some(),
        args.value_num.is_some(),
        args.value_date.is_some(),
        args.value_ref.is_some(),
    ]
    .iter()
    .filter(|b| **b)
    .count();
    if provided != 1 {
        return Err(AppError::Validation(format!(
            "tool `set_property`: exactly one of value_text / value_num / value_date / value_ref \
             must be provided (got {provided})"
        )));
    }

    let resp = set_property_inner(
        pool,
        device_id,
        materializer,
        args.block_id,
        args.key,
        args.value_text,
        args.value_num,
        args.value_date,
        args.value_ref,
    )
    .await?;
    Ok(serde_json::to_value(resp)?)
}

async fn handle_add_tag(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: AddTagArgs = parse_args("add_tag", args)?;
    let resp = add_tag_inner(pool, device_id, materializer, args.block_id, args.tag_id).await?;
    Ok(serde_json::to_value(resp)?)
}

async fn handle_create_page(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: CreatePageArgs = parse_args("create_page", args)?;
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
    Ok(serde_json::to_value(resp)?)
}

async fn handle_delete_block(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: DeleteBlockArgs = parse_args("delete_block", args)?;
    let resp = delete_block_inner(pool, device_id, materializer, args.block_id).await?;
    Ok(serde_json::to_value(resp)?)
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
        use crate::mcp::last_append::LAST_APPEND;
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
}
