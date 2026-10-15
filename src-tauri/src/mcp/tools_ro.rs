//! Read-only [`ToolRegistry`] impl — the v1 MCP tool surface.
//!
//! wired nine read-only tools into the MCP dispatcher established by
//! /4b; #633 added `list_spaces` (space discovery) as the tenth.
//! Each tool is a **thin wrapper** around an existing
//! `*_inner` command handler so the op-log / event-sourcing / sqlx-compile-time-query
//! invariants of the frontend path apply verbatim to agent calls
//! (AGENTS.md §Key Architectural Invariants).
//!
//! # Tool surface
//!
//! | Tool | Backing `*_inner` | Notes |
//! |------|-------------------|-------|
//! | `list_pages` | [`list_pages_inner`] | The pages of one space. Cursor paginated. Limits outside `[1, 100]` are rejected. `space_id` required. |
//! | `get_page` | [`get_page_inner`] | Composes `get_active_block_inner` + paginated subtree via `page_id`; `page` carries its properties, tags and aliases (#5377). soft-deleted pages → `NotFound`. `space_id` required; a page in another space is rejected. Children stop at [`RESPONSE_BYTES_CAP`] (#5402). |
//! | `search` | [`search_blocks_inner`] | FTS5. Result count capped at 50, snippet length at 512 chars. |
//! | `get_block` | [`get_active_block_inner`] | Plus the block's properties, tags and, for a page, aliases (#5377). soft-deleted blocks → `NotFound`. `space_id` required; a block in another space is rejected. |
//! | `list_backlinks` | [`list_backlinks_grouped_inner`] | Grouped by source page. `space_id` required. Groups stop at [`RESPONSE_BYTES_CAP`] (#5402). |
//! | `list_tags` | [`list_tags_inner`] | The tags of one space. Cursor paginated. Limits outside `[1, 100]` are rejected. `space_id` required. |
//! | `list_property_defs` | [`list_property_defs_inner`] | Typed property schema; cursor paginated. No `space_id`: property definitions are vault-wide. |
//! | `get_agenda` | [`agenda_range_inner`] | Dated blocks in the range plus projected repeats, one row each. `space_id` required. |
//! | `journal_for_date` | [`journal_for_date_inner`] | Idempotent date → page lookup with a **bounded create carve-out (#2719)**: for `date` within today ± [`JOURNAL_CREATE_WINDOW_MONTHS`] months, creates the missing page on first call (single `CreateBlock`+`SetProperty` op pair, origin `agent:<name>`); outside that window the tool never creates — it returns an existing page as a pure read or `AppError::NotFound`. See [`ReadOnlyTools`] and `handle_journal_for_date` below. |
//! | `list_spaces` | [`list_spaces_registry_inner`] | #633 — space discovery for agents. Returns `{ id, name, is_default }` per live space from the canonical `spaces` registry (#804). |
//! | `get_page_markdown` | [`get_page_for_agent_paged_inner`], or [`get_page_source_inner`] with `editable` | #5375 — the page as Markdown, ids written as names and every block with its `^ID`, a [`RESPONSE_BYTES_CAP`] stretch at a time from a block cursor (#5402). `editable` (#5399) returns instead the whole source buffer `edit_page_markdown` takes back, never cut: a block left out of it is deleted. `space_id` required; a page in another space is rejected. |
//! | `page_history` | [`list_page_history_inner`] | Ops on a page's blocks, newest first: device, origin, op type, time, clipped before/after. Cursor paginated. `space_id` required. |
//! | `block_history` | [`get_block_history_inner`] | The same rows for one block. |
//! | `get_journal` | [`get_journal_page_by_date_inner`] + [`get_page_for_agent_inner`] | #5396 — a day as `get_page_markdown` renders it; `date` is `today` (default), `yesterday` or `YYYY-MM-DD` on the device's clock. Never creates: a missing day is an empty `markdown`. |
//! | `list_journal` | [`list_journal_days_inner`] | #5396 — the days in `[from, to]` with their block counts. Cursor paginated. |
//! | `list_trash` | [`list_trash_inner`] | Deleted blocks of one space (deletion roots), newest first. Cursor paginated. `space_id` required. |
//! | `query` | [`compile_and_run`] | #5398 — the advanced-query engine over one space: a `FilterExpr` tree, sort, group, aggregate. Rows add the page title and the properties the query reads. Cursor paginated. `space_id` required. |
//!
//! # Actor scoping
//!
//! Each handler (re-)scopes [`ACTOR`](agaric_store::task_locals::ACTOR) around the
//! inner call. The server wraps `registry.call_tool(...)` in
//! `ACTOR.scope(ctx, ...)` at the dispatch site so the nested scope is
//! normally a no-op, but it future-proofs any direct invocation of
//! [`ReadOnlyTools::call_tool`] (e.g. tests, diagnostics) against a missing
//! task-local — v1 commands do not call `current_actor()` anywhere, so the
//! plumbing is latent until populates the op-log `origin` column.
//!
//! # Cap enforcement
//!
//! Four caps are enforced at the tool boundary:
//!
//! - **Result count:** `search` is capped at [`SEARCH_RESULT_CAP`] (50),
//!   list-style tools at [`LIST_RESULT_CAP`] (100), `get_agenda` at
//!   [`AGENDA_RESULT_CAP`] (500). a `limit` outside `[1, cap]`
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
//! - **Response bytes (#5402):** `get_page`, `list_backlinks` and
//!   `get_page_markdown` stop at [`RESPONSE_BYTES_CAP`] content bytes, on a
//!   row, group or block boundary, with `truncated: true` and a
//!   `next_cursor`. One row, group or block always comes back, however large.
//! - **Filter-term budget (#699):** `search` rejects requests whose
//!   combined `tag_ids` + `filter` vector element count exceeds
//!   [`SEARCH_FILTER_TERMS_CAP`] (= SQLite's bind-parameter limit) —
//!   such a query could never execute anyway; the boundary check turns
//!   the failure into an actionable `-32602`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;

use super::dispatch::{scoped_dispatch, unknown_tool_error};
use super::handler_utils::{
    Named, fetch_op_origins, normalize_ulid_arg, parse_args, resolve_id_arg, resolve_id_args,
    resolve_journal_date, to_tool_result, validate_block_in_space,
};
use super::registry::{
    TOOL_BLOCK_HISTORY, TOOL_GET_AGENDA, TOOL_GET_BLOCK, TOOL_GET_JOURNAL, TOOL_GET_PAGE,
    TOOL_GET_PAGE_MARKDOWN, TOOL_JOURNAL_FOR_DATE, TOOL_LIST_BACKLINKS, TOOL_LIST_JOURNAL,
    TOOL_LIST_PAGES, TOOL_LIST_PROPERTY_DEFS, TOOL_LIST_SPACES, TOOL_LIST_TAGS, TOOL_LIST_TRASH,
    TOOL_PAGE_HISTORY, TOOL_QUERY, TOOL_RESOLVE, TOOL_SEARCH, ToolDescription, ToolRegistry,
};
use super::view_notify::{NoopViewChangeEmitter, ViewChangeEmitter};
use crate::commands::pages::markdown::{NameMatch, match_page_names, match_tag_names};
use crate::commands::{
    PropertyRow, agenda_range_inner, batch_resolve_inner, get_active_block_inner,
    get_batch_properties_inner, get_block_history_inner, get_journal_page_by_date_inner,
    get_page_aliases_inner, get_page_for_agent_inner, get_page_for_agent_paged_inner,
    get_page_inner, get_page_source_inner, get_properties_inner, journal_for_date_inner,
    list_backlinks_grouped_inner, list_journal_days_inner, list_page_history_inner,
    list_pages_inner, list_property_defs_inner, list_spaces_registry_inner,
    list_tags_for_block_inner, list_tags_inner, list_trash_inner, search_blocks_inner,
};
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::filters::{FilterExpr, FilterPrimitive};
use agaric_store::op::OpRef;
use agaric_store::pagination::{
    ActiveBlockRow, BlockRow, Cursor, HistoryEntry, PageResponse, split_position_keyset_page,
};
use agaric_store::query::{
    AdvancedQueryRequest, AdvancedQueryResponse, AggregateResult, AggregateSpec, AggregateTarget,
    GroupKey, GroupSpec, SortKey, compile_and_run,
};
use agaric_store::search_types::SearchScope;
use agaric_store::space::{SpaceId, SpaceScope};
use agaric_store::task_locals::ActorContext;

// ---------------------------------------------------------------------------
// Caps — enforced at the tool boundary (decision)
// ---------------------------------------------------------------------------

/// Content bytes `get_page`, `list_backlinks` and `get_page_markdown` return
/// in one response (#5402). Past it a response stops at a row, group or block
/// boundary with `truncated: true` and a `next_cursor` that continues it, so a
/// large page cannot overrun an agent's context.
pub const RESPONSE_BYTES_CAP: usize = 64 * 1024;

/// Maximum results returned by the `search` tool. Below
/// [`agaric_store::pagination::MAX_PAGE_SIZE`] deliberately — agents see a narrower
/// page than the frontend.
pub const SEARCH_RESULT_CAP: i64 = 50;

/// Default for list-style tools (`list_pages`, `list_tags`,
/// `list_backlinks`). Re-exported from
/// [`crate::commands::MCP_PAGE_LIMIT_CAP`] so the tool boundary and the
/// [`list_pages_inner`] / [`get_page_inner`] internal strict validation
/// share a single source of truth.
pub use crate::commands::MCP_PAGE_LIMIT_CAP as LIST_RESULT_CAP;

/// Per-result snippet length cap (in Unicode scalars / `char`s) for the
/// `search` tool. Prevents oversized content strings when an agent
/// searches for a common term and hits long blocks. Truncation is
/// done via `chars().take(...)`, which always lands on a UTF-8 char
/// boundary — the worst-case byte length is `4 * SEARCH_SNIPPET_CAP`
/// (every codepoint a four-byte emoji).
pub const SEARCH_SNIPPET_CAP: usize = 512;

/// Cap for `get_agenda`'s `limit` — advertised in the tool schema and
/// enforced strictly at the tool boundary: out-of-range values
/// surface as [`AppError::Validation`]. It equals the per-page ceiling
/// `list_projected_agenda_inner` validates, which [`agenda_range_inner`]
/// shares.
pub const AGENDA_RESULT_CAP: i64 = 500;

/// #699 — upper bound on the combined number of `search` filter terms
/// (`tag_ids` plus every `filter` vector element).
///
/// Not an invented number: this is [`crate::db::MAX_SQL_PARAMS`] (999),
/// SQLite's per-statement bind-parameter limit — the same bound the
/// chunked-insert helpers (`spaces/bootstrap.rs`, `cache/`) already
/// derive their chunk sizes from. Every filter term binds at least one
/// SQL parameter in the search query, so a request with more terms
/// than this can never execute; rejecting it at the boundary turns an
/// opaque post-#698 `-32603 internal error` into an actionable
/// `-32602 invalid params`.
pub const SEARCH_FILTER_TERMS_CAP: usize = crate::db::MAX_SQL_PARAMS;

/// #1607 — upper bound on the byte length of any single `search` term
/// string (the `query`, each page glob, and each property-filter key /
/// value). `SEARCH_FILTER_TERMS_CAP` caps how *many* terms a request
/// may carry but never how *large* each one is, so a handful of
/// multi-megabyte strings slip under the count cap and force large
/// allocations plus expensive glob / regex matching downstream.
///
/// Not an invented number: this is the same
/// [`crate::commands::MAX_CONTENT_LENGTH`] (256 KiB) the `set_property`
/// MCP tool already enforces on `value_text`, and search property
/// values are matched against the very same `block_properties.value_text`
/// column. Reusing it keeps the per-string ceiling consistent across the
/// MCP boundary.
pub const SEARCH_TERM_BYTES_CAP: usize = crate::commands::MAX_CONTENT_LENGTH;

/// #1607 — upper bound on the *combined* byte length of every `search`
/// term string in one request. Even with each individual string under
/// [`SEARCH_TERM_BYTES_CAP`], a request packed with up to
/// [`SEARCH_FILTER_TERMS_CAP`] near-cap strings could still total
/// hundreds of megabytes. We bound the aggregate at the same
/// `MAX_CONTENT_LENGTH` (one block's worth of content) so the total
/// search-term payload can never exceed a single block body.
pub const SEARCH_TERM_TOTAL_BYTES_CAP: usize = crate::commands::MAX_CONTENT_LENGTH;

/// #2719 — width, in calendar months on either side of "today", of the
/// window inside which the read-only `journal_for_date` tool is permitted
/// to CREATE a missing journal page.
///
/// Before this bound, `handle_journal_for_date` parsed **any** valid
/// `YYYY-MM-DD` string and delegated straight into
/// [`journal_for_date_inner`], which creates the page unconditionally on
/// a miss. That meant a prompt-injected agent connected to the nominally
/// read-only socket could append an unbounded number of `CreateBlock` +
/// `SetProperty(space)` op pairs to the append-only `op_log` — roughly
/// 3.6M distinct dates per space, none of them reclaimable. Bounding the
/// *create* branch to a year on either side of today closes that path
/// while leaving the documented, intentional carve-out (AGENTS.md
/// §Read-only vs read-write surfaces) in place for its real use case:
/// an agent journaling around the current date.
///
/// A `date` outside the window is never rejected outright — see
/// `handle_journal_for_date` — it just can't *create*: an existing
/// page there is still returned (pure read), and a miss becomes
/// [`AppError::NotFound`] instead of a write.
pub const JOURNAL_CREATE_WINDOW_MONTHS: u32 = 12;

/// True when `date` falls inside `[today - JOURNAL_CREATE_WINDOW_MONTHS,
/// today + JOURNAL_CREATE_WINDOW_MONTHS]` (inclusive on both ends).
///
/// "Today" is `chrono::Local::now().date_naive()` — the same source
/// `commands/agenda.rs` (`list_projected_agenda_inner`) and
/// `recurrence/parser.rs` already use for their own "today" reference,
/// so this stays consistent with the rest of the journal/agenda surface
/// rather than inventing a second clock source.
///
/// Uses calendar-month arithmetic (`checked_add_months` /
/// `checked_sub_months`) rather than a flat day count so the window
/// means "the same day-of-month a year away" regardless of leap years.
/// Saturates to `NaiveDate::MIN` / `NaiveDate::MAX` on the (practically
/// unreachable) overflow case so the function stays total.
fn within_journal_create_window(date: chrono::NaiveDate) -> bool {
    let today = chrono::Local::now().date_naive();
    let months = chrono::Months::new(JOURNAL_CREATE_WINDOW_MONTHS);
    let start = today
        .checked_sub_months(months)
        .unwrap_or(chrono::NaiveDate::MIN);
    let end = today
        .checked_add_months(months)
        .unwrap_or(chrono::NaiveDate::MAX);
    date >= start && date <= end
}

// ---------------------------------------------------------------------------
// Typed argument structs (one per tool)
//
// Each uses `serde(deny_unknown_fields)` so typos in an agent's JSON
// arguments are surfaced immediately as `AppError::Validation` rather than
// silently ignored. Every field is `Option<T>` unless the tool requires it.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListPagesArgs {
    space_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetPageArgs {
    page_id: String,
    space_id: String,
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
    /// The active space's ULID. Required: every search runs
    /// inside a single space and the FTS5 hits are restricted to blocks
    /// whose owning page carries `space = ?space_id`. Agents discover
    /// space ids with the `list_spaces` tool (#633).
    space_id: String,
    /// Optional structured filter set mirroring the
    /// `SearchFilter` user-facing surface. Omitted = the agent runs a
    /// Query-string-only search (the pre-existing contract). When
    /// present, the handler maps each field 1:1 onto the underlying
    /// `SearchFilter` and dispatches as the Tauri command path does.
    /// Inline filter syntax (`tag:` / `state:` / `prop:`…) is NOT
    /// parsed from `query` at the MCP boundary — agents pass
    /// structured arguments instead.
    #[serde(default)]
    filter: Option<SearchFilterArgs>,
}

/// JSON wire shape for the MCP `search.filter` argument.
///
/// Mirrors [`crate::commands::queries::SearchFilter`] field-for-field
/// (minus `parent_id` / `tag_ids` / `space_id`, which the existing
/// top-level arg slots already carry). Every field is
/// `#[serde(default)]` so an agent can pass any subset; the handler
/// folds the provided fields into the constructed `SearchFilter`.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
struct SearchFilterArgs {
    #[serde(default)]
    include_page_globs: Vec<String>,
    #[serde(default)]
    exclude_page_globs: Vec<String>,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    whole_word: bool,
    #[serde(default)]
    is_regex: bool,
    #[serde(default)]
    block_type_filter: Option<String>,
    #[serde(default)]
    state_filter: Vec<String>,
    #[serde(default)]
    priority_filter: Vec<String>,
    #[serde(default)]
    excluded_state_filter: Vec<String>,
    #[serde(default)]
    excluded_priority_filter: Vec<String>,
    #[serde(default)]
    due_filter: Option<crate::commands::queries::DateFilter>,
    #[serde(default)]
    scheduled_filter: Option<crate::commands::queries::DateFilter>,
    #[serde(default)]
    property_filters: Vec<crate::commands::queries::SearchPropertyFilter>,
    #[serde(default)]
    excluded_property_filters: Vec<crate::commands::queries::SearchPropertyFilter>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetBlockArgs {
    block_id: String,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetPageMarkdownArgs {
    page_id: String,
    space_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    editable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListTrashArgs {
    space_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

/// `where`, `sort`, `group_by` and `aggregate` are the advanced-query engine's
/// own wire types, so the tool and the app's query builder share one grammar.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryArgs {
    space_id: String,
    #[serde(rename = "where")]
    filter: FilterExpr,
    #[serde(default)]
    sort: Vec<SortKey>,
    #[serde(default)]
    group_by: Option<GroupKey>,
    #[serde(default)]
    aggregate: Vec<AggregateSpec>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PageHistoryArgs {
    page_id: String,
    space_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BlockHistoryArgs {
    block_id: String,
    space_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListBacklinksArgs {
    block_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    /// Backlinks are restricted to source blocks in this space.
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListTagsArgs {
    space_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListPropertyDefsArgs {
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetAgendaArgs {
    start_date: String,
    end_date: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    /// The agenda is restricted to blocks in this space.
    space_id: String,
}

/// #633 — `list_spaces` takes no arguments; the empty struct (with
/// `deny_unknown_fields`) keeps the strict-boundary posture so a typo'd
/// argument surfaces as `-32602` instead of being silently ignored.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListSpacesArgs {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalForDateArgs {
    date: String,
    /// The active space's ULID. Required: every journal page
    /// belongs to a space. Agents discover space ids with the
    /// `list_spaces` tool (#633).
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetJournalArgs {
    space_id: String,
    #[serde(default)]
    date: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveArgs {
    names: Vec<String>,
    space_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListJournalArgs {
    space_id: String,
    from: String,
    to: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
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
/// Via `create_block_inner`), matching the invariant that v1 never
/// exposes non-reversible ops.
///
/// `journal_for_date` is the only RO tool with a write side-effect —
/// it calls `create_block_inner` when the requested date has no existing
/// page **and** the date falls inside the bounded create window (today ±
/// [`JOURNAL_CREATE_WINDOW_MONTHS`] months, see
/// `within_journal_create_window` / #2719). The reader pool sets
/// `PRAGMA query_only = ON`, so feeding it to the create path raises
/// `SQLITE_READONLY`. The struct therefore carries **both** pools: `pool`
/// (reader) backs every read, the space checks included; `writer_pool` backs
/// only the in-window create branch of `journal_for_date` (#5402).
///
/// Because of the carve-out, **enabling the read-only MCP server
/// implicitly grants the agent permission to append a single
/// `CreateBlock` + `SetProperty(space)` op pair to `op_log` (origin
/// `agent:<name>`) on the first call for a given `(space_id, date)` pair
/// — but only when `date` is within the bounded create window.** Outside
/// the window `journal_for_date` never creates: an existing page there is
/// still returned as a pure read, and a miss surfaces
/// [`AppError::NotFound`] instead of a write. The op (when it happens) is
/// reversible (ordinary `page` block via `create_block_inner`) and shows
/// up in the agent activity feed like any other agent-authored write, but
/// it is **not** a pure read. The Settings "Read-only access" tooltip
/// (`agentAccess.roToggleDescription` in `src/lib/i18n.ts`) and
/// `src-tauri/src/mcp/AGENTS.md` §Read-only vs read-write surfaces both
/// surface this bounded carve-out to the user / reader. Splitting
/// `journal_for_date` into RO+RW halves was rejected as a public API
/// change requiring explicit user approval — bounding the create window
/// (#2719) closes the unbounded-mutation risk while preserving the v1
/// tool surface.
pub struct ReadOnlyTools {
    pool: SqlitePool,
    /// Writer pool from `DbPools::write`: `journal_for_date`'s create
    /// branch only; every read stays on `pool`.
    writer_pool: SqlitePool,
    materializer: Materializer,
    /// Local-device id used when a tool has to write (today only
    /// `journal_for_date` when the requested date page does not exist
    /// Yet). Namespaced so future RW tools can stamp the same
    /// origin without a second field.
    device_id: String,
    /// #5314: `journal_for_date` can create a page, and open views learn of a
    /// write only through `blocks:changed`. Defaults to a no-op, as on
    /// `ReadWriteTools`.
    view_emitter: Arc<dyn ViewChangeEmitter>,
}

impl ReadOnlyTools {
    /// Construct a read-only registry.
    ///
    /// - `pool` is the *reader* pool (`DbPools::read`) and backs every
    ///   pure-read tool plus the lookup branch of `journal_for_date`.
    /// - `writer_pool` is the *writer* pool (`DbPools::write`) and backs
    ///   the `journal_for_date` create branch — opening `BEGIN IMMEDIATE`
    ///   on the read pool fails with `SQLITE_READONLY` because the read
    ///   Pool sets `PRAGMA query_only = ON`. (.)
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
            view_emitter: Arc::new(NoopViewChangeEmitter),
        }
    }

    /// Install the emitter that tells open views about a page `journal_for_date`
    /// created (#5314). Production passes a `TauriViewChangeEmitter`.
    #[must_use]
    pub fn with_view_emitter(mut self, view_emitter: Arc<dyn ViewChangeEmitter>) -> Self {
        self.view_emitter = view_emitter;
        self
    }
}

/// Static tool-description list for the read-only MCP surface.
///
/// Lifted out of [`ToolRegistry::list_tools`] so callers that need the
/// names without a constructed registry (notably the privacy-guard test
/// In `summarise.rs`) can drive iteration from the live
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
        tool_desc_list_spaces(),
        tool_desc_get_page_markdown(),
        tool_desc_page_history(),
        tool_desc_block_history(),
        tool_desc_get_journal(),
        tool_desc_list_journal(),
        tool_desc_list_trash(),
        tool_desc_resolve(),
        tool_desc_query(),
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
        // The ACTOR scope + name-clone boilerplate is
        // shared with `tools_rw` via `super::dispatch::scoped_dispatch`.
        let pool = self.pool.clone();
        let writer_pool = self.writer_pool.clone();
        let materializer = self.materializer.clone();
        let device_id = self.device_id.clone();
        let view_emitter = self.view_emitter.clone();
        scoped_dispatch(ctx, name, move |name| async move {
            match name.as_str() {
                TOOL_LIST_PAGES => handle_list_pages(&pool, args).await,
                TOOL_GET_PAGE => handle_get_page(&pool, args).await,
                TOOL_SEARCH => handle_search(&pool, args).await,
                TOOL_LIST_BACKLINKS => handle_list_backlinks(&pool, args).await,
                TOOL_LIST_TAGS => handle_list_tags(&pool, args).await,
                TOOL_LIST_PROPERTY_DEFS => handle_list_property_defs(&pool, args).await,
                TOOL_GET_AGENDA => handle_get_agenda(&pool, args).await,
                TOOL_JOURNAL_FOR_DATE => {
                    // #2719 — the handler needs BOTH pools now: the
                    // reader pool for the out-of-window / lookup-only
                    // path (a pure SELECT), and the writer pool for the
                    // in-window create path, because `journal_for_date_inner`
                    // opens `BEGIN IMMEDIATE` and inserts into `op_log` +
                    // `blocks` whenever the requested date has no existing
                    // page AND falls inside the bounded create window. The
                    // reader pool's `PRAGMA query_only = ON` rejects that
                    // INSERT path with `SQLITE_READONLY`, so the create
                    // branch must stay on the writer pool.
                    handle_journal_for_date(
                        &pool,
                        &writer_pool,
                        &materializer,
                        &device_id,
                        view_emitter.as_ref(),
                        args,
                    )
                    .await
                }
                TOOL_LIST_SPACES => handle_list_spaces(&pool, args).await,
                TOOL_GET_BLOCK => handle_get_block(&pool, args).await,
                TOOL_GET_PAGE_MARKDOWN => handle_get_page_markdown(&pool, args).await,
                TOOL_PAGE_HISTORY => handle_page_history(&pool, args).await,
                TOOL_BLOCK_HISTORY => handle_block_history(&pool, args).await,
                TOOL_GET_JOURNAL => {
                    handle_get_journal(&pool, args, chrono::Local::now().date_naive()).await
                }
                TOOL_LIST_JOURNAL => handle_list_journal(&pool, args).await,
                TOOL_LIST_TRASH => handle_list_trash(&pool, args).await,
                TOOL_RESOLVE => handle_resolve(&pool, args).await,
                TOOL_QUERY => handle_query(&pool, args).await,
                other => Err(unknown_tool_error(other)),
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Tool descriptions (static metadata)
// ---------------------------------------------------------------------------

fn tool_desc_resolve() -> ToolDescription {
    ToolDescription {
        name: TOOL_RESOLVE.to_string(),
        description: "Look up page and tag names in a space, many in one call, as a written \
             `[[Name]]` / `#name` is matched: a page by exact title, else by one \
             case-insensitive title, else by alias; a tag by name, ignoring case. Each name \
             answers `page_id` and `tag_id`, null when nothing matches; a name several pages \
             share answers `page_candidates` instead. Tools that take a page or tag id take \
             its name too, so this is only for ids up front."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["names", "space_id"],
            "properties": {
                "names": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "maxItems": agaric_store::pagination::MAX_BATCH_BLOCK_IDS,
                    "description": "The page or tag names to look up.",
                },
                "space_id": { "type": "string", "description": "ULID of the space to look in." },
            },
        }),
    }
}

fn tool_desc_list_pages() -> ToolDescription {
    ToolDescription {
        name: TOOL_LIST_PAGES.to_string(),
        description: "List the pages of a space, with cursor pagination.".to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["space_id"],
            "properties": {
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space whose pages to list.",
                },
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
        description: format!(
            "Fetch a page and a paginated slice of its non-conflict subtree (grandchildren \
                 included). `page` also carries `properties` (every property row, raw), `tags` \
                 (tag ULIDs; `list_tags` names them) and `aliases`; the children are plain rows. \
                 A slice whose content passes {RESPONSE_BYTES_CAP} bytes stops early with \
                 `truncated: true`; pass `next_cursor` as `cursor` to read on."
        ),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["page_id", "space_id"],
            "properties": {
                "page_id": { "type": "string", "description": "ULID of the page block." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the page belongs to. A page in another space is rejected with a Validation error.",
                },
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

/// The `filter` sub-schema of the `search` tool: the MCP-facing mirror of the
/// user-facing `SearchFilter` (`agaric-store`'s `search_types.rs`).
///
/// Its own function because it is two thirds of `tool_desc_search`, and because
/// a new filter dimension is a change to this shape and nothing else.
fn search_filter_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "description": "Structured filter set mirroring the user-facing `SearchFilter` (omit for a query-string-only search).",
        "properties": {
            "include_page_globs": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Page-name glob include list (SQLite GLOB syntax, `{a,b}` brace expansion). Bare tokens are wrapped with `*…*`.",
            },
            "exclude_page_globs": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Page-name glob exclude list.",
            },
            "case_sensitive": { "type": "boolean" },
            "whole_word": { "type": "boolean" },
            "is_regex": { "type": "boolean", "description": "Treat `query` as a regex (FTS5 bypassed)." },
            "block_type_filter": { "type": "string", "description": "Restrict to a single `blocks.block_type` value (e.g. `'page'`)." },
            "state_filter": {
                "type": "array",
                "items": { "type": "string" },
                "description": "`todo_state IN (...)`. Literal `'none'` means `todo_state IS NULL`.",
            },
            "priority_filter": { "type": "array", "items": { "type": "string" } },
            "excluded_state_filter": {
                "type": "array",
                "items": { "type": "string" },
                "description": "`(todo_state IS NULL OR todo_state NOT IN (...))`. Adding literal `'none'` excludes the NULL bucket too, AND-joining to `(todo_state IS NOT NULL AND todo_state NOT IN (...))`; `'none'` alone emits `todo_state IS NOT NULL`.",
            },
            "excluded_priority_filter": { "type": "array", "items": { "type": "string" } },
            "due_filter": {
                "type": "object",
                "description": "Date predicate on `blocks.due_date`. One of `{ \"named\": \"today\"|\"this-week\"|... }` or `{ \"op\": { \"op\": \"lt\"|..., \"date\": \"YYYY-MM-DD\" } }`.",
            },
            "scheduled_filter": {
                "type": "object",
                "description": "Same shape as `due_filter` but on `blocks.scheduled_date`.",
            },
            "property_filters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "key": { "type": "string" },
                        "value": { "type": "string" },
                    },
                    "required": ["key", "value"],
                },
                "description": "AND-joined property predicates. Matches across `value_text` / `value_num` / `value_date` / `value_ref` with type coercion.",
            },
            "excluded_property_filters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "key": { "type": "string" },
                        "value": { "type": "string" },
                    },
                    "required": ["key", "value"],
                },
            },
        },
    })
}

fn tool_desc_search() -> ToolDescription {
    ToolDescription {
        name: TOOL_SEARCH.to_string(),
        description:
            "Full-text search across block content (FTS5). Returns BlockRow records; content \
             is truncated to 512 chars per result. pass `filter` for structured \
             narrowing (state / priority / due / scheduled / property / page-name globs / \
             block-type / case-sensitive / whole-word / regex toggles)."
                .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["query", "space_id"],
            "properties": {
                "query": { "type": "string", "description": "FTS5 MATCH query string." },
                "cursor": { "type": "string" },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": SEARCH_RESULT_CAP,
                    "description": format!("Max results per response (capped at {SEARCH_RESULT_CAP})."),
                },
                "parent_id": { "type": "string", "description": "Optional parent ULID, or a page's title or alias, to scope the search." },
                "tag_ids": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional list of tag ULIDs or names to intersect the result set with.",
                },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the search runs inside. Required: every FTS5 hit is restricted to blocks whose owning page carries `space = ?space_id`.",
                },
                "filter": search_filter_schema(),
            },
        }),
    }
}

fn tool_desc_get_block() -> ToolDescription {
    ToolDescription {
        name: TOOL_GET_BLOCK.to_string(),
        description: "Fetch a single block by ULID. Returns the BlockRow plus `properties` (every \
             property row, raw), `tags` (tag ULIDs; `list_tags` names them) and, for a page, \
             `aliases`; soft-deleted (tombstoned) blocks are excluded."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id", "space_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the block." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the block belongs to. A block in another space is rejected with a Validation error.",
                },
            },
        }),
    }
}

fn tool_desc_list_backlinks() -> ToolDescription {
    ToolDescription {
        name: TOOL_LIST_BACKLINKS.to_string(),
        description: format!(
            "List backlinks for a block, grouped by source page. A response whose content \
             passes {RESPONSE_BYTES_CAP} bytes stops at a group with `truncated: true`; pass \
             `next_cursor` as `cursor` to read on."
        ),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["block_id", "space_id"],
            "properties": {
                "block_id": { "type": "string", "description": "ULID of the target block/page." },
                "cursor": { "type": "string" },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": LIST_RESULT_CAP,
                    "description": format!("Max grouped results per response (capped at {LIST_RESULT_CAP})."),
                },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space to scope backlinks to."
                },
            },
        }),
    }
}

fn tool_desc_list_tags() -> ToolDescription {
    ToolDescription {
        name: TOOL_LIST_TAGS.to_string(),
        description: "List the tags of a space, with cursor pagination.".to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["space_id"],
            "properties": {
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space whose tags to list.",
                },
                "cursor": {
                    "type": "string",
                    "description": "Opaque pagination cursor from a prior response.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": LIST_RESULT_CAP,
                    "description": format!("Max tags per response (capped at {LIST_RESULT_CAP})."),
                },
            },
        }),
    }
}

fn tool_desc_list_property_defs() -> ToolDescription {
    ToolDescription {
        name: TOOL_LIST_PROPERTY_DEFS.to_string(),
        description:
            "List every property definition (typed property schema), with cursor pagination."
                .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "cursor": {
                    "type": "string",
                    "description": "Opaque pagination cursor from a prior response.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": LIST_RESULT_CAP,
                    "description": format!("Max definitions per response (capped at {LIST_RESULT_CAP})."),
                },
            },
        }),
    }
}

fn tool_desc_get_agenda() -> ToolDescription {
    ToolDescription {
        name: TOOL_GET_AGENDA.to_string(),
        description:
            "Agenda for an inclusive date range: every block whose due or scheduled date falls \
             in the range (done tasks excluded), plus each later occurrence of a repeating \
             task in the range. One row per (date, block, source): `source` names the date \
             field (`due_date` or `scheduled_date`); `projected` is false for the block's own \
             date and true for a later occurrence of a repeating task."
                .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["start_date", "end_date", "space_id"],
            "properties": {
                "start_date": { "type": "string", "description": "Inclusive YYYY-MM-DD lower bound." },
                "end_date":   { "type": "string", "description": "Inclusive YYYY-MM-DD upper bound." },
                "cursor": {
                    "type": "string",
                    "description": "Opaque cursor returned by a previous response's `next_cursor` to fetch the next page."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": AGENDA_RESULT_CAP,
                    "description": format!("Max entries per response (capped at {AGENDA_RESULT_CAP})."),
                },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space to scope the agenda to."
                },
            },
        }),
    }
}

fn tool_desc_journal_for_date() -> ToolDescription {
    ToolDescription {
        name: TOOL_JOURNAL_FOR_DATE.to_string(),
        // Lead with the side-effect so an LLM agent skimming
        // a tool list does not classify this as read-only based on the
        // file group / leading verb. The tool emits a `CreateBlock` op
        // With origin `agent:<name>` on first miss inside the bounded
        // create window (#2719) — never outside it.
        description: "Creates the page if missing and `date` is within ~12 months of today (one \
             `CreateBlock` op with origin `agent:<name>`), then returns the journal page for \
             `space_id` on `date`. Idempotent per `(space_id, date)` after the first call. \
             Outside that ~12-month window this tool never creates: an existing page is \
             returned as a pure read, and a missing one returns a not-found error."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["date", "space_id"],
            "properties": {
                "date": { "type": "string", "description": "YYYY-MM-DD date string." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the daily journal belongs to."
                },
            },
        }),
    }
}

fn tool_desc_list_spaces() -> ToolDescription {
    ToolDescription {
        name: TOOL_LIST_SPACES.to_string(),
        description: "List every space as { id, name, is_default }. Every other tool except \
             list_property_defs requires a space_id — call this first to discover one. \
             is_default marks the seeded Personal space."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {},
        }),
    }
}

fn tool_desc_get_page_markdown() -> ToolDescription {
    ToolDescription {
        name: TOOL_GET_PAGE_MARKDOWN.to_string(),
        description: format!(
            "Read a page as Markdown, returned as {{ page_id, markdown, truncated, next_cursor }}: \
             a `# Title` line, YAML front matter with the page's aliases, tags and properties, \
             then the block outline with each block's `key:: value` properties under it. Links, \
             tags and ref-typed values are written as names, for reading; a name can be \
             ambiguous, so write links by ULID (`[[ULID]]`, `#[ULID]`). Each block ends with \
             `^ULID`, the block_id update_block_content takes. Past {RESPONSE_BYTES_CAP} bytes \
             the Markdown stops at a block with `truncated: true`; pass `next_cursor` as \
             `cursor` for the rest, which carries on from that block. With `editable: true`, \
             `markdown` is instead the page's whole source, never truncated, the text the \
             read-write server's edit_page_markdown takes back: no title line, a name only \
             where it reads back as the same link, ref-typed values as ULIDs, and each block's \
             `^ULID`."
        ),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["page_id", "space_id"],
            "properties": {
                "page_id": { "type": "string", "description": "ULID of the page block." },
                "space_id": {
                    "type": "string",
                    "description": "ULID of the space the page belongs to. A page in another space is rejected with a Validation error.",
                },
                "cursor": {
                    "type": "string",
                    "description": "The `next_cursor` of a truncated read, to continue it.",
                },
                "editable": { "type": "boolean", "description": "Return the source edit_page_markdown takes instead. Defaults to false." },
            },
        }),
    }
}

fn history_input_schema(id_key: &str, id_description: &str) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": [id_key, "space_id"],
        "properties": {
            id_key: { "type": "string", "description": id_description },
            "space_id": {
                "type": "string",
                "description": format!("ULID of the space the agent is operating in. The read is rejected with a Validation error if `{id_key}` lives in a different space."),
            },
            "cursor": { "type": "string" },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": LIST_RESULT_CAP,
                "description": format!("Max rows per response (capped at {LIST_RESULT_CAP})."),
            },
        },
    })
}

const HISTORY_ROW_DESCRIPTION: &str = "Each row has device_id, seq, origin (`user`, or \
     `agent:<name>` for an agent's write), op_type, created_at (epoch ms), block_id, a \
     clipped `after` (the text or property value the op wrote) and, for an edit, a clipped \
     `before`. Newest first; cursor paginated.";

fn tool_desc_page_history() -> ToolDescription {
    ToolDescription {
        name: TOOL_PAGE_HISTORY.to_string(),
        description: format!(
            "Who changed what on a page, and when: every op on the page's blocks. \
             {HISTORY_ROW_DESCRIPTION}"
        ),
        input_schema: history_input_schema(
            "page_id",
            "ULID of the page block, or its title or alias.",
        ),
    }
}

fn tool_desc_block_history() -> ToolDescription {
    ToolDescription {
        name: TOOL_BLOCK_HISTORY.to_string(),
        description: format!("Who changed what on one block, and when. {HISTORY_ROW_DESCRIPTION}"),
        input_schema: history_input_schema("block_id", "ULID of the block."),
    }
}

fn tool_desc_get_journal() -> ToolDescription {
    ToolDescription {
        name: TOOL_GET_JOURNAL.to_string(),
        description: "Read a day's journal page as Markdown, returned as { date, page_id, \
             markdown } in the shape get_page_markdown returns. Never creates the day: a \
             missing one returns `page_id: null` and empty `markdown`."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["space_id"],
            "properties": {
                "space_id": { "type": "string", "description": "ULID of the space the journal belongs to." },
                "date": {
                    "type": "string",
                    "description": "`today` (the default), `yesterday`, or YYYY-MM-DD, on this device's clock.",
                },
            },
        }),
    }
}

fn tool_desc_list_journal() -> ToolDescription {
    ToolDescription {
        name: TOOL_LIST_JOURNAL.to_string(),
        description: "List the journal days of a space from `from` to `to` (inclusive), oldest \
             first, each as { page_id, date, block_count }. Cursor paginated."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["space_id", "from", "to"],
            "properties": {
                "space_id": { "type": "string", "description": "ULID of the space the journal belongs to." },
                "from": { "type": "string", "description": "First day, YYYY-MM-DD." },
                "to": { "type": "string", "description": "Last day, YYYY-MM-DD." },
                "cursor": { "type": "string", "description": "Opaque pagination cursor from a prior response." },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": LIST_RESULT_CAP,
                    "description": format!("Max days per response (capped at {LIST_RESULT_CAP})."),
                },
            },
        }),
    }
}

fn tool_desc_query() -> ToolDescription {
    ToolDescription {
        name: TOOL_QUERY.to_string(),
        description: "Query one space's blocks with a boolean tree of predicates, optionally \
                      sorted, grouped and aggregated; cursor paginated. Rows carry `page_title` \
                      and the properties the query reads; with `group_by` the result is `groups` \
                      of { key, title, count, aggregates } instead. Open TODOs with \
                      estimate > 3: {\"space_id\": \"<ULID>\", \"where\": {\"type\": \"And\", \
                      \"children\": [{\"type\": \"Leaf\", \"primitive\": {\"type\": \"State\", \
                      \"values\": [\"TODO\"]}}, {\"type\": \"Leaf\", \"primitive\": {\"type\": \
                      \"HasProperty\", \"key\": \"estimate\", \"predicate\": {\"type\": \"Gt\", \
                      \"value\": {\"type\": \"Num\", \"value\": 3}}}}]}}"
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["space_id", "where"],
            "properties": {
                "space_id": { "type": "string", "description": "ULID of the space to query." },
                "where": {
                    "type": "object",
                    "description": "{type: And|Or, children: [...]}, {type: Not, child} or \
                                    {type: Leaf, primitive}. Primitives: Tag {tag} (attached), \
                                    TagOrRef {tag} (attached or inline), HasProperty {key, \
                                    predicate}, State {values}, Priority {values}, BlockType \
                                    {values, exclude}, DueDate {predicate}, Scheduled \
                                    {predicate}, Created {after?, before?}, LastEdited {spec}, \
                                    LinksTo {target}, LinkedFrom {source}, ChildOf {parent}, \
                                    HasParentMatching {matcher: <where>}, PathGlob {pattern, \
                                    exclude} (pages whose lower-case title matches the GLOB). \
                                    Property predicate: Exists, \
                                    NotExists, or Eq|Ne|Lt|Gt|Lte|Gte|Contains|StartsWith \
                                    {value: {type: Text|Num|Date|Ref, value}}. Date predicate: \
                                    IsNull, Before|After|OnOrBefore|OnOrAfter|On {date}, \
                                    Between {from, to}. LastEdited spec: Rolling {days}, \
                                    OlderThan {days}, Range {start, end}. Ids are ULIDs, \
                                    dates YYYY-MM-DD.",
                },
                "sort": {
                    "type": "array",
                    "description": "[{source: {type: Column, name: created|lastEdited|position|\
                                    priority|title}, desc?}]. Default: newest first.",
                },
                "group_by": {
                    "type": "object",
                    "description": "{type: Page|Tag|State|Priority|BlockType}, {type: Property, \
                                    key} or {type: DateBucket, source: due|scheduled|created|\
                                    lastEdited, unit: day|week|month}.",
                },
                "aggregate": {
                    "type": "array",
                    "description": "[{op: count|sum|avg|min|max, target?: {type: Property, key} \
                                    | {type: Column, name: priority|position}}], over the whole \
                                    match and per group.",
                },
                "cursor": { "type": "string", "description": "Opaque pagination cursor from a prior response." },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": LIST_RESULT_CAP,
                    "description": format!("Max rows or groups per response (capped at {LIST_RESULT_CAP})."),
                },
            },
        }),
    }
}

fn tool_desc_list_trash() -> ToolDescription {
    ToolDescription {
        name: TOOL_LIST_TRASH.to_string(),
        description: "List the soft-deleted blocks of a space, newest deletion first, with \
                      cursor pagination. A block deleted with its parent is not listed: restoring \
                      the parent restores it. Pass a row's id and deleted_at to restore_block."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["space_id"],
            "properties": {
                "space_id": { "type": "string", "description": "ULID of the space whose trash to list." },
                "cursor": { "type": "string", "description": "Opaque pagination cursor from a prior response." },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": LIST_RESULT_CAP,
                    "description": format!("Max blocks per response (capped at {LIST_RESULT_CAP})."),
                },
            },
        }),
    }
}

// ---------------------------------------------------------------------------
// Handler implementations
//
// Each handler: (1) parse args, (2) validate `limit` against the schema's
// `[1, cap]` advertised range, (3) delegate to `*_inner`,
// (4) serialise result to `serde_json::Value`. Errors from `*_inner`
// propagate as `AppError` — the server translates them to JSON-RPC codes
// (`-32001` for `NotFound`, `-32602` for `Validation`/`InvalidOperation`/
// `Ulid`, `-32603` otherwise).
// ---------------------------------------------------------------------------

/// Reject `limit` values outside the documented `[1, cap]` range with
/// An [`AppError::Validation`]. The dispatcher then surfaces
/// it as JSON-RPC `-32602 invalid params` via `app_error_to_rmcp`,
/// matching the strict `serde(deny_unknown_fields)` posture used
/// elsewhere on the MCP boundary. Silent clamping previously hid
/// out-of-range typos and let agents request pages that quietly
/// exceeded the documented cap. Returns the value unchanged so the
/// caller can pass it straight through to `*_inner`.
///
/// #1665: on the MCP path this check *shadows* the equivalent range
/// checks inside the backing `*_inner` functions (e.g.
/// `list_pages_inner` / `get_page_inner` in `commands/pages/listing.rs`).
/// Because `validate_limit` runs first and short-circuits, the `*_inner`
/// message is never observed on the wire by an MCP agent — what they see
/// is the message produced here. The inner checks are intentional
/// defense-in-depth for *non-MCP* callers (e.g. direct command/IPC
/// callers that bypass this boundary), so do NOT "fix" the inner message
/// expecting it to surface to MCP agents, and do NOT delete the inner
/// checks as redundant — they guard the non-MCP entry path.
fn validate_limit(tool: &str, limit: Option<i64>, cap: i64) -> Result<Option<i64>, AppError> {
    if let Some(l) = limit
        && !(1..=cap).contains(&l)
    {
        return Err(AppError::validation(format!(
            "{tool}: limit must be in [1, {cap}], got {l}"
        )));
    }
    Ok(limit)
}

async fn handle_list_pages(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListPagesArgs = parse_args(TOOL_LIST_PAGES, args)?;
    let limit = validate_limit(TOOL_LIST_PAGES, args.limit, LIST_RESULT_CAP)?;
    let space_id = SpaceId::from_string(args.space_id)?;
    let resp = list_pages_inner(pool, space_id.as_str(), args.cursor, limit).await?;
    to_tool_result(&resp)
}

async fn handle_get_page(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: GetPageArgs = parse_args(TOOL_GET_PAGE, args)?;
    let limit = validate_limit(TOOL_GET_PAGE, args.limit, LIST_RESULT_CAP)?;
    // Normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let page_id = normalize_ulid_arg(&args.page_id);
    let space_id = SpaceId::from_string(args.space_id)?;
    // `get_page_inner` rejects a page outside `space_id` (Validation).
    let mut resp = get_page_inner(pool, &page_id, space_id.as_str(), args.cursor, limit).await?;
    let cut_at = cap_children_bytes(&mut resp.children)?;
    let truncated = cut_at.is_some();
    if truncated {
        resp.next_cursor = cut_at;
        resp.has_more = true;
    }
    let page = with_metadata(pool, resp.page.clone()).await?;
    let mut result = to_tool_result(&resp)?;
    result["page"] = to_tool_result(&page)?;
    result["truncated"] = json!(truncated);
    Ok(result)
}

/// How many of `sizes`, from the first, fit in [`RESPONSE_BYTES_CAP`]
/// together; never fewer than one, so a reader always moves forward.
fn count_within_bytes_cap(sizes: impl IntoIterator<Item = usize>) -> usize {
    let mut total = 0usize;
    let mut count = 0;
    for size in sizes {
        total = total.saturating_add(size);
        if count > 0 && total > RESPONSE_BYTES_CAP {
            break;
        }
        count += 1;
    }
    count
}

/// Cut `children` to the rows whose content fits [`RESPONSE_BYTES_CAP`],
/// returning the cursor that resumes after the last row kept, or `None` when
/// all fit (#5402).
fn cap_children_bytes(children: &mut Vec<BlockRow>) -> Result<Option<String>, AppError> {
    let keep = count_within_bytes_cap(
        children
            .iter()
            .map(|row| row.content.as_deref().map_or(0, str::len)),
    );
    if keep == children.len() {
        return Ok(None);
    }
    let limit = i64::try_from(keep).expect("at most LIST_RESULT_CAP children");
    Ok(split_position_keyset_page(children, limit)?.next_cursor)
}

/// A block as `get_block` and `get_page` return it (#5377): its row, every
/// `block_properties` row it has, the ids of the tags applied to it, and, for
/// a page, its aliases.
#[derive(Serialize)]
struct BlockWithMetadata {
    #[serde(flatten)]
    block: BlockRow,
    properties: Vec<PropertyRow>,
    tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    aliases: Option<Vec<String>>,
}

async fn with_metadata(pool: &SqlitePool, block: BlockRow) -> Result<BlockWithMetadata, AppError> {
    let properties = get_properties_inner(pool, block.id.clone()).await?;
    let tags = list_tags_for_block_inner(pool, block.id.clone()).await?;
    let aliases = if block.block_type == "page" {
        Some(get_page_aliases_inner(pool, block.id.as_str()).await?)
    } else {
        None
    };
    Ok(BlockWithMetadata {
        block,
        properties,
        tags,
        aliases,
    })
}

async fn handle_get_page_markdown(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: GetPageMarkdownArgs = parse_args(TOOL_GET_PAGE_MARKDOWN, args)?;
    let page_id = normalize_ulid_arg(&args.page_id);
    let space_id = SpaceId::from_string(args.space_id)?;
    validate_block_in_space(pool, &page_id, space_id.as_str()).await?;
    // The source `edit_page_markdown` takes back is never cut: a block left out
    // of it is deleted.
    let (markdown, next_cursor) = if args.editable {
        (get_page_source_inner(pool, &page_id).await?, None)
    } else {
        get_page_for_agent_paged_inner(pool, &page_id, args.cursor.as_deref(), RESPONSE_BYTES_CAP)
            .await?
    };
    Ok(json!({
        "page_id": page_id,
        "markdown": markdown,
        "truncated": next_cursor.is_some(),
        "next_cursor": next_cursor,
    }))
}

/// The SQLite bind-parameter budget: `tag_ids` plus every filter vector.
fn validate_search_term_count(args: &SearchArgs) -> Result<(), AppError> {
    let f = args.filter.as_ref();
    let total = args.tag_ids.as_ref().map_or(0, Vec::len)
        + f.map_or(0, |f| {
            f.include_page_globs.len()
                + f.exclude_page_globs.len()
                + f.state_filter.len()
                + f.priority_filter.len()
                + f.excluded_state_filter.len()
                + f.excluded_priority_filter.len()
                + f.property_filters.len()
                + f.excluded_property_filters.len()
        });
    if total > SEARCH_FILTER_TERMS_CAP {
        return Err(AppError::validation(format!(
            "{TOOL_SEARCH}: too many filter terms — tag_ids plus filter vectors total {total}, \
             max {SEARCH_FILTER_TERMS_CAP} (SQLite bind-parameter limit)"
        )));
    }
    Ok(())
}

/// #1607 — the count cap bounds how *many* terms arrive but not
/// how *large* each is. Cap every free-text term string by bytes (and
/// their combined size) so a handful of multi-megabyte strings can't
/// slip under the count cap and force huge allocations / expensive
/// glob / regex / SQL matching. `tag_ids`, `parent_id` and `space_id`
/// are ULID tokens, parsed strictly by the caller, but the
/// state/priority/block-type filter strings are NOT enum-validated —
/// `prepare_metadata_with_today` clones them verbatim and binds them
/// into the `IN (…)` predicate (`metadata_filter.rs`), so a single
/// multi-MB entry would otherwise sail past every cap. Cover the
/// `query`, both glob lists, the property-filter keys/values, the
/// block-type filter, the four state/priority vectors, and the
/// due/scheduled date strings.
fn validate_search_term_bytes(args: &SearchArgs) -> Result<(), AppError> {
    let f = args.filter.as_ref();
    let mut aggregate = 0usize;
    let mut check = |dimension: &str, s: &str| -> Result<(), AppError> {
        let len = s.len();
        if len > SEARCH_TERM_BYTES_CAP {
            return Err(AppError::validation(format!(
                "{TOOL_SEARCH}: {dimension} length {len} bytes exceeds maximum \
                 {SEARCH_TERM_BYTES_CAP} bytes per term"
            )));
        }
        aggregate += len;
        if aggregate > SEARCH_TERM_TOTAL_BYTES_CAP {
            return Err(AppError::validation(format!(
                "{TOOL_SEARCH}: combined search-term length exceeds maximum \
                 {SEARCH_TERM_TOTAL_BYTES_CAP} bytes across all terms"
            )));
        }
        Ok(())
    };
    check("query", &args.query)?;
    if let Some(f) = f {
        for g in &f.include_page_globs {
            check("include_page_globs entry", g)?;
        }
        for g in &f.exclude_page_globs {
            check("exclude_page_globs entry", g)?;
        }
        for pf in f
            .property_filters
            .iter()
            .chain(&f.excluded_property_filters)
        {
            check("property_filters key", &pf.key)?;
            check("property_filters value", &pf.value)?;
        }
        if let Some(bt) = &f.block_type_filter {
            check("block_type_filter", bt)?;
        }
        // state/priority vectors are free-text values bound into the SQL
        // `IN (…)` predicate (no enum allowlist), so byte-bound them too.
        for s in f
            .state_filter
            .iter()
            .chain(&f.priority_filter)
            .chain(&f.excluded_state_filter)
            .chain(&f.excluded_priority_filter)
        {
            check("state/priority filter entry", s)?;
        }
        // The explicit-operator date variant carries a user `date` string
        // (calendar-validated only later, after this budget gate).
        for df in f.due_filter.iter().chain(&f.scheduled_filter) {
            if let crate::commands::queries::DateFilter::Op { date, .. } = df {
                check("date filter", date)?;
            }
        }
    }
    Ok(())
}

async fn handle_search(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: SearchArgs = parse_args(TOOL_SEARCH, args)?;
    // Reject out-of-range explicitly; default to SEARCH_RESULT_CAP
    // when the caller omits `limit` so PageRequest::new does not fall
    // back to MAX_PAGE_SIZE=200.
    let validated = validate_limit(TOOL_SEARCH, args.limit, SEARCH_RESULT_CAP)?;
    let limit = Some(validated.unwrap_or(SEARCH_RESULT_CAP));
    // #699 — bound the input vectors before they reach SQL. Two budgets,
    // because neither bounds the other: how MANY terms arrived, and how LARGE
    // each of them is.
    validate_search_term_count(&args)?;
    validate_search_term_bytes(&args)?;
    // #3301 — every id resolves to a real one or errors: a string that matches
    // nothing reads to an agent as "no block carries that tag", and it does
    // not retry. A non-ULID names a page or tag in the space (#5397). Runs
    // after the two budget checks so an oversized vector still gets its own
    // actionable message.
    let space_id = SpaceId::from_string(args.space_id.as_str())?;
    let parent_id = match args.parent_id.as_deref() {
        Some(parent) => Some(
            resolve_id_arg(
                pool,
                TOOL_SEARCH,
                "parent_id",
                parent,
                Named::Page,
                space_id.as_str(),
            )
            .await?,
        ),
        None => None,
    };
    let tag_ids = resolve_id_args(
        pool,
        TOOL_SEARCH,
        "tag_ids",
        &args.tag_ids.unwrap_or_default(),
        Named::Tag,
        space_id.as_str(),
    )
    .await?;
    // Fold the optional structured `filter` arg into the
    // `SearchFilter` passed to `search_blocks_inner`. Omitting `filter`
    // Preserves the pre-existing contract (no metadata / glob / toggle
    // Filters applied). `space_id` is always required and
    // comes from the top-level arg; `parent_id` / `tag_ids` likewise
    // stay at the top level to keep the existing wire contract
    // backward-compatible.
    let f = args.filter.unwrap_or_default();
    // P4 (#346) — push the snippet truncation into the DB instead of
    // fetching up to 50 full block bodies and `.chars().take(...)`-ing them
    // in Rust. `search_blocks_inner` returns `content` already truncated to
    // `SEARCH_SNIPPET_CAP` codepoints (codepoint-safe `substr` on the
    // non-matching paths; post-match truncation on the toggle/regex paths).
    let resp = search_blocks_inner(
        pool,
        args.query,
        args.cursor,
        limit,
        crate::commands::SearchFilter {
            parent_id,
            tag_ids,
            // The MCP `search` tool searches the one space its required arg
            // names.
            // #2956 — validate the id via the strict `from_string` constructor
            // like every sibling tool (`list_backlinks`, `list_property_defs`,
            // `create_page`): a malformed / truncated / empty `space_id` must
            // error (`AppError::Ulid`, which `app_error_to_rmcp` maps to
            // JSON-RPC -32602 invalid-params, #3301) rather than silently
            // become an id that matches nothing (which would make an
            // agent wrongly conclude the vault is empty).
            scope: SearchScope::Spaces(vec![space_id]),
            include_page_globs: f.include_page_globs,
            exclude_page_globs: f.exclude_page_globs,
            case_sensitive: f.case_sensitive,
            whole_word: f.whole_word,
            is_regex: f.is_regex,
            block_type_filter: f.block_type_filter,
            state_filter: f.state_filter,
            priority_filter: f.priority_filter,
            due_filter: f.due_filter,
            scheduled_filter: f.scheduled_filter,
            property_filters: f.property_filters,
            excluded_property_filters: f.excluded_property_filters,
            excluded_state_filter: f.excluded_state_filter,
            excluded_priority_filter: f.excluded_priority_filter,
            // #1320-C — the MCP `search` tool does not expose a
            // `last-edited:` qualifier; leave the window filter unset.
            last_edited: None,
        },
        // P4 (#346) — DB-side truncation to SEARCH_SNIPPET_CAP codepoints.
        // `substr` on TEXT cuts on codepoint boundaries, so the output is
        // always valid UTF-8 even with multi-byte content (CJK, emoji).
        Some(SEARCH_SNIPPET_CAP),
    )
    .await?;
    // #828 — the backend snippet carries PUA sentinels (U+E000/U+E001); the
    // web UI parses them directly, but the agent-facing MCP contract is
    // <mark>/</mark>, so convert them back before serialising the result.
    let mut resp = resp;
    for row in &mut resp.items {
        if let Some(s) = row.snippet.take() {
            row.snippet = Some(
                s.replace(agaric_store::fts::SNIPPET_HL_OPEN, "<mark>")
                    .replace(agaric_store::fts::SNIPPET_HL_CLOSE, "</mark>"),
            );
        }
    }
    to_tool_result(&resp)
}

async fn handle_get_block(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: GetBlockArgs = parse_args(TOOL_GET_BLOCK, args)?;
    // Normalise ULID-shaped IDs to uppercase at the MCP boundary.
    let block_id = normalize_ulid_arg(&args.block_id);
    let space_id = SpaceId::from_string(args.space_id)?;
    validate_block_in_space(pool, &block_id, space_id.as_str()).await?;
    // `get_active_block_inner` (not `get_block_inner`) so an
    // agent cannot fetch tombstoned rows. The MCP read surface
    // mirrors the Tauri IPC `get_block` command's contract.
    let block = get_active_block_inner(pool, block_id.into()).await?;
    to_tool_result(&with_metadata(pool, block).await?)
}

async fn handle_list_backlinks(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListBacklinksArgs = parse_args(TOOL_LIST_BACKLINKS, args)?;
    let limit = validate_limit(TOOL_LIST_BACKLINKS, args.limit, LIST_RESULT_CAP)?;
    // #3301 — parse, don't wave through. `list_backlinks_grouped_inner`
    // rejects only an EMPTY `block_id`; a malformed one binds a string that
    // matches nothing and comes back as an empty grouped response, which an
    // agent reads as "this block has no backlinks" and does not retry.
    let block_id = BlockId::from_string(args.block_id)?;
    let scope = SpaceScope::Active(SpaceId::from_string(args.space_id)?);
    let mut resp =
        list_backlinks_grouped_inner(pool, block_id, None, None, args.cursor, limit, &scope, None)
            .await?;
    // #5402: whole groups up to the byte cap; the group cursor resumes after
    // the last group kept, as the store's own page boundary does.
    let keep = count_within_bytes_cap(resp.groups.iter().map(|group| {
        group
            .blocks
            .iter()
            .map(|row| row.content.as_deref().map_or(0, str::len))
            .sum::<usize>()
    }));
    if keep < resp.groups.len() {
        resp.groups.truncate(keep);
        let last = resp
            .groups
            .last()
            .expect("the cap keeps at least one group");
        resp.next_cursor =
            Some(Cursor::for_group(last.page_id.clone(), last.page_title.clone()).encode()?);
        resp.has_more = true;
        resp.truncated = true;
    }
    to_tool_result(&resp)
}

async fn handle_list_tags(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListTagsArgs = parse_args(TOOL_LIST_TAGS, args)?;
    let limit = validate_limit(TOOL_LIST_TAGS, args.limit, LIST_RESULT_CAP)?;
    let space_id = SpaceId::from_string(args.space_id)?;
    let resp = list_tags_inner(pool, space_id.as_str(), args.cursor, limit).await?;
    to_tool_result(&resp)
}

async fn handle_list_property_defs(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListPropertyDefsArgs = parse_args(TOOL_LIST_PROPERTY_DEFS, args)?;
    let limit = validate_limit(TOOL_LIST_PROPERTY_DEFS, args.limit, LIST_RESULT_CAP)?;
    let resp = list_property_defs_inner(pool, args.cursor, limit).await?;
    to_tool_result(&resp)
}

async fn handle_get_agenda(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: GetAgendaArgs = parse_args(TOOL_GET_AGENDA, args)?;
    let limit = validate_limit(TOOL_GET_AGENDA, args.limit, AGENDA_RESULT_CAP)?;
    let scope = SpaceScope::Active(SpaceId::from_string(args.space_id)?);
    let resp = agenda_range_inner(
        pool,
        args.start_date,
        args.end_date,
        args.cursor,
        limit,
        &scope,
    )
    .await?;
    to_tool_result(&resp)
}

/// Handle the `journal_for_date` MCP tool call.
///
/// **RO tool with a BOUNDED write side-effect (#2719).** Despite living
/// on the read-only [`ReadOnlyTools`] registry, this handler may emit a
/// single `CreateBlock` + `SetProperty(space)` op pair (origin
/// `agent:<name>`) when the requested date has no existing journal page
/// in the given space — but ONLY when `date` falls inside
/// [`within_journal_create_window`] (today ±
/// [`JOURNAL_CREATE_WINDOW_MONTHS`] months). The op lands in `op_log` via
/// [`journal_for_date_inner`] → `create_block_inner` and is reversible
/// from the agent activity feed like any other agent-authored write.
///
/// - **In-window + missing:** creates the page (mutates state) via
///   [`journal_for_date_inner`] on the writer pool. Idempotent per
///   `(space_id, date)` — only the first call in the window creates;
///   later calls are pure lookups.
/// - **Existing, in or out of the window:** pure lookup via
///   [`get_journal_page_by_date_inner`] on the reader pool — no write and no
///   writer lock (#5396).
/// - **Out-of-window + missing:** returns [`AppError::NotFound`]. The RO
///   surface never creates a page for an arbitrary far-future or
///   far-past date — that was the unbounded-mutation path #2719 closes
///   (any valid `YYYY-MM-DD` string, ~3.6M reachable dates per space,
///   each one a free `CreateBlock`+`SetProperty` op into the
///   non-reclaimable append-only `op_log`).
///
/// See the doc block on [`ReadOnlyTools`] for the pool-split rationale
/// (why the in-window create path needs the writer pool while every
/// other branch stays on the reader pool).
async fn handle_journal_for_date(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    view_emitter: &dyn ViewChangeEmitter,
    args: Value,
) -> Result<Value, AppError> {
    let args: JournalForDateArgs = parse_args(TOOL_JOURNAL_FOR_DATE, args)?;
    let date = chrono::NaiveDate::parse_from_str(&args.date, "%Y-%m-%d").map_err(|e| {
        AppError::validation(format!(
            "tool `{TOOL_JOURNAL_FOR_DATE}`: `date` must be YYYY-MM-DD — {e}"
        ))
    })?;
    // / #694: normalise the space ULID at the MCP boundary like
    // every other handler — the per-space lookup inside
    // `resolve_or_create_journal_page` matches `blocks.space_id`
    // case-sensitively, so a lowercase ULID previously surfaced as a
    // spurious "space not found" on this one tool.
    let space_id = normalize_ulid_arg(&args.space_id);
    let formatted = date.format("%Y-%m-%d").to_string();

    // A day that exists is a pure read on the reader pool: no writer lock.
    if let Some(row) = get_journal_page_by_date_inner(read_pool, &formatted, &space_id).await? {
        return to_tool_result(&row);
    }
    // #2719 — out-of-window: this tool may NEVER create here.
    if !within_journal_create_window(date) {
        return Err(AppError::NotFound(format!(
            "tool `{TOOL_JOURNAL_FOR_DATE}`: no journal page exists for '{formatted}' in space \
             '{space_id}', and '{formatted}' is outside the {JOURNAL_CREATE_WINDOW_MONTHS}-month \
             window around today in which this read-only tool is permitted to create one"
        )));
    }
    // In-window miss: lookup or create, idempotent per (space_id, date), on
    // the writer pool. #5314 — the page reaches open views as every RW
    // tool's write does; a lost race to another creator only costs an extra
    // reload.
    let resp = journal_for_date_inner(write_pool, device_id, materializer, date, &space_id).await?;
    view_emitter.emit_blocks_changed(vec![resp.id.as_str().to_owned()]);
    to_tool_result(&resp)
}

/// A day's journal page through the `get_page_markdown` renderer (#5396).
/// `today` is the device's date, passed in so a test can fix it.
async fn handle_get_journal(
    pool: &SqlitePool,
    args: Value,
    today: chrono::NaiveDate,
) -> Result<Value, AppError> {
    let args: GetJournalArgs = parse_args(TOOL_GET_JOURNAL, args)?;
    let date = resolve_journal_date(TOOL_GET_JOURNAL, args.date.as_deref(), today)?
        .format("%Y-%m-%d")
        .to_string();
    let space_id = SpaceId::from_string(args.space_id)?;
    let page = get_journal_page_by_date_inner(pool, &date, space_id.as_str()).await?;
    let markdown = match &page {
        Some(page) => get_page_for_agent_inner(pool, page.id.as_str()).await?,
        None => String::new(),
    };
    Ok(json!({
        "date": date,
        "page_id": page.map(|page| page.id),
        "markdown": markdown,
    }))
}

async fn handle_list_journal(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListJournalArgs = parse_args(TOOL_LIST_JOURNAL, args)?;
    let limit = validate_limit(TOOL_LIST_JOURNAL, args.limit, LIST_RESULT_CAP)?;
    let space_id = SpaceId::from_string(args.space_id)?;
    let resp = list_journal_days_inner(
        pool,
        space_id.as_str(),
        &args.from,
        &args.to,
        args.cursor,
        limit,
    )
    .await?;
    to_tool_result(&resp)
}

/// Handle the `list_spaces` MCP tool call (#633).
///
/// Pure read against the canonical `spaces` registry (#804). This is
/// the discovery entry point for the `space_id` argument every other tool
/// but `list_property_defs` requires — without it an agent
/// with no out-of-band configuration could not legally call any of
/// them. Returns a JSON array of `{ id, name, is_default }` rows.
async fn handle_list_spaces(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let _args: ListSpacesArgs = parse_args(TOOL_LIST_SPACES, args)?;
    let resp = list_spaces_registry_inner(pool).await?;
    to_tool_result(&resp)
}

async fn handle_page_history(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: PageHistoryArgs = parse_args(TOOL_PAGE_HISTORY, args)?;
    let limit = validate_limit(TOOL_PAGE_HISTORY, args.limit, LIST_RESULT_CAP)?;
    let space_id = SpaceId::from_string(args.space_id)?;
    // Resolves to a live block's id, so never to `__all__`, which would read
    // every space.
    let page_id = resolve_id_arg(
        pool,
        TOOL_PAGE_HISTORY,
        "page_id",
        &args.page_id,
        Named::Page,
        space_id.as_str(),
    )
    .await?;
    validate_block_in_space(pool, &page_id, space_id.as_str()).await?;
    let scope = SpaceScope::Active(space_id);
    let resp = list_page_history_inner(pool, page_id, None, &scope, args.cursor, limit).await?;
    history_result(pool, resp).await
}

async fn handle_block_history(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: BlockHistoryArgs = parse_args(TOOL_BLOCK_HISTORY, args)?;
    let limit = validate_limit(TOOL_BLOCK_HISTORY, args.limit, LIST_RESULT_CAP)?;
    let block_id = BlockId::from_string(&args.block_id)?;
    let space_id = SpaceId::from_string(args.space_id)?;
    validate_block_in_space(pool, block_id.as_str(), space_id.as_str()).await?;
    let resp = get_block_history_inner(pool, block_id, None, args.cursor, limit).await?;
    history_result(pool, resp).await
}

async fn handle_list_trash(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ListTrashArgs = parse_args(TOOL_LIST_TRASH, args)?;
    let limit = validate_limit(TOOL_LIST_TRASH, args.limit, LIST_RESULT_CAP)?;
    let space_id = SpaceId::from_string(args.space_id)?;
    let resp = list_trash_inner(pool, args.cursor, limit, space_id.as_str().to_owned()).await?;
    to_tool_result(&resp)
}

/// One name as `resolve` answers it.
#[derive(Serialize)]
struct ResolvedName {
    name: String,
    page_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    page_candidates: Vec<PageCandidate>,
    tag_id: Option<String>,
}

#[derive(Serialize)]
struct PageCandidate {
    id: String,
    title: String,
}

async fn handle_resolve(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: ResolveArgs = parse_args(TOOL_RESOLVE, args)?;
    agaric_store::pagination::ensure_batch_within_cap("names", args.names.len())?;
    let space_id = SpaceId::from_string(args.space_id)?;
    let mut conn = pool.acquire().await?;
    let pages = match_page_names(&mut conn, space_id.as_str(), &args.names).await?;
    let tags = match_tag_names(&mut conn, space_id.as_str(), &args.names).await?;
    let answers: Vec<ResolvedName> = args
        .names
        .into_iter()
        .zip(pages)
        .zip(tags)
        .map(|((name, page), tag)| {
            let (page_id, page_candidates) = match page {
                NameMatch::Id(id) => (Some(id), Vec::new()),
                NameMatch::Tie(ties) => (
                    None,
                    ties.into_iter()
                        .map(|(id, title)| PageCandidate { id, title })
                        .collect(),
                ),
                NameMatch::Unknown => (None, Vec::new()),
            };
            let tag_id = match tag {
                NameMatch::Id(id) => Some(id),
                NameMatch::Tie(_) | NameMatch::Unknown => None,
            };
            ResolvedName {
                name,
                page_id,
                page_candidates,
                tag_id,
            }
        })
        .collect();
    to_tool_result(&answers)
}

async fn handle_query(pool: &SqlitePool, args: Value) -> Result<Value, AppError> {
    let args: QueryArgs = parse_args(TOOL_QUERY, args)?;
    let limit = validate_limit(TOOL_QUERY, args.limit, LIST_RESULT_CAP)?;
    let space_id = SpaceId::from_string(args.space_id)?;
    let property_keys =
        touched_property_keys(&args.filter, args.group_by.as_ref(), &args.aggregate);
    let groups_name_blocks = matches!(args.group_by, Some(GroupKey::Page | GroupKey::Tag));
    let resp = compile_and_run(
        pool,
        AdvancedQueryRequest {
            space_id: space_id.as_str().to_owned(),
            filter: args.filter,
            sort: args.sort,
            cursor: args.cursor,
            limit,
            fulltext: None,
            group_by: args.group_by.map(|key| GroupSpec { key }),
            aggregates: args.aggregate,
        },
    )
    .await?;
    let titles = query_titles(pool, &resp, groups_name_blocks, space_id).await?;
    let mut properties = if property_keys.is_empty() {
        HashMap::new()
    } else {
        let ids = resp
            .rows
            .iter()
            .map(|r| BlockId::from(r.block.id.clone()))
            .collect();
        get_batch_properties_inner(pool, ids).await?
    };
    let title_of = |id: &str| titles.get(id).cloned().flatten();
    let rows = resp
        .rows
        .into_iter()
        .map(|r| {
            let mut props = properties.remove(r.block.id.as_str()).unwrap_or_default();
            props.retain(|p| property_keys.contains(&p.key));
            QueryRow::new(r.block, props, title_of)
        })
        .collect();
    let groups = resp
        .groups
        .into_iter()
        .map(|g| QueryGroupRow {
            title: title_of(&g.key),
            key: g.key,
            count: g.count,
            aggregates: g.aggregates,
        })
        .collect();
    to_tool_result(&QueryResult {
        rows,
        groups,
        aggregates: resp.aggregates,
        next_cursor: resp.next_cursor,
        has_more: resp.has_more,
        total_count: resp.total_count,
    })
}

/// The property keys a query reads off its own rows: `HasProperty` leaves
/// (not those inside `HasParentMatching`, which test the parent), a property
/// group key and property aggregate targets.
fn touched_property_keys(
    filter: &FilterExpr,
    group_by: Option<&GroupKey>,
    aggregates: &[AggregateSpec],
) -> HashSet<String> {
    fn walk(expr: &FilterExpr, keys: &mut HashSet<String>) {
        match expr {
            FilterExpr::Leaf {
                primitive: FilterPrimitive::HasProperty { key, .. },
            } => {
                keys.insert(key.clone());
            }
            FilterExpr::Leaf { .. } => {}
            FilterExpr::And { children } | FilterExpr::Or { children } => {
                for child in children {
                    walk(child, keys);
                }
            }
            FilterExpr::Not { child } => walk(child, keys),
        }
    }
    let mut keys = HashSet::new();
    walk(filter, &mut keys);
    if let Some(GroupKey::Property { key }) = group_by {
        keys.insert(key.clone());
    }
    for spec in aggregates {
        if let Some(AggregateTarget::Property { key }) = &spec.target {
            keys.insert(key.clone());
        }
    }
    keys
}

/// Titles for the rows' pages and, when the groups are keyed by page or tag
/// id, for the group keys, in one lookup.
async fn query_titles(
    pool: &SqlitePool,
    resp: &AdvancedQueryResponse,
    groups_name_blocks: bool,
    space_id: SpaceId,
) -> Result<HashMap<String, Option<String>>, AppError> {
    let mut ids: HashSet<String> = resp
        .rows
        .iter()
        .filter_map(|r| r.block.page_id.as_ref().map(|id| id.as_str().to_owned()))
        .collect();
    if groups_name_blocks {
        // The `none` bucket is not an id.
        ids.extend(
            resp.groups
                .iter()
                .filter_map(|g| BlockId::from_string(&g.key).ok().map(BlockId::into_string)),
        );
    }
    let ids = ids.iter().map(|id| BlockId::from_trusted(id)).collect();
    let resolved = batch_resolve_inner(pool, ids, &SpaceScope::Active(space_id)).await?;
    Ok(resolved.into_iter().map(|r| (r.id, r.title)).collect())
}

/// One `query` row: the block, its page's title and the touched properties.
#[derive(Serialize)]
struct QueryRow {
    id: String,
    page_id: Option<String>,
    page_title: Option<String>,
    content: Option<String>,
    block_type: String,
    todo_state: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    scheduled_date: Option<String>,
    properties: Vec<PropertyRow>,
}

impl QueryRow {
    fn new(
        b: ActiveBlockRow,
        properties: Vec<PropertyRow>,
        title_of: impl Fn(&str) -> Option<String>,
    ) -> Self {
        let page_id = b.page_id.map(BlockId::into_string);
        Self {
            page_title: page_id.as_deref().and_then(title_of),
            id: b.id.as_str().to_owned(),
            page_id,
            content: b.content,
            block_type: b.block_type,
            todo_state: b.todo_state,
            priority: b.priority,
            due_date: b.due_date,
            scheduled_date: b.scheduled_date,
            properties,
        }
    }
}

/// One `query` group. `title` names a page or tag key.
#[derive(Serialize)]
struct QueryGroupRow {
    key: String,
    title: Option<String>,
    count: i64,
    aggregates: Vec<AggregateResult>,
}

#[derive(Serialize)]
struct QueryResult {
    rows: Vec<QueryRow>,
    groups: Vec<QueryGroupRow>,
    aggregates: Vec<AggregateResult>,
    next_cursor: Option<String>,
    has_more: bool,
    total_count: Option<i64>,
}

/// Longest before / after text a history row carries, in chars: the row
/// describes a change, `get_block` returns the content.
const HISTORY_TEXT_CAP: usize = 80;

/// One op as `page_history` / `block_history` return it.
#[derive(Serialize)]
struct HistoryRow {
    device_id: String,
    seq: i64,
    origin: Option<String>,
    op_type: String,
    created_at: i64,
    is_replicated: bool,
    block_id: Option<String>,
    before: Option<String>,
    after: Option<String>,
}

async fn history_result(
    pool: &SqlitePool,
    resp: PageResponse<HistoryEntry>,
) -> Result<Value, AppError> {
    let refs: Vec<OpRef> = resp
        .items
        .iter()
        .map(|e| OpRef {
            device_id: e.device_id.clone(),
            seq: e.seq,
        })
        .collect();
    let origins = fetch_op_origins(pool, &refs).await?;
    let payloads = resp
        .items
        .iter()
        .map(|e| serde_json::from_str::<Value>(&e.payload))
        .collect::<Result<Vec<_>, _>>()?;
    let mut before_texts = prior_texts(pool, &resp.items, &payloads).await?;
    let mut items = Vec::with_capacity(resp.items.len());
    for (entry, payload) in resp.items.into_iter().zip(payloads) {
        let origin = origins
            .iter()
            .find(|o| o.device_id == entry.device_id && o.seq == entry.seq)
            .map(|o| o.origin.clone());
        let before = before_texts.remove(&(entry.device_id.clone(), entry.seq));
        items.push(history_row(entry, &payload, origin, before));
    }
    to_tool_result(&json!({
        "items": items,
        "next_cursor": resp.next_cursor,
        "has_more": resp.has_more,
    }))
}

fn payload_block_id(payload: &Value) -> Option<&str> {
    payload.get("block_id").and_then(Value::as_str)
}

/// The text each `edit_block` entry replaced, keyed by `(device_id, seq)`:
/// `agaric_engine::reverse::find_prior_text` for the whole page in one query.
async fn prior_texts(
    pool: &SqlitePool,
    entries: &[HistoryEntry],
    payloads: &[Value],
) -> Result<HashMap<(String, i64), String>, AppError> {
    let keys: Vec<Value> = entries
        .iter()
        .zip(payloads)
        .filter(|(e, _)| e.op_type == "edit_block")
        .filter_map(|(e, p)| {
            Some(json!({
                "block_id": payload_block_id(p)?,
                "created_at": e.created_at,
                "seq": e.seq,
                "device_id": e.device_id,
            }))
        })
        .collect();
    let keys_json = serde_json::to_string(&keys)?;
    let rows = sqlx::query!(
        r#"WITH k AS (
             SELECT upper(json_extract(value, '$.block_id')) AS block_id,
                    json_extract(value, '$.created_at') AS created_at,
                    json_extract(value, '$.seq') AS seq,
                    json_extract(value, '$.device_id') AS device_id
               FROM json_each(?))
           SELECT k.device_id AS "device_id!: String", k.seq AS "seq!: i64",
                  (SELECT CASE o.op_type WHEN 'edit_block' THEN json_extract(o.payload, '$.to_text')
                                         ELSE json_extract(o.payload, '$.content') END
                     FROM op_log o
                    WHERE o.block_id = k.block_id
                      AND o.op_type IN ('edit_block', 'create_block')
                      AND o.is_replicated = 0
                      AND (o.created_at, o.seq, o.device_id) < (k.created_at, k.seq, k.device_id)
                    ORDER BY o.created_at DESC, o.seq DESC, o.device_id DESC
                    LIMIT 1) AS "before?: String"
             FROM k"#,
        keys_json,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| Some(((r.device_id, r.seq), r.before?)))
        .collect())
}

fn history_row(
    entry: HistoryEntry,
    payload: &Value,
    origin: Option<String>,
    before: Option<String>,
) -> HistoryRow {
    HistoryRow {
        after: history_after(&entry.op_type, payload),
        device_id: entry.device_id,
        seq: entry.seq,
        origin,
        op_type: entry.op_type,
        created_at: entry.created_at,
        is_replicated: entry.is_replicated,
        block_id: payload_block_id(payload).map(str::to_owned),
        before: before.map(|text| clip_history_text(&text)),
    }
}

/// The text or property value an op leaves behind, clipped.
fn history_after(op_type: &str, payload: &Value) -> Option<String> {
    let field = |key: &str| payload.get(key).filter(|v| !v.is_null());
    match op_type {
        "create_block" => field("content")?.as_str().map(clip_history_text),
        "edit_block" => field("to_text")?.as_str().map(clip_history_text),
        "set_property" => {
            let key = field("key")?.as_str()?;
            let value = [
                "value_text",
                "value_num",
                "value_date",
                "value_ref",
                "value_bool",
            ]
            .iter()
            .find_map(|k| field(k))?;
            let value = value
                .as_str()
                .map_or_else(|| value.to_string(), str::to_owned);
            Some(clip_history_text(&format!("{key}={value}")))
        }
        _ => None,
    }
}

/// Clips on a char boundary, so multi-byte text never splits.
fn clip_history_text(text: &str) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(HISTORY_TEXT_CAP).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Tests — split-pool semantics for `journal_for_date`
//
// These tests exercise the production wiring that `mk_tools()` deliberately
// does not: separate reader (`PRAGMA query_only = ON`) and writer pools,
// Just like `init_pools()`. The bug fixed by was that `ReadOnlyTools`
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
    use agaric_store::task_locals::{Actor, ActorContext};
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

    /// Helper for the split-pool fixture: create a single
    /// space on the *writer* pool (the reader pool is `query_only = ON`
    /// and would reject the CreateBlock op).
    ///
    /// Takes an existing `Materializer` rather than constructing a new
    /// one — building a second `Materializer` over the same writer pool
    /// spawns another set of background consumers (foreground, background,
    /// cache-init, metrics tasks) that compete for the writer pool's
    /// `max_connections(2)` budget. Under nextest's parallel test load the
    /// extra contention pushed `journal_for_date_finds_existing_page_via_either_pool`
    /// past sqlx's 30 s pool-acquire deadline → `Database(PoolTimedOut)`
    /// on every retry. Reusing the test-scoped materializer halves the
    /// background-task count and keeps the first `call_tool` inside its
    /// budget.
    async fn mk_space(write_pool: &SqlitePool, materializer: &Materializer, name: &str) -> String {
        create_space_inner(write_pool, DEV, materializer, name.into(), None)
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

    /// Reproduction of the production failure: with the old wiring
    /// (`pool` = reader-only) the very first `journal_for_date` call for
    /// a missing date opens `BEGIN IMMEDIATE` and INSERTs into `op_log`
    /// + `blocks`, which `query_only = ON` rejects as `SQLITE_READONLY`
    /// and surfaces as JSON-RPC `-32603`. With the writer pool wired in
    /// the create branch succeeds and we get back a freshly minted
    /// journal page.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn journal_for_date_uses_writer_pool_for_missing_date() {
        let (tools, mat, _dir) = mk_split_tools().await;
        // Seed a space on the writer pool so the lookup has
        // somewhere to scope under.
        let space = mk_space(&tools.writer_pool, &mat, "Personal").await;

        // #2719 — must stay inside the bounded create window (today ±
        // JOURNAL_CREATE_WINDOW_MONTHS), so compute the date relative to
        // "today" instead of a fixed literal that would eventually (and,
        // relative to this repo's current clock, already does) drift
        // outside the window and start hitting the NotFound branch
        // instead of the create branch this test targets.
        let date = (chrono::Local::now().date_naive() + chrono::Days::new(30))
            .format("%Y-%m-%d")
            .to_string();

        // No journal page exists for this date — the call must hit the
        // create branch, which is the path that previously failed on the
        // query_only=ON reader pool.
        let result = tools
            .call_tool(
                "journal_for_date",
                json!({"date": date, "space_id": space}),
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
            Some(date.as_str()),
            "expected `content` == requested date, got {value:?}",
        );
    }

    /// Sanity check that the lookup branch of `journal_for_date` works
    /// across pool wirings: idempotency on a date that already has a
    /// page must succeed whether the registry is wired with the
    /// Production split (reader pool + writer pool) or the legacy
    /// combined `init_pool` wiring used by the in-tree test fixture
    /// (`mk_tools()`). An existing day is read on the reader pool without
    /// the writer lock (#5396), so the split lookup runs while another
    /// connection holds that lock.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn journal_for_date_finds_existing_page_via_either_pool() {
        // ── Wiring A — production split via init_pools() ──────────────
        let (tools_split, mat_split, _dir_split) = mk_split_tools().await;
        let space_split = mk_space(&tools_split.writer_pool, &mat_split, "Personal").await;
        // #2719 — computed relative to "today" so the first `call_tool`
        // below (which must hit the create branch) stays inside the
        // bounded create window regardless of when this test runs.
        let date = (chrono::Local::now().date_naive() + chrono::Days::new(31))
            .format("%Y-%m-%d")
            .to_string();
        let date = date.as_str();

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
        mat_split.flush_background().await.unwrap();

        // Second call finds the same page via the lookup branch while
        // another connection holds the writer lock: a lookup that took it
        // would wait out the busy timeout and fail.
        let mut holder = tools_split.writer_pool.acquire().await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *holder)
            .await
            .unwrap();
        let second = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tools_split.call_tool(
                "journal_for_date",
                json!({"date": date, "space_id": space_split}),
                &test_ctx(),
            ),
        )
        .await
        .expect("an existing day is read without waiting for the writer lock")
        .expect("lookup branch must succeed on the production split wiring when the page exists");
        sqlx::query("ROLLBACK").execute(&mut *holder).await.unwrap();
        drop(holder);
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
        let space_combined = mk_space(&combined, &mat_combined, "Personal").await;
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

    /// #5402: a read's space check runs on the reader pool, so the reads
    /// that address a block or page by id answer while another connection
    /// holds the writer lock; a check that took it would wait out the busy
    /// timeout.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn id_addressed_reads_never_wait_for_the_writer_5402() {
        let (tools, mat, _dir) = mk_split_tools().await;
        let space = mk_space(&tools.writer_pool, &mat, "Personal").await;
        let page = create_page_in_space_inner(
            &tools.writer_pool,
            DEV,
            &mat,
            None,
            "Read me".into(),
            space.clone(),
        )
        .await
        .unwrap();
        let block = crate::commands::create_block_inner(
            &tools.writer_pool,
            DEV,
            &mat,
            "content".into(),
            "a block".into(),
            Some(page.clone()),
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let mut holder = tools.writer_pool.acquire().await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *holder)
            .await
            .unwrap();
        for (name, args) in [
            (
                "get_block",
                json!({"block_id": block.id, "space_id": space}),
            ),
            (
                "get_page_markdown",
                json!({"page_id": page, "space_id": space}),
            ),
            ("page_history", json!({"page_id": page, "space_id": space})),
            (
                "block_history",
                json!({"block_id": block.id, "space_id": space}),
            ),
        ] {
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                tools.call_tool(name, args, &test_ctx()),
            )
            .await
            .unwrap_or_else(|_| panic!("{name} waited for the writer lock"))
            .unwrap_or_else(|e| panic!("{name} must succeed: {e:?}"));
        }
        sqlx::query("ROLLBACK").execute(&mut *holder).await.unwrap();
    }
}

// ---------------------------------------------------------------------------
// Tests — #2719: bounded create window for `journal_for_date`
//
// Before this fix, `handle_journal_for_date` parsed ANY valid `YYYY-MM-DD`
// string and delegated straight into `journal_for_date_inner`, which
// creates the page unconditionally on a miss — an unbounded mutation path
// on the nominally read-only socket (any of ~3.6M reachable dates per
// space, each one a free, non-reclaimable `CreateBlock` + `SetProperty`
// op pair into `op_log`). These tests pin the bounded-window fix:
//
//   (a) an in-window MISSING date still creates exactly one page — the
//       pre-#2719 happy path is unchanged.
//   (b) an out-of-window MISSING date is rejected with `NotFound` and
//       appends NO op to `op_log` — the create path stays closed.
//   (c) an out-of-window EXISTING date is returned as a pure read (no
//       new op) rather than erroring or trying to re-create it.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests_2719 {
    use super::*;
    use crate::commands::create_space_inner;
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use agaric_store::task_locals::{Actor, ActorContext};
    use serde_json::json;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const DEV: &str = "test-mcp-dev-2719";

    fn test_ctx() -> ActorContext {
        ActorContext {
            actor: Actor::Agent {
                name: "test-agent-2719".to_string(),
            },
            request_id: "req-test-2719".to_string(),
        }
    }

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test-2719.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Combined-pool fixture (mirrors `tools_ro::tests::mk_tools()`) — the
    /// pool-split (reader `query_only=ON` vs writer) wiring is covered
    /// separately by `tests_m82`; these tests are only about the window
    /// gate, so a single combined pool keeps the fixture minimal.
    async fn mk_tools(pool: &SqlitePool, mat: &Materializer) -> ReadOnlyTools {
        ReadOnlyTools::new(pool.clone(), pool.clone(), mat.clone(), DEV.to_string())
    }

    async fn mk_space(pool: &SqlitePool, mat: &Materializer, name: &str) -> String {
        create_space_inner(pool, DEV, mat, name.into(), None)
            .await
            .expect("create_space must succeed")
            .into_string()
    }

    /// Count `CreateBlock` ops in `op_log`. Uses the runtime
    /// (non-`!`-macro) `query_scalar` form deliberately — this is a new
    /// query text with no pre-generated `.sqlx` cache entry, and the
    /// `query_scalar!` macro would fail an offline compile without one.
    async fn create_block_op_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log WHERE op_type = 'create_block'")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// (a) In-window happy path: preserves the pre-#2719 behaviour
    /// exactly — a missing date inside today ± JOURNAL_CREATE_WINDOW_MONTHS
    /// creates exactly one page.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn in_window_missing_date_creates_page() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, &mat, "Personal").await;
        mat.flush_background().await.unwrap();
        let tools = mk_tools(&pool, &mat).await;

        let date = (chrono::Local::now().date_naive() + chrono::Days::new(60))
            .format("%Y-%m-%d")
            .to_string();

        let before = create_block_op_count(&pool).await;
        let result = tools
            .call_tool(
                "journal_for_date",
                json!({"date": date, "space_id": space}),
                &test_ctx(),
            )
            .await
            .expect("in-window missing date must create the page");
        mat.flush_background().await.unwrap();

        assert_eq!(result["block_type"], "page");
        assert_eq!(result["content"], date);
        let after = create_block_op_count(&pool).await;
        assert_eq!(
            after,
            before + 1,
            "exactly one CreateBlock op must be appended for the new in-window page"
        );

        // Idempotent: a second call for the same (space, date) returns
        // the same page and appends no further op.
        let again = tools
            .call_tool(
                "journal_for_date",
                json!({"date": date, "space_id": space}),
                &test_ctx(),
            )
            .await
            .expect("second call must succeed (lookup branch)");
        mat.flush_background().await.unwrap();
        assert_eq!(again["id"], result["id"], "must be idempotent");
        assert_eq!(
            create_block_op_count(&pool).await,
            after,
            "idempotent second call must not append another CreateBlock op"
        );
    }

    /// (b) Out-of-window MISSING date: must NOT create a page. The tool
    /// returns `AppError::NotFound` and appends NO op to `op_log`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn out_of_window_missing_date_returns_not_found_and_creates_no_op() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, &mat, "Personal").await;
        mat.flush_background().await.unwrap();
        let tools = mk_tools(&pool, &mat).await;

        // 13 months out guarantees outside the 12-month window regardless
        // of leap years / month-length edge cases.
        let date = (chrono::Local::now().date_naive() + chrono::Months::new(13))
            .format("%Y-%m-%d")
            .to_string();

        let before = create_block_op_count(&pool).await;
        let err = tools
            .call_tool(
                "journal_for_date",
                json!({"date": date, "space_id": space}),
                &test_ctx(),
            )
            .await
            .expect_err("out-of-window missing date must be rejected, not created");
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected AppError::NotFound, got {err:?}"
        );
        mat.flush_background().await.unwrap();
        let after = create_block_op_count(&pool).await;
        assert_eq!(
            after, before,
            "out-of-window miss must not append any CreateBlock op to op_log"
        );
    }

    /// (c) Out-of-window date whose page ALREADY EXISTS: returned as a
    /// pure read rather than erroring or attempting to re-create it. The
    /// page is seeded directly via the shared `journal_for_date_inner`
    /// helper (bypassing the RO handler's window gate entirely, the same
    /// way a page created while still in-window would persist after the
    /// rolling window has since moved past its date).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn out_of_window_existing_date_is_returned_as_pure_read() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, &mat, "Personal").await;
        mat.flush_background().await.unwrap();
        let tools = mk_tools(&pool, &mat).await;

        let naive_date = chrono::Local::now().date_naive() + chrono::Months::new(14);
        let date = naive_date.format("%Y-%m-%d").to_string();

        let seeded = journal_for_date_inner(&pool, DEV, &mat, naive_date, &space)
            .await
            .expect("seed the page directly via the shared inner helper");
        mat.flush_background().await.unwrap();
        let seeded_id = seeded.id.into_string();

        let before = create_block_op_count(&pool).await;
        let result = tools
            .call_tool(
                "journal_for_date",
                json!({"date": date, "space_id": space}),
                &test_ctx(),
            )
            .await
            .expect("out-of-window EXISTING date must be returned as a pure read");
        mat.flush_background().await.unwrap();

        assert_eq!(
            result["id"].as_str(),
            Some(seeded_id.as_str()),
            "must return the pre-existing page, not create a new one"
        );
        assert_eq!(result["block_type"], "page");
        let after = create_block_op_count(&pool).await;
        assert_eq!(
            after, before,
            "returning an existing out-of-window page must not append any op"
        );
    }
}
