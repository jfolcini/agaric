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
mod tests;
