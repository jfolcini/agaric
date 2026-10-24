//! Read-write [`ToolRegistry`] impl — the v2 MCP write tool surface (slice 2).
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
//! | `append_block` | `append_block_resolving_names` | `block_type` hard-coded to `"content"`. `parent_id` required. |
//! | `append_markdown` | [`append_markdown_inner`] | A Markdown outline under `parent_id`, read and resolved as paste does: an unmatched `[[Name]]` / `#name` creates the page or tag. |
//! | `update_block_content` | `edit_block_resolving_names` | |
//! | `set_property` | [`set_property_inner`] | Exactly one of `value_*` must be provided. |
//! | `add_tag` | [`add_tag_inner`] | Tag block must already exist in the block's space. |
//! | `create_page` | [`create_block_inner_with_space`] | `block_type = "page"`, `parent_id = None`. |
//! | `delete_block` | [`delete_block_inner`] | Soft delete. Reversible via `reverse.rs`. |
//! | `move_page_to_space` | [`move_blocks_to_space_inner`] | Page blocks only: a page moves with its content blocks. A move that would drop properties the target space defines differently is refused until `acknowledge_property_loss` names them; a title the target space holds is refused. |
//! | `create_tag` | [`create_block_inner_with_space`] | `block_type = "tag"`; returns the space's same-name tag when one exists. |
//! | `delete_property` | [`delete_property_inner`] | Rejects `space`; the inner refuses system-managed keys. |
//! | `undo` | [`revert_ops_inner`] | Reverts `op_refs` as one op group. Refuses an op another origin wrote. |
//! | `capture` | [`capture_to_journal_inner`] | #5396 — a Markdown outline at the end of a day's journal page, creating the day with its template, in one transaction. `date` is `today` (default), `yesterday` or `YYYY-MM-DD` on the device's clock. |
//! | `move_blocks` | [`move_blocks_batch_inner`] | One transaction; ids kept. Every block and the parent must be in `space_id`. |
//! | `remove_tag` | [`remove_tag_inner`] | |
//! | `restore_block` | [`restore_block_inner`] | Takes the `deleted_at` that `delete_block` / `list_trash` returned. |
//! | `batch` | the `_in_tx` halves of the tools it names | #5399 — `append_block`, `update_block_content`, `set_property`, `add_tag`, `remove_tag`, `move_blocks` and `delete_block` calls in one transaction: one activity entry, one undo, nothing written when one is refused. |
//! | `edit_page_markdown` | [`apply_page_source_inner`] | #5399 — the page's source as `get_page_markdown` with `editable` reads it, edited, saved as the app's source mode saves it. A stale `base` is refused. |
//! | `set_page_aliases` | [`set_page_aliases_inner`] | Replaces the page's whole alias list in one transaction. An alias another page holds is refused, nothing written. |
//!
//! Every `tools_ro` tool follows the write tools, served by the
//! [`ReadOnlyTools`] this registry holds (#5379).
//!
//! Every write tool's result carries the `op_refs` it appended, added by the
//! adapter (`rmcp_adapter::with_op_refs`), not by these handlers.
//!
//! # Actor scoping
//!
//! Each call is wrapped in [`ACTOR::scope`](agaric_store::task_locals::ACTOR) so
//! downstream `append_local_op_in_tx` stamps `origin = 'agent:<name>'`
//! (slice 1). The server dispatcher already wraps outer
//! `call_tool` invocations; scoping again here is idempotent and keeps
//! direct `ReadWriteTools::call_tool` calls (tests, diagnostics) honest.
//!
//! # What is deliberately NOT exposed
//!
//! - `purge_block` / `delete_attachment` (non-reversible)
//! - Property-definition mutation
//! - The reserved `space` property key through `set_property` /
//!   `delete_property` (#3301): space membership changes only through
//!   `move_page_to_space`
//! - Conflict resolution, compaction, recovery
//! - Anything that touches sync peers or the device id
//!
//! If an agent needs one of these, the user runs it from the UI.

use std::future::Future;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use super::dispatch::scoped_dispatch;
use super::handler_utils::{
    Named, normalize_ulid_arg, parse_args, resolve_id_arg, resolve_journal_date, to_tool_result,
    with_space_guard,
};
use super::registry::{
    TOOL_ADD_TAG, TOOL_APPEND_BLOCK, TOOL_APPEND_MARKDOWN, TOOL_BATCH, TOOL_CAPTURE,
    TOOL_CREATE_PAGE, TOOL_CREATE_TAG, TOOL_DELETE_BLOCK, TOOL_DELETE_PROPERTY,
    TOOL_EDIT_PAGE_MARKDOWN, TOOL_MOVE_BLOCKS, TOOL_MOVE_PAGE_TO_SPACE, TOOL_REMOVE_TAG,
    TOOL_RESTORE_BLOCK, TOOL_SET_PAGE_ALIASES, TOOL_SET_PROPERTY, TOOL_UNDO,
    TOOL_UPDATE_BLOCK_CONTENT, ToolDescription, ToolRegistry,
};
use super::tools_ro::{self, ReadOnlyTools};
use super::view_notify::{NoopViewChangeEmitter, ViewChangeEmitter};
use crate::commands::blocks::crud::{DeleteInTx, delete_block_in_tx, dispatch_deletes};
use crate::commands::blocks::move_ops::move_blocks_batch_in_tx;
use crate::commands::blocks::space_move::describe_losses;
use crate::commands::pages::markdown::{
    anchor_free, append_block_resolving_names, append_block_resolving_names_in_tx,
    edit_block_resolving_names, edit_block_resolving_names_in_tx,
};
use crate::commands::properties::set_property_inner_in_tx;
use crate::commands::tags::{add_tag_in_tx, remove_tag_inner_in_tx};
use crate::commands::{
    DeletePropertyResponse, DeleteResponse, MovedBlocks, PropertyLoss, SourceSaveFlags,
    TagResponse, add_tag_inner, append_markdown_inner, apply_page_source_inner,
    capture_to_journal_inner, create_block_inner_with_space, delete_block_inner,
    delete_property_inner, get_active_block_inner, move_blocks_batch_inner,
    move_blocks_to_space_inner, preview_space_move_inner, remove_tag_inner, restore_block_inner,
    revert_ops_inner, set_page_aliases_inner, set_property_inner,
};
use crate::db::{CommandTx, validate_block_in_space};
use crate::materializer::Materializer;
use agaric_core::error::{AppError, ValidationCode};
use agaric_core::ulid::BlockId;
use agaric_store::op::OpRef;
use agaric_store::space::{SpaceId, SpaceScope};
use agaric_store::task_locals::{ActorContext, current_actor};

// ---------------------------------------------------------------------------
// Typed argument structs (one per tool)
// ---------------------------------------------------------------------------

// +C2 — every rw tool that targets a block carries a required
// `space_id` field. For tools that take a block ID input (`parent_id` /
// `block_id`), the handler wraps its `*_inner` in `with_space_guard`, which
// checks the target inside the write's own transaction, and `batch` checks each
// op's targets the same way in its one transaction, so an agent scoped to
// space A cannot mutate content owned by space B by knowing a Work-side ULID. For
// `create_page`, `space_id` is threaded into
// `create_block_inner_with_space` so the page lands with its `space`
// Property in a single `BEGIN IMMEDIATE` transaction.
//
// Will eventually replace these `String` fields with a `SpaceId`
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
struct AppendMarkdownArgs {
    parent_id: String,
    markdown: String,
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
    /// #697 — boolean slot (`value_type = 'boolean'` defs).
    /// Previously the backend accepted it and the error message
    /// advertised it, but the MCP schema rejected it via
    /// `deny_unknown_fields` — an agent following the error got a
    /// parse failure.
    #[serde(default)]
    value_bool: Option<bool>,
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MovePageToSpaceArgs {
    page_id: String,
    space_id: String,
    target_space_id: String,
    /// Key → count of the values the move drops, as its refusal listed them.
    #[serde(default)]
    acknowledge_property_loss: std::collections::BTreeMap<String, i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateTagArgs {
    name: String,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeletePropertyArgs {
    block_id: String,
    key: String,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UndoArgs {
    op_refs: Vec<OpRef>,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptureArgs {
    content: String,
    space_id: String,
    #[serde(default)]
    date: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MoveBlocksArgs {
    block_ids: Vec<String>,
    parent_id: String,
    #[serde(default)]
    position: Option<i64>,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoveTagArgs {
    block_id: String,
    tag_id: String,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreBlockArgs {
    block_id: String,
    deleted_at: i64,
    space_id: String,
}

/// Each op is a write tool's arguments less `space_id`, under `op` naming the
/// tool; [`prepare_batch_op`] reads it as that tool's own argument struct.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchArgs {
    ops: Vec<serde_json::Map<String, Value>>,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditPageMarkdownArgs {
    page_id: String,
    markdown: String,
    base: String,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SetPageAliasesArgs {
    page_id: String,
    aliases: Vec<String>,
    space_id: String,
}

// ---------------------------------------------------------------------------
// ReadWriteTools
// ---------------------------------------------------------------------------

/// Read-write MCP tool registry. Holds the **write pool**, the
/// [`ReadOnlyTools`] that serves every read tool, a [`Materializer`] handle,
/// and this device's `device_id` so every mutation lands with the correct
/// attribution.
///
/// The struct shape mirrors [`crate::mcp::tools_ro::ReadOnlyTools`] so the
/// wiring in `mod.rs` can share helpers.
pub struct ReadWriteTools {
    pool: SqlitePool,
    /// Serves every read tool on the reader pool, so a read never waits for a
    /// writer connection (#5379, #5402).
    reads: ReadOnlyTools,
    materializer: Materializer,
    device_id: String,
    /// #2505: emits `blocks:changed` / `block:properties-changed` on the Tauri
    /// bus after each tool commits, so an MCP write propagates to open views.
    /// Defaults to [`NoopViewChangeEmitter`] (headless / test path); production
    /// swaps in the Tauri emitter via [`with_view_emitter`](Self::with_view_emitter).
    view_emitter: Arc<dyn ViewChangeEmitter>,
}

impl ReadWriteTools {
    /// Construct a read-write registry. `pool` must be the *writer* pool
    /// the write tools use, and `read_pool` the reader pool the read tools
    /// use.
    ///
    /// The view-change emitter defaults to a no-op; production callers chain
    /// [`with_view_emitter`](Self::with_view_emitter) to route change
    /// notifications onto the Tauri event bus.
    pub fn new(
        pool: SqlitePool,
        read_pool: SqlitePool,
        materializer: Materializer,
        device_id: String,
    ) -> Self {
        Self {
            reads: ReadOnlyTools::new(
                read_pool,
                pool.clone(),
                materializer.clone(),
                device_id.clone(),
            ),
            pool,
            materializer,
            device_id,
            view_emitter: Arc::new(NoopViewChangeEmitter),
        }
    }

    /// #2505: install the emitter that propagates each committed write to open
    /// views. Production passes a `TauriViewChangeEmitter`; tests inject a
    /// recording emitter to assert payload parity with the local-write path.
    #[must_use]
    pub fn with_view_emitter(mut self, view_emitter: Arc<dyn ViewChangeEmitter>) -> Self {
        // `journal_for_date` can create a page, so the reads notify views too.
        self.reads = self.reads.with_view_emitter(view_emitter.clone());
        self.view_emitter = view_emitter;
        self
    }
}

/// The write tools, in their wire order.
pub(crate) fn write_tool_descriptions() -> Vec<ToolDescription> {
    vec![
        tool_desc_append_block(),
        tool_desc_update_block_content(),
        tool_desc_set_property(),
        tool_desc_add_tag(),
        tool_desc_create_page(),
        tool_desc_delete_block(),
        tool_desc_append_markdown(),
        tool_desc_move_page_to_space(),
        tool_desc_create_tag(),
        tool_desc_delete_property(),
        tool_desc_undo(),
        tool_desc_capture(),
        tool_desc_move_blocks(),
        tool_desc_remove_tag(),
        tool_desc_restore_block(),
        tool_desc_batch(),
        tool_desc_edit_page_markdown(),
        tool_desc_set_page_aliases(),
    ]
}

/// Static tool-description list for the read-write MCP surface.
///
/// Lifted out of [`ToolRegistry::list_tools`] so callers that need the
/// names without a constructed registry (notably the privacy-guard test
/// In `summarise.rs`) can drive iteration from the live
/// metadata. The `&self` impl below just delegates here.
pub(crate) fn list_tool_descriptions() -> Vec<ToolDescription> {
    let mut descriptions = write_tool_descriptions();
    descriptions.extend(tools_ro::list_tool_descriptions());
    descriptions
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
        // ACTOR scope + name-clone boilerplate is
        // shared with `tools_ro` via `super::dispatch::scoped_dispatch`.
        let pool = self.pool.clone();
        let reads = self.reads.clone();
        let read_ctx = ctx.clone();
        let materializer = self.materializer.clone();
        let device_id = self.device_id.clone();
        let emitter = self.view_emitter.clone();
        scoped_dispatch(ctx, name, move |name| async move {
            let emitter: &dyn ViewChangeEmitter = emitter.as_ref();
            match name.as_str() {
                TOOL_APPEND_BLOCK => {
                    handle_append_block(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_UPDATE_BLOCK_CONTENT => {
                    handle_update_block_content(&pool, &materializer, &device_id, emitter, args)
                        .await
                }
                TOOL_SET_PROPERTY => {
                    handle_set_property(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_ADD_TAG => {
                    handle_add_tag(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_CREATE_PAGE => {
                    handle_create_page(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_DELETE_BLOCK => {
                    handle_delete_block(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_APPEND_MARKDOWN => {
                    handle_append_markdown(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_MOVE_PAGE_TO_SPACE => {
                    handle_move_page_to_space(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_CREATE_TAG => {
                    handle_create_tag(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_DELETE_PROPERTY => {
                    handle_delete_property(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_UNDO => handle_undo(&pool, &materializer, &device_id, emitter, args).await,
                TOOL_CAPTURE => {
                    let today = chrono::Local::now().date_naive();
                    handle_capture(&pool, &materializer, &device_id, emitter, args, today).await
                }
                TOOL_MOVE_BLOCKS => {
                    handle_move_blocks(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_REMOVE_TAG => {
                    handle_remove_tag(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_RESTORE_BLOCK => {
                    handle_restore_block(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_BATCH => handle_batch(&pool, &materializer, &device_id, emitter, args).await,
                TOOL_EDIT_PAGE_MARKDOWN => {
                    handle_edit_page_markdown(&pool, &materializer, &device_id, emitter, args).await
                }
                TOOL_SET_PAGE_ALIASES => {
                    handle_set_page_aliases(&pool, &materializer, &device_id, emitter, args).await
                }
                // Every read tool, and the unknown-tool error (#5379).
                other => reads.call_tool(other, args, &read_ctx).await,
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
                    "description": "ULID of the parent block, or a page's title or alias (required — no orphan blocks).",
                },
                "content": {
                    "type": "string",
                    "description": "Markdown content for the new block. A `[[Name]]` or `#name` links the page or tag of that name in the space, creating it when none matches.",
                },
                "position": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional 1-based sibling position. Defaults to append (end).",
                },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The append is rejected with a Validation error if `parent_id`'s owning page lives in a different space.",
                },
            },
        }),
    }
}

fn tool_desc_append_markdown() -> ToolDescription {
    ToolDescription {
        name: TOOL_APPEND_MARKDOWN.to_string(),
        description: format!(
            "Append a Markdown outline under an existing parent in one call, as one undo, \
             exactly as a paste in the app lands it: list items nest by indentation, a heading \
             outside a list owns what follows it, a fenced code block stays one block, a \
             `- [ ]` checkbox is a task, and `key:: value` lines are properties. A `[[Name]]` \
             or `#name` that matches no page or tag in the parent's space creates that page or \
             tag there. A call that would write more than {} operations is refused; split it.",
            agaric_store::pagination::MAX_BATCH_BLOCK_IDS,
        ),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["parent_id", "markdown", "space_id"],
            "properties": {
                "parent_id": {
                    "type": "string",
                    "description": "ULID of the parent block or page the outline lands under, or the page's title or alias.",
                },
                "markdown": {
                    "type": "string",
                    "description": "The Markdown outline to append.",
                },
                "position": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional 1-based sibling position of the first top-level block. Defaults to append (end).",
                },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The append is rejected with a Validation error if `parent_id`'s owning page lives in a different space.",
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
                "content": { "type": "string", "description": "New Markdown content. In a content block, a `[[Name]]` or `#name` links the page or tag of that name in the space, creating it when none matches." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The edit is rejected with a Validation error if `block_id`'s owning page lives in a different space.",
                },
            },
        }),
    }
}

fn tool_desc_set_property() -> ToolDescription {
    ToolDescription {
        name: TOOL_SET_PROPERTY.to_string(),
        description: "Set (upsert) a typed property on a block. Exactly one of value_text / \
                      value_num / value_date / value_ref / value_bool must be provided. The task \
                      keys behave as in the app: `todo_state` and `priority` take value_text, \
                      `due_date` and `scheduled_date` take value_date, and `todo_state = DONE` \
                      stamps `completed_at` and creates a repeating task's next occurrence."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id", "key", "space_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the target block." },
                "key":      { "type": "string", "description": "Property key (see list_property_defs). The reserved key `space` is rejected — space membership is not a content property." },
                "value_text": { "type": "string", "description": "Text value (exactly one value_* must be set)." },
                "value_num":  { "type": "number", "description": "Numeric value (exactly one value_* must be set)." },
                "value_date": { "type": "string", "description": "ISO-8601 date (exactly one value_* must be set)." },
                "value_ref":  { "type": "string", "description": "Block ULID reference (exactly one value_* must be set)." },
                "value_bool": { "type": "boolean", "description": "Boolean value (exactly one value_* must be set). #697 — for `value_type = 'boolean'` property definitions." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The write is rejected with a Validation error if `block_id`'s owning page lives in a different space.",
                },
            },
        }),
    }
}

fn tool_desc_add_tag() -> ToolDescription {
    ToolDescription {
        name: TOOL_ADD_TAG.to_string(),
        description: "Apply an existing tag to a block. The tag block must already exist — \
                      `create_tag` makes one."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id", "tag_id", "space_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the block to tag." },
                "tag_id":   { "type": "string", "description": "ULID or name of an existing tag block." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The tag application is rejected with a Validation error if `block_id`'s owning page lives in a different space. `tag_id` must be a tag of the same space.",
                },
            },
        }),
    }
}

fn tool_desc_create_page() -> ToolDescription {
    ToolDescription {
        name: TOOL_CREATE_PAGE.to_string(),
        description: "Create a new top-level page with the given title in the given space, or, \
                      when a live page with that title already exists in the space, return that \
                      page's id. The page has no parent (pages are always top-level in Agaric's \
                      model) and lands with its `space` property set in a single transaction."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["title", "space_id"],
            "properties": {
                "title": { "type": "string", "description": "Page title (becomes the page's content)." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the new page belongs to. Required: every page lives in exactly one space; a page created without a `space_id` would be invisible to every space-scoped query.",
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
                    "description": "ULID of the space the agent is operating in. The delete is rejected with a Validation error if `block_id`'s owning page lives in a different space.",
                },
            },
        }),
    }
}

fn tool_desc_move_page_to_space() -> ToolDescription {
    ToolDescription {
        name: TOOL_MOVE_PAGE_TO_SPACE.to_string(),
        description: "Move a page, with its content blocks, to another space. Reversible via \
                      page history. Property definitions are per space: a value whose key the \
                      target space does not define identically is removed by the move. Such a \
                      move is refused until `acknowledge_property_loss` lists those keys with \
                      the counts the refusal names. A page whose title the target space \
                      already holds is refused."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["page_id", "space_id", "target_space_id"],
            "properties": {
                "page_id": { "type": "string", "description": "ULID, title or alias of the page to move. Only page blocks move; a content block stays with its page." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The move is rejected with a Validation error if `page_id` lives in a different space.",
                },
                "target_space_id": { "type": "string", "description": "ULID of the live space to move the page into (see list_spaces)." },
                "acknowledge_property_loss": {
                    "type": "object",
                    "additionalProperties": { "type": "integer" },
                    "description": "Property key → number of values the move removes, exactly as a refusal of this move listed them. Omit it for a move that removes nothing.",
                },
            },
        }),
    }
}

fn tool_desc_create_tag() -> ToolDescription {
    ToolDescription {
        name: TOOL_CREATE_TAG.to_string(),
        description: "Create a tag in the given space, or, when the space already has a live \
                      tag with that name, return that tag. Apply it with add_tag."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["name", "space_id"],
            "properties": {
                "name": { "type": "string", "description": "Tag name (becomes the tag's content)." },
                "space_id": { "type": "string", "description": "ULID of the space the tag belongs to." },
            },
        }),
    }
}

fn tool_desc_delete_property() -> ToolDescription {
    ToolDescription {
        name: TOOL_DELETE_PROPERTY.to_string(),
        description: "Delete a property from a block. Reversible via page history. The task \
                      keys behave as in the app: deleting `todo_state` un-tasks the block, and \
                      deleting `repeat` removes its end conditions too. The bookkeeping keys \
                      `created_at`, `completed_at`, `repeat-seq` and `repeat-origin` are refused."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id", "key", "space_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the target block." },
                "key": { "type": "string", "description": "Property key to delete. The reserved key `space` is rejected — use move_page_to_space." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The delete is rejected with a Validation error if `block_id`'s owning page lives in a different space.",
                },
            },
        }),
    }
}

fn tool_desc_set_page_aliases() -> ToolDescription {
    ToolDescription {
        name: TOOL_SET_PAGE_ALIASES.to_string(),
        description: "Replace a page's aliases with the given list, returned as { page_id, \
                      aliases }. Entries are trimmed, blank ones dropped, and a second spelling \
                      of one alias (ignoring ASCII case) dropped; an empty list removes every \
                      alias. An alias another page holds, in any space or the Trash, is refused \
                      with a Validation error and nothing is written. Reversible via page \
                      history."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["page_id", "aliases", "space_id"],
            "properties": {
                "page_id": { "type": "string", "description": "ULID, title or alias of the page." },
                "aliases": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "The page's full alias list after the call.",
                },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The call is rejected with a Validation error if `page_id` lives in a different space.",
                },
            },
        }),
    }
}

fn tool_desc_undo() -> ToolDescription {
    ToolDescription {
        name: TOOL_UNDO.to_string(),
        description: "Undo your own writes: pass the `op_refs` a write tool returned. They are \
                      reverted together as one action the user can undo in turn, and this \
                      call returns the `op_refs` of the revert. An op written by the user or \
                      by another agent is refused."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["op_refs", "space_id"],
            "properties": {
                "op_refs": {
                    "type": "array",
                    "description": "The `op_refs` a write tool returned, as given.",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["device_id", "seq"],
                        "properties": {
                            "device_id": { "type": "string" },
                            "seq": { "type": "integer" },
                        },
                    },
                },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The undo is rejected with a Validation error if a block the ops touched lives in a different space.",
                },
            },
        }),
    }
}

fn tool_desc_capture() -> ToolDescription {
    ToolDescription {
        name: TOOL_CAPTURE.to_string(),
        description: "Capture a thought into a day's journal in one call, as one undo: the \
             Markdown outline lands at the end of the day's page, read as append_markdown reads \
             it, and a missing day is created with the space's journal template first."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["content", "space_id"],
            "properties": {
                "content": { "type": "string", "description": "The Markdown outline to capture." },
                "space_id": { "type": "string", "description": "ULID of the space the journal belongs to." },
                "date": {
                    "type": "string",
                    "description": "`today` (the default), `yesterday`, or YYYY-MM-DD, on this device's clock.",
                },
            },
        }),
    }
}

fn tool_desc_move_blocks() -> ToolDescription {
    ToolDescription {
        name: TOOL_MOVE_BLOCKS.to_string(),
        description: "Move blocks, with their children, under a new parent in one transaction. \
                      Ids, backlinks and history are kept. The blocks land in the given order \
                      as one run. Moving a block under itself or its own descendant is refused."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_ids", "parent_id", "space_id"],
            "properties": {
                "block_ids": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "maxItems": agaric_store::pagination::MAX_BATCH_BLOCK_IDS,
                    "description": "ULIDs of the blocks to move, in the order they should land.",
                },
                "parent_id": { "type": "string", "description": "ULID of the new parent block or page, or the page's title or alias." },
                "position": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional 1-based position among the parent's other children. Defaults to append (end).",
                },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The move is rejected with a Validation error if any block or `parent_id` lives in a different space.",
                },
            },
        }),
    }
}

fn tool_desc_remove_tag() -> ToolDescription {
    ToolDescription {
        name: TOOL_REMOVE_TAG.to_string(),
        description: "Remove a tag from a block. Reversible via page history.".to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id", "tag_id", "space_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the tagged block." },
                "tag_id":   { "type": "string", "description": "ULID or name of the tag to remove." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The removal is rejected with a Validation error if `block_id`'s owning page lives in a different space.",
                },
            },
        }),
    }
}

fn tool_desc_restore_block() -> ToolDescription {
    ToolDescription {
        name: TOOL_RESTORE_BLOCK.to_string(),
        description: "Restore a soft-deleted block and the descendants deleted with it. \
                      list_trash lists what can be restored."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id", "deleted_at", "space_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the deleted block." },
                "deleted_at": {
                    "type": "integer",
                    "description": "The block's `deleted_at`, as delete_block or list_trash returned it. A block deleted again since is refused.",
                },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The restore is rejected with a Validation error if `block_id` lives in a different space.",
                },
            },
        }),
    }
}

/// The write tools a `batch` op can name.
fn batch_op_descriptions() -> [ToolDescription; 7] {
    [
        tool_desc_append_block(),
        tool_desc_update_block_content(),
        tool_desc_set_property(),
        tool_desc_add_tag(),
        tool_desc_remove_tag(),
        tool_desc_move_blocks(),
        tool_desc_delete_block(),
    ]
}

/// `desc`'s input schema as a batch op: `op` naming the tool, then its
/// arguments less `space_id`, which the batch gives every op.
fn batch_op_schema(desc: ToolDescription) -> Value {
    let mut schema = desc.input_schema;
    if let Some(properties) = schema["properties"].as_object_mut() {
        properties.remove("space_id");
        properties.insert(
            "op".to_owned(),
            json!({ "type": "string", "enum": [desc.name] }),
        );
    }
    let required: Vec<Value> = std::iter::once(json!("op"))
        .chain(
            schema["required"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|key| *key != "space_id")
                .cloned(),
        )
        .collect();
    schema["required"] = Value::Array(required);
    schema
}

fn tool_desc_batch() -> ToolDescription {
    let ops: Vec<Value> = batch_op_descriptions()
        .into_iter()
        .map(batch_op_schema)
        .collect();
    ToolDescription {
        name: TOOL_BATCH.to_string(),
        description: format!(
            "Apply several writes in one transaction, as one activity entry and one undo. Each \
             op names a write tool in `op` and takes that tool's arguments less `space_id`, \
             which the batch gives every op. The ops run in order, each on what the ones before \
             it wrote; a page or tag argument given by name is resolved before the first one \
             runs. If any op is refused, nothing is written and the error names it as `ops[i]`. \
             Returns `results`, each op's result as its tool returns it, in order. At most {} \
             ops, and a batch that would write more operations than one undo reverts is refused.",
            agaric_store::pagination::MAX_BATCH_BLOCK_IDS,
        ),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["ops", "space_id"],
            "properties": {
                "ops": {
                    "type": "array",
                    "maxItems": agaric_store::pagination::MAX_BATCH_BLOCK_IDS,
                    "items": { "oneOf": ops },
                    "description": "The writes, in order.",
                },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in, for every op. An op that touches a block of another space is refused, and with it the batch.",
                },
            },
        }),
    }
}

fn tool_desc_edit_page_markdown() -> ToolDescription {
    ToolDescription {
        name: TOOL_EDIT_PAGE_MARKDOWN.to_string(),
        description: "Save an edited copy of a page's source in one transaction and one undo, \
                      as the app's source mode saves it. Read the page with get_page_markdown \
                      and `editable: true`, edit that text, and pass \
                      it back as `markdown`, with the text you read as `base`. Blocks are matched \
                      by the `^ULID` each one's text ends with, so keep it with the block when \
                      you move or change it: a bullet without one is a new block, and a block \
                      left out is deleted. Only what changed is written, so moving one bullet is \
                      one move. If the page changed since `base` was read, the call is refused: \
                      read it again and redo the edit. Returns how many blocks were created, \
                      edited, moved and deleted, how many properties were set and deleted, the \
                      pages and tags created for new names, and warnings for what could not be \
                      kept as written."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["page_id", "markdown", "base", "space_id"],
            "properties": {
                "page_id": { "type": "string", "description": "ULID of the page, or its title or alias." },
                "markdown": { "type": "string", "description": "The page's source, edited, each kept block still ending with its `^ULID`." },
                "base": { "type": "string", "description": "The source get_page_markdown returned with `editable: true`, unedited." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the agent is operating in. The save is rejected with a Validation error if the page lives in a different space.",
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

/// #2505: resolve the owning-page id set for `seed` (post-commit) and emit
/// `blocks:changed` so open views reload the touched page store(s).
///
/// Reuses [`agaric_sync::sync_protocol::loro_sync::resolve_changed_page_ids`] — the
/// exact `parent_id`-chain walk the sync path (#1071) uses — so the payload is
/// semantically identical to `SyncEvent::Complete`'s `changed_page_ids`. The
/// walk reads `parent_id` (set synchronously in the command tx), NOT the
/// denormalized `page_id` column (stamped later in a background task), so it is
/// correct immediately after the inner command commits. A resolution error is
/// logged, never propagated — the write already committed and the tool result
/// must not fail on a notification hiccup.
async fn emit_blocks_changed_for(
    pool: &SqlitePool,
    emitter: &dyn ViewChangeEmitter,
    seed: BlockId,
) {
    emit_blocks_changed_for_all(pool, emitter, std::slice::from_ref(&seed)).await;
}

async fn emit_blocks_changed_for_all(
    pool: &SqlitePool,
    emitter: &dyn ViewChangeEmitter,
    seeds: &[BlockId],
) {
    match agaric_sync::sync_protocol::loro_sync::resolve_changed_page_ids(pool, seeds).await {
        Ok(changed_page_ids) => emitter.emit_blocks_changed(changed_page_ids),
        Err(e) => tracing::warn!(
            target: "mcp",
            error = %e,
            blocks = seeds.len(),
            "failed to resolve changed_page_ids for blocks:changed emit; \
             open views may stay stale until reload-on-mount",
        ),
    }
}

async fn handle_append_block(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: AppendBlockArgs = parse_args(TOOL_APPEND_BLOCK, args)?;
    let space_id = normalize_ulid_arg(&args.space_id);
    let (parent, content, index) = prepare_append_block(pool, args).await?;
    // Refuses a parent in another space inside the append's own transaction.
    let (block, warnings) = with_space_guard(
        &space_id,
        vec![parent.as_str().to_owned()],
        append_block_resolving_names(pool, device_id, materializer, &parent, content, index),
    )
    .await?;
    // The appended block shares its parent's owning page, so resolve from the
    // freshly-created block id (BlockRow.id).
    emit_blocks_changed_for(pool, emitter, block.id.clone()).await;
    with_warnings(&block, &warnings)
}

/// `append_block`'s parent, content and 0-based sibling index, refused as the
/// tool refuses them.
async fn prepare_append_block(
    pool: &SqlitePool,
    args: AppendBlockArgs,
) -> Result<(BlockId, String, Option<i64>), AppError> {
    let space_id = normalize_ulid_arg(&args.space_id);
    let parent_id = resolve_id_arg(
        pool,
        TOOL_APPEND_BLOCK,
        "parent_id",
        &args.parent_id,
        Named::Page,
        &space_id,
    )
    .await?;
    // #1606: the JSON schema declares `position` `minimum: 1`, but serde does
    // not enforce JSON-Schema constraints, so an out-of-range `position` (0 or
    // negative) used to be silently clamped to the first child. That violated
    // the loud-rejection posture the MCP boundary takes elsewhere (see
    // `validate_limit` in tools_ro.rs), hiding agent typos. Reject `position < 1`
    // with a Validation error (→ JSON-RPC -32602) instead.
    if let Some(p) = args.position
        && p < 1
    {
        return Err(AppError::validation(format!(
            "tool `{TOOL_APPEND_BLOCK}`: position must be >= 1 (1-based), got {p}"
        )));
    }
    // #400: the MCP tool keeps its stable agent-facing **1-based** `position`
    // contract; `create_block_in_tx` takes a 0-based sibling `index`, so
    // convert here (position 1 → index 0 = first child). `None` still appends.
    // The `position < 1` rejection above is the primary guard; the
    // `max(1).saturating_sub(1)` here is retained as a defense-in-depth
    // underflow backstop so an extreme/hostile negative position (e.g.
    // i64::MIN from an LLM agent) can never underflow even if a future caller
    // bypasses the check above.
    let index = args.position.map(|p| p.max(1).saturating_sub(1));
    Ok((BlockId::from_trusted(&parent_id), args.content, index))
}

/// `block` as a write tool returns it, with the warnings naming a `[[Name]]`
/// or `#name` its content left as text, when there are any.
fn with_warnings(
    block: &agaric_store::pagination::BlockRow,
    warnings: &[String],
) -> Result<Value, AppError> {
    let mut result = to_tool_result(block)?;
    if !warnings.is_empty() {
        result["warnings"] = json!(warnings);
    }
    Ok(result)
}

async fn handle_append_markdown(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: AppendMarkdownArgs = parse_args(TOOL_APPEND_MARKDOWN, args)?;
    let space_id = normalize_ulid_arg(&args.space_id);
    let parent_id = resolve_id_arg(
        pool,
        TOOL_APPEND_MARKDOWN,
        "parent_id",
        &args.parent_id,
        Named::Page,
        &space_id,
    )
    .await?;
    // The same 1-based contract and refusal as `append_block` (#1606, #400).
    if let Some(p) = args.position
        && p < 1
    {
        return Err(AppError::validation(format!(
            "tool `{TOOL_APPEND_MARKDOWN}`: position must be >= 1 (1-based), got {p}"
        )));
    }
    let index = args.position.map(|p| p - 1);
    let parent = BlockId::from_trusted(&parent_id);
    let resp = with_space_guard(
        &space_id,
        vec![parent_id],
        append_markdown_inner(
            pool,
            device_id,
            materializer,
            parent.clone(),
            &args.markdown,
            index,
        ),
    )
    .await?;
    emit_blocks_changed_for(pool, emitter, parent).await;
    to_tool_result(&resp)
}

async fn handle_update_block_content(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: UpdateBlockContentArgs = parse_args(TOOL_UPDATE_BLOCK_CONTENT, args)?;
    // Normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let block_id = normalize_ulid_arg(&args.block_id);
    let space_id = normalize_ulid_arg(&args.space_id);
    let guarded = vec![block_id.clone()];
    let block_id = BlockId::from_trusted(&block_id);
    let (block, warnings) = with_space_guard(
        &space_id,
        guarded,
        edit_block_resolving_names(pool, device_id, materializer, &block_id, args.content),
    )
    .await?;
    emit_blocks_changed_for(pool, emitter, block_id).await;
    with_warnings(&block, &warnings)
}

async fn handle_set_property(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: SetPropertyArgs = parse_args(TOOL_SET_PROPERTY, args)?;
    let space_id = normalize_ulid_arg(&args.space_id);
    let args = prepare_set_property(args)?;
    let block_id = args.block_id;
    // The exactly-one-value invariant is enforced inside
    // `set_property_inner` when a `caller_context` is supplied — passing
    // `Some(TOOL_SET_PROPERTY)` keeps the agent-facing error message
    // naming the tool, without duplicating the precheck at this boundary.
    let active_id =
        crate::ulid::verify_active(pool, &agaric_core::ulid::BlockId::from_trusted(&block_id))
            .await?;
    // Clone the key for the property-changed emit below — `set_property_inner`
    // takes it by value.
    let key_for_emit = args.key.clone();
    let resp = with_space_guard(
        &space_id,
        vec![block_id.clone()],
        set_property_inner(
            pool,
            device_id,
            materializer,
            active_id,
            args.key,
            args.value_text,
            args.value_num,
            args.value_date,
            args.value_ref,
            // #697 — thread the boolean slot through; the schema and the
            // Error message now agree on the five accepted slots.
            args.value_bool,
            Some(TOOL_SET_PROPERTY),
        ),
    )
    .await?;
    // #2505: a property write touches the block's page (a visible todo
    // checkbox / priority badge etc. may need to re-render), so emit the
    // page-keyed `blocks:changed` AND the existing `block:properties-changed`
    // event with the exact `{ block_id, changed_keys }` payload the local
    // `set_property` command emits (`emit_property_changed_event`), so the
    // property-change dispatcher needs no changes.
    emit_blocks_changed_for(pool, emitter, BlockId::from_trusted(&block_id)).await;
    emitter.emit_property_changed(block_id, vec![key_for_emit]);
    to_tool_result(&agaric_store::pagination::BlockRow::from(resp))
}

/// `set_property`'s arguments, refused as the tool refuses them, with the
/// block id and `value_ref` canonical.
fn prepare_set_property(mut args: SetPropertyArgs) -> Result<SetPropertyArgs, AppError> {
    // #3301 — `space` is not a content property: it is the column-backed
    // space-membership key, and writing it runs the canonical cross-space
    // move (`UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?`),
    // re-homing the page and every descendant. The space check sees only
    // where the block is *now*, so it cannot catch this.
    if args.key == agaric_store::op::SPACE_PROPERTY_KEY {
        return Err(AppError::validation(format!(
            "tool `{TOOL_SET_PROPERTY}`: `{}` is space membership, not a content property, \
             and is not settable through the MCP surface",
            agaric_store::op::SPACE_PROPERTY_KEY,
        )));
    }
    // #699 — cap `value_text` at the same MAX_CONTENT_LENGTH the IPC
    // layer enforces on block content (`create_block_in_tx`,
    // `edit_block_inner`; see `commands/mod.rs`). `block_properties`
    // rows had no size bound at this boundary, so a buggy agent could
    // push multi-MB payloads into the property table.
    if let Some(ref text) = args.value_text
        && text.len() > crate::commands::MAX_CONTENT_LENGTH
    {
        return Err(AppError::validation(format!(
            "tool `{TOOL_SET_PROPERTY}`: value_text length {} exceeds maximum {}",
            text.len(),
            crate::commands::MAX_CONTENT_LENGTH,
        )));
    }
    // Normalise ULID-shaped IDs to uppercase at the MCP boundary.
    args.block_id = normalize_ulid_arg(&args.block_id);
    // #3301 — a malformed `value_ref` had no downstream backstop, so it was
    // stored verbatim and the tool answered Ok.
    args.value_ref = args
        .value_ref
        .as_deref()
        .map(BlockId::from_string)
        .transpose()?
        .map(BlockId::into_string);
    // The space check covers `block_id` only. We
    // intentionally do NOT validate `value_ref` against `space_id`: a
    // ref-typed property may legitimately point at a global block
    // (a tag, a space, etc.). hardens cross-space *references*
    // separately at the op boundary.
    Ok(args)
}

async fn handle_add_tag(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: AddTagArgs = parse_args(TOOL_ADD_TAG, args)?;
    let (block_id, tag_id) = prepare_tagging(
        pool,
        TOOL_ADD_TAG,
        &args.block_id,
        &args.tag_id,
        &args.space_id,
    )
    .await?;
    // The guard checks only the target `block_id`: `add_tag_inner` itself
    // rejects a tag of another space and adopts a space-less one, which the
    // guard would refuse.
    let resp = with_space_guard(
        &normalize_ulid_arg(&args.space_id),
        vec![block_id.as_str().to_owned()],
        add_tag_inner(pool, device_id, materializer, block_id.clone(), tag_id),
    )
    .await?;
    // The tagged block's page re-renders (a tag chip appears on the block).
    emit_blocks_changed_for(pool, emitter, block_id).await;
    to_tool_result(&resp)
}

/// The block and tag of `add_tag` or `remove_tag` (`tool`), refused as the
/// tool refuses them.
async fn prepare_tagging(
    pool: &SqlitePool,
    tool: &str,
    block_id: &str,
    tag_id: &str,
    space_id: &str,
) -> Result<(BlockId, BlockId), AppError> {
    // Normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let block_id = BlockId::from_trusted(&normalize_ulid_arg(block_id));
    let space_id = normalize_ulid_arg(space_id);
    let tag_id = resolve_id_arg(pool, tool, "tag_id", tag_id, Named::Tag, &space_id).await?;
    Ok((block_id, BlockId::from_trusted(&tag_id)))
}

async fn handle_create_page(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: CreatePageArgs = parse_args(TOOL_CREATE_PAGE, args)?;
    // Every MCP-created page must carry the `space`
    // property. Routing through `create_block_inner_with_space` (the
    // IPC-tightened wrapper) emits `CreateBlock` +
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
        // #2849 PR2: MCP page creation mints a server id.
        None,
    )
    .await?;
    // A newly-created page resolves to itself (page_id = id), so `blocks:changed`
    // carries the new page id. No mounted store renders it yet; the event drops
    // the `[[` picker's cached names and the Pages list.
    emit_blocks_changed_for(pool, emitter, resp.id.clone()).await;
    to_tool_result(&resp)
}

async fn handle_delete_block(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: DeleteBlockArgs = parse_args(TOOL_DELETE_BLOCK, args)?;
    // Normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let block_id = normalize_ulid_arg(&args.block_id);
    let space_id = normalize_ulid_arg(&args.space_id);
    let resp = with_space_guard(
        &space_id,
        vec![block_id.clone()],
        delete_block_inner(pool, device_id, materializer, block_id.clone().into()),
    )
    .await?;
    // Soft-delete leaves the row (and its `parent_id` chain) intact, so the
    // owning page still resolves — the page must reload to drop the block from
    // its rendered tree.
    emit_blocks_changed_for(pool, emitter, BlockId::from_trusted(&block_id)).await;
    to_tool_result(&resp)
}

async fn handle_move_page_to_space(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: MovePageToSpaceArgs = parse_args(TOOL_MOVE_PAGE_TO_SPACE, args)?;
    let space_id = normalize_ulid_arg(&args.space_id);
    let page_id = BlockId::from_trusted(
        &resolve_id_arg(
            pool,
            TOOL_MOVE_PAGE_TO_SPACE,
            "page_id",
            &args.page_id,
            Named::Page,
            &space_id,
        )
        .await?,
    );
    let target_space_id = SpaceId::from_string(args.target_space_id)?;
    // The engine refuses `space` on a content block; a top-level tag would
    // pass it, and moving one strands the blocks of the old space it tags.
    let page = get_active_block_inner(pool, page_id.clone()).await?;
    if page.block_type != "page" {
        return Err(AppError::validation(format!(
            "tool `{TOOL_MOVE_PAGE_TO_SPACE}`: block '{page_id}' is a {} block; only pages move \
             between spaces",
            page.block_type,
        )));
    }
    let acknowledged: Vec<PropertyLoss> = args
        .acknowledge_property_loss
        .into_iter()
        .map(|(key, count)| PropertyLoss { key, count })
        .collect();
    let moved = with_space_guard(
        &space_id,
        vec![page_id.as_str().to_owned()],
        move_blocks_to_space_inner(
            pool,
            device_id,
            materializer,
            vec![page_id.clone()],
            target_space_id.as_str().to_owned(),
            &acknowledged,
        ),
    )
    .await;
    if let Err(err) = moved {
        return Err(explain_unacknowledged_loss(pool, err, &page_id, &target_space_id).await);
    }
    emit_blocks_changed_for(pool, emitter, page_id.clone()).await;
    to_tool_result(&json!({
        "page_id": page_id.as_str(),
        "space_id": target_space_id.as_str(),
    }))
}

/// A refused property-loss acknowledgement, rewritten to say what to pass: the
/// keys and counts the move would drop now, as a JSON object. Any other error
/// passes through.
async fn explain_unacknowledged_loss(
    pool: &SqlitePool,
    err: AppError,
    page_id: &BlockId,
    target_space_id: &SpaceId,
) -> AppError {
    if err.validation_code() != Some(ValidationCode::UnacknowledgedPropertyLoss) {
        return err;
    }
    let losses = match preview_space_move_inner(
        pool,
        vec![page_id.clone()],
        target_space_id.as_str().to_owned(),
    )
    .await
    {
        Ok(losses) => losses,
        Err(preview_err) => return preview_err,
    };
    let ack: serde_json::Map<String, Value> = losses
        .iter()
        .map(|loss| (loss.key.clone(), Value::from(loss.count)))
        .collect();
    AppError::validation_coded(
        ValidationCode::UnacknowledgedPropertyLoss,
        format!(
            "tool `{TOOL_MOVE_PAGE_TO_SPACE}`: the target space does not define these properties \
             the way this page's space does, so the move would remove their values: {}. To move \
             anyway, call again with \"acknowledge_property_loss\": {}",
            describe_losses(&losses),
            Value::Object(ack),
        ),
    )
}

/// `blocks:changed` names the tag itself: no page owns a tag, and an empty set
/// would reload every mounted page store.
async fn handle_create_tag(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: CreateTagArgs = parse_args(TOOL_CREATE_TAG, args)?;
    let space_id = normalize_ulid_arg(&args.space_id);
    let scope = SpaceScope::Active(SpaceId::from_string(space_id)?);
    let resp = create_block_inner_with_space(
        pool,
        device_id,
        materializer,
        "tag".to_string(),
        args.name,
        None,
        None,
        &scope,
        None,
    )
    .await?;
    // The `#` picker refills from `tags_cache`, which the background queue
    // rebuilds after the commit, so a refill before that would keep a list
    // without the tag. The wait fails only on shutdown, when no view listens.
    let _ = materializer.flush_background().await;
    emitter.emit_blocks_changed(vec![resp.id.as_str().to_owned()]);
    to_tool_result(&resp)
}

async fn handle_delete_property(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: DeletePropertyArgs = parse_args(TOOL_DELETE_PROPERTY, args)?;
    // #3301 — deleting `space` clears the page's membership, hiding it from
    // every space-scoped view; space changes go through `move_page_to_space`.
    if args.key == agaric_store::op::SPACE_PROPERTY_KEY {
        return Err(AppError::validation(format!(
            "tool `{TOOL_DELETE_PROPERTY}`: `{}` is space membership, not a content property; \
             use `{TOOL_MOVE_PAGE_TO_SPACE}`",
            agaric_store::op::SPACE_PROPERTY_KEY,
        )));
    }
    let block_id = normalize_ulid_arg(&args.block_id);
    let space_id = normalize_ulid_arg(&args.space_id);
    let active_id = crate::ulid::verify_active(pool, &BlockId::from_trusted(&block_id)).await?;
    let deleted_keys = with_space_guard(
        &space_id,
        vec![block_id.clone()],
        delete_property_inner(pool, device_id, materializer, active_id, args.key.clone()),
    )
    .await?;
    // Same `block:properties-changed` payload as the local `delete_property`.
    emit_blocks_changed_for(pool, emitter, BlockId::from_trusted(&block_id)).await;
    emitter.emit_property_changed(block_id.clone(), deleted_keys);
    to_tool_result(&DeletePropertyResponse {
        block_id,
        key: args.key,
    })
}

async fn handle_set_page_aliases(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: SetPageAliasesArgs = parse_args(TOOL_SET_PAGE_ALIASES, args)?;
    let space_id = normalize_ulid_arg(&args.space_id);
    let page_id = resolve_id_arg(
        pool,
        TOOL_SET_PAGE_ALIASES,
        "page_id",
        &args.page_id,
        Named::Page,
        &space_id,
    )
    .await?;
    validate_block_in_space(pool, &page_id, &space_id).await?;
    let aliases =
        set_page_aliases_inner(pool, device_id, materializer, &page_id, args.aliases).await?;
    emit_blocks_changed_for(pool, emitter, BlockId::from_trusted(&page_id)).await;
    to_tool_result(&json!({ "page_id": page_id, "aliases": aliases }))
}

/// Reverts through the same inner as the Activity feed's Undo, so the revert
/// is one op group the user can undo in turn.
async fn handle_undo(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: UndoArgs = parse_args(TOOL_UNDO, args)?;
    let space_id = normalize_ulid_arg(&args.space_id);
    let block_ids = own_op_block_ids(pool, &args.op_refs).await?;
    let guarded: Vec<String> = block_ids.iter().map(|id| id.as_str().to_owned()).collect();
    let undone = with_space_guard(
        &space_id,
        guarded,
        revert_ops_inner(pool, device_id, materializer, args.op_refs),
    )
    .await?;
    emit_blocks_changed_for_all(pool, emitter, &block_ids).await;
    to_tool_result(&json!({ "undone": undone }))
}

/// `today` is the device's date, passed in so a test can fix it.
async fn handle_capture(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
    today: chrono::NaiveDate,
) -> Result<Value, AppError> {
    let args: CaptureArgs = parse_args(TOOL_CAPTURE, args)?;
    let date = resolve_journal_date(TOOL_CAPTURE, args.date.as_deref(), today)?;
    let space_id = SpaceId::from_string(args.space_id)?;
    let resp = capture_to_journal_inner(
        pool,
        device_id,
        materializer,
        space_id.as_str(),
        date,
        &args.content,
    )
    .await?;
    emit_blocks_changed_for(pool, emitter, resp.page.id.clone()).await;
    to_tool_result(&resp)
}

async fn handle_move_blocks(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: MoveBlocksArgs = parse_args(TOOL_MOVE_BLOCKS, args)?;
    let space_id = normalize_ulid_arg(&args.space_id);
    let (block_ids, parent_id, index) = prepare_move_blocks(pool, args).await?;
    // Resolved before the move: the blocks leave these pages, which reload too.
    let old_pages =
        agaric_sync::sync_protocol::loro_sync::resolve_changed_page_ids(pool, &block_ids).await?;
    let guarded: Vec<String> = std::iter::once(&parent_id)
        .chain(&block_ids)
        .map(|id| id.as_str().to_owned())
        .collect();
    let moves = with_space_guard(
        &space_id,
        guarded,
        move_blocks_batch_inner(
            pool,
            device_id,
            materializer,
            block_ids,
            Some(parent_id.clone()),
            index,
        ),
    )
    .await?;
    let mut seeds: Vec<BlockId> = old_pages
        .iter()
        .map(|id| BlockId::from_trusted(id))
        .collect();
    seeds.push(parent_id);
    emit_blocks_changed_for_all(pool, emitter, &seeds).await;
    to_tool_result(&MovedBlocks { moves })
}

/// `move_blocks`'s blocks, new parent and 0-based index, refused as the tool
/// refuses them.
async fn prepare_move_blocks(
    pool: &SqlitePool,
    args: MoveBlocksArgs,
) -> Result<(Vec<BlockId>, BlockId, i64), AppError> {
    let space_id = normalize_ulid_arg(&args.space_id);
    let parent_id = BlockId::from_trusted(
        &resolve_id_arg(
            pool,
            TOOL_MOVE_BLOCKS,
            "parent_id",
            &args.parent_id,
            Named::Page,
            &space_id,
        )
        .await?,
    );
    let block_ids: Vec<BlockId> = args
        .block_ids
        .iter()
        .map(|id| BlockId::from_trusted(&normalize_ulid_arg(id)))
        .collect();
    // The same 1-based contract and refusal as `append_block` (#1606, #400).
    if let Some(p) = args.position
        && p < 1
    {
        return Err(AppError::validation(format!(
            "tool `{TOOL_MOVE_BLOCKS}`: position must be >= 1 (1-based), got {p}"
        )));
    }
    // The inner clamps an index past the last sibling to an append.
    let index = args.position.map_or(i64::MAX, |p| p - 1);
    Ok((block_ids, parent_id, index))
}

async fn handle_remove_tag(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: RemoveTagArgs = parse_args(TOOL_REMOVE_TAG, args)?;
    let (block_id, tag_id) = prepare_tagging(
        pool,
        TOOL_REMOVE_TAG,
        &args.block_id,
        &args.tag_id,
        &args.space_id,
    )
    .await?;
    let resp = with_space_guard(
        &normalize_ulid_arg(&args.space_id),
        vec![block_id.as_str().to_owned()],
        remove_tag_inner(pool, device_id, materializer, block_id.clone(), tag_id),
    )
    .await?;
    emit_blocks_changed_for(pool, emitter, block_id).await;
    to_tool_result(&resp)
}

async fn handle_restore_block(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: RestoreBlockArgs = parse_args(TOOL_RESTORE_BLOCK, args)?;
    let block_id = BlockId::from_trusted(&normalize_ulid_arg(&args.block_id));
    let space_id = normalize_ulid_arg(&args.space_id);
    let resp = with_space_guard(
        &space_id,
        vec![block_id.as_str().to_owned()],
        restore_block_inner(
            pool,
            device_id,
            materializer,
            block_id.clone(),
            args.deleted_at,
        ),
    )
    .await?;
    emit_blocks_changed_for(pool, emitter, block_id).await;
    to_tool_result(&resp)
}

/// One op of a `batch`, refused and resolved as its own tool refuses and
/// resolves it, ready to run in the batch's transaction.
enum BatchOp {
    AppendBlock {
        parent: BlockId,
        content: String,
        index: Option<i64>,
    },
    UpdateBlockContent {
        block: BlockId,
        content: String,
    },
    SetProperty(SetPropertyArgs),
    AddTag {
        block: BlockId,
        tag: BlockId,
    },
    RemoveTag {
        block: BlockId,
        tag: BlockId,
    },
    MoveBlocks {
        blocks: Vec<BlockId>,
        parent: BlockId,
        index: i64,
    },
    DeleteBlock {
        block: BlockId,
    },
}

impl BatchOp {
    /// The blocks the op names: the ones its tool's space check covers, whose
    /// pages reload once the batch commits.
    fn block_ids(&self) -> Vec<BlockId> {
        match self {
            Self::AppendBlock { parent, .. } => vec![parent.clone()],
            Self::UpdateBlockContent { block, .. }
            | Self::AddTag { block, .. }
            | Self::RemoveTag { block, .. }
            | Self::DeleteBlock { block } => vec![block.clone()],
            Self::SetProperty(args) => vec![BlockId::from_trusted(&args.block_id)],
            Self::MoveBlocks { blocks, parent, .. } => {
                blocks.iter().chain([parent]).cloned().collect()
            }
        }
    }
}

/// Each op is resolved and checked as its tool does before the transaction
/// opens, since those reads take connections of their own; its space check
/// alone runs inside the transaction, on the batch's connection (#5402).
async fn handle_batch(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: BatchArgs = parse_args(TOOL_BATCH, args)?;
    if args.ops.is_empty() {
        return Err(AppError::validation(format!(
            "tool `{TOOL_BATCH}`: ops cannot be empty"
        )));
    }
    crate::commands::ensure_batch_within_cap("ops", args.ops.len())?;
    let space_id = normalize_ulid_arg(&args.space_id);
    let mut ops = Vec::with_capacity(args.ops.len());
    for (i, op) in args.ops.into_iter().enumerate() {
        let op = prepare_batch_op(pool, &space_id, op).await;
        ops.push(op.map_err(|err| at_op(i, err))?);
    }
    // Resolved before the batch: a moved block leaves its page, which reloads too.
    let touched: Vec<BlockId> = ops.iter().flat_map(BatchOp::block_ids).collect();
    let pages =
        agaric_sync::sync_protocol::loro_sync::resolve_changed_page_ids(pool, &touched).await?;
    let properties: Vec<(String, String)> = ops
        .iter()
        .filter_map(|op| match op {
            BatchOp::SetProperty(args) => Some((args.block_id.clone(), args.key.clone())),
            _ => None,
        })
        .collect();
    let results = run_batch(pool, materializer, device_id, &space_id, ops).await?;
    emitter.emit_blocks_changed(pages);
    for (block_id, key) in properties {
        emitter.emit_property_changed(block_id, vec![key]);
    }
    to_tool_result(&json!({ "results": results }))
}

/// `op` read as the arguments of the tool its `op` names, with the batch's
/// `space_id`, and refused or resolved as that tool does; [`run_batch`] makes
/// its space check.
async fn prepare_batch_op(
    pool: &SqlitePool,
    space_id: &str,
    mut op: serde_json::Map<String, Value>,
) -> Result<BatchOp, AppError> {
    let Some(Value::String(tool)) = op.remove("op") else {
        return Err(AppError::validation(format!(
            "tool `{TOOL_BATCH}`: each op needs `op`, the name of its tool"
        )));
    };
    op.insert("space_id".to_owned(), Value::String(space_id.to_owned()));
    let args = Value::Object(op);
    Ok(match tool.as_str() {
        TOOL_APPEND_BLOCK => {
            let (parent, content, index) =
                prepare_append_block(pool, parse_args(TOOL_APPEND_BLOCK, args)?).await?;
            BatchOp::AppendBlock {
                parent,
                content,
                index,
            }
        }
        TOOL_UPDATE_BLOCK_CONTENT => {
            let a: UpdateBlockContentArgs = parse_args(TOOL_UPDATE_BLOCK_CONTENT, args)?;
            BatchOp::UpdateBlockContent {
                block: BlockId::from_trusted(&normalize_ulid_arg(&a.block_id)),
                content: a.content,
            }
        }
        TOOL_SET_PROPERTY => {
            BatchOp::SetProperty(prepare_set_property(parse_args(TOOL_SET_PROPERTY, args)?)?)
        }
        TOOL_ADD_TAG => {
            let a: AddTagArgs = parse_args(TOOL_ADD_TAG, args)?;
            let (block, tag) =
                prepare_tagging(pool, TOOL_ADD_TAG, &a.block_id, &a.tag_id, &a.space_id).await?;
            BatchOp::AddTag { block, tag }
        }
        TOOL_REMOVE_TAG => {
            let a: RemoveTagArgs = parse_args(TOOL_REMOVE_TAG, args)?;
            let (block, tag) =
                prepare_tagging(pool, TOOL_REMOVE_TAG, &a.block_id, &a.tag_id, &a.space_id).await?;
            BatchOp::RemoveTag { block, tag }
        }
        TOOL_MOVE_BLOCKS => {
            let (blocks, parent, index) =
                prepare_move_blocks(pool, parse_args(TOOL_MOVE_BLOCKS, args)?).await?;
            BatchOp::MoveBlocks {
                blocks,
                parent,
                index,
            }
        }
        TOOL_DELETE_BLOCK => {
            let a: DeleteBlockArgs = parse_args(TOOL_DELETE_BLOCK, args)?;
            BatchOp::DeleteBlock {
                block: BlockId::from_trusted(&normalize_ulid_arg(&a.block_id)),
            }
        }
        other => {
            let names: Vec<String> = batch_op_descriptions().map(|d| d.name).into();
            return Err(AppError::validation(format!(
                "tool `{TOOL_BATCH}`: `{other}` is not a batch op; an op is one of {}",
                names.join(", "),
            )));
        }
    })
}

/// Run `ops` in order in one transaction: each op's result as its tool
/// returns it, or the first refusal, naming its op, with nothing written.
async fn run_batch(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    space_id: &str,
    ops: Vec<BatchOp>,
) -> Result<Vec<Value>, AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "mcp_batch").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let mut results = Vec::with_capacity(ops.len());
    let mut deletes = Vec::new();
    for (i, op) in ops.into_iter().enumerate() {
        // The op's space check, on this transaction's connection (#5402).
        for block in op.block_ids() {
            validate_block_in_space(&mut **tx, block.as_str(), space_id)
                .await
                .map_err(|err| at_op(i, err))?;
        }
        let applied = Box::pin(apply_batch_op(
            tx,
            materializer,
            device_id,
            op,
            &mut deletes,
        ))
        .await;
        let (next, result) = applied.map_err(|err| at_op(i, err))?;
        tx = next;
        results.push(result);
    }
    tx.commit_and_dispatch(materializer).await?;
    dispatch_deletes(pool, materializer, &deletes).await;
    Ok(results)
}

/// `op` written in `tx` as its tool writes it in its own transaction, and the
/// result that tool returns. A delete also goes on `deletes`, for the
/// post-commit fan-out.
async fn apply_batch_op(
    mut tx: CommandTx,
    materializer: &Materializer,
    device_id: &str,
    op: BatchOp,
    deletes: &mut Vec<DeleteInTx>,
) -> Result<(CommandTx, Value), AppError> {
    let loro = materializer.loro_state();
    let result = match op {
        BatchOp::AppendBlock {
            parent,
            content,
            index,
        } => {
            let appended = append_block_resolving_names_in_tx(
                tx,
                materializer,
                device_id,
                &parent,
                content,
                index,
            );
            let (next, block, warnings) = Box::pin(appended).await?;
            tx = next;
            with_warnings(&block, &warnings)?
        }
        BatchOp::UpdateBlockContent { block, content } => {
            let edited =
                edit_block_resolving_names_in_tx(tx, materializer, device_id, &block, content);
            let (next, row, warnings) = Box::pin(edited).await?;
            tx = next;
            with_warnings(&row, &warnings)?
        }
        BatchOp::SetProperty(args) => {
            Box::pin(set_property_in_batch(&mut tx, loro, device_id, args)).await?
        }
        BatchOp::AddTag { block, tag } => {
            add_tag_in_tx(&mut tx, loro, device_id, &block, &tag).await?;
            to_tool_result(&TagResponse {
                block_id: block.into_string(),
                tag_id: tag.into_string(),
            })?
        }
        BatchOp::RemoveTag { block, tag } => {
            remove_tag_inner_in_tx(&mut tx, loro, device_id, &block, &tag).await?;
            to_tool_result(&TagResponse {
                block_id: block.into_string(),
                tag_id: tag.into_string(),
            })?
        }
        BatchOp::MoveBlocks {
            blocks,
            parent,
            index,
        } => {
            let moves =
                move_blocks_batch_in_tx(&mut tx, loro, device_id, blocks, Some(parent), index)
                    .await?;
            to_tool_result(&MovedBlocks { moves })?
        }
        BatchOp::DeleteBlock { block } => {
            let block_id = block.into_string();
            let deleted = delete_block_in_tx(&mut tx, loro, device_id, block_id.clone()).await?;
            let result = to_tool_result(&DeleteResponse {
                block_id,
                deleted_at: deleted.deleted_at,
                descendants_affected: deleted.effects.deleted_cohort.len() as u64,
                affected_page_ids: deleted.affected_page_ids.clone(),
            })?;
            deletes.push(deleted);
            result
        }
    };
    // One undo reverts the batch only while it wrote no more ops than one
    // revert takes.
    crate::commands::ensure_batch_within_cap("ops", tx.pending_len())?;
    Ok((tx, result))
}

/// A batch's `set_property` op written in `tx`, and the block row the tool
/// returns.
async fn set_property_in_batch(
    tx: &mut CommandTx,
    loro: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    args: SetPropertyArgs,
) -> Result<Value, AppError> {
    let active_id =
        crate::ulid::verify_active_in_tx(tx, &BlockId::from_trusted(&args.block_id)).await?;
    let row = set_property_inner_in_tx(
        tx,
        loro,
        device_id,
        active_id,
        args.key,
        args.value_text,
        args.value_num,
        args.value_date,
        args.value_ref,
        args.value_bool,
        Some(TOOL_SET_PROPERTY),
    )
    .await?;
    to_tool_result(&row)
}

/// `err` naming the batch op it was refused at, `ops[i]: ` before its message.
fn at_op(index: usize, err: AppError) -> AppError {
    let at = |message: String| format!("ops[{index}]: {message}");
    match err {
        AppError::Validation { code, message } => AppError::Validation {
            code,
            message: at(message),
        },
        AppError::NotFound(message) => AppError::NotFound(at(message)),
        AppError::InvalidOperation(message) => AppError::InvalidOperation(at(message)),
        AppError::Ulid(message) => AppError::Ulid(at(message)),
        err => err,
    }
}

/// Saves through the app's source-mode save, which takes the buffer's text
/// with its anchors beside it, not in it: [`anchor_free`] splits the agent's
/// anchored text the way the app's editor holds it.
async fn handle_edit_page_markdown(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: EditPageMarkdownArgs = parse_args(TOOL_EDIT_PAGE_MARKDOWN, args)?;
    let space_id = normalize_ulid_arg(&args.space_id);
    let page_id = resolve_id_arg(
        pool,
        TOOL_EDIT_PAGE_MARKDOWN,
        "page_id",
        &args.page_id,
        Named::Page,
        &space_id,
    )
    .await?;
    let (text, line_ids) = anchor_free(&args.markdown);
    // A stale base is refused, as the app's save first refuses it: a merge
    // keeps a block both sides changed twice, which an agent cannot review.
    let flags = SourceSaveFlags {
        merge: false,
        line_ids,
    };
    // Refuses a page in another space inside the save's own transaction.
    let report = with_space_guard(
        &space_id,
        vec![page_id.clone()],
        apply_page_source_inner(
            pool,
            device_id,
            materializer,
            &page_id,
            text,
            args.base,
            flags,
        ),
    )
    .await?;
    emit_blocks_changed_for(pool, emitter, BlockId::from_trusted(&page_id)).await;
    let mut result = to_tool_result(&report)?;
    result["page_id"] = json!(page_id);
    Ok(result)
}

/// The distinct blocks `refs` touch, once every known ref is an op the calling
/// agent wrote; `revert_ops_inner` answers an unknown ref with `NotFound`.
/// Not a security boundary (agent names are self-declared, #2957): it keeps an
/// agent from clobbering the user's edits with a mistaken ref.
async fn own_op_block_ids(pool: &SqlitePool, refs: &[OpRef]) -> Result<Vec<BlockId>, AppError> {
    let caller = current_actor().origin_tag();
    let found = super::handler_utils::fetch_op_origins(pool, refs).await?;
    if let Some(foreign) = found.iter().find(|op| op.origin != caller) {
        return Err(AppError::validation(format!(
            "tool `{TOOL_UNDO}`: op ({}, {}) was written by `{}`, not by `{caller}`; \
             an agent can undo only its own ops",
            foreign.device_id, foreign.seq, foreign.origin
        )));
    }
    let mut block_ids: Vec<String> = found.into_iter().filter_map(|op| op.block_id).collect();
    block_ids.sort_unstable();
    block_ids.dedup();
    Ok(block_ids
        .iter()
        .map(|id| BlockId::from_trusted(id))
        .collect())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
