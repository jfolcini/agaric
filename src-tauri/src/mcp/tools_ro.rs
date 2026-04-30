//! Read-only [`ToolRegistry`] impl — the v1 MCP tool surface.
//!
//! FEAT-4c wires nine read-only tools into the MCP dispatcher established by
//! FEAT-4a/4b. Each tool is a **thin wrapper** around an existing
//! `*_inner` command handler so the op-log / CQRS / sqlx-compile-time-query
//! invariants of the frontend path apply verbatim to agent calls
//! (AGENTS.md §Key Architectural Invariants).
//!
//! # Tool surface
//!
//! | Tool | Backing `*_inner` | Notes |
//! |------|-------------------|-------|
//! | `list_pages` | [`list_pages_inner`](crate::commands::list_pages_inner) | Cursor paginated. Limit clamped server-side to 100. |
//! | `get_page` | [`get_page_inner`](crate::commands::get_page_inner) | Composes `get_block_inner` + paginated subtree via `page_id`. |
//! | `search` | [`search_blocks_inner`](crate::commands::search_blocks_inner) | FTS5. Result count capped at 50, snippet length at 512 chars. |
//! | `get_block` | [`get_block_inner`](crate::commands::get_block_inner) | |
//! | `list_backlinks` | [`list_backlinks_grouped_inner`](crate::commands::list_backlinks_grouped_inner) | Grouped by source page. |
//! | `list_tags` | [`list_tags_inner`](crate::commands::list_tags_inner) | All tags; thin wrapper over `list_tags_by_prefix_inner("")`. |
//! | `list_property_defs` | [`list_property_defs_inner`](crate::commands::list_property_defs_inner) | Typed property schema. |
//! | `get_agenda` | [`list_projected_agenda_inner`](crate::commands::list_projected_agenda_inner) | Date-range agenda projection. |
//! | `journal_for_date` | [`journal_for_date_inner`](crate::commands::journal_for_date_inner) | Idempotent date → page lookup. **M-84 carve-out:** on first read-of-the-day this RO tool emits a single `CreateBlock` op (origin `agent:<name>`) for the missing journal page; see the M-82/M-84 commentary on [`ReadOnlyTools`] below. |
//!
//! # Actor scoping
//!
//! Each handler (re-)scopes [`ACTOR`](crate::mcp::actor::ACTOR) around the
//! inner call. The server wraps `registry.call_tool(...)` in
//! `ACTOR.scope(ctx, ...)` at the dispatch site so the nested scope is
//! normally a no-op, but it future-proofs any direct invocation of
//! [`ReadOnlyTools::call_tool`] (e.g. tests, diagnostics) against a missing
//! task-local — v1 commands do not call `current_actor()` anywhere, so the
//! plumbing is latent until FEAT-4h populates the op-log `origin` column.
//!
//! # Cap enforcement
//!
//! Two caps are enforced at the tool boundary:
//!
//! - **Result count:** `search` is capped at [`SEARCH_RESULT_CAP`] (50),
//!   list-style tools at [`LIST_RESULT_CAP`] (100), `get_agenda` at
//!   [`AGENDA_RESULT_CAP`] (500). L-119: a `limit` outside `[1, cap]`
//!   is **rejected** as [`AppError::Validation`] (→ JSON-RPC `-32602
//!   invalid params`) rather than silently clamped — matching the
//!   strict `serde(deny_unknown_fields)` posture used elsewhere on
//!   the MCP boundary. Omitting `limit` keeps the per-tool default
//!   (e.g. `search` falls back to [`SEARCH_RESULT_CAP`]).
//! - **Snippet length:** `search` truncates each `BlockRow.content` to
//!   [`SEARCH_SNIPPET_CAP`] Unicode scalars (chars) before returning it —
//!   agents that want the full content call `get_block` on the returned
//!   id. The implementation truncates at char boundaries so the output
//!   is always valid UTF-8 even when the content contains multi-byte
//!   codepoints (CJK, emoji, etc.).

use std::future::Future;

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;

use super::actor::ActorContext;
use super::dispatch::{scoped_dispatch, unknown_tool_error};
use super::handler_utils::{normalize_ulid_arg, parse_args, to_tool_result};
use super::registry::{
    ToolDescription, ToolRegistry, TOOL_GET_AGENDA, TOOL_GET_BLOCK, TOOL_GET_PAGE,
    TOOL_JOURNAL_FOR_DATE, TOOL_LIST_BACKLINKS, TOOL_LIST_PAGES, TOOL_LIST_PROPERTY_DEFS,
    TOOL_LIST_TAGS, TOOL_SEARCH,
};
use crate::commands::{
    get_block_inner, get_page_unscoped_inner, journal_for_date_inner, list_backlinks_grouped_inner,
    list_pages_inner, list_projected_agenda_inner, list_property_defs_inner, list_tags_inner,
    search_blocks_inner,
};
use crate::error::AppError;
use crate::materializer::Materializer;

// ---------------------------------------------------------------------------
// Caps — enforced at the tool boundary (FEAT-4c decision)
// ---------------------------------------------------------------------------

/// Maximum results returned by the `search` tool. Below
/// [`crate::pagination::MAX_PAGE_SIZE`] deliberately — agents see a narrower
/// page than the frontend.
pub const SEARCH_RESULT_CAP: i64 = 50;

/// Default for list-style tools (`list_pages`, `list_tags`,
/// `list_backlinks`). Re-exported from
/// [`crate::commands::MCP_PAGE_LIMIT_CAP`] so the tool boundary cap and
/// the [`list_pages_inner`] / [`get_page_inner`] internal clamp share a
/// single source of truth.
pub use crate::commands::MCP_PAGE_LIMIT_CAP as LIST_RESULT_CAP;

/// Per-result snippet length cap (in Unicode scalars / `char`s) for the
/// `search` tool. Prevents oversized content strings when an agent
/// searches for a common term and hits long blocks. Truncation is
/// done via `chars().take(...)`, which always lands on a UTF-8 char
/// boundary — the worst-case byte length is `4 * SEARCH_SNIPPET_CAP`
/// (every codepoint a four-byte emoji).
pub const SEARCH_SNIPPET_CAP: usize = 512;

/// Cap for `get_agenda`'s `limit` — advertised in the tool schema and
/// enforced strictly at the tool boundary (L-119): out-of-range values
/// surface as [`AppError::Validation`]. The matching ceiling baked
/// into [`list_projected_agenda_inner`] remains as a defense-in-depth
/// backstop for any non-MCP caller.
pub const AGENDA_RESULT_CAP: i64 = 500;

// ---------------------------------------------------------------------------
// Typed argument structs (one per tool)
//
// Each uses `serde(deny_unknown_fields)` so typos in an agent's JSON
// arguments are surfaced immediately as `AppError::Validation` rather than
// silently ignored. Every field is `Option<T>` unless the tool requires it.
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListPagesArgs {
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetPageArgs {
    page_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArgs {
    query: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    tag_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetBlockArgs {
    block_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListBacklinksArgs {
    block_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListTagsArgs {
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListPropertyDefsArgs {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetAgendaArgs {
    start_date: String,
    end_date: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalForDateArgs {
    date: String,
    /// FEAT-3p5 — the active space's ULID. Required: every journal page
    /// belongs to a space. Agents that do not yet track a "current
    /// space" must pick one explicitly (typically the first space
    /// surfaced via `list_spaces`).
    space_id: String,
}

// ---------------------------------------------------------------------------
// ReadOnlyTools
// ---------------------------------------------------------------------------

/// Read-only MCP tool registry. Holds a [`SqlitePool`] (reader pool from
/// `DbPools::read`) plus a [`Materializer`] handle used solely by the
/// `journal_for_date` tool — the other eight tools never need it because
/// journal-page creation is the only side-effect allowed in v1.
///
/// Journal-page creation is reversible (creates an ordinary `page` block
/// via `create_block_inner`), matching the FEAT-4 invariant that v1 never
/// exposes non-reversible ops.
///
/// M-82: `journal_for_date` is the only RO tool with a write side-effect —
/// it calls `create_block_inner` when the requested date has no existing
/// page. The reader pool sets `PRAGMA query_only = ON`, so feeding it to
/// the create path raises `SQLITE_READONLY`. The struct therefore carries
/// **both** pools: `pool` (reader) is used by the eight pure-read tools
/// and the lookup branch of `journal_for_date`, while `writer_pool` is
/// used by `journal_for_date` whenever it has to insert a new page.
///
/// M-84: because of the M-82 carve-out, **enabling the read-only MCP
/// server implicitly grants the agent permission to append a single
/// `CreateBlock` op to `op_log` (origin `agent:<name>`) on the first
/// read-of-the-day for any space**. The op is reversible (ordinary
/// `page` block via `create_block_inner`) and shows up in the agent
/// activity feed like any other agent-authored write, but it is **not**
/// a pure read. The Settings "Read-only access" tooltip
/// (`agentAccess.roToggleDescription` in `src/lib/i18n.ts`) and the
/// FEAT-4 entry in `REVIEW-LATER.md` surface this carve-out to the
/// user. Splitting `journal_for_date` into RO+RW halves was rejected as
/// a public API change requiring explicit user approval — the
/// docs-only fix preserves the v1 tool surface.
pub struct ReadOnlyTools {
    pool: SqlitePool,
    /// Writer pool from `DbPools::write` — used exclusively by
    /// `journal_for_date` when it needs to create a missing journal
    /// page. The other eight RO tools continue to use `pool` (reader)
    /// so the read/write capacity split is preserved. (M-82.)
    writer_pool: SqlitePool,
    materializer: Materializer,
    /// Local-device id used when a tool has to write (today only
    /// `journal_for_date` when the requested date page does not exist
    /// yet). Namespaced so future RW tools (FEAT-4h) can stamp the same
    /// origin without a second field.
    device_id: String,
}

impl ReadOnlyTools {
    /// Construct a read-only registry.
    ///
    /// - `pool` is the *reader* pool (`DbPools::read`) and backs every
    ///   pure-read tool plus the lookup branch of `journal_for_date`.
    /// - `writer_pool` is the *writer* pool (`DbPools::write`) and backs
    ///   the `journal_for_date` create branch — opening `BEGIN IMMEDIATE`
    ///   on the read pool fails with `SQLITE_READONLY` because the read
    ///   pool sets `PRAGMA query_only = ON`. (M-82.)
    /// - `materializer` carries its own writer-pool handle internally;
    ///   passed through unchanged.
    pub fn new(
        pool: SqlitePool,
        writer_pool: SqlitePool,
        materializer: Materializer,
        device_id: String,
    ) -> Self {
        Self {
            pool,
            writer_pool,
            materializer,
            device_id,
        }
    }
}

/// Static tool-description list for the read-only MCP surface.
///
/// Lifted out of [`ToolRegistry::list_tools`] so callers that need the
/// names without a constructed registry (notably the privacy-guard test
/// in `summarise.rs`, MAINT-136) can drive iteration from the live
/// metadata. The `&self` impl below just delegates here.
pub(crate) fn list_tool_descriptions() -> Vec<ToolDescription> {
    vec![
        tool_desc_list_pages(),
        tool_desc_get_page(),
        tool_desc_search(),
        tool_desc_get_block(),
        tool_desc_list_backlinks(),
        tool_desc_list_tags(),
        tool_desc_list_property_defs(),
        tool_desc_get_agenda(),
        tool_desc_journal_for_date(),
    ]
}

impl ToolRegistry for ReadOnlyTools {
    fn list_tools(&self) -> Vec<ToolDescription> {
        list_tool_descriptions()
    }

    fn call_tool(
        &self,
        name: &str,
        args: Value,
        ctx: &ActorContext,
    ) -> impl Future<Output = Result<Value, AppError>> + Send {
        // The server already wraps the outer call in `ACTOR.scope(...)`,
        // but `scoped_dispatch` re-scopes here (nested scope shadows
        // with the same value) so direct `call_tool(...)` invocations
        // (tests, diagnostics) see the actor without requiring the
        // caller to know about `ACTOR`. See `mcp::actor` tests.
        // MAINT-150 (h): the ACTOR scope + name-clone boilerplate is
        // shared with `tools_rw` via `super::dispatch::scoped_dispatch`.
        let pool = self.pool.clone();
        let writer_pool = self.writer_pool.clone();
        let materializer = self.materializer.clone();
        let device_id = self.device_id.clone();
        scoped_dispatch(ctx, name, move |name| async move {
            match name.as_str() {
                TOOL_LIST_PAGES => handle_list_pages(&pool, args).await,
                TOOL_GET_PAGE => handle_get_page(&pool, args).await,
                TOOL_SEARCH => handle_search(&pool, args).await,
                TOOL_GET_BLOCK => handle_get_block(&pool, args).await,
                TOOL_LIST_BACKLINKS => handle_list_backlinks(&pool, args).await,
                TOOL_LIST_TAGS => handle_list_tags(&pool, args).await,
                TOOL_LIST_PROPERTY_DEFS => handle_list_property_defs(&pool, args).await,
                TOOL_GET_AGENDA => handle_get_agenda(&pool, args).await,
                TOOL_JOURNAL_FOR_DATE => {
                    // M-82: route `journal_for_date` to the writer
                    // pool because `journal_for_date_inner` opens
                    // `BEGIN IMMEDIATE` and inserts into `op_log` +
                    // `blocks` whenever the requested date has no
                    // existing page. The reader pool's
                    // `PRAGMA query_only = ON` rejects that path with
                    // `SQLITE_READONLY`. The other eight tools stay
                    // on the reader pool.
                    handle_journal_for_date(&writer_pool, &materializer, &device_id, args).await
                }
                other => Err(unknown_tool_error(other)),
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Tool descriptions (static metadata)
// ---------------------------------------------------------------------------

fn tool_desc_list_pages() -> ToolDescription {
    ToolDescription {
        name: TOOL_LIST_PAGES.to_string(),
        description: "List all pages with cursor pagination.".to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "cursor": { "type": "string", "description": "Opaque pagination cursor from a prior response." },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": LIST_RESULT_CAP,
                    "description": format!("Max pages per response (capped at {LIST_RESULT_CAP})."),
                },
            },
        }),
    }
}

fn tool_desc_get_page() -> ToolDescription {
    ToolDescription {
        name: TOOL_GET_PAGE.to_string(),
        description:
            "Fetch a page and a paginated slice of its non-conflict subtree (grandchildren included)."
                .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["page_id"],
            "properties": {
                "page_id": { "type": "string", "description": "ULID of the page block." },
                "cursor": { "type": "string", "description": "Opaque cursor for the children page." },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": LIST_RESULT_CAP,
                    "description": format!("Max children per response (capped at {LIST_RESULT_CAP})."),
                },
            },
        }),
    }
}

fn tool_desc_search() -> ToolDescription {
    ToolDescription {
        name: TOOL_SEARCH.to_string(),
        description: "Full-text search across block content (FTS5). Returns BlockRow records; \
                      content is truncated to 512 chars per result."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["query"],
            "properties": {
                "query": { "type": "string", "description": "FTS5 MATCH query string." },
                "cursor": { "type": "string" },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": SEARCH_RESULT_CAP,
                    "description": format!("Max results per response (capped at {SEARCH_RESULT_CAP})."),
                },
                "parent_id": { "type": "string", "description": "Optional parent ULID to scope the search." },
                "tag_ids": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional list of tag ULIDs to intersect the result set with.",
                },
            },
        }),
    }
}

fn tool_desc_get_block() -> ToolDescription {
    ToolDescription {
        name: TOOL_GET_BLOCK.to_string(),
        description:
            "Fetch a single block by ULID. Returns the BlockRow including soft-deleted blocks."
                .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the block." },
            },
        }),
    }
}

fn tool_desc_list_backlinks() -> ToolDescription {
    ToolDescription {
        name: TOOL_LIST_BACKLINKS.to_string(),
        description: "List backlinks for a block, grouped by source page.".to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the target block/page." },
                "cursor": { "type": "string" },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": LIST_RESULT_CAP,
                    "description": format!("Max grouped results per response (capped at {LIST_RESULT_CAP})."),
                },
            },
        }),
    }
}

fn tool_desc_list_tags() -> ToolDescription {
    ToolDescription {
        name: TOOL_LIST_TAGS.to_string(),
        description: "List every tag in the tag cache (no prefix filter).".to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": LIST_RESULT_CAP,
                    "description": format!("Max tags returned (capped at {LIST_RESULT_CAP})."),
                },
            },
        }),
    }
}

fn tool_desc_list_property_defs() -> ToolDescription {
    ToolDescription {
        name: TOOL_LIST_PROPERTY_DEFS.to_string(),
        description: "List every property definition (typed property schema).".to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {},
        }),
    }
}

fn tool_desc_get_agenda() -> ToolDescription {
    ToolDescription {
        name: TOOL_GET_AGENDA.to_string(),
        description:
            "Project the agenda (repeating tasks + due/scheduled blocks) for a date range."
                .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["start_date", "end_date"],
            "properties": {
                "start_date": { "type": "string", "description": "Inclusive YYYY-MM-DD lower bound." },
                "end_date":   { "type": "string", "description": "Inclusive YYYY-MM-DD upper bound." },
                "cursor": {
                    "type": "string",
                    "description": "Opaque cursor returned by a previous response's `next_cursor` to fetch the next page (M-25)."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": AGENDA_RESULT_CAP,
                    "description": format!("Max entries per response (capped at {AGENDA_RESULT_CAP})."),
                },
            },
        }),
    }
}

fn tool_desc_journal_for_date() -> ToolDescription {
    ToolDescription {
        name: TOOL_JOURNAL_FOR_DATE.to_string(),
        description:
            "Return the journal page for a specific date in the given space, creating it if missing. Idempotent per-space."
                .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["date", "space_id"],
            "properties": {
                "date": { "type": "string", "description": "YYYY-MM-DD date string." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the daily journal belongs to (FEAT-3p5)."
                },
            },
        }),
    }
}

// ---------------------------------------------------------------------------
// Handler implementations
//
// Each handler: (1) parse args, (2) validate `limit` against the schema's
// `[1, cap]` advertised range (L-119), (3) delegate to `*_inner`,
// (4) serialise result to `serde_json::Value`. Errors from `*_inner`
// propagate as `AppError` — the server translates them to JSON-RPC codes
// (`-32001` for `NotFound`, `-32602` for `Validation`/`InvalidOperation`,
// `-32603` otherwise).
// ---------------------------------------------------------------------------

/// Reject `limit` values outside the documented `[1, cap]` range with
/// an [`AppError::Validation`] (L-119). The dispatcher then surfaces
/// it as JSON-RPC `-32602 invalid params` via `app_error_to_jsonrpc`,
/// matching the strict `serde(deny_unknown_fields)` posture used
/// elsewhere on the MCP boundary. Silent clamping previously hid
/// out-of-range typos and let agents request pages that quietly
/// exceeded the documented cap. Returns the value unchanged so the
/// caller can pass it straight through to `*_inner`.
fn validate_limit(tool: &str, limit: Option<i64>, cap: i64) -> Result<Option<i64>, AppError> {
    if let Some(l) = limit {
        if !(1..=cap).contains(&l) {
            return Err(AppError::Validation(format!(
                "{tool}: limit must be in [1, {cap}], got {l}"
            )));
        }
    }
    Ok(limit)
}

async fn handle_list_pages(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListPagesArgs = parse_args(TOOL_LIST_PAGES, args)?;
    let limit = validate_limit(TOOL_LIST_PAGES, args.limit, LIST_RESULT_CAP)?;
    let resp = list_pages_inner(pool, args.cursor, limit).await?;
    to_tool_result(&resp)
}

async fn handle_get_page(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: GetPageArgs = parse_args(TOOL_GET_PAGE, args)?;
    let limit = validate_limit(TOOL_GET_PAGE, args.limit, LIST_RESULT_CAP)?;
    // L-121: normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let page_id = normalize_ulid_arg(&args.page_id);
    // MAINT-150 (g): the FEAT-3 Phase 7 space-membership lookup lives
    // inside `get_page_unscoped_inner` so this module stays a thin
    // wrapper around `*_inner`. MCP agents are intentionally unscoped
    // — every page they can name belongs to its own space by
    // construction, and the helper preserves the
    // unknown-id / wrong-type / unscoped error categories.
    let resp = get_page_unscoped_inner(pool, &page_id, args.cursor, limit).await?;
    to_tool_result(&resp)
}

async fn handle_search(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: SearchArgs = parse_args(TOOL_SEARCH, args)?;
    // L-119: reject out-of-range explicitly; default to SEARCH_RESULT_CAP
    // when the caller omits `limit` so PageRequest::new does not fall
    // back to MAX_PAGE_SIZE=200.
    let validated = validate_limit(TOOL_SEARCH, args.limit, SEARCH_RESULT_CAP)?;
    let limit = Some(validated.unwrap_or(SEARCH_RESULT_CAP));
    // L-121: normalise ULID-shaped IDs (parent + each tag) at the MCP boundary.
    let parent_id = args.parent_id.as_deref().map(normalize_ulid_arg);
    let tag_ids = args
        .tag_ids
        .map(|v| v.iter().map(|s| normalize_ulid_arg(s)).collect());
    let mut resp = search_blocks_inner(
        pool,
        args.query,
        args.cursor,
        limit,
        parent_id,
        tag_ids,
        None, // FEAT-3 Phase 2: MCP agents see every space — unscoped.
    )
    .await?;
    // Truncate each result's content to SEARCH_SNIPPET_CAP chars. We
    // truncate at char boundaries (not byte boundaries) so the output is
    // always valid UTF-8 even when the content contains multi-byte
    // characters (e.g. CJK, emoji).
    for row in resp.items.iter_mut() {
        if let Some(ref c) = row.content {
            if c.chars().count() > SEARCH_SNIPPET_CAP {
                let truncated: String = c.chars().take(SEARCH_SNIPPET_CAP).collect();
                row.content = Some(truncated);
            }
        }
    }
    to_tool_result(&resp)
}

async fn handle_get_block(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: GetBlockArgs = parse_args(TOOL_GET_BLOCK, args)?;
    // L-121: normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let block_id = normalize_ulid_arg(&args.block_id);
    let resp = get_block_inner(pool, block_id).await?;
    to_tool_result(&resp)
}

async fn handle_list_backlinks(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListBacklinksArgs = parse_args(TOOL_LIST_BACKLINKS, args)?;
    let limit = validate_limit(TOOL_LIST_BACKLINKS, args.limit, LIST_RESULT_CAP)?;
    // L-121: normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let block_id = normalize_ulid_arg(&args.block_id);
    let resp = list_backlinks_grouped_inner(pool, block_id, None, None, args.cursor, limit).await?;
    to_tool_result(&resp)
}

async fn handle_list_tags(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListTagsArgs = parse_args(TOOL_LIST_TAGS, args)?;
    let limit = validate_limit(TOOL_LIST_TAGS, args.limit, LIST_RESULT_CAP)?;
    let resp = list_tags_inner(pool, limit).await?;
    to_tool_result(&resp)
}

async fn handle_list_property_defs(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    // Validate the arg object even though it is always empty — catches
    // typos like `{"prefix": "foo"}` and surfaces them as -32602.
    let _: ListPropertyDefsArgs = parse_args(TOOL_LIST_PROPERTY_DEFS, args)?;
    let resp = list_property_defs_inner(pool).await?;
    to_tool_result(&resp)
}

async fn handle_get_agenda(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: GetAgendaArgs = parse_args(TOOL_GET_AGENDA, args)?;
    let limit = validate_limit(TOOL_GET_AGENDA, args.limit, AGENDA_RESULT_CAP)?;
    let resp =
        list_projected_agenda_inner(pool, args.start_date, args.end_date, args.cursor, limit)
            .await?;
    to_tool_result(&resp)
}

/// Handle the `journal_for_date` MCP tool call.
///
/// **M-84 — RO tool with a write side-effect.** Despite living on the
/// read-only [`ReadOnlyTools`] registry, this handler may emit a single
/// `CreateBlock` op (origin `agent:<name>`) when the requested date
/// has no existing journal page in the given space. The op lands in
/// `op_log` via [`journal_for_date_inner`] → `create_block_inner` and
/// is reversible from the agent activity feed like any other
/// agent-authored write. The first call for a given (space, date)
/// pair therefore mutates state; subsequent calls for the same pair
/// are pure lookups (idempotent per-space). See the M-82/M-84 block
/// on [`ReadOnlyTools`] for the rationale and for why this is wired
/// to the writer pool instead of the reader pool.
async fn handle_journal_for_date(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: JournalForDateArgs = parse_args(TOOL_JOURNAL_FOR_DATE, args)?;
    let date = chrono::NaiveDate::parse_from_str(&args.date, "%Y-%m-%d").map_err(|e| {
        AppError::Validation(format!(
            "tool `{TOOL_JOURNAL_FOR_DATE}`: `date` must be YYYY-MM-DD — {e}"
        ))
    })?;
    let resp = journal_for_date_inner(pool, device_id, materializer, date, &args.space_id).await?;
    to_tool_result(&resp)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// M-82 tests — split-pool semantics for `journal_for_date`
//
// These tests exercise the production wiring that `mk_tools()` deliberately
// does not: separate reader (`PRAGMA query_only = ON`) and writer pools,
// just like `init_pools()`. The bug fixed by M-82 was that `ReadOnlyTools`
// was constructed with the reader pool only, so the very first
// `journal_for_date` call for a missing date hit `BEGIN IMMEDIATE` + INSERT
// against `query_only = ON` and surfaced as JSON-RPC `-32603`.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests_m82 {
    use super::*;
    use crate::commands::{create_page_in_space_inner, create_space_inner};
    use crate::db::init_pools;
    use crate::materializer::Materializer;
    use crate::mcp::actor::{Actor, ActorContext};
    use serde_json::json;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const DEV: &str = "test-mcp-dev-m82";

    fn test_ctx() -> ActorContext {
        ActorContext {
            actor: Actor::Agent {
                name: "test-agent-m82".to_string(),
            },
            request_id: "req-test-m82".to_string(),
        }
    }

    /// FEAT-3p5 helper for the M-82 split-pool fixture: create a single
    /// space on the *writer* pool (the reader pool is `query_only = ON`
    /// and would reject the CreateBlock op).
    async fn mk_space(write_pool: &SqlitePool, name: &str) -> String {
        let materializer = Materializer::new(write_pool.clone());
        create_space_inner(write_pool, DEV, &materializer, name.into(), None)
            .await
            .expect("create_space must succeed")
            .into_string()
    }

    /// Build production-style split pools — a reader pool with
    /// `PRAGMA query_only = ON` and a writer pool without — so the
    /// resulting `ReadOnlyTools` mirrors the way `lib.rs` wires the
    /// real MCP RO server.
    async fn mk_split_tools() -> (ReadOnlyTools, Materializer, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("m82.db");
        let pools = init_pools(&db_path).await.unwrap();
        // Materializer uses the writer pool internally — same wiring as
        // production (`lib.rs` builds it from `pools.write` / `pools.read`).
        let mat = Materializer::with_read_pool(pools.write.clone(), pools.read.clone());
        let tools = ReadOnlyTools::new(
            pools.read.clone(),
            pools.write.clone(),
            mat.clone(),
            DEV.to_string(),
        );
        (tools, mat, dir)
    }

    /// Reproduction of the M-82 production failure: with the old wiring
    /// (`pool` = reader-only) the very first `journal_for_date` call for
    /// a missing date opens `BEGIN IMMEDIATE` and INSERTs into `op_log`
    /// + `blocks`, which `query_only = ON` rejects as `SQLITE_READONLY`
    /// and surfaces as JSON-RPC `-32603`. With the writer pool wired in
    /// the create branch succeeds and we get back a freshly minted
    /// journal page.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn journal_for_date_uses_writer_pool_for_missing_date() {
        let (tools, _mat, _dir) = mk_split_tools().await;
        // FEAT-3p5: seed a space on the writer pool so the lookup has
        // somewhere to scope under.
        let space = mk_space(&tools.writer_pool, "Personal").await;

        // No journal page exists for this date — the call must hit the
        // create branch, which is the path that previously failed on the
        // query_only=ON reader pool.
        let result = tools
            .call_tool(
                "journal_for_date",
                json!({"date": "2025-09-09", "space_id": space}),
                &test_ctx(),
            )
            .await;

        let value = result.expect("journal_for_date must succeed for a missing date when wired with the writer pool — pre-M-82 this surfaced SQLITE_READONLY as JSON-RPC -32603");

        // Verify the response shape matches a fresh journal page (a
        // `page` block whose `content` is the requested date).
        assert_eq!(
            value.get("block_type").and_then(|v| v.as_str()),
            Some("page"),
            "expected a fresh `page` block, got {value:?}",
        );
        assert_eq!(
            value.get("content").and_then(|v| v.as_str()),
            Some("2025-09-09"),
            "expected `content` == requested date, got {value:?}",
        );
    }

    /// Sanity check that the lookup branch of `journal_for_date` works
    /// across pool wirings: idempotency on a date that already has a
    /// page must succeed whether the registry is wired with the
    /// production split (reader pool + writer pool, M-82 fix) or the
    /// legacy combined `init_pool` wiring used by the in-tree test
    /// fixture (`mk_tools()`). The lookup-then-return path inside
    /// `journal_for_date_inner` uses `BEGIN IMMEDIATE` to keep the
    /// SELECT-then-INSERT pair atomic against concurrent callers; the
    /// transaction commits without inserting when the page exists, so
    /// any pool that can acquire the writer lock is sufficient. With
    /// the M-82 fix applied, both wirings use the writer pool for this
    /// path and resolve to the same `BlockRow.id`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn journal_for_date_finds_existing_page_via_either_pool() {
        // ── Wiring A — production split via init_pools() ──────────────
        let (tools_split, mat_split, _dir_split) = mk_split_tools().await;
        let space_split = mk_space(&tools_split.writer_pool, "Personal").await;
        let date = "2025-09-10";

        // First call creates the page via the writer pool.
        let first = tools_split
            .call_tool(
                "journal_for_date",
                json!({"date": date, "space_id": space_split}),
                &test_ctx(),
            )
            .await
            .expect("first journal_for_date call must succeed (creates the page)");
        let first_id = first
            .get("id")
            .and_then(|v| v.as_str())
            .expect("response must include an `id`")
            .to_string();
        mat_split.flush_background().await.unwrap();

        // Second call finds the same page via the lookup branch — no
        // INSERT runs, the BEGIN IMMEDIATE transaction commits empty.
        let second = tools_split
            .call_tool(
                "journal_for_date",
                json!({"date": date, "space_id": space_split}),
                &test_ctx(),
            )
            .await
            .expect(
                "lookup branch must succeed on the production split wiring when the page exists",
            );
        assert_eq!(
            second.get("id").and_then(|v| v.as_str()),
            Some(first_id.as_str()),
            "idempotent call must return the same page id under split wiring",
        );

        // ── Wiring B — legacy combined-pool wiring (init_pool) ─────────
        // Mirrors the in-tree `mk_tools()` fixture: a single pool wired
        // into both slots. Pre-create the page (with its space property)
        // via the same pool so the subsequent `call_tool` exercises the
        // lookup branch.
        let combined_dir = TempDir::new().unwrap();
        let combined_path = combined_dir.path().join("m82-combined.db");
        let combined = crate::db::init_pool(&combined_path).await.unwrap();
        let mat_combined = Materializer::new(combined.clone());
        let space_combined = mk_space(&combined, "Personal").await;
        create_page_in_space_inner(
            &combined,
            DEV,
            &mat_combined,
            None,
            date.into(),
            space_combined.clone(),
        )
        .await
        .unwrap();
        mat_combined.flush_background().await.unwrap();
        let tools_combined =
            ReadOnlyTools::new(combined.clone(), combined, mat_combined, DEV.to_string());

        let combined_resp = tools_combined
            .call_tool(
                "journal_for_date",
                json!({"date": date, "space_id": space_combined}),
                &test_ctx(),
            )
            .await
            .expect("lookup branch must succeed on the combined-pool wiring when the page exists");
        assert_eq!(
            combined_resp.get("block_type").and_then(|v| v.as_str()),
            Some("page"),
            "lookup must return a `page` block under combined wiring",
        );
        assert_eq!(
            combined_resp.get("content").and_then(|v| v.as_str()),
            Some(date),
            "lookup must return the page whose content matches the requested date",
        );
    }
}
