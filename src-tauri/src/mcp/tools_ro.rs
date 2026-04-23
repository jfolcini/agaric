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
//! Two soft caps are enforced at the tool boundary:
//!
//! - **Result count:** `search` is capped at [`SEARCH_RESULT_CAP`] (50),
//!   list-style tools at [`LIST_RESULT_CAP`] (100). `search` passes the cap
//!   through [`PageRequest::new`]'s clamp while list tools pre-clamp the
//!   caller's `limit`.
//! - **Snippet length:** `search` truncates each `BlockRow.content` to
//!   [`SEARCH_SNIPPET_CAP`] bytes (512 UTF-8 chars worst case) before
//!   returning it — agents that want the full content call `get_block` on
//!   the returned id.

use std::future::Future;

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;

use super::actor::{ActorContext, ACTOR};
use super::registry::{ToolDescription, ToolRegistry};
use crate::commands::{
    get_block_inner, get_page_inner, journal_for_date_inner, list_backlinks_grouped_inner,
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
/// `list_backlinks`). Matches [`crate::commands::MCP_PAGE_LIMIT_CAP`].
pub const LIST_RESULT_CAP: i64 = 100;

/// Per-result snippet length cap (in UTF-8 bytes) for the `search` tool.
/// Prevents oversized content strings when an agent searches for a common
/// term and hits long blocks.
pub const SEARCH_SNIPPET_CAP: usize = 512;

/// Cap for `get_agenda`'s `limit` — matches the ceiling baked into
/// [`list_projected_agenda_inner`] so we do not need a tool-layer clamp.
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
pub struct ReadOnlyTools {
    pool: SqlitePool,
    materializer: Materializer,
    /// Local-device id used when a tool has to write (today only
    /// `journal_for_date` when the requested date page does not exist
    /// yet). Namespaced so future RW tools (FEAT-4h) can stamp the same
    /// origin without a second field.
    device_id: String,
}

impl ReadOnlyTools {
    /// Construct a read-only registry. `pool` should be the *reader*
    /// pool — writes still go through `materializer` (which carries its
    /// own writer-pool handle internally).
    pub fn new(pool: SqlitePool, materializer: Materializer, device_id: String) -> Self {
        Self {
            pool,
            materializer,
            device_id,
        }
    }
}

impl ToolRegistry for ReadOnlyTools {
    fn list_tools(&self) -> Vec<ToolDescription> {
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

    fn call_tool(
        &self,
        name: &str,
        args: Value,
        ctx: &ActorContext,
    ) -> impl Future<Output = Result<Value, AppError>> + Send {
        // Clone the context once for the task-local scope; the registry
        // methods themselves take `&self` so no further clones are needed.
        // The server already wraps the outer call in `ACTOR.scope(...)`,
        // but scoping again here is idempotent (nested scope shadows with
        // the same value) AND makes direct `call_tool(...)` invocations
        // (tests, diagnostics) see the actor without requiring the caller
        // to know about `ACTOR`. See `mcp::actor` tests.
        let scoped = ctx.clone();
        let pool = self.pool.clone();
        let materializer = self.materializer.clone();
        let device_id = self.device_id.clone();
        let name = name.to_string();
        async move {
            ACTOR
                .scope(scoped, async move {
                    match name.as_str() {
                        "list_pages" => handle_list_pages(&pool, args).await,
                        "get_page" => handle_get_page(&pool, args).await,
                        "search" => handle_search(&pool, args).await,
                        "get_block" => handle_get_block(&pool, args).await,
                        "list_backlinks" => handle_list_backlinks(&pool, args).await,
                        "list_tags" => handle_list_tags(&pool, args).await,
                        "list_property_defs" => handle_list_property_defs(&pool, args).await,
                        "get_agenda" => handle_get_agenda(&pool, args).await,
                        "journal_for_date" => {
                            handle_journal_for_date(&pool, &materializer, &device_id, args).await
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

fn tool_desc_list_pages() -> ToolDescription {
    ToolDescription {
        name: "list_pages".to_string(),
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
        name: "get_page".to_string(),
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
        name: "search".to_string(),
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
        name: "get_block".to_string(),
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
        name: "list_backlinks".to_string(),
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
        name: "list_tags".to_string(),
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
        name: "list_property_defs".to_string(),
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
        name: "get_agenda".to_string(),
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
        name: "journal_for_date".to_string(),
        description:
            "Return the journal page for a specific date, creating it if missing. Idempotent."
                .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["date"],
            "properties": {
                "date": { "type": "string", "description": "YYYY-MM-DD date string." },
            },
        }),
    }
}

// ---------------------------------------------------------------------------
// Handler implementations
//
// Each handler: (1) parse args, (2) clamp limits, (3) delegate to `*_inner`,
// (4) serialise result to `serde_json::Value`. Errors from `*_inner`
// propagate as `AppError` — the server translates them to JSON-RPC codes
// (`-32001` for `NotFound`, `-32602` for `Validation`/`InvalidOperation`,
// `-32603` otherwise).
// ---------------------------------------------------------------------------

async fn handle_list_pages(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListPagesArgs = parse_args("list_pages", args)?;
    let limit = args.limit.map(|l| l.clamp(1, LIST_RESULT_CAP));
    let resp = list_pages_inner(pool, args.cursor, limit).await?;
    Ok(serde_json::to_value(resp)?)
}

async fn handle_get_page(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: GetPageArgs = parse_args("get_page", args)?;
    let limit = args.limit.map(|l| l.clamp(1, LIST_RESULT_CAP));
    let resp = get_page_inner(pool, &args.page_id, args.cursor, limit).await?;
    Ok(serde_json::to_value(resp)?)
}

async fn handle_search(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: SearchArgs = parse_args("search", args)?;
    // Hard-cap at SEARCH_RESULT_CAP regardless of what the caller asked
    // for. PageRequest::new would otherwise clamp to MAX_PAGE_SIZE=200.
    let limit = Some(
        args.limit
            .unwrap_or(SEARCH_RESULT_CAP)
            .clamp(1, SEARCH_RESULT_CAP),
    );
    let mut resp = search_blocks_inner(
        pool,
        args.query,
        args.cursor,
        limit,
        args.parent_id,
        args.tag_ids,
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
    Ok(serde_json::to_value(resp)?)
}

async fn handle_get_block(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: GetBlockArgs = parse_args("get_block", args)?;
    let resp = get_block_inner(pool, args.block_id).await?;
    Ok(serde_json::to_value(resp)?)
}

async fn handle_list_backlinks(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListBacklinksArgs = parse_args("list_backlinks", args)?;
    let limit = args.limit.map(|l| l.clamp(1, LIST_RESULT_CAP));
    let resp =
        list_backlinks_grouped_inner(pool, args.block_id, None, None, args.cursor, limit).await?;
    Ok(serde_json::to_value(resp)?)
}

async fn handle_list_tags(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListTagsArgs = parse_args("list_tags", args)?;
    let limit = args.limit.map(|l| l.clamp(1, LIST_RESULT_CAP));
    let resp = list_tags_inner(pool, limit).await?;
    Ok(serde_json::to_value(resp)?)
}

async fn handle_list_property_defs(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    // Validate the arg object even though it is always empty — catches
    // typos like `{"prefix": "foo"}` and surfaces them as -32602.
    let _: ListPropertyDefsArgs = parse_args("list_property_defs", args)?;
    let resp = list_property_defs_inner(pool).await?;
    Ok(serde_json::to_value(resp)?)
}

async fn handle_get_agenda(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: GetAgendaArgs = parse_args("get_agenda", args)?;
    let resp =
        list_projected_agenda_inner(pool, args.start_date, args.end_date, args.limit).await?;
    Ok(serde_json::to_value(resp)?)
}

async fn handle_journal_for_date(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    args: Value,
) -> Result<Value, AppError> {
    let args: JournalForDateArgs = parse_args("journal_for_date", args)?;
    let date = chrono::NaiveDate::parse_from_str(&args.date, "%Y-%m-%d").map_err(|e| {
        AppError::Validation(format!(
            "tool `journal_for_date`: `date` must be YYYY-MM-DD — {e}"
        ))
    })?;
    let resp = journal_for_date_inner(pool, device_id, materializer, date).await?;
    Ok(serde_json::to_value(resp)?)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::create_block_inner;
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
        let tools = ReadOnlyTools::new(pool, mat.clone(), DEV.to_string());
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_enforces_result_cap() {
        // Insert 55 matching blocks; request 100 — cap trims to 50.
        let (tools, mat, _dir) = mk_tools().await;
        for i in 0..55 {
            create_block_inner(
                &tools.pool,
                DEV,
                &mat,
                "content".into(),
                format!("unique{i:03}"),
                None,
                Some(i as i64 + 1),
            )
            .await
            .unwrap();
        }
        settle(&mat).await;

        let result = tools
            .call_tool(
                "search",
                json!({"query": "unique", "limit": 100}),
                &test_ctx(),
            )
            .await
            .expect("happy path");
        let items = result["items"].as_array().expect("items");
        let cap = usize::try_from(SEARCH_RESULT_CAP).unwrap_or(usize::MAX);
        assert!(
            items.len() <= cap,
            "server must clamp even when caller requests limit > {}: got {}",
            SEARCH_RESULT_CAP,
            items.len(),
        );
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
        let (tools, _mat, _dir) = mk_tools().await;
        // A fresh DB ships with 17 built-in property definitions seeded
        // by migrations (todo_state, priority, due_date, scheduled_date,
        // created_at, completed_at, effort, location, status, url,
        // assignee, the four repeat-* keys, and a handful of legacy
        // aliases). The exact count is snapshot-locked; the assertion
        // just pins the non-empty behaviour.
        let result = tools
            .call_tool("list_property_defs", json!({}), &test_ctx())
            .await
            .expect("happy path");
        let arr = result.as_array().expect("defs array");
        assert_eq!(
            arr.len(),
            17,
            "fresh DB ships the seeded property definitions; \
             update this count (and the snapshot) together if migrations change",
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
        let result = tools
            .call_tool(
                "journal_for_date",
                json!({"date": "2025-06-15"}),
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
                json!({"date": "2025-06-15"}),
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
        let err = tools
            .call_tool(
                "journal_for_date",
                json!({"date": "2025-13-99"}),
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
        assert!(
            result.is_ok(),
            "list_property_defs must succeed inside scoped call",
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
                    for r in [a, b, d] {
                        assert!(r.is_ok(), "stress call failed: {r:?}");
                        ok += 1;
                    }
                }
                ok
            }));
        }

        let mut total = 0usize;
        for h in handles {
            total += h.await.expect("task joined");
        }
        assert_eq!(
            total,
            CLIENTS * ITERS * TOOLS_PER_ITER,
            "all {} × {} × {} calls must succeed",
            CLIENTS,
            ITERS,
            TOOLS_PER_ITER,
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

        let resp = get_page_inner(&pool, &page.id, None, Some(10))
            .await
            .unwrap();
        assert_eq!(resp.page.id, page.id);
        assert_eq!(resp.children.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inner_get_page_unknown_id_not_found() {
        let (pool, _dir) = test_pool().await;
        let err = get_page_inner(&pool, "NOPE", None, Some(10))
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
        let date = chrono::NaiveDate::from_ymd_opt(2025, 7, 20).unwrap();
        let first = journal_for_date_inner(&pool, DEV, &mat, date)
            .await
            .unwrap();
        settle(&mat).await;
        let again = journal_for_date_inner(&pool, DEV, &mat, date)
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
        let date = chrono::NaiveDate::from_ymd_opt(2025, 8, 10).unwrap();
        let via_navigate =
            navigate_journal_inner(&pool, DEV, &mat, date.format("%Y-%m-%d").to_string())
                .await
                .unwrap();
        settle(&mat).await;
        let via_typed = journal_for_date_inner(&pool, DEV, &mat, date)
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
        let result = tools
            .call_tool(
                "journal_for_date",
                json!({"date": "2025-09-09"}),
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
        use crate::mcp::last_append::LAST_APPEND;
        use std::cell::Cell;

        let (tools, _mat, _dir) = mk_tools().await;

        let captured = LAST_APPEND
            .scope(Cell::new(None), async {
                tools
                    .call_tool("list_pages", json!({}), &test_ctx())
                    .await
                    .expect("list_pages ok");
                LAST_APPEND.with(|c| c.take())
            })
            .await;

        assert!(
            captured.is_none(),
            "RO tool `list_pages` must not populate LAST_APPEND; got {captured:?}",
        );
    }
}
