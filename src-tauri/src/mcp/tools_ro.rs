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
//! | `journal_for_date` | [`journal_for_date_inner`](crate::commands::journal_for_date_inner) | Idempotent date → page lookup. |
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
use super::handler_utils::{parse_args, to_tool_result};
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
    // MAINT-150 (g): the FEAT-3 Phase 7 space-membership lookup lives
    // inside `get_page_unscoped_inner` so this module stays a thin
    // wrapper around `*_inner`. MCP agents are intentionally unscoped
    // — every page they can name belongs to its own space by
    // construction, and the helper preserves the
    // unknown-id / wrong-type / unscoped error categories.
    let resp = get_page_unscoped_inner(pool, &args.page_id, args.cursor, limit).await?;
    to_tool_result(&resp)
}

async fn handle_search(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: SearchArgs = parse_args(TOOL_SEARCH, args)?;
    // L-119: reject out-of-range explicitly; default to SEARCH_RESULT_CAP
    // when the caller omits `limit` so PageRequest::new does not fall
    // back to MAX_PAGE_SIZE=200.
    let validated = validate_limit(TOOL_SEARCH, args.limit, SEARCH_RESULT_CAP)?;
    let limit = Some(validated.unwrap_or(SEARCH_RESULT_CAP));
    let mut resp = search_blocks_inner(
        pool,
        args.query,
        args.cursor,
        limit,
        args.parent_id,
        args.tag_ids,
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
    let resp = get_block_inner(pool, args.block_id).await?;
    to_tool_result(&resp)
}

async fn handle_list_backlinks(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListBacklinksArgs = parse_args(TOOL_LIST_BACKLINKS, args)?;
    let limit = validate_limit(TOOL_LIST_BACKLINKS, args.limit, LIST_RESULT_CAP)?;
    let resp =
        list_backlinks_grouped_inner(pool, args.block_id, None, None, args.cursor, limit).await?;
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
    let resp = list_projected_agenda_inner(pool, args.start_date, args.end_date, limit).await?;
    to_tool_result(&resp)
}

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
mod tests {
    use super::*;
    use crate::commands::{create_block_inner, create_space_inner};
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use crate::mcp::actor::Actor;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tempfile::TempDir;

    const DEV: &str = "test-mcp-dev";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// FEAT-3p5: create a single space and return its ULID. Used by the
    /// journal_for_date MCP tests so the per-space lookup has a valid
    /// space to scope under.
    async fn mk_space(pool: &SqlitePool, name: &str) -> String {
        let materializer = Materializer::new(pool.clone());
        create_space_inner(pool, DEV, &materializer, name.into(), None)
            .await
            .expect("create_space must succeed")
            .into_string()
    }

    fn test_ctx() -> ActorContext {
        ActorContext {
            actor: Actor::Agent {
                name: "test-agent".to_string(),
            },
            request_id: "req-test".to_string(),
        }
    }

    async fn mk_tools() -> (ReadOnlyTools, Materializer, TempDir) {
        let (pool, dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        // M-82: `init_pool` returns a single combined pool, so reuse it
        // for both the reader and writer slots in this fixture. The
        // production wiring uses split `init_pools` semantics; the
        // dedicated `tests_m82` block below exercises that path.
        let tools = ReadOnlyTools::new(pool.clone(), pool, mat.clone(), DEV.to_string());
        (tools, mat, dir)
    }

    async fn settle(mat: &Materializer) {
        mat.flush_background().await.unwrap();
    }

    // -------------------------------------------------------------------
    // list_tools — snapshot of the 9-tool wire contract
    // -------------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_tools_advertises_nine_tools() {
        let (tools, _mat, _dir) = mk_tools().await;
        let descs = tools.list_tools();
        let names: Vec<&str> = descs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names.len(),
            9,
            "ReadOnlyTools exposes exactly nine v1 tools"
        );
        assert_eq!(
            names,
            vec![
                "list_pages",
                "get_page",
                "search",
                "get_block",
                "list_backlinks",
                "list_tags",
                "list_property_defs",
                "get_agenda",
                "journal_for_date",
            ],
            "tool order is part of the wire contract — do not re-order",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_tool_descriptions() {
        // Snapshot the full list_tools() response — any accidental change
        // to names / descriptions / input schemas will break CI.
        let (tools, _mat, _dir) = mk_tools().await;
        let descs = tools.list_tools();
        // Use `to_value` so camelCase `inputSchema` is visible in the snap.
        let wire: Value = serde_json::to_value(&descs).unwrap();
        insta::assert_yaml_snapshot!("tool_descriptions", wire);
    }

    // -------------------------------------------------------------------
    // MAINT-150 (d) PARTIAL — schema/struct equivalence
    //
    // The full fix would derive `JsonSchema` via `schemars` on each
    // `*Args` struct so the tool description's `inputSchema` is
    // auto-generated, eliminating drift. That is a meaningful design
    // change requiring user approval (extra dependency + a re-derive on
    // every `*Args` struct), so it is DEFERRED.
    //
    // As a partial / starting point, the following tests pin the link
    // between the hand-authored `json!` schema and the typed `*Args`
    // struct for two representative tools (one trivial, one with
    // multiple optional fields). Drift between schema and struct will
    // fail one of these asserts:
    //
    //   - The struct must successfully `serde_json::from_value` a
    //     payload built from the schema's `required` list.
    //   - Every property advertised in the schema's `properties` must
    //     deserialise into the struct without an `unknown_fields`
    //     rejection (the structs use `deny_unknown_fields`).
    //
    // The asserts below cover `list_pages` (no required fields, two
    // optional) and `get_block` (one required field, no optional). When
    // schemars lands these can be removed in favour of the
    // auto-generated schema.
    // -------------------------------------------------------------------
    #[test]
    fn list_pages_schema_matches_args_struct() {
        let desc = tool_desc_list_pages();
        let schema = &desc.input_schema;
        let props = schema
            .get("properties")
            .and_then(|p| p.as_object())
            .expect("inputSchema has properties object");
        let prop_names: Vec<&str> = props.keys().map(String::as_str).collect();

        // Every property advertised in the schema must round-trip
        // through `ListPagesArgs` without `deny_unknown_fields` firing.
        // The schema has no required fields — an empty object must
        // deserialize cleanly (no required-field rejection).
        let empty: ListPagesArgs = serde_json::from_value(json!({}))
            .expect("ListPagesArgs accepts an empty object (all fields optional)");
        let _ = empty;

        // Build a concrete payload using every property the schema
        // advertises. If the struct lacks one of these fields, this
        // would parse but lose data; if the struct has additional
        // fields, those would be required (currently they are all
        // `Option<T>` with `#[serde(default)]`, so this stays valid).
        let mut payload = serde_json::Map::new();
        for &name in &prop_names {
            // Pick a value-shape that matches the schema's declared
            // type. Both fields here are typed (`string` and
            // `integer`); extending the test would need a small type
            // mapper.
            let ty = props[name]["type"].as_str().expect("each prop has a type");
            let value = match ty {
                "string" => json!("placeholder"),
                "integer" => json!(1),
                other => panic!("list_pages schema grew an unexpected type: {other}"),
            };
            payload.insert(name.to_string(), value);
        }
        let parsed: ListPagesArgs = serde_json::from_value(Value::Object(payload))
            .expect("ListPagesArgs accepts every property the schema advertises");
        assert_eq!(parsed.cursor.as_deref(), Some("placeholder"));
        assert_eq!(parsed.limit, Some(1));

        // The schema must not advertise `additionalProperties: true`
        // (struct uses `deny_unknown_fields`) — pin that here so a
        // future schema edit cannot silently drift.
        assert_eq!(
            schema.get("additionalProperties"),
            Some(&Value::Bool(false)),
            "list_pages schema must mirror `deny_unknown_fields` with additionalProperties: false",
        );
    }

    #[test]
    fn get_block_schema_matches_args_struct() {
        let desc = tool_desc_get_block();
        let schema = &desc.input_schema;
        let required: Vec<&str> = schema
            .get("required")
            .and_then(|r| r.as_array())
            .expect("get_block inputSchema declares required[]")
            .iter()
            .map(|v| v.as_str().expect("required entries are strings"))
            .collect();
        assert_eq!(
            required,
            vec!["block_id"],
            "get_block schema requires exactly the `block_id` field",
        );

        // A payload that omits `block_id` must fail deserialization
        // (the struct field is non-optional).
        let missing: Result<GetBlockArgs, _> = serde_json::from_value(json!({}));
        assert!(
            missing.is_err(),
            "GetBlockArgs must reject an empty object — required field missing",
        );

        // A payload that includes `block_id` deserializes cleanly.
        let parsed: GetBlockArgs = serde_json::from_value(json!({"block_id": "abc"}))
            .expect("GetBlockArgs accepts a payload with block_id");
        assert_eq!(parsed.block_id, "abc");

        // A payload with an unknown property must be rejected by
        // `deny_unknown_fields` — pinning the schema/struct contract
        // even when the schema's `additionalProperties: false` is the
        // wire contract.
        let stray: Result<GetBlockArgs, _> =
            serde_json::from_value(json!({"block_id": "abc", "extra": 1}));
        assert!(
            stray.is_err(),
            "GetBlockArgs must reject unknown fields (deny_unknown_fields)",
        );
        assert_eq!(
            schema.get("additionalProperties"),
            Some(&Value::Bool(false)),
            "get_block schema must mirror `deny_unknown_fields` with additionalProperties: false",
        );
    }

    // -------------------------------------------------------------------
    // Happy + error path per tool (9 × 2 = 18 tests)
    // -------------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_pages_happy_path_returns_pages_only() {
        let (tools, mat, _dir) = mk_tools().await;
        // Create 3 pages + 1 non-page block — list_pages must ignore the
        // non-page block.
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            "P1".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            "P2".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            "P3".into(),
            None,
            Some(3),
        )
        .await
        .unwrap();
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            "x".into(),
            None,
            Some(4),
        )
        .await
        .unwrap();
        settle(&mat).await;

        let result = tools
            .call_tool("list_pages", json!({}), &test_ctx())
            .await
            .expect("happy path");
        let items = result["items"].as_array().expect("items array");
        assert_eq!(items.len(), 3, "list_pages returns exactly the three pages");
        for item in items {
            assert_eq!(item["block_type"], "page");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_pages_rejects_unknown_field() {
        let (tools, _mat, _dir) = mk_tools().await;
        let err = tools
            .call_tool("list_pages", json!({"bogus": 1}), &test_ctx())
            .await
            .expect_err("must reject unknown field");
        assert!(
            matches!(err, AppError::Validation(_)),
            "unknown-field must surface as AppError::Validation (→ -32602), got {err:?}",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_page_happy_path_returns_subtree() {
        let (tools, mat, _dir) = mk_tools().await;
        let page = create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            "P".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        let child1 = create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            "c1".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        let _grandchild = create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            "g1".into(),
            Some(child1.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;
        // FEAT-3 Phase 7 — MCP `handle_get_page` looks up the page's own
        // `space` property and threads it through `get_page_inner`. Run
        // bootstrap so the page lands in Personal via the back-fill sweep.
        crate::spaces::bootstrap_spaces(&tools.pool, DEV)
            .await
            .unwrap();

        let result = tools
            .call_tool("get_page", json!({"page_id": page.id.clone()}), &test_ctx())
            .await
            .expect("happy path");
        assert_eq!(result["page"]["id"], page.id);
        let children = result["children"].as_array().expect("children array");
        assert_eq!(
            children.len(),
            2,
            "get_page returns full subtree (child + grandchild), not just direct children",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_page_not_found_returns_not_found() {
        let (tools, _mat, _dir) = mk_tools().await;
        let err = tools
            .call_tool(
                "get_page",
                json!({"page_id": "NONEXISTENT_ULID_01HZ"}),
                &test_ctx(),
            )
            .await
            .expect_err("unknown page must error");
        assert!(
            matches!(err, AppError::NotFound(_)),
            "missing page must surface as AppError::NotFound (→ -32001), got {err:?}",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_page_on_non_page_block_validation_error() {
        let (tools, mat, _dir) = mk_tools().await;
        let page = create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            "P".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        let content = create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            "c".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;

        let err = tools
            .call_tool("get_page", json!({"page_id": content.id}), &test_ctx())
            .await
            .expect_err("non-page block must error");
        assert!(
            matches!(err, AppError::Validation(_)),
            "non-page must surface as Validation (→ -32602), got {err:?}",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_happy_path_returns_matches() {
        let (tools, mat, _dir) = mk_tools().await;
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            "needle in the haystack".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            "just hay".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        settle(&mat).await;

        let result = tools
            .call_tool("search", json!({"query": "needle"}), &test_ctx())
            .await
            .expect("happy path");
        let items = result["items"].as_array().expect("items");
        assert_eq!(items.len(), 1, "exactly one hit for 'needle'");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_missing_query_returns_validation() {
        let (tools, _mat, _dir) = mk_tools().await;
        let err = tools
            .call_tool("search", json!({}), &test_ctx())
            .await
            .expect_err("missing query must fail");
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
    }

    // -------------------------------------------------------------------
    // L-119: explicit `limit` validation (rejects out-of-range values
    // instead of silently clamping). Six tools advertise a min/max in
    // their input schema; cover them parametrically.
    // -------------------------------------------------------------------

    /// Parametric expectations for every tool that gates `limit`
    /// against an advertised `[1, cap]` range. `base_args` carries the
    /// rest of each tool's required fields; the test merges a
    /// `"limit"` field in.
    fn limit_validation_cases() -> Vec<(&'static str, i64, Value)> {
        vec![
            (TOOL_LIST_PAGES, LIST_RESULT_CAP, json!({})),
            // page_id need not exist — `validate_limit` runs before
            // the inner lookup, so out-of-range cases fire before any
            // NotFound is possible.
            (TOOL_GET_PAGE, LIST_RESULT_CAP, json!({"page_id": "ANY"})),
            (TOOL_SEARCH, SEARCH_RESULT_CAP, json!({"query": "needle"})),
            (
                TOOL_LIST_BACKLINKS,
                LIST_RESULT_CAP,
                json!({"block_id": "ANY"}),
            ),
            (TOOL_LIST_TAGS, LIST_RESULT_CAP, json!({})),
            (
                TOOL_GET_AGENDA,
                AGENDA_RESULT_CAP,
                json!({"start_date": "2025-01-01", "end_date": "2025-01-02"}),
            ),
        ]
    }

    fn args_with_limit(base: &Value, limit: i64) -> Value {
        let mut obj = base.as_object().expect("base_args is an object").clone();
        obj.insert("limit".into(), json!(limit));
        Value::Object(obj)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn limit_validation_rejects_zero_and_above_cap() {
        let (tools, _mat, _dir) = mk_tools().await;
        for (tool, cap, base_args) in limit_validation_cases() {
            for bad in [0i64, cap + 1] {
                let args = args_with_limit(&base_args, bad);
                let result = tools.call_tool(tool, args, &test_ctx()).await;
                match result {
                    Err(AppError::Validation(msg)) => {
                        assert!(
                            msg.contains(tool),
                            "{tool}: error message must name the tool — got {msg:?}",
                        );
                        assert!(
                            msg.contains(&cap.to_string()),
                            "{tool}: error message must name the cap {cap} — got {msg:?}",
                        );
                        assert!(
                            msg.contains(&bad.to_string()),
                            "{tool}: error message must echo the offending value {bad} — got {msg:?}",
                        );
                    }
                    other => panic!(
                        "{tool}: limit={bad} (cap={cap}) must return AppError::Validation, got {other:?}",
                    ),
                }
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn limit_validation_accepts_boundary() {
        let (tools, _mat, _dir) = mk_tools().await;
        for (tool, cap, base_args) in limit_validation_cases() {
            let args = args_with_limit(&base_args, cap);
            let result = tools.call_tool(tool, args, &test_ctx()).await;
            // Boundary value must NOT trip the L-119 validation. The
            // inner handler may still legitimately surface another
            // error (e.g. NotFound when `page_id`/`block_id` is a
            // placeholder, or a different Validation for an invalid
            // ULID) — only the L-119 message pattern is the regression
            // signal here.
            if let Err(AppError::Validation(msg)) = &result {
                assert!(
                    !msg.contains("limit must be in"),
                    "{tool}: limit={cap} (boundary) tripped L-119 validation: {msg}",
                );
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_truncates_long_content() {
        let (tools, mat, _dir) = mk_tools().await;
        let long: String = "needle ".to_string() + &"x".repeat(2000);
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            long,
            None,
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;

        let result = tools
            .call_tool("search", json!({"query": "needle"}), &test_ctx())
            .await
            .expect("happy path");
        let items = result["items"].as_array().expect("items");
        assert_eq!(items.len(), 1);
        let content = items[0]["content"].as_str().unwrap_or("");
        assert!(
            content.chars().count() <= SEARCH_SNIPPET_CAP,
            "content must be truncated to {} chars, got {}",
            SEARCH_SNIPPET_CAP,
            content.chars().count(),
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_block_happy_path() {
        let (tools, mat, _dir) = mk_tools().await;
        let blk = create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            "hello".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;

        let result = tools
            .call_tool(
                "get_block",
                json!({"block_id": blk.id.clone()}),
                &test_ctx(),
            )
            .await
            .expect("happy path");
        assert_eq!(result["id"], blk.id);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_block_not_found_error() {
        let (tools, _mat, _dir) = mk_tools().await;
        let err = tools
            .call_tool(
                "get_block",
                json!({"block_id": "NONEXISTENT_ID"}),
                &test_ctx(),
            )
            .await
            .expect_err("unknown block must error");
        assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_backlinks_happy_path() {
        let (tools, mat, _dir) = mk_tools().await;
        let target = create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            "Target".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;

        // No sources yet → empty grouped response, not an error.
        let result = tools
            .call_tool(
                "list_backlinks",
                json!({"block_id": target.id}),
                &test_ctx(),
            )
            .await
            .expect("happy path");
        // `list_backlinks_grouped_inner` returns a GroupedBacklinkResponse
        // shaped `{ groups: [], next_cursor, has_more, total_count, ... }`.
        // Just assert the envelope exists.
        assert!(result.is_object(), "response is a JSON object");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_backlinks_missing_block_id_validation() {
        let (tools, _mat, _dir) = mk_tools().await;
        let err = tools
            .call_tool("list_backlinks", json!({}), &test_ctx())
            .await
            .expect_err("missing block_id");
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_tags_happy_path() {
        let (tools, mat, _dir) = mk_tools().await;
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "tag".into(),
            "work".into(),
            None,
            None,
        )
        .await
        .unwrap();
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "tag".into(),
            "home".into(),
            None,
            None,
        )
        .await
        .unwrap();
        settle(&mat).await;

        let result = tools
            .call_tool("list_tags", json!({}), &test_ctx())
            .await
            .expect("happy path");
        let arr = result.as_array().expect("tag array");
        assert_eq!(arr.len(), 2, "two tags returned");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_tags_rejects_unknown_field() {
        let (tools, _mat, _dir) = mk_tools().await;
        let err = tools
            .call_tool("list_tags", json!({"prefix": "w"}), &test_ctx())
            .await
            .expect_err("prefix is not a valid arg for list_tags");
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_property_defs_happy_path() {
        // L-115: a fresh DB ships built-in property definitions seeded by
        // migrations. The exact wire shape is snapshot-locked by
        // `tool_response_list_property_defs.snap`; this test just pins
        // (a) a stable subset of must-be-present keys (the four reserved
        // keys named in AGENTS.md "Architectural Stability — properties
        // system", which any future migration must preserve), and
        // (b) cross-checks the response count against the live
        // `property_definitions` table so adding/removing seeded defs
        // does not silently desync this assertion from reality.
        let (tools, _mat, _dir) = mk_tools().await;
        let result = tools
            .call_tool("list_property_defs", json!({}), &test_ctx())
            .await
            .expect("happy path");
        let arr = result.as_array().expect("defs array");

        // (a) Stable subset — these four are the reserved-column keys
        //     enumerated by `op::is_reserved_property_key` and must
        //     ship in every Agaric build (they back columns on the
        //     `blocks` table directly).
        let actual_keys: std::collections::HashSet<&str> = arr
            .iter()
            .map(|v| v["key"].as_str().expect("each def has a 'key' string"))
            .collect();
        for required in ["todo_state", "priority", "due_date", "scheduled_date"] {
            assert!(
                actual_keys.contains(required),
                "required reserved-property key {required:?} missing from list_property_defs; \
                 got {actual_keys:?}",
            );
        }

        // (b) Cross-check against the live DB so this test detects
        //     drift in either direction (added or removed migrations)
        //     without requiring a hand-edited count constant.
        let live_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM property_definitions")
            .fetch_one(&tools.pool)
            .await
            .expect("count property_definitions");
        assert_eq!(
            arr.len() as i64,
            live_count,
            "list_property_defs response count must match live property_definitions row count",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_property_defs_rejects_unknown_field() {
        let (tools, _mat, _dir) = mk_tools().await;
        let err = tools
            .call_tool("list_property_defs", json!({"key": "x"}), &test_ctx())
            .await
            .expect_err("any arg is an error");
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_agenda_happy_path() {
        let (tools, _mat, _dir) = mk_tools().await;
        let result = tools
            .call_tool(
                "get_agenda",
                json!({"start_date": "2025-01-01", "end_date": "2025-01-31"}),
                &test_ctx(),
            )
            .await
            .expect("happy path");
        let arr = result.as_array().expect("agenda array");
        assert_eq!(arr.len(), 0, "empty DB has zero agenda entries");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_agenda_invalid_date_returns_validation() {
        let (tools, _mat, _dir) = mk_tools().await;
        let err = tools
            .call_tool(
                "get_agenda",
                json!({"start_date": "not-a-date", "end_date": "2025-01-31"}),
                &test_ctx(),
            )
            .await
            .expect_err("invalid date");
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn journal_for_date_happy_path_creates_page() {
        let (tools, mat, _dir) = mk_tools().await;
        let space = mk_space(&tools.pool, "Personal").await;
        let result = tools
            .call_tool(
                "journal_for_date",
                json!({"date": "2025-06-15", "space_id": space}),
                &test_ctx(),
            )
            .await
            .expect("happy path");
        assert_eq!(result["block_type"], "page");
        assert_eq!(result["content"], "2025-06-15");
        // Second call must return the same page id (idempotent).
        let first_id = result["id"].as_str().expect("id present").to_string();
        settle(&mat).await;
        let again = tools
            .call_tool(
                "journal_for_date",
                json!({"date": "2025-06-15", "space_id": space}),
                &test_ctx(),
            )
            .await
            .expect("second call");
        assert_eq!(
            again["id"].as_str(),
            Some(first_id.as_str()),
            "journal_for_date is idempotent",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn journal_for_date_invalid_date_validation() {
        let (tools, _mat, _dir) = mk_tools().await;
        let space = mk_space(&tools.pool, "Personal").await;
        let err = tools
            .call_tool(
                "journal_for_date",
                json!({"date": "2025-13-99", "space_id": space}),
                &test_ctx(),
            )
            .await
            .expect_err("invalid date");
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
    }

    // -------------------------------------------------------------------
    // Unknown tool name → NotFound (→ -32001)
    // -------------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unknown_tool_returns_not_found() {
        let (tools, _mat, _dir) = mk_tools().await;
        let err = tools
            .call_tool("this_tool_does_not_exist", json!({}), &test_ctx())
            .await
            .expect_err("unknown tool");
        assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
    }

    // -------------------------------------------------------------------
    // Actor scoping — ACTOR task-local must reflect ctx inside call_tool
    // -------------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn call_tool_scopes_actor_even_when_outer_scope_absent() {
        // Direct invocation (no server wrapper) — the registry must scope
        // ACTOR itself so downstream `current_actor()` reads the agent.
        let (tools, _mat, _dir) = mk_tools().await;
        let ctx = ActorContext {
            actor: Actor::Agent {
                name: "scoped-agent".to_string(),
            },
            request_id: "req-scoped".to_string(),
        };
        // Inject a check inside the pool-free handler path by calling
        // list_property_defs (no DB side effects needed for the check,
        // but ACTOR.scope runs in the same task).
        let result = tools.call_tool("list_property_defs", json!({}), &ctx).await;
        let Ok(resp) = result else {
            panic!("list_property_defs must succeed inside scoped call, got {result:?}");
        };
        // Sanity-check the response shape: list_property_defs returns a JSON
        // array of definitions. Confirms the scoped call actually ran the
        // handler (not just returned a default value).
        assert!(
            resp.is_array(),
            "list_property_defs response should be a JSON array, got {resp:?}",
        );
    }

    // -------------------------------------------------------------------
    // Cursor pagination roundtrip
    // -------------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_pages_cursor_pagination_roundtrip() {
        let (tools, mat, _dir) = mk_tools().await;
        // Insert 5 pages; page with limit=2 → page1 (2), page2 (2), page3 (1).
        for i in 0..5 {
            create_block_inner(
                &tools.pool,
                DEV,
                &mat,
                "page".into(),
                format!("P{i}"),
                None,
                Some(i as i64 + 1),
            )
            .await
            .unwrap();
        }
        settle(&mat).await;

        let page1 = tools
            .call_tool("list_pages", json!({"limit": 2}), &test_ctx())
            .await
            .unwrap();
        let items1 = page1["items"].as_array().unwrap();
        assert_eq!(items1.len(), 2);
        assert_eq!(page1["has_more"], true);
        let cursor = page1["next_cursor"].as_str().expect("cursor").to_string();
        let ids1: Vec<&str> = items1.iter().map(|i| i["id"].as_str().unwrap()).collect();

        let page2 = tools
            .call_tool(
                "list_pages",
                json!({"limit": 2, "cursor": cursor}),
                &test_ctx(),
            )
            .await
            .unwrap();
        let items2 = page2["items"].as_array().unwrap();
        assert_eq!(items2.len(), 2);
        let ids2: Vec<&str> = items2.iter().map(|i| i["id"].as_str().unwrap()).collect();
        for id in &ids2 {
            assert!(
                !ids1.contains(id),
                "page2 must not repeat page1 items; found overlap on {id}",
            );
        }
    }

    // -------------------------------------------------------------------
    // Proptest — search tool matches search_blocks_inner directly
    // -------------------------------------------------------------------

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig {
            cases: 32,
            .. proptest::prelude::ProptestConfig::default()
        })]

        #[test]
        fn proptest_search_tool_matches_search_blocks_inner(
            query in "[a-zA-Z]{1,32}",
        ) {
            // fast-check style: run each case in a fresh tokio runtime +
            // fresh DB so state does not leak between iterations.
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap();

            rt.block_on(async {
                let (tools, mat, _dir) = mk_tools().await;
                // Insert a handful of blocks with the query string plus
                // noise. `create_block_inner` trips FTS indexing.
                create_block_inner(
                    &tools.pool, DEV, &mat, "content".into(),
                    format!("exact {query} match"), None, Some(1),
                ).await.unwrap();
                create_block_inner(
                    &tools.pool, DEV, &mat, "content".into(),
                    format!("also {query} here"), None, Some(2),
                ).await.unwrap();
                create_block_inner(
                    &tools.pool, DEV, &mat, "content".into(),
                    "no match".into(), None, Some(3),
                ).await.unwrap();
                settle(&mat).await;

                let via_tool = tools
                    .call_tool("search", json!({"query": query, "limit": 50}), &test_ctx())
                    .await
                    .unwrap();
                let via_inner = search_blocks_inner(
                    &tools.pool,
                    query.clone(),
                    None,
                    Some(SEARCH_RESULT_CAP),
                    None,
                    None,
                    None,
                )
                .await
                .unwrap();

                let tool_ids: Vec<String> = via_tool["items"].as_array().unwrap().iter()
                    .map(|i| i["id"].as_str().unwrap().to_string()).collect();
                let inner_ids: Vec<String> = via_inner.items.iter().map(|b| b.id.clone()).collect();
                assert_eq!(
                    tool_ids, inner_ids,
                    "MCP `search` tool must return the same ids in the same order \
                     as `search_blocks_inner` with equivalent caps",
                );
            });
        }
    }

    // -------------------------------------------------------------------
    // Concurrent-client stress — 8 parallel clients × 3 tools × N iters
    // -------------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_clients_exact_success_count() {
        let (tools, mat, _dir) = mk_tools().await;
        // Seed some data so the tools have something to return.
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            "SeedPage".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            "hello world".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        settle(&mat).await;

        let tools = Arc::new(tools);
        const CLIENTS: usize = 8;
        const ITERS: usize = 10;
        const TOOLS_PER_ITER: usize = 3;

        let mut handles = Vec::new();
        for c in 0..CLIENTS {
            let tools = tools.clone();
            handles.push(tokio::spawn(async move {
                let mut ok = 0usize;
                // Hold onto one sample list_pages response per task so the
                // outer scope can shape-check at least one of the N calls
                // beyond just `is_ok()`.
                let mut last_list_pages: Value = Value::Null;
                for _ in 0..ITERS {
                    let ctx = ActorContext {
                        actor: Actor::Agent {
                            name: format!("stress-{c}"),
                        },
                        request_id: format!("{c}-{ok}"),
                    };
                    let a = tools
                        .call_tool("search", json!({"query": "hello"}), &ctx)
                        .await;
                    let b = tools.call_tool("list_pages", json!({}), &ctx).await;
                    let d = tools
                        .call_tool(
                            "get_agenda",
                            json!({"start_date": "2025-01-01", "end_date": "2025-01-02"}),
                            &ctx,
                        )
                        .await;
                    if let Ok(ref v) = b {
                        last_list_pages = v.clone();
                    }
                    for r in [a, b, d] {
                        assert!(r.is_ok(), "stress call failed: {r:?}");
                        ok += 1;
                    }
                }
                (ok, last_list_pages)
            }));
        }

        let mut total = 0usize;
        let mut samples: Vec<Value> = Vec::new();
        for h in handles {
            let (ok, sample) = h.await.expect("task joined");
            total += ok;
            samples.push(sample);
        }
        assert_eq!(
            total,
            CLIENTS * ITERS * TOOLS_PER_ITER,
            "all {} × {} × {} calls must succeed",
            CLIENTS,
            ITERS,
            TOOLS_PER_ITER,
        );

        // Shape check: at least one of the sampled list_pages responses
        // must be a JSON object exposing the paginated `items` field.
        // Catches handlers that succeed but return wrong-typed JSON under
        // contention (e.g., Null, raw array).
        let sample = samples
            .iter()
            .find(|v| !v.is_null())
            .expect("at least one stress task should have captured a list_pages response");
        assert!(
            sample.get("items").is_some(),
            "list_pages stress response should expose `items` field, got {sample:?}",
        );
    }

    // -------------------------------------------------------------------
    // Happy + error path per *new* *_inner helper (4 × 2 = 8 tests)
    // -------------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inner_list_pages_returns_only_pages() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        create_block_inner(&pool, DEV, &mat, "page".into(), "P1".into(), None, Some(1))
            .await
            .unwrap();
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "c1".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        settle(&mat).await;

        let resp = list_pages_inner(&pool, None, Some(10)).await.unwrap();
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].block_type, "page");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inner_list_pages_rejects_bogus_cursor() {
        let (pool, _dir) = test_pool().await;
        let err = list_pages_inner(&pool, Some("not-a-real-cursor".to_string()), Some(10))
            .await
            .expect_err("invalid cursor");
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inner_get_page_composes_root_and_subtree() {
        use crate::commands::get_page_inner;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let page = create_block_inner(&pool, DEV, &mat, "page".into(), "P".into(), None, Some(1))
            .await
            .unwrap();
        let _c = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "c".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;
        // FEAT-3 Phase 7 — `get_page_inner` enforces space membership.
        // Bootstrap seeds Personal + Work and back-fills any pages missing a
        // `space` property into Personal, which is exactly what we want.
        crate::spaces::bootstrap_spaces(&pool, DEV).await.unwrap();

        let resp = get_page_inner(
            &pool,
            &page.id,
            crate::spaces::SPACE_PERSONAL_ULID,
            None,
            Some(10),
        )
        .await
        .unwrap();
        assert_eq!(resp.page.id, page.id);
        assert_eq!(resp.children.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inner_get_page_unknown_id_not_found() {
        use crate::commands::get_page_inner;

        let (pool, _dir) = test_pool().await;
        // Even with no bootstrap, `get_page_inner` resolves NotFound first
        // (via `get_block_inner`) before reaching the space-membership
        // check, so the error category is unchanged for unknown IDs.
        let err = get_page_inner(
            &pool,
            "NOPE",
            crate::spaces::SPACE_PERSONAL_ULID,
            None,
            Some(10),
        )
        .await
        .expect_err("unknown id");
        assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inner_list_tags_wraps_by_prefix() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        create_block_inner(&pool, DEV, &mat, "tag".into(), "alpha".into(), None, None)
            .await
            .unwrap();
        create_block_inner(&pool, DEV, &mat, "tag".into(), "beta".into(), None, None)
            .await
            .unwrap();
        settle(&mat).await;

        let tags = list_tags_inner(&pool, Some(100)).await.unwrap();
        assert_eq!(tags.len(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inner_list_tags_empty_db() {
        let (pool, _dir) = test_pool().await;
        let tags = list_tags_inner(&pool, Some(100)).await.unwrap();
        assert_eq!(tags.len(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inner_journal_for_date_idempotent() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;
        let date = chrono::NaiveDate::from_ymd_opt(2025, 7, 20).unwrap();
        let first = journal_for_date_inner(&pool, DEV, &mat, date, &space)
            .await
            .unwrap();
        settle(&mat).await;
        let again = journal_for_date_inner(&pool, DEV, &mat, date, &space)
            .await
            .unwrap();
        assert_eq!(
            first.id, again.id,
            "journal_for_date_inner must return the same id for the same date",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inner_journal_for_date_agrees_with_navigate_journal() {
        // Extraction-preservation check: the new helper and the pre-existing
        // `navigate_journal_inner` must return identical results for the
        // same date so the refactor does not drift the behaviour.
        use crate::commands::navigate_journal_inner;
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;
        let date = chrono::NaiveDate::from_ymd_opt(2025, 8, 10).unwrap();
        let via_navigate = navigate_journal_inner(
            &pool,
            DEV,
            &mat,
            date.format("%Y-%m-%d").to_string(),
            &space,
        )
        .await
        .unwrap();
        settle(&mat).await;
        let via_typed = journal_for_date_inner(&pool, DEV, &mat, date, &space)
            .await
            .unwrap();
        assert_eq!(
            via_navigate.id, via_typed.id,
            "typed and string variants must agree on the same date",
        );
    }

    // -------------------------------------------------------------------
    // Snapshot per-tool output shape (9 snapshots)
    //
    // Each snapshot redacts ULIDs / timestamps / cursors — the shape of
    // the response is what is locked in, not the data. Any accidental
    // change to a tool's JSON envelope breaks CI.
    // -------------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_list_pages_response_shape() {
        let (tools, mat, _dir) = mk_tools().await;
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            "Alpha".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;
        let result = tools
            .call_tool("list_pages", json!({}), &test_ctx())
            .await
            .unwrap();
        insta::assert_yaml_snapshot!("tool_response_list_pages", result, {
            ".items[].id" => "[ULID]",
            ".items[].page_id" => "[ULID]",
            ".next_cursor" => "[CURSOR]",
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_get_page_response_shape() {
        let (tools, mat, _dir) = mk_tools().await;
        let page = create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            "Root".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            "child".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;
        // FEAT-3 Phase 7 — bootstrap so the page lands in Personal via the
        // back-fill sweep; otherwise `handle_get_page` rejects pages with
        // no `space` property.
        crate::spaces::bootstrap_spaces(&tools.pool, DEV)
            .await
            .unwrap();
        let result = tools
            .call_tool("get_page", json!({"page_id": page.id}), &test_ctx())
            .await
            .unwrap();
        insta::assert_yaml_snapshot!("tool_response_get_page", result, {
            ".page.id" => "[ULID]",
            ".page.page_id" => "[ULID]",
            ".children[].id" => "[ULID]",
            ".children[].parent_id" => "[ULID]",
            ".children[].page_id" => "[ULID]",
            ".next_cursor" => "[CURSOR]",
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_search_response_shape() {
        let (tools, mat, _dir) = mk_tools().await;
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            "findme please".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;
        let result = tools
            .call_tool("search", json!({"query": "findme"}), &test_ctx())
            .await
            .unwrap();
        insta::assert_yaml_snapshot!("tool_response_search", result, {
            ".items[].id" => "[ULID]",
            ".items[].page_id" => "[ULID]",
            ".next_cursor" => "[CURSOR]",
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_get_block_response_shape() {
        let (tools, mat, _dir) = mk_tools().await;
        let blk = create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            "text".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;
        let result = tools
            .call_tool("get_block", json!({"block_id": blk.id}), &test_ctx())
            .await
            .unwrap();
        insta::assert_yaml_snapshot!("tool_response_get_block", result, {
            ".id" => "[ULID]",
            ".page_id" => "[ULID]",
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_list_backlinks_response_shape() {
        let (tools, mat, _dir) = mk_tools().await;
        let target = create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            "Target".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        settle(&mat).await;
        let result = tools
            .call_tool(
                "list_backlinks",
                json!({"block_id": target.id}),
                &test_ctx(),
            )
            .await
            .unwrap();
        insta::assert_yaml_snapshot!("tool_response_list_backlinks", result, {
            ".next_cursor" => "[CURSOR]",
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_list_tags_response_shape() {
        let (tools, mat, _dir) = mk_tools().await;
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "tag".into(),
            "snap-tag".into(),
            None,
            None,
        )
        .await
        .unwrap();
        settle(&mat).await;
        let result = tools
            .call_tool("list_tags", json!({}), &test_ctx())
            .await
            .unwrap();
        insta::assert_yaml_snapshot!("tool_response_list_tags", result, {
            "[].tag_id" => "[ULID]",
            "[].updated_at" => "[TIMESTAMP]",
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_list_property_defs_response_shape() {
        let (tools, _mat, _dir) = mk_tools().await;
        let result = tools
            .call_tool("list_property_defs", json!({}), &test_ctx())
            .await
            .unwrap();
        insta::assert_yaml_snapshot!("tool_response_list_property_defs", result, {
            "[].created_at" => "[TIMESTAMP]",
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_get_agenda_response_shape() {
        let (tools, _mat, _dir) = mk_tools().await;
        let result = tools
            .call_tool(
                "get_agenda",
                json!({"start_date": "2025-01-01", "end_date": "2025-01-07"}),
                &test_ctx(),
            )
            .await
            .unwrap();
        insta::assert_yaml_snapshot!("tool_response_get_agenda", result);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_journal_for_date_response_shape() {
        let (tools, _mat, _dir) = mk_tools().await;
        let space = mk_space(&tools.pool, "Personal").await;
        let result = tools
            .call_tool(
                "journal_for_date",
                json!({"date": "2025-09-09", "space_id": space}),
                &test_ctx(),
            )
            .await
            .unwrap();
        insta::assert_yaml_snapshot!("tool_response_journal_for_date", result, {
            ".id" => "[ULID]",
            ".page_id" => "[ULID]",
        });
    }

    /// FEAT-4h slice 3: RO tools must NOT populate `LAST_APPEND` — they
    /// don't append ops, so the dispatch layer should see `None` and
    /// emit an `ActivityEntry` with `op_ref = None`. Drive `list_pages`
    /// inside an explicit scope and assert the cell is still `None` on
    /// exit.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_pages_does_not_populate_last_append() {
        use crate::task_locals::LAST_APPEND;
        use std::cell::Cell;

        let (tools, _mat, _dir) = mk_tools().await;

        let captured = LAST_APPEND
            .scope(Cell::new(None), async {
                tools
                    .call_tool("list_pages", json!({}), &test_ctx())
                    .await
                    .expect("list_pages ok");
                LAST_APPEND.with(Cell::take)
            })
            .await;

        assert!(
            captured.is_none(),
            "RO tool `list_pages` must not populate LAST_APPEND; got {captured:?}",
        );
    }
}

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
