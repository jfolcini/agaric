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
pub(crate) mod block_row_columns;
mod hierarchy;
mod history;
mod links;
mod properties;
mod tags;
mod tasks;
mod trash;
mod undated;

#[cfg(test)]
mod tests;

pub use agenda::{list_agenda, list_agenda_range};
pub use hierarchy::{list_by_type, list_children};
pub use history::{list_block_history, list_page_history};
pub use links::list_backlinks;
pub use properties::query_by_property;
pub use tags::list_by_tag;
pub use tasks::list_unfinished_tasks;
pub use trash::{list_trash, trash_descendant_counts};
pub use undated::list_undated_tasks;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default page size when no limit is specified by the client.
const DEFAULT_PAGE_SIZE: i64 = 50;

/// Maximum page size the client may request.
const MAX_PAGE_SIZE: i64 = 200;

/// Current cursor schema version (L-18).
///
/// The encoded JSON cursor carries a `version` field so that any future
/// reordering or semantic change of the [`Cursor`] fields can reject stale
/// cursors instead of silently decoding them under the new schema.
///
/// Bump this constant in the same commit that changes [`Cursor`]'s field
/// layout / semantics.  Pre-versioning cursors (no `version` key in their
/// JSON) decode as version 1 — see [`Cursor::decode`].
const CURRENT_CURSOR_VERSION: u8 = 1;

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
///
/// MAINT-113 took the parallel-types path (over the explored
/// `BlockRow<Id = String>` generic, which collided with two
/// `specta-typescript` 0.0.11 constraints — no generic-default emit and
/// `PLACEHOLDER_Id` codegen dropping `Id: Clone` bounds through embedded
/// generic structs). `BlockRow` stays raw — used by polymorphic
/// dispatchers (`list_blocks_inner`'s show-deleted/agenda/tag/by-type/
/// children fan-out) and by helpers that intentionally surface conflict
/// or deleted rows (`get_block`, `list_trash`). Helpers
/// whose SQL filters `deleted_at IS NULL` return
/// [`ActiveBlockRow`] instead and lift the activeness invariant into
/// the type system at the helper signature.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, specta::Type)]
pub struct BlockRow {
    pub id: String,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted_at: Option<String>,
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

/// MAINT-113 M1.5 — Row returned by paginated block queries that filter
/// on `deleted_at IS NULL` in their SQL.
///
/// Mirror of [`BlockRow`] except `id` is typed [`crate::ulid::ActiveBlockId`]
/// — a strict subset of the raw block-id space that has been verified
/// (by the helper's own SQL filter) to refer to a live block. Helpers
/// that intentionally surface deleted rows (`list_trash`) keep returning
/// `BlockRow`.
///
/// Specta emits this as a separate TypeScript type, but `id`'s emit is
/// `ActiveBlockId` which is itself a transparent alias for `string`. The
/// runtime wire format is byte-identical to `BlockRow` (same JSON shape,
/// same SQLite column types). Frontend code that consumed `BlockRow` from
/// active-filtering Tauri commands continues to compile because
/// TypeScript's structural typing accepts `ActiveBlockRow` wherever a
/// `BlockRow` is expected (and vice-versa) — both have `id: string`
/// at the wire level.
///
/// Construction is via `sqlx::query_as` with a column cast like
/// `id as "id: ActiveBlockId"` (see `fts/search.rs::search_fts` for an
/// example), or via [`ActiveBlockRow::from_block_row_unchecked`] at the
/// boundary of an internal helper that already filtered active rows.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, specta::Type)]
pub struct ActiveBlockRow {
    pub id: crate::ulid::ActiveBlockId,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted_at: Option<String>,
    pub todo_state: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
    pub scheduled_date: Option<String>,
    pub page_id: Option<String>,
}

impl ActiveBlockRow {
    /// Construct from a raw [`BlockRow`] without re-checking the active
    /// invariant. Use ONLY at the boundary of a helper that has just
    /// produced the row from an active-filtering SQL query
    /// (`WHERE deleted_at IS NULL`).
    ///
    /// For untrusted input (e.g., a `BlockRow` returned by a polymorphic
    /// dispatcher that may have routed through `list_trash`), call
    /// [`crate::ulid::verify_active`] on the id and reconstruct the row
    /// instead.
    pub fn from_block_row_unchecked(row: BlockRow) -> Self {
        Self {
            id: crate::ulid::ActiveBlockId::from_trusted_active(&row.id),
            block_type: row.block_type,
            content: row.content,
            parent_id: row.parent_id,
            position: row.position,
            deleted_at: row.deleted_at,
            todo_state: row.todo_state,
            priority: row.priority,
            due_date: row.due_date,
            scheduled_date: row.scheduled_date,
            page_id: row.page_id,
        }
    }
}

impl From<ActiveBlockRow> for BlockRow {
    /// `ActiveBlockRow` is a strict subset of `BlockRow`; conversion is
    /// always safe and infallible.
    fn from(active: ActiveBlockRow) -> Self {
        Self {
            id: active.id.into_string(),
            block_type: active.block_type,
            content: active.content,
            parent_id: active.parent_id,
            position: active.position,
            deleted_at: active.deleted_at,
            todo_state: active.todo_state,
            priority: active.priority,
            due_date: active.due_date,
            scheduled_date: active.scheduled_date,
            page_id: active.page_id,
        }
    }
}

/// MAINT-113 M1.5 — Active-id variant of [`ProjectedAgendaEntry`]. Used by
/// `commands::agenda::list_projected_agenda_inner` and its on-the-fly
/// fallback, both of which only emit projections of live, non-conflict
/// blocks (the projector reads from `block_properties` joined against
/// `blocks WHERE deleted_at IS NULL`).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ActiveProjectedAgendaEntry {
    /// The source block (real, materialized, active block).
    pub block: ActiveBlockRow,
    /// The projected date for this occurrence (YYYY-MM-DD).
    pub projected_date: String,
    /// Which date column was used as the base for projection.
    pub source: String, // "due_date" or "scheduled_date"
}

impl From<ActiveProjectedAgendaEntry> for ProjectedAgendaEntry {
    fn from(active: ActiveProjectedAgendaEntry) -> Self {
        Self {
            block: active.block.into(),
            projected_date: active.projected_date,
            source: active.source,
        }
    }
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
///
/// **Composite overload** (`list_page_history`): three slots are reused
/// simultaneously — `deleted_at` stashes `created_at`, `seq` keeps its
/// usual meaning, and `id` stashes `device_id` as the keyset tiebreaker.
/// This compound usage lets the same opaque cursor type carry the
/// `(created_at, seq, device_id)` triple without expanding the struct;
/// future cursor-bearing queries should reuse the existing slots in the
/// same way rather than adding new fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Cursor {
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
    // `after` is `pub(crate)` because `Cursor` is `pub(crate)` (I-Cache-2):
    // exposing the field as `pub` would leak a private type. External callers
    // construct `PageRequest` via [`PageRequest::new`].
    pub(crate) after: Option<Cursor>,
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
    ///
    /// The encoded JSON includes a `version` key set to
    /// [`CURRENT_CURSOR_VERSION`] so that future schema bumps can reject
    /// stale cursors on decode (L-18).  The version is injected via a
    /// `serde_json::Value` intermediate rather than a struct field so
    /// that the many `Cursor { … }` literal call sites across the crate
    /// (`tag_query`, `fts`, `commands`, `backlink`) remain unchanged —
    /// versioning is an encode/decode concern, not part of the cursor's
    /// in-memory shape.
    #[must_use = "encoded cursor string must be returned to the client"]
    pub(crate) fn encode(&self) -> Result<String, AppError> {
        let mut value = serde_json::to_value(self)?;
        if let serde_json::Value::Object(ref mut map) = value {
            map.insert(
                "version".to_string(),
                serde_json::Value::from(CURRENT_CURSOR_VERSION),
            );
        }
        let json = serde_json::to_string(&value)?;
        Ok(URL_SAFE_NO_PAD.encode(json.as_bytes()))
    }

    /// Decode an opaque cursor string.
    ///
    /// Cursors emitted by [`Cursor::encode`] carry a `version` key.  This
    /// function rejects any cursor whose version is not
    /// [`CURRENT_CURSOR_VERSION`] with [`AppError::Validation`] so clients
    /// re-paginate from page 1 instead of silently consuming a cursor that
    /// was encoded against a different field layout (L-18).
    ///
    /// **Backwards compatibility:** pre-versioning cursors (no `version`
    /// key in their JSON) are treated as version 1.  This is the desired
    /// behaviour at the seating commit — any FUTURE bump of
    /// [`CURRENT_CURSOR_VERSION`] will reject those legacy cursors.
    pub(crate) fn decode(s: &str) -> Result<Self, AppError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(s)
            .map_err(|e| AppError::Validation(format!("invalid cursor: {e}")))?;
        let json = String::from_utf8(bytes)
            .map_err(|e| AppError::Validation(format!("invalid cursor UTF-8: {e}")))?;
        let value: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| AppError::Validation(format!("invalid cursor JSON: {e}")))?;

        // Read the version slot.  Missing → assume 1 (pre-versioning
        // cursor).  Present-but-malformed → reject as invalid version.
        let version = match value.get("version") {
            None => CURRENT_CURSOR_VERSION,
            Some(serde_json::Value::Number(n)) => n
                .as_u64()
                .and_then(|v| u8::try_from(v).ok())
                .ok_or_else(|| AppError::Validation("cursor: invalid version field".to_string()))?,
            Some(_) => {
                return Err(AppError::Validation(
                    "cursor: invalid version field".to_string(),
                ));
            }
        };
        if version != CURRENT_CURSOR_VERSION {
            return Err(AppError::Validation(format!(
                "cursor: unsupported version {version} (expected {CURRENT_CURSOR_VERSION})"
            )));
        }

        // The `Cursor` struct does not declare a `version` field; serde
        // silently ignores unknown keys (no `deny_unknown_fields`), so the
        // value can be deserialised in place without stripping `version`.
        serde_json::from_value(value)
            .map_err(|e| AppError::Validation(format!("invalid cursor JSON: {e}")))
    }

    // -------------------------------------------------------------------
    // Constructors (MAINT-148c)
    // -------------------------------------------------------------------
    //
    // The optional fields on `Cursor` are populated in a small number of
    // recurring shapes across `pagination::*` (and `fts::search`). The
    // constructors below cover the four common shapes; each call site
    // collapses from a 6-line struct literal to a one-line helper call.
    // Shapes not enumerated here (currently only the FTS rank cursor in
    // `fts::search`) keep using the struct literal.

    /// Cursor keyed only on `id` — all other slots `None`.
    ///
    /// Used by `list_backlinks`, `list_by_type`, `list_undated_tasks`,
    /// `list_by_tag`, `query_by_property`, and `list_agenda`
    /// (single-date variant).
    #[must_use]
    pub(super) fn for_id(id: String) -> Self {
        Self {
            id,
            position: None,
            deleted_at: None,
            seq: None,
            rank: None,
        }
    }

    /// Cursor keyed on `(position, id)` — used by `list_children` whose
    /// keyset is `(position ASC, id ASC)`. NULL positions are encoded
    /// with [`NULL_POSITION_SENTINEL`] so they sort after positioned
    /// siblings.
    #[must_use]
    pub(super) fn for_id_and_position(id: String, position: i64) -> Self {
        Self {
            id,
            position: Some(position),
            deleted_at: None,
            seq: None,
            rank: None,
        }
    }

    /// Cursor keyed on `(deleted_at, id)` — used by `list_trash` and
    /// `list_agenda_range` (which reuses `deleted_at` as the
    /// agenda-cache `date` carrier per the H-8 fix in `agenda.rs`).
    #[must_use]
    pub(super) fn for_id_and_deleted_at(id: String, deleted_at: Option<String>) -> Self {
        Self {
            id,
            position: None,
            deleted_at,
            seq: None,
            rank: None,
        }
    }

    /// Cursor keyed on `(seq, device_id)` — used by `list_block_history`
    /// where `id` stores the op-log `device_id` tiebreaker.
    #[must_use]
    pub(super) fn for_history_seq(device_id: String, seq: i64) -> Self {
        Self {
            id: device_id,
            position: None,
            deleted_at: None,
            seq: Some(seq),
            rank: None,
        }
    }

    /// Cursor keyed on `(created_at, seq, device_id)` — used by
    /// `list_page_history`, where `deleted_at` reuses the slot to carry
    /// the op-log `created_at` and `id` carries `device_id`.
    #[must_use]
    pub(super) fn for_history_full(device_id: String, created_at: String, seq: i64) -> Self {
        Self {
            id: device_id,
            position: None,
            deleted_at: Some(created_at),
            seq: Some(seq),
            rank: None,
        }
    }

    /// Cursor keyed on `(rank, id)` — used by `fts::search`, whose
    /// keyset is `(rank ASC, id ASC)` with epsilon comparison
    /// `ABS(rank - cursor_rank) < 1e-9` to avoid exact float equality.
    /// `id` stores the `block_id` deterministic tiebreaker.
    #[must_use]
    pub(super) fn for_id_and_rank(id: String, rank: f64) -> Self {
        Self {
            id,
            position: None,
            deleted_at: None,
            seq: None,
            rank: Some(rank),
        }
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
