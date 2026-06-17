//! Shared search domain types (#642).
//!
//! These row / filter types are the wire shapes for the `search_blocks`
//! family of commands. They were previously defined in
//! `crate::commands::queries`; moving them into the neutral `domain` layer
//! lets `crate::fts` (the SQL composition layer that actually consumes
//! them) depend *down* on `crate::domain` instead of *up* on
//! `crate::commands`, breaking the `commands ⇄ fts` module cycle.
//!
//! The definitions are moved **verbatim** — same fields, same derives
//! (`serde`, `specta::Type`), same serde renames — so the IPC wire format
//! and the generated TS bindings are byte-for-byte unchanged. The old
//! `crate::commands::queries` path re-exports them so command-internal
//! callers and `tauri-specta` collection are untouched.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::filters::primitive::LastEditedSpec;

/// PEND-53 — Date-filter shape used by [`SearchFilter::due_filter`] /
/// [`SearchFilter::scheduled_filter`].
///
/// Two variants:
///
/// - [`DateFilter::Named`] — bucket keyword resolved at query time
///   against `chrono::Local::today()` (or the cell-injected clock in
///   tests). Vocabulary: `overdue`, `today`, `yesterday`, `this-week`,
///   `this-month`, `next-week`, `older`, `none`. Unknown keywords are
///   rejected as `Validation("InvalidDateFilter: …")`.
/// - [`DateFilter::Op`] — explicit comparison operator (`<`, `<=`, `=`,
///   `>=`, `>`) followed by an ISO `YYYY-MM-DD` date. The frontend
///   parser accepts the same shape (`due:>=2026-01-01`).
///
/// `#[serde(rename_all = "camelCase")]` on the enum variants keeps the
/// wire shape ergonomic for the TS side: the AST projection emits
/// `{ named: "today" }` or `{ op: { op: "gte", date: "2026-01-01" } }`.
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DateFilter {
    /// Named bucket — resolved to a date predicate at query time.
    Named(NamedDateRange),
    /// Explicit comparison operator + ISO date.
    Op {
        /// One of [`DateOp::Lt`] / [`DateOp::Lte`] / [`DateOp::Eq`] /
        /// [`DateOp::Gte`] / [`DateOp::Gt`].
        op: DateOp,
        /// ISO `YYYY-MM-DD`. Calendar-validated at the SQL composition
        /// boundary; invalid dates yield `Validation("InvalidDateFilter:
        /// …")`.
        date: String,
    },
}

/// PEND-53 — Named date buckets recognised by [`DateFilter::Named`].
///
/// Resolution semantics (today = `chrono::Local::today()`):
///
/// - `Overdue`   → column `< today AND column IS NOT NULL`.
/// - `Today`     → column `= today`.
/// - `Yesterday` → column `= today - 1d`.
/// - `ThisWeek`  → column `BETWEEN start_of_week AND end_of_week` (Mon..Sun).
/// - `ThisMonth` → column `BETWEEN start_of_month AND end_of_month`.
/// - `NextWeek`  → column `BETWEEN start_of_next_week AND end_of_next_week`.
/// - `Older`     → column `< today - 30d AND column IS NOT NULL`.
/// - `None`      → column `IS NULL`. Used by `state:none` analogue —
///   "show blocks with no scheduled/due date".
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NamedDateRange {
    Overdue,
    Today,
    Yesterday,
    ThisWeek,
    ThisMonth,
    NextWeek,
    Older,
    None,
}

/// PEND-53 — Comparison operator for [`DateFilter::Op`]. Mirrors the
/// frontend parser shape (`<`, `<=`, `=`, `>=`, `>`).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DateOp {
    Lt,
    Lte,
    Eq,
    Gte,
    Gt,
}

impl DateOp {
    /// SQL operator string.
    #[must_use]
    pub fn as_sql(self) -> &'static str {
        match self {
            DateOp::Lt => "<",
            DateOp::Lte => "<=",
            DateOp::Eq => "=",
            DateOp::Gte => ">=",
            DateOp::Gt => ">",
        }
    }
}

/// PEND-53 — Property predicate for [`SearchFilter::property_filters`] /
/// [`SearchFilter::excluded_property_filters`].
///
/// Named separately from the (existing) `PropertyFilter` struct used by
/// `filtered_blocks_query` — that one carries five typed value fields and
/// a comparison operator; this one is the simpler `(key, value_text)`
/// shape the inline `prop:key=value` token produces.
///
/// `value` is matched against `block_properties.value_text` (the
/// most-common case for user-typed properties; locked in by the plan's
/// "Locked-in decisions" #4). An empty `value` matches "block has this
/// key at all" (`block_properties.value_text IS NOT NULL` is NOT
/// required — only the key presence).
#[derive(Debug, Clone, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchPropertyFilter {
    /// Property key — case-sensitive (locked in by plan #1).
    pub key: String,
    /// Property value — matched against `block_properties.value_text`.
    /// Empty string treated as "key presence only".
    pub value: String,
}

/// Optional filter bundle for `search_blocks_inner`.
///
/// PEND-50 Phase 0 collapses the previous positional `parent_id` /
/// `tag_ids` / `space_id` args into a single struct so the `tauri-specta`
/// 10-arg ceiling stays comfortable as follow-up plans append filter
/// fields. Every field carries `#[serde(default)]` — a missing key on
/// the wire deserialises to the field's `Default`, which preserves
/// today's "no filter" behaviour. Follow-up plans append new fields the
/// same way; they MUST NOT add positional args.
///
/// Future appendees (locked in by PEND-50's design section):
///
/// - PEND-54: `include_page_globs`, `exclude_page_globs` (`Vec<String>`).
/// - PEND-55: `case_sensitive`, `whole_word`, `is_regex` (`bool`).
/// - PEND-51: `block_type_filter` (`Option<String>`).
/// - PEND-53: `state_filter`, `priority_filter`, `due_filter`,
///   `scheduled_filter`, `property_filters`, `excluded_property_filters`.
#[derive(Debug, Clone, Default, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilter {
    /// Restrict results to direct children of this parent block.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Restrict results to blocks carrying every tag in this list
    /// (`ALL` semantics — see `fts::search_fts`).
    #[serde(default)]
    pub tag_ids: Vec<String>,
    /// FEAT-3p4 — restrict to blocks whose owning page lives in this
    /// space. Empty string is treated as "no match" by the SQL path
    /// (returns an empty page), matching pre-bootstrap callers that
    /// pass `''`.
    #[serde(default)]
    pub space_id: Option<String>,
    /// PEND-54 — page-name glob include list. Each entry may use
    /// SQLite `GLOB` syntax (`*`, `?`, `[...]`) and `{a,b}` brace
    /// expansion. Bare tokens are wrapped with `*…*` for a
    /// substring match. Resolved against `pages_cache.title` with
    /// `LOWER(...)` for case-insensitive matching. See
    /// `fts::glob_filter::prepare_globs` for the parsing pipeline.
    #[serde(default)]
    pub include_page_globs: Vec<String>,
    /// PEND-54 — page-name glob exclude list. Same shape as
    /// [`Self::include_page_globs`]; AND-joined into a `NOT IN (...)`
    /// sub-select. A page matching both include and exclude is
    /// excluded.
    #[serde(default)]
    pub exclude_page_globs: Vec<String>,
    /// PEND-55 — case-sensitive search toggle. When `true`, results are
    /// narrowed by a post-FTS regex pass that asserts case-sensitive
    /// match against `fts_blocks.stripped`. The FTS5 trigram tokenizer
    /// is `case_sensitive 0`, so the candidate set is still
    /// case-insensitive; this toggle forces the post-filter even when
    /// the other toggles are off (documented cost). `#[serde(default)]`
    /// keeps the wire shape additive — pre-PEND-55 frontends omit the
    /// field and observe today's behaviour unchanged.
    #[serde(default)]
    pub case_sensitive: bool,
    /// PEND-55 — whole-word search toggle. ASCII-only via the regex
    /// crate's `(?-u:\b)` predicate. CJK content does NOT match `\b`
    /// (no ASCII word boundary inside CJK runs); v1 documents this and
    /// a future plan revisits Unicode whole-word.
    #[serde(default)]
    pub whole_word: bool,
    /// PEND-55 — regex-mode search toggle. The query string is treated
    /// as a Rust [`regex`] pattern verbatim; the FTS5 MATCH path is
    /// **bypassed entirely** (FTS5 cannot accept a regex) and the
    /// candidate set comes from a recency-ordered scan of
    /// structurally-filtered blocks. Compile failures surface as
    /// [`AppError::Validation`] with an `InvalidRegex:` prefix.
    #[serde(default)]
    pub is_regex: bool,
    /// PEND-51 — restrict matches to a specific `blocks.block_type`
    /// value (e.g. `"page"`). `None` (the default) preserves the
    /// existing "no filter" behaviour. Empty string is rejected at the
    /// SQL layer the same way as any other no-match equality. The
    /// palette uses this to fire a separate page-only query in
    /// parallel with the unrestricted blocks query so the page-group
    /// rendering on the FE only needs to merge by `page_id`.
    /// `#[serde(default)]` keeps the wire shape additive — pre-PEND-51
    /// frontends omit the field and observe today's behaviour
    /// unchanged.
    #[serde(default)]
    pub block_type_filter: Option<String>,
    /// PEND-53 — restrict matches to blocks with `blocks.todo_state IN
    /// (...)`. Each entry is matched verbatim — the column is a
    /// free-form `TEXT` so custom states are allowed. The literal
    /// keyword `none` (case-insensitive) selects `todo_state IS NULL`
    /// (the `state:none` token); a custom state literally called
    /// `"none"` is still matched correctly because the AST projects
    /// `state:none` into a distinct sentinel (see the SQL composition).
    #[serde(default)]
    pub state_filter: Vec<String>,
    /// PEND-53 — `blocks.priority IN (...)`. Same `none` sentinel
    /// behaviour as `state_filter`.
    #[serde(default)]
    pub priority_filter: Vec<String>,
    /// PEND-53 — date predicate on `blocks.due_date`. `None` means
    /// "no filter".
    #[serde(default)]
    pub due_filter: Option<DateFilter>,
    /// PEND-53 — date predicate on `blocks.scheduled_date`.
    #[serde(default)]
    pub scheduled_filter: Option<DateFilter>,
    /// PEND-53 — AND-joined property filters. Each entry adds an
    /// `EXISTS (SELECT 1 FROM block_properties …)` sub-select against
    /// `value_text` (locked in by plan #4).
    #[serde(default)]
    pub property_filters: Vec<SearchPropertyFilter>,
    /// PEND-53 — AND-joined property exclusions. Each entry adds a
    /// `NOT EXISTS (...)` sub-select.
    #[serde(default)]
    pub excluded_property_filters: Vec<SearchPropertyFilter>,
    /// PEND-63 — `blocks.todo_state IS NULL OR todo_state NOT IN
    /// (...)`. Each entry is matched verbatim against the column. The
    /// inversion intentionally includes NULL: a "blocks not in DONE"
    /// query should return blocks with no state set at all, not
    /// exclude them. The literal keyword `none` (case-insensitive)
    /// flips to `todo_state IS NOT NULL` (the `not-state:none` token);
    /// a custom state literally called `"none"` is treated as the
    /// sentinel — documented in `docs/SEARCH.md`. Empty list = no
    /// filter (preserves pre-PEND-63 wire compat).
    #[serde(default)]
    pub excluded_state_filter: Vec<String>,
    /// PEND-63 — `blocks.priority IS NULL OR priority NOT IN (...)`.
    /// Same `none` sentinel behaviour as
    /// [`Self::excluded_state_filter`].
    #[serde(default)]
    pub excluded_priority_filter: Vec<String>,
    /// #1320-C — `last-edited:` time-window predicate. Resolved against
    /// each block's last `op_log.created_at` (epoch-ms `MAX(...)`,
    /// COALESCE'd to the epoch sentinel for blocks with no op-log row).
    /// `None` (the default) preserves the existing "no filter" behaviour.
    /// Compiled through [`crate::filters::primitive::SearchProjection`]
    /// (`compile_last_edited`) and spliced into the dynamic FTS WHERE via
    /// the [`crate::fts::filter_builder`] projection routing — see the
    /// `add_last_edited_via_projection` splice. `#[serde(default)]` keeps
    /// the wire shape additive: pre-#1320-C frontends omit the field and
    /// observe today's behaviour unchanged.
    #[serde(default)]
    pub last_edited: Option<LastEditedSpec>,
}

/// Match span emitted by the PEND-55 toggle pipeline.
///
/// The `start` / `end` indices are **UTF-16 code-unit offsets** into the
/// block's content string — chosen to match JavaScript's native string
/// indexing (`.length`, `.substring`, `.charCodeAt`). Rust's `regex`
/// crate reports byte offsets into a UTF-8 buffer; the post-filter
/// pipeline converts to UTF-16 before serialising so the frontend can
/// slice `row.content` directly. ASCII content has identical byte /
/// UTF-16 indices; CJK and emoji content does not. See
/// `pending/PEND-55-search-toggles-history.md` (UTF-8 → UTF-16 section)
/// for the rationale and the conversion helper.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchOffset {
    /// UTF-16 code-unit offset (matches JavaScript string indexing).
    pub start: u32,
    /// UTF-16 code-unit offset (matches JavaScript string indexing).
    pub end: u32,
}

/// Response row for `search_blocks_inner`.
///
/// Mirrors `ActiveBlockRow` column-for-column so the wire format is a
/// strict superset (every field in `ActiveBlockRow` is reproduced
/// verbatim) and adds `snippet` — the FTS5 [`snippet`] window with
/// #828 PUA sentinel boundaries (U+E000 open / U+E001 close) on every
/// match span. The web UI parses the sentinels into React nodes (no
/// `dangerouslySetInnerHTML`); the MCP search tool converts them back to
/// `<mark>` / `</mark>` so the agent-facing contract is unchanged. See
/// `pending/PEND-50-search-vscode-ux.md` for the renderer contract.
///
/// PEND-55 appends `match_offsets: Vec<MatchOffset>` for the
/// regex/whole-word offset rendering path; `#[serde(default)]` keeps
/// the wire shape additive (pre-PEND-55 frontends see an empty array
/// from absent payloads and fall through to the snippet path).
///
/// [`snippet`]: https://www.sqlite.org/fts5.html#the_snippet_function
#[derive(Debug, Clone, Serialize, Type)]
pub struct SearchBlockRow {
    pub id: crate::ulid::ActiveBlockId,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    /// Epoch-ms (blocks.deleted_at is INTEGER since migration 0080). Always
    /// `None` on search rows — the FTS SQL filters `deleted_at IS NULL` — but
    /// typed as `i64` to match the rest of the #109 cluster.
    pub deleted_at: Option<i64>,
    pub todo_state: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
    pub scheduled_date: Option<String>,
    pub page_id: Option<String>,
    /// FTS5 `snippet()` window for the matched block. `None` when the
    /// match has no content snippet (e.g. a page-title-only hit on a
    /// block with `content IS NULL`). Contains #828 PUA sentinel
    /// boundaries (U+E000 open / U+E001 close) around each match span —
    /// the web UI parses these as React nodes (never
    /// `dangerouslySetInnerHTML`); the MCP search tool converts them back
    /// to `<mark>` / `</mark>`.
    #[serde(default)]
    pub snippet: Option<String>,
    /// PEND-55 — UTF-16 code-unit match offsets for the toggle
    /// pipeline. Populated when any of the three search toggles
    /// (`case_sensitive` / `whole_word` / `is_regex`) is on and the
    /// post-FTS regex pass produced matches; empty otherwise. The
    /// frontend prefers offsets over the snippet when both are
    /// present, splitting `content` into React nodes (no
    /// `dangerouslySetInnerHTML`). Capped at
    /// `MAX_OFFSETS_PER_BLOCK` per row to bound IPC payload size on
    /// pathological patterns (e.g. `.` against a long block).
    #[serde(default)]
    pub match_offsets: Vec<MatchOffset>,
}
