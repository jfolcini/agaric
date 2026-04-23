//! Cursor-based keyset pagination for block queries.
//!
//! All list queries use cursor/keyset pagination — offset pagination is banned
//! per the ADR.  The cursor is an opaque base64-encoded JSON string.
//!
//! ## Design notes
//!
//! **`total_count` is intentionally omitted** from [`PageResponse`]. Cursor/keyset
//! pagination doesn't require or benefit from a total count (which would need an
//! extra `COUNT(*)` query on every request), and clients detect the end of results
//! via `has_more = false`.
//!
//! **Cursor type**: a single [`Cursor`] struct is used for all query types.  The
//! `position` and `deleted_at` fields are only populated by the queries that key
//! on those columns (`list_children` and `list_trash`, respectively).  This keeps
//! the API surface small and the cursor remains opaque to callers anyway.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

mod agenda;
mod hierarchy;
mod history;
mod links;
mod properties;
mod tags;
mod trash;
mod undated;

#[cfg(test)]
mod tests;

pub use agenda::{list_agenda, list_agenda_range};
pub use hierarchy::{list_by_type, list_children, list_conflicts};
pub use history::{list_block_history, list_page_history};
pub use links::list_backlinks;
pub use properties::query_by_property;
pub use tags::list_by_tag;
pub use trash::{list_trash, trash_descendant_counts};
pub use undated::list_undated_tasks;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default page size when no limit is specified by the client.
const DEFAULT_PAGE_SIZE: i64 = 50;

/// Maximum page size the client may request.
const MAX_PAGE_SIZE: i64 = 200;

// ---------------------------------------------------------------------------
// FEAT-3 Phase 2 — shared space-filter SQL fragment.
// ---------------------------------------------------------------------------
//
// Every paginated list / search query that honours the active space must
// restrict results to blocks whose owning page (`COALESCE(b.page_id,
// b.id)`) carries `space = ?space_id`. The clause short-circuits when
// `?space_id` is NULL so the same SQL serves both the scoped and unscoped
// cases without a separate codepath.
//
// Canonical form (bind slot `?N` is referenced twice — once for the NULL
// guard, once for the subquery filter):
//
//     AND (?N IS NULL OR COALESCE(b.page_id, b.id) IN (
//          SELECT bp.block_id FROM block_properties bp
//          WHERE bp.key = 'space' AND bp.value_ref = ?N))
//
// `sqlx::query_as!` / `sqlx::query!` require a string literal and do
// *not* accept `concat!()`, so the fragment is inlined at each compile-
// time-checked callsite (`pagination::list_children`,
// `pagination::list_by_type`, `pagination::list_trash`). The dynamic-SQL
// FTS path (`fts::search_fts`) builds the same fragment through string
// concatenation so its `?N` index tracks the runtime param count. Any
// change to the filter SQL must mirror across every copy.
//
// Schema reminder (migration 0035 + migration 0027):
// * `blocks.page_id` — nullable. For page blocks it is the page's own id;
//   for content blocks it is the owning page's id.
// * `block_properties(key = 'space').value_ref` — points to the space
//   block's id. Non-space pages carry this property; space blocks
//   themselves carry `is_space = 'true'` instead.

/// Sentinel substituted for NULL `position` in keyset comparisons.
///
/// Children with `position = NULL` (e.g. tag associations) are sorted *after*
/// all positioned siblings.  `i64::MAX` is safe because no real block list will
/// approach 2^63 children, and SQLite natively handles 64-bit signed integers.
pub(crate) const NULL_POSITION_SENTINEL: i64 = i64::MAX;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Row returned by paginated block queries.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, specta::Type)]
pub struct BlockRow {
    pub id: String,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted_at: Option<String>,
    pub is_conflict: bool,
    pub conflict_type: Option<String>,
    pub todo_state: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
    pub scheduled_date: Option<String>,
    pub page_id: Option<String>,
}

/// A projected future occurrence of a repeating block.
///
/// Not stored in the database — computed on-the-fly from repeat rules.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ProjectedAgendaEntry {
    /// The source block (real, materialized block).
    pub block: BlockRow,
    /// The projected date for this occurrence (YYYY-MM-DD).
    pub projected_date: String,
    /// Which date column was used as the base for projection.
    pub source: String, // "due_date" or "scheduled_date"
}

/// Row returned by block history queries (op_log entries for a block).
#[derive(Debug, Clone, Serialize, sqlx::FromRow, specta::Type)]
pub struct HistoryEntry {
    pub device_id: String,
    pub seq: i64,
    pub op_type: String,
    pub payload: String,
    pub created_at: String,
}

/// Internal cursor for keyset pagination.
/// Opaque to callers; serialised as base64-encoded JSON.
///
/// A single cursor type is shared across all queries:
/// - `position` — set by `list_children` (keyset on `position, id`).
/// - `deleted_at` — set by `list_trash` (keyset on `deleted_at, id`).
/// - `seq` — set by `list_block_history` (keyset on `seq, device_id`).
///   For history queries `id` stores `device_id` as the tie-breaker
///   because the op_log PK is `(device_id, seq)`.
/// - `rank` — set by `search_fts` (keyset on `rank, id` with epsilon
///   comparison `ABS(rank - cursor_rank) < 1e-9` to avoid exact float
///   equality).  `id` stores `block_id` as the deterministic tiebreaker.
/// - `id` — always present; serves as the tie-breaker in every keyset.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Cursor {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank: Option<f64>,
}

/// Pagination request from the client.
#[derive(Debug, Clone)]
pub struct PageRequest {
    pub after: Option<Cursor>,
    pub limit: i64,
}

/// Paginated response.
///
/// `total_count` is intentionally omitted — see module docs.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PageResponse<T: specta::Type> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

// ---------------------------------------------------------------------------
// Cursor codec
// ---------------------------------------------------------------------------

impl Cursor {
    /// Encode to opaque base64 representation.
    #[must_use = "encoded cursor string must be returned to the client"]
    pub fn encode(&self) -> Result<String, AppError> {
        let json = serde_json::to_string(self)?;
        Ok(URL_SAFE_NO_PAD.encode(json.as_bytes()))
    }

    /// Decode an opaque cursor string.
    pub fn decode(s: &str) -> Result<Self, AppError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(s)
            .map_err(|e| AppError::Validation(format!("invalid cursor: {e}")))?;
        let json = String::from_utf8(bytes)
            .map_err(|e| AppError::Validation(format!("invalid cursor UTF-8: {e}")))?;
        serde_json::from_str(&json)
            .map_err(|e| AppError::Validation(format!("invalid cursor JSON: {e}")))
    }
}

impl PageRequest {
    /// Build a page request, clamping `limit` to \[1, [`MAX_PAGE_SIZE`]\] (default [`DEFAULT_PAGE_SIZE`]).
    pub fn new(after: Option<String>, limit: Option<i64>) -> Result<Self, AppError> {
        let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
        let after = match after {
            Some(s) => Some(Cursor::decode(&s)?),
            None => None,
        };
        Ok(Self { after, limit })
    }
}

// ---------------------------------------------------------------------------
// Shared pagination helper
// ---------------------------------------------------------------------------

/// Build a [`PageResponse`] from a result set that fetched `limit + 1` rows.
///
/// The extra row is used solely to detect `has_more`; it is trimmed before
/// returning.  `cursor_from_last` constructs the cursor from the last item on
/// the page.
pub(super) fn build_page_response<T: specta::Type>(
    mut rows: Vec<T>,
    limit: i64,
    cursor_from_last: impl FnOnce(&T) -> Cursor,
) -> Result<PageResponse<T>, AppError> {
    // limit is a validated positive pagination bound; safe to convert
    let limit_usize = usize::try_from(limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > limit_usize;
    if has_more {
        rows.truncate(limit_usize);
    }
    let next_cursor = if has_more {
        let last = rows.last().expect("has_more implies non-empty");
        Some(cursor_from_last(last).encode()?)
    } else {
        None
    };
    Ok(PageResponse {
        items: rows,
        next_cursor,
        has_more,
    })
}
