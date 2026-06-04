//! Read-write [`ToolRegistry`] impl — the v2 MCP write tool surface (FEAT-4h slice 2).
//!
//! Where `tools_ro.rs` exposes read paths, this module exposes the narrow
//! set of **reversible** mutations that external agents may perform. Every
//! tool is a thin wrapper around an existing `*_inner` command handler so
//! the op-log / event-sourcing / sqlx-compile-time-query invariants of the frontend
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
use super::handler_utils::{
    normalize_ulid_arg, parse_args, to_tool_result, validate_block_in_space,
};
use super::registry::{
    ToolDescription, ToolRegistry, TOOL_ADD_TAG, TOOL_APPEND_BLOCK, TOOL_CREATE_PAGE,
    TOOL_DELETE_BLOCK, TOOL_SET_PROPERTY, TOOL_UPDATE_BLOCK_CONTENT,
};
use crate::commands::{
    add_tag_inner, create_block_inner, create_block_inner_with_space, delete_block_inner,
    edit_block_inner, set_property_inner,
};
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::space::{SpaceId, SpaceScope};

// ---------------------------------------------------------------------------
// Typed argument structs (one per tool)
// ---------------------------------------------------------------------------

// PEND-24 C1+C2 — every rw tool that targets a block carries a required
// `space_id` field. For tools that take a block ID input (`parent_id` /
// `block_id`), the handler runs `validate_block_in_space` before
// delegating to `*_inner`, so an agent scoped to space A cannot mutate
// content owned by space B by knowing a Work-side ULID. For
// `create_page`, `space_id` is threaded into
// `create_block_inner_with_space` so the page lands with its `space`
// property in a single `BEGIN IMMEDIATE` transaction (BUG-1 / H-3a).
//
// PEND-18 will eventually replace these `String` fields with a `SpaceId`
// newtype; until then the wire format stays plain-string for parity
// with the rest of the IPC surface.

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AppendBlockArgs {
    parent_id: String,
    content: String,
    #[serde(default)]
    position: Option<i64>,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateBlockContentArgs {
    block_id: String,
    content: String,
    space_id: String,
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
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AddTagArgs {
    block_id: String,
    tag_id: String,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreatePageArgs {
    title: String,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteBlockArgs {
    block_id: String,
    space_id: String,
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
            "required": ["parent_id", "content", "space_id"],
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
                "space_id": {
                    "type": "string",
                    "description": "PEND-24 — ULID of the space the agent is operating in. The append is rejected with a Validation error if `parent_id`'s owning page lives in a different space.",
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
            "required": ["block_id", "content", "space_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the block to edit." },
                "content": { "type": "string", "description": "New Markdown content." },
                "space_id": {
                    "type": "string",
                    "description": "PEND-24 — ULID of the space the agent is operating in. The edit is rejected with a Validation error if `block_id`'s owning page lives in a different space.",
                },
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
            "required": ["block_id", "key", "space_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the target block." },
                "key":      { "type": "string", "description": "Property key (see list_property_defs)." },
                "value_text": { "type": "string", "description": "Text value (exactly one value_* must be set)." },
                "value_num":  { "type": "number", "description": "Numeric value (exactly one value_* must be set)." },
                "value_date": { "type": "string", "description": "ISO-8601 date (exactly one value_* must be set)." },
                "value_ref":  { "type": "string", "description": "Block ULID reference (exactly one value_* must be set)." },
                "space_id": {
                    "type": "string",
                    "description": "PEND-24 — ULID of the space the agent is operating in. The write is rejected with a Validation error if `block_id`'s owning page lives in a different space.",
                },
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
            "required": ["block_id", "tag_id", "space_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the block to tag." },
                "tag_id":   { "type": "string", "description": "ULID of an existing tag block." },
                "space_id": {
                    "type": "string",
                    "description": "PEND-24 — ULID of the space the agent is operating in. The tag application is rejected with a Validation error if `block_id`'s owning page lives in a different space. (Tags themselves are global — `tag_id` is not space-scoped.)",
                },
            },
        }),
    }
}

fn tool_desc_create_page() -> ToolDescription {
    ToolDescription {
        name: TOOL_CREATE_PAGE.to_string(),
        description: "Create a new top-level page with the given title in the given space. The \
                      page has no parent (pages are always top-level in Agaric's model) and \
                      lands with its `space` property set in a single transaction."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["title", "space_id"],
            "properties": {
                "title": { "type": "string", "description": "Page title (becomes the page's content)." },
                "space_id": {
                    "type": "string",
                    "description": "PEND-24 / BUG-1 — ULID of the space the new page belongs to. Required: every page lives in exactly one space; a page created without a `space_id` would be invisible to every space-scoped query.",
                },
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
            "required": ["block_id", "space_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the block to soft-delete." },
                "space_id": {
                    "type": "string",
                    "description": "PEND-24 — ULID of the space the agent is operating in. The delete is rejected with a Validation error if `block_id`'s owning page lives in a different space.",
                },
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
    let space_id = normalize_ulid_arg(&args.space_id);
    // PEND-24 C2 — refuse cross-space writes at the MCP boundary
    // before opening the BEGIN IMMEDIATE in `create_block_inner`.
    validate_block_in_space(pool, &parent_id, &space_id).await?;
    // #400: the MCP tool keeps its stable agent-facing **1-based** `position`
    // contract; `create_block_inner` now takes a 0-based sibling `index`, so
    // convert here (position 1 → index 0 = first child). `None` still appends.
    // Clamp the 1-based input to >=1 BEFORE subtracting so an extreme/hostile
    // negative position (e.g. i64::MIN from an LLM agent) can't underflow.
    let index = args.position.map(|p| p.max(1).saturating_sub(1));
    let resp = create_block_inner(
        pool,
        device_id,
        materializer,
        "content".to_string(),
        args.content,
        Some(parent_id.into()),
        index,
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
    let space_id = normalize_ulid_arg(&args.space_id);
    // PEND-24 C2 — refuse cross-space writes at the MCP boundary.
    validate_block_in_space(pool, &block_id, &space_id).await?;
    let resp =
        edit_block_inner(pool, device_id, materializer, block_id.into(), args.content).await?;
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
    let space_id = normalize_ulid_arg(&args.space_id);
    // PEND-24 C2 — refuse cross-space writes at the MCP boundary. We
    // intentionally do NOT validate `value_ref` against `space_id`: a
    // ref-typed property may legitimately point at a global block
    // (a tag, a space, etc.). PEND-15 hardens cross-space *references*
    // separately at the op boundary.
    validate_block_in_space(pool, &block_id, &space_id).await?;
    // L-122: the exactly-one-value invariant is enforced inside
    // `set_property_inner` when a `caller_context` is supplied — passing
    // `Some(TOOL_SET_PROPERTY)` keeps the agent-facing error message
    // naming the tool, without duplicating the precheck at this boundary.
    let active_id =
        crate::ulid::verify_active(pool, &crate::ulid::BlockId::from_trusted(&block_id)).await?;
    let resp = set_property_inner(
        pool,
        device_id,
        materializer,
        active_id,
        args.key,
        args.value_text,
        args.value_num,
        args.value_date,
        value_ref,
        None,
        Some(TOOL_SET_PROPERTY),
    )
    .await?;
    to_tool_result(&crate::pagination::BlockRow::from(resp))
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
    let space_id = normalize_ulid_arg(&args.space_id);
    // PEND-24 C2 — refuse cross-space writes at the MCP boundary. We
    // validate only the target `block_id`; tags themselves are global
    // (no `space` property by design), so validating `tag_id` would
    // reject every legitimate add_tag call.
    validate_block_in_space(pool, &block_id, &space_id).await?;
    let resp = add_tag_inner(
        pool,
        device_id,
        materializer,
        crate::ulid::BlockId::from(block_id),
        crate::ulid::BlockId::from(tag_id),
    )
    .await?;
    to_tool_result(&resp)
}

async fn handle_create_page(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: CreatePageArgs = parse_args(TOOL_CREATE_PAGE, args)?;
    // PEND-24 C1 — every MCP-created page must carry the `space`
    // property. Routing through `create_block_inner_with_space` (the
    // BUG-1 / H-3a IPC-tightened wrapper) emits `CreateBlock` +
    // `SetProperty(space = <space_id>)` inside one
    // `BEGIN IMMEDIATE` transaction so the page never exists in the
    // op log without its space stamp.
    let space_id = normalize_ulid_arg(&args.space_id);
    let scope = SpaceScope::Active(SpaceId::from_string(space_id)?);
    let resp = create_block_inner_with_space(
        pool,
        device_id,
        materializer,
        "page".to_string(),
        args.title,
        None,
        None,
        &scope,
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
    let space_id = normalize_ulid_arg(&args.space_id);
    // PEND-24 C2 — refuse cross-space writes at the MCP boundary.
    validate_block_in_space(pool, &block_id, &space_id).await?;
    let resp = delete_block_inner(pool, device_id, materializer, block_id.into()).await?;
    to_tool_result(&resp)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
