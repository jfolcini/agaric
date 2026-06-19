//! Row shape returned by the FTS5 query, the `content` SELECT-expression
//! builder, and the mapping from the raw DB row to the IPC wire row.

use crate::domain::search_types::SearchBlockRow;

/// Row from the FTS5 search query (private; mapped to `ActiveBlockRow` for
/// response — the SQL filters deleted_at IS NULL`).
#[derive(Debug, sqlx::FromRow)]
pub(super) struct FtsSearchRow {
    // Block fields
    pub(super) id: crate::ulid::BlockId,
    pub(super) block_type: String,
    pub(super) content: Option<String>,
    pub(super) parent_id: Option<crate::ulid::BlockId>,
    pub(super) position: Option<i64>,
    // #109 Phase 2 — blocks.deleted_at is INTEGER epoch-ms (migration 0080).
    // The FTS SQL filters `deleted_at IS NULL`, so this is always None here,
    // but the type tracks the column to stay consistent with the cluster.
    pub(super) deleted_at: Option<i64>,
    pub(super) todo_state: Option<String>,
    pub(super) priority: Option<String>,
    pub(super) due_date: Option<String>,
    pub(super) scheduled_date: Option<String>,
    pub(super) page_id: Option<String>,
    // PEND-50 Phase 1 — FTS5 `snippet()` window with #828 PUA sentinel
    // boundaries (U+E000 open / U+E001 close). May be `NULL` from SQLite
    // when the matched row has `content IS NULL` (page-title hits etc.).
    pub(super) snippet: Option<String>,
    // FTS ranking field (for cursor)
    pub(super) search_rank: f64,
}

/// P4 (#346) — build the `content` SELECT expression for the search SQL.
///
/// - `None` → `b.content` (full column, unchanged behaviour; the FE/IPC
///   path always passes `None`).
/// - `Some(n)` → `substr(b.content, 1, n) AS content` — DB-side truncation
///   to the first `n` codepoints. `substr` on a TEXT column counts
///   codepoints (not bytes), so the cut never splits a multi-byte
///   character; the result is always valid UTF-8. Used by the MCP `search`
///   tool so it no longer ships up to 50 full block bodies just to
///   `.chars().take(512)` them in Rust.
///
/// `n` is a server-controlled `usize` (never user input), so formatting it
/// straight into the SQL text carries no injection risk. The `AS content`
/// alias keeps the column name stable for `FromRow`/positional decoding.
pub(in crate::fts) fn content_select_expr(snippet_len: Option<usize>) -> String {
    match snippet_len {
        Some(n) => format!("substr(b.content, 1, {n}) AS content"),
        None => "b.content".to_string(),
    }
}

/// Map a raw [`FtsSearchRow`] into the IPC wire shape [`SearchBlockRow`].
///
/// The FTS path emits no `match_offsets` — those are the toggle
/// pipeline's responsibility (see `super::super::toggle_filter`).
pub(super) fn fts_row_to_block_row(r: FtsSearchRow) -> SearchBlockRow {
    SearchBlockRow {
        // MAINT-113 M1.5 — boundary cast: the FTS SQL filters
        // `deleted_at IS NULL`, so every surviving row is active.
        // `from_trusted_active` records the claim in the type system
        // without re-running the predicate.
        id: crate::ulid::ActiveBlockId::from_trusted_active(r.id.as_str()),
        block_type: r.block_type,
        content: r.content,
        parent_id: r.parent_id.map(crate::ulid::BlockId::into_string),
        position: r.position,
        deleted_at: r.deleted_at,
        todo_state: r.todo_state,
        priority: r.priority,
        due_date: r.due_date,
        scheduled_date: r.scheduled_date,
        page_id: r.page_id,
        snippet: r.snippet,
        match_offsets: Vec::new(),
    }
}
