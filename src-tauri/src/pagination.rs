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
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::op::is_reserved_property_key;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default page size when no limit is specified by the client.
const DEFAULT_PAGE_SIZE: i64 = 50;

/// Maximum page size the client may request.
const MAX_PAGE_SIZE: i64 = 200;

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
fn build_page_response<T: specta::Type>(
    mut rows: Vec<T>,
    limit: i64,
    cursor_from_last: impl FnOnce(&T) -> Cursor,
) -> Result<PageResponse<T>, AppError> {
    let has_more = rows.len() as i64 > limit;
    if has_more {
        rows.truncate(limit as usize);
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

// ---------------------------------------------------------------------------
// Paginated queries
// ---------------------------------------------------------------------------
//
// Each query uses the `(?N IS NULL OR <keyset-condition>)` pattern so that a
// single SQL statement handles both the first-page (no cursor) and subsequent
// (with cursor) cases.  When `cursor_flag` is NULL the keyset condition
// short-circuits; when it is 1 the condition is evaluated normally.
// This eliminates the duplicated if/else branches that the original code had.

/// List children of `parent_id` (or top-level blocks when `None`), paginated.
///
/// Ordered by `(position ASC, id ASC)`.  Blocks that formerly had `NULL`
/// position (e.g. tag children) now store `NULL_POSITION_SENTINEL` and sort
/// *after* all positioned blocks.
///
/// Uses index `idx_blocks_parent_covering(parent_id, deleted_at, position, id)`.
pub async fn list_children(
    pool: &SqlitePool,
    parent_id: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_pos, cursor_id): (Option<i64>, i64, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), c.position.unwrap_or(NULL_POSITION_SENTINEL), &c.id),
        None => (None, 0, ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date
         FROM blocks
         WHERE parent_id IS ?1 AND deleted_at IS NULL
           AND (?2 IS NULL OR (
                position > ?3
                OR (position = ?3 AND id > ?4)))
         ORDER BY position ASC, id ASC
         LIMIT ?5"#,
        parent_id,   // ?1
        cursor_flag, // ?2
        cursor_pos,  // ?3
        cursor_id,   // ?4
        fetch_limit, // ?5
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: Some(last.position.unwrap_or(NULL_POSITION_SENTINEL)),
        deleted_at: None,
        seq: None,
        rank: None,
    })
}

/// List blocks by `block_type`, paginated.
///
/// Ordered by `id ASC` (ULID ≈ chronological).
/// Uses index `idx_blocks_type(block_type, deleted_at)`.
pub async fn list_by_type(
    pool: &SqlitePool,
    block_type: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date
         FROM blocks
         WHERE block_type = ?1 AND deleted_at IS NULL
           AND (?2 IS NULL OR id > ?3)
         ORDER BY id ASC
         LIMIT ?4"#,
        block_type,  // ?1
        cursor_flag, // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: None,
        seq: None,
        rank: None,
    })
}

/// List soft-deleted blocks (trash view), paginated.
///
/// Ordered by `(deleted_at DESC, id ASC)` — most recently deleted first.
/// Excludes conflict blocks (`is_conflict = 0`).
pub async fn list_trash(
    pool: &SqlitePool,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_del, cursor_id): (Option<i64>, &str, &str) = match page.after.as_ref()
    {
        Some(c) => {
            let del = c.deleted_at.as_deref().ok_or_else(|| {
                AppError::Validation("cursor missing deleted_at for trash query".into())
            })?;
            (Some(1), del, &c.id)
        }
        None => (None, "", ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date
         FROM blocks
         WHERE deleted_at IS NOT NULL AND is_conflict = 0
           AND (?1 IS NULL OR (
                deleted_at < ?2 OR (deleted_at = ?2 AND id > ?3)))
         ORDER BY deleted_at DESC, id ASC
         LIMIT ?4"#,
        cursor_flag, // ?1
        cursor_del,  // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: last.deleted_at.clone(),
        seq: None,
        rank: None,
    })
}

/// List blocks that carry a specific tag, paginated.
///
/// Ordered by `id ASC` (ULID ≈ chronological).  Excludes soft-deleted and
/// conflict blocks, consistent with `eval_tag_query`.
/// Uses index `idx_block_tags_tag(tag_id)`.
pub async fn list_by_tag(
    pool: &SqlitePool,
    tag_id: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict as "is_conflict: bool",
                b.conflict_type, b.todo_state, b.priority, b.due_date, b.scheduled_date
         FROM block_tags bt
         JOIN blocks b ON b.id = bt.block_id
         WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0
           AND (?2 IS NULL OR b.id > ?3)
         ORDER BY b.id ASC
         LIMIT ?4"#,
        tag_id,      // ?1
        cursor_flag, // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: None,
        seq: None,
        rank: None,
    })
}

/// Query blocks by property key and optional value, with cursor pagination.
///
/// Returns blocks that have a row in `block_properties` matching the given
/// `key`.  When `value_text` is `Some`, only rows whose `value_text` matches
/// the supplied value (using the given `operator`) are included.  Excludes
/// soft-deleted and conflict blocks, consistent with other listing queries.
///
/// `operator` is one of: `"eq"`, `"neq"`, `"lt"`, `"gt"`, `"lte"`, `"gte"`.
/// It defaults to `"eq"` for any unrecognised value.
///
/// Ordered by `b.id ASC` (ULID ≈ chronological).
pub async fn query_by_property(
    pool: &SqlitePool,
    key: &str,
    value_text: Option<&str>,
    value_date: Option<&str>,
    operator: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    // Convert from safe string tag to SQL operator via match — prevents injection.
    let sql_op = match operator {
        "neq" => "!=",
        "lt" => "<",
        "gt" => ">",
        "lte" => "<=",
        "gte" => ">=",
        _ => "=", // default to equality
    };

    let rows = if is_reserved_property_key(key) {
        // Reserved keys live as columns on the blocks table, not in block_properties.
        let col = match key {
            "todo_state" => "todo_state",
            "priority" => "priority",
            "due_date" => "due_date",
            "scheduled_date" => "scheduled_date",
            _ => unreachable!(),
        };
        let sql = format!(
            "SELECT id, block_type, content, parent_id, position, \
                    deleted_at, is_conflict, conflict_type, \
                    todo_state, priority, due_date, scheduled_date \
             FROM blocks \
             WHERE {col} IS NOT NULL \
               AND deleted_at IS NULL \
               AND is_conflict = 0 \
               AND (?1 IS NULL OR {col} {sql_op} ?1) \
               AND (?2 IS NULL OR id > ?3) \
             ORDER BY id ASC \
             LIMIT ?4"
        );
        // For date columns, use value_date; for text columns, use value_text.
        let filter_value: Option<&str> = match col {
            "due_date" | "scheduled_date" => value_date.or(value_text),
            _ => value_text.or(value_date),
        };
        sqlx::query_as::<_, BlockRow>(&sql)
            .bind(filter_value)
            .bind(cursor_flag)
            .bind(cursor_id)
            .bind(fetch_limit)
            .fetch_all(pool)
            .await?
    } else {
        // Dynamic SQL needed because sqlx::query_as! macro cannot interpolate operators.
        let sql = format!(
            "SELECT b.id, b.block_type, b.content, b.parent_id, b.position, \
                    b.deleted_at, b.is_conflict, b.conflict_type, \
                    b.todo_state, b.priority, b.due_date, b.scheduled_date \
             FROM block_properties bp \
             JOIN blocks b ON b.id = bp.block_id \
             WHERE bp.key = ?1 \
               AND b.deleted_at IS NULL \
               AND b.is_conflict = 0 \
               AND (?2 IS NULL OR bp.value_text {sql_op} ?2) \
               AND (?3 IS NULL OR bp.value_date {sql_op} ?3) \
               AND (?4 IS NULL OR b.id > ?5) \
             ORDER BY b.id ASC \
             LIMIT ?6"
        );
        sqlx::query_as::<_, BlockRow>(&sql)
            .bind(key) // ?1
            .bind(value_text) // ?2
            .bind(value_date) // ?3
            .bind(cursor_flag) // ?4
            .bind(cursor_id) // ?5
            .bind(fetch_limit) // ?6
            .fetch_all(pool)
            .await?
    };

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: None,
        seq: None,
        rank: None,
    })
}

/// List blocks for a specific date from the agenda cache, paginated.
///
/// Ordered by `block_id ASC` (ULID ≈ chronological).
/// Uses index `idx_agenda_date(date)`.
///
/// `date` must be in `YYYY-MM-DD` format.
pub async fn list_agenda(
    pool: &SqlitePool,
    date: &str,
    source: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict as "is_conflict: bool",
                b.conflict_type, b.todo_state, b.priority, b.due_date, b.scheduled_date
         FROM agenda_cache ac
         JOIN blocks b ON b.id = ac.block_id
         WHERE ac.date = ?1 AND b.deleted_at IS NULL
           AND (?2 IS NULL OR ac.source = ?2)
           AND (?3 IS NULL OR b.id > ?4)
         ORDER BY b.id ASC
         LIMIT ?5"#,
        date,        // ?1
        source,      // ?2
        cursor_flag, // ?3
        cursor_id,   // ?4
        fetch_limit, // ?5
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: None,
        seq: None,
        rank: None,
    })
}

/// List blocks for a date *range* from the agenda cache, paginated.
///
/// When `start_date` and `end_date` are provided, returns blocks whose
/// `agenda_cache.date` falls `BETWEEN start_date AND end_date` (inclusive).
/// Ordered by `(ac.date ASC, b.id ASC)` so results stream chronologically.
/// The cursor carries both `date` (encoded in `deleted_at` field for reuse)
/// and `block_id` for keyset pagination.
pub async fn list_agenda_range(
    pool: &SqlitePool,
    start_date: &str,
    end_date: &str,
    source: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    // For the range query we use a composite cursor: (date, block_id).
    // We stash the cursor date in `deleted_at` and block_id in `id`.
    let (cursor_flag, cursor_date, cursor_id): (Option<i64>, &str, &str) = match page.after.as_ref()
    {
        Some(c) => (Some(1), c.deleted_at.as_deref().unwrap_or(""), &c.id),
        None => (None, "", ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict as "is_conflict: bool",
                b.conflict_type, b.todo_state, b.priority, b.due_date, b.scheduled_date
         FROM agenda_cache ac
         JOIN blocks b ON b.id = ac.block_id
         WHERE ac.date >= ?1 AND ac.date <= ?2
           AND b.deleted_at IS NULL
           AND (?3 IS NULL OR ac.source = ?3)
           AND (?4 IS NULL OR (ac.date > ?5 OR (ac.date = ?5 AND b.id > ?6)))
         ORDER BY ac.date ASC, b.id ASC
         LIMIT ?7"#,
        start_date,  // ?1
        end_date,    // ?2
        source,      // ?3
        cursor_flag, // ?4
        cursor_date, // ?5
        cursor_id,   // ?6
        fetch_limit, // ?7
    )
    .fetch_all(pool)
    .await?;

    // We need the date from agenda_cache for the cursor. Since BlockRow doesn't
    // carry it, we re-derive it: for due_date source use due_date, for
    // scheduled_date source use scheduled_date, otherwise pick whichever is set.
    // This is a best-effort approach; the cursor just needs to be consistent.
    fn extract_date_for_cursor(b: &BlockRow, source: Option<&str>) -> String {
        match source {
            Some(s) if s.contains("due_date") => b.due_date.clone().unwrap_or_default(),
            Some(s) if s.contains("scheduled_date") => b.scheduled_date.clone().unwrap_or_default(),
            _ => b
                .due_date
                .clone()
                .or_else(|| b.scheduled_date.clone())
                .unwrap_or_default(),
        }
    }

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: Some(extract_date_for_cursor(last, source)),
        seq: None,
        rank: None,
    })
}

/// List backlinks — blocks that link *to* `target_id`, paginated.
///
/// Ordered by `b.id ASC` (ULID ≈ chronological).
/// Uses index `idx_block_links_target(target_id)`.
pub async fn list_backlinks(
    pool: &SqlitePool,
    target_id: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict as "is_conflict: bool",
                b.conflict_type, b.todo_state, b.priority, b.due_date, b.scheduled_date
         FROM block_links bl
         JOIN blocks b ON b.id = bl.source_id
         WHERE bl.target_id = ?1 AND b.deleted_at IS NULL
           AND (?2 IS NULL OR b.id > ?3)
         ORDER BY b.id ASC
         LIMIT ?4"#,
        target_id,   // ?1
        cursor_flag, // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: None,
        seq: None,
        rank: None,
    })
}

/// List op-log history for a specific block, paginated.
///
/// Returns all ops whose payload contains the given `block_id`, ordered by
/// `(seq DESC, device_id DESC)` (newest first).  The cursor stores `seq` and
/// `device_id` (in the `id` field) for correct keyset pagination across
/// multiple devices — the op_log PK is `(device_id, seq)` and `seq` alone
/// is not globally unique.
///
/// A `LIKE` pre-filter narrows candidates before `json_extract` to avoid
/// full-table JSON parsing (same pattern as `recovery.rs`).
///
/// Note: This queries ALL op types for a block (create, edit, add_tag,
/// remove_tag, move, set_property, etc.).
pub async fn list_block_history(
    pool: &SqlitePool,
    block_id: &str,
    page: &PageRequest,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let fetch_limit = page.limit + 1;

    // `id` in the cursor stores `device_id` for history queries — it is the
    // tie-breaker because the op_log PK is `(device_id, seq)`.
    let (cursor_flag, cursor_seq, cursor_device_id): (Option<i64>, i64, &str) =
        match page.after.as_ref() {
            Some(c) => (Some(1), c.seq.unwrap_or(0), &c.id),
            None => (None, 0, ""),
        };

    let rows = sqlx::query_as!(
        HistoryEntry,
        "SELECT device_id, seq, op_type, payload, created_at \
         FROM op_log \
         WHERE payload LIKE '%\"block_id\":\"' || ?1 || '\"%' \
           AND json_extract(payload, '$.block_id') = ?1 \
           AND (?2 IS NULL OR (\
                seq < ?3 OR (seq = ?3 AND device_id < ?5))) \
         ORDER BY seq DESC, device_id DESC \
         LIMIT ?4",
        block_id,         // ?1
        cursor_flag,      // ?2
        cursor_seq,       // ?3
        fetch_limit,      // ?4
        cursor_device_id, // ?5
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.device_id.clone(), // device_id as tie-breaker
        position: None,
        deleted_at: None,
        seq: Some(last.seq),
        rank: None,
    })
}

/// List op-log history for all blocks descended from a page, paginated.
///
/// Uses a recursive CTE to find all block IDs in the page subtree, then
/// queries the op_log for ops touching those blocks. Ordered by
/// `(created_at DESC, seq DESC)` (newest first). Optionally filters by
/// `op_type`.
///
/// The cursor stores `created_at` (in the `deleted_at` field, reused for
/// this timestamp purpose) and `seq` for correct keyset pagination.
pub async fn list_page_history(
    pool: &SqlitePool,
    page_id: &str,
    op_type_filter: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let fetch_limit = page.limit + 1;

    // Cursor: reuse `deleted_at` field for `created_at` and `seq` + `id` for device_id
    let (cursor_flag, cursor_created_at, cursor_seq, cursor_device_id): (
        Option<i64>,
        &str,
        i64,
        &str,
    ) = match page.after.as_ref() {
        Some(c) => {
            let created_at = c.deleted_at.as_deref().ok_or_else(|| {
                AppError::Validation("cursor missing created_at for page history query".into())
            })?;
            (Some(1), created_at, c.seq.unwrap_or(0), &c.id)
        }
        None => (None, "", 0, ""),
    };

    if page_id == "__all__" {
        // Global history: query all ops without page-scoping CTE
        let rows = sqlx::query_as::<_, HistoryEntry>(
            "SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at \
             FROM op_log ol \
             WHERE (?1 IS NULL OR ol.op_type = ?1) \
               AND (?2 IS NULL OR ( \
                    ol.created_at < ?3 \
                    OR (ol.created_at = ?3 AND ol.seq < ?4) \
                    OR (ol.created_at = ?3 AND ol.seq = ?4 AND ol.device_id < ?6))) \
             ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC \
             LIMIT ?5",
        )
        .bind(op_type_filter) // ?1
        .bind(cursor_flag) // ?2
        .bind(cursor_created_at) // ?3
        .bind(cursor_seq) // ?4
        .bind(fetch_limit) // ?5
        .bind(cursor_device_id) // ?6
        .fetch_all(pool)
        .await?;

        return build_page_response(rows, page.limit, |last| Cursor {
            id: last.device_id.clone(),
            position: None,
            deleted_at: Some(last.created_at.clone()),
            seq: Some(last.seq),
            rank: None,
        });
    }

    let rows = sqlx::query_as!(
        HistoryEntry,
        "WITH RECURSIVE page_blocks(id) AS ( \
             SELECT id FROM blocks WHERE id = ?1 \
             UNION ALL \
             SELECT b.id FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
         ) \
         SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at \
         FROM op_log ol \
         WHERE json_extract(ol.payload, '$.block_id') IN (SELECT id FROM page_blocks) \
           AND (?2 IS NULL OR ol.op_type = ?2) \
           AND (?3 IS NULL OR ( \
                ol.created_at < ?4 \
                OR (ol.created_at = ?4 AND ol.seq < ?5) \
                OR (ol.created_at = ?4 AND ol.seq = ?5 AND ol.device_id < ?7))) \
         ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC \
         LIMIT ?6",
        page_id,           // ?1
        op_type_filter,    // ?2
        cursor_flag,       // ?3
        cursor_created_at, // ?4
        cursor_seq,        // ?5
        fetch_limit,       // ?6
        cursor_device_id,  // ?7
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.device_id.clone(),
        position: None,
        deleted_at: Some(last.created_at.clone()), // reuse deleted_at for created_at
        seq: Some(last.seq),
        rank: None,
    })
}

/// List conflict blocks, paginated.
///
/// Ordered by `id ASC` (ULID ≈ chronological).
/// Returns only non-deleted blocks with `is_conflict = 1`.
pub async fn list_conflicts(
    pool: &SqlitePool,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date
         FROM blocks
         WHERE is_conflict = 1 AND deleted_at IS NULL
           AND (?1 IS NULL OR id > ?2)
         ORDER BY id ASC
         LIMIT ?3"#,
        cursor_flag, // ?1
        cursor_id,   // ?2
        fetch_limit, // ?3
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: None,
        seq: None,
        rank: None,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests for cursor-based keyset pagination — cursor codec, page request
    //! validation, and all eight paginated query functions (list_children,
    //! list_by_type, list_trash, list_by_tag, list_agenda, list_backlinks,
    //! list_block_history, list_conflicts).  Covers first-page,
    //! cursor-continuation, last-page, empty results, ordering, tiebreakers,
    //! soft-delete exclusion, cursor stability after inserts, exhaustive walks,
    //! seq-field backward compatibility, and all op types in history.

    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    // ── Deterministic test fixtures ─────────────────────────────────────

    const FIXED_DELETED_AT: &str = "2025-01-15T00:00:00+00:00";

    // ── Helpers ─────────────────────────────────────────────────────────

    /// Create a fresh SQLite pool with migrations applied (temp directory).
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a block with optional parent and position.
    async fn insert_block(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: Option<i64>,
    ) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(parent_id)
        .bind(position)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Associate a block with a tag via `block_tags`.
    async fn insert_tag_association(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Insert an agenda cache entry directly.
    async fn insert_agenda_entry(pool: &SqlitePool, date: &str, block_id: &str, source: &str) {
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind(date)
            .bind(block_id)
            .bind(source)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Soft-delete a block with a deterministic timestamp.
    async fn soft_delete_block(pool: &SqlitePool, id: &str, deleted_at: &str) {
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(deleted_at)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    // ====================================================================
    // Cursor codec
    // ====================================================================

    #[test]
    fn cursor_encode_decode_roundtrip() {
        let cursor = Cursor {
            id: "01HZ0000000000000000000001".into(),
            position: Some(3),
            deleted_at: None,
            seq: None,
            rank: None,
        };
        let encoded = cursor.encode().unwrap();
        let decoded = Cursor::decode(&encoded).unwrap();
        assert_eq!(
            cursor, decoded,
            "cursor must survive encode/decode roundtrip"
        );
    }

    #[test]
    fn cursor_encode_decode_with_deleted_at() {
        let cursor = Cursor {
            id: "01HZ0000000000000000000001".into(),
            position: None,
            deleted_at: Some("2025-01-15T12:00:00+00:00".into()),
            seq: None,
            rank: None,
        };
        let encoded = cursor.encode().unwrap();
        let decoded = Cursor::decode(&encoded).unwrap();
        assert_eq!(
            cursor, decoded,
            "cursor with deleted_at must survive roundtrip"
        );
    }

    #[test]
    fn cursor_encode_decode_with_seq() {
        let cursor = Cursor {
            id: String::new(),
            position: None,
            deleted_at: None,
            seq: Some(42),
            rank: None,
        };
        let encoded = cursor.encode().unwrap();
        let decoded = Cursor::decode(&encoded).unwrap();
        assert_eq!(cursor, decoded, "cursor with seq must survive roundtrip");
    }

    #[test]
    fn cursor_decode_without_seq_defaults_to_none() {
        // Simulate a pre-Phase-2 cursor that doesn't have the seq field
        let old_json = r#"{"id":"01HZ0000000000000000000001","position":3}"#;
        let encoded = URL_SAFE_NO_PAD.encode(old_json.as_bytes());
        let decoded = Cursor::decode(&encoded).unwrap();
        assert_eq!(
            decoded.id, "01HZ0000000000000000000001",
            "id must be preserved from old cursor"
        );
        assert_eq!(
            decoded.position,
            Some(3),
            "position must be preserved from old cursor"
        );
        assert_eq!(
            decoded.seq, None,
            "old cursor without seq field must default to None"
        );
    }

    #[test]
    fn cursor_decode_rejects_invalid_base64() {
        let result = Cursor::decode("not-valid-base64!!!");
        assert!(result.is_err(), "invalid base64 must be rejected");
        assert!(
            result.unwrap_err().to_string().contains("invalid cursor"),
            "error message must mention 'invalid cursor'"
        );
    }

    #[test]
    fn cursor_encode_decode_preserves_special_characters() {
        let cursor = Cursor {
            id: "id-with-émojis-\u{1f389}-and-\"quotes\"".into(),
            position: Some(42),
            deleted_at: Some("2025-06-01T00:00:00+00:00".into()),
            seq: None,
            rank: None,
        };
        let encoded = cursor.encode().unwrap();
        let decoded = Cursor::decode(&encoded).unwrap();
        assert_eq!(cursor, decoded, "special characters must survive roundtrip");
    }

    // ====================================================================
    // PageRequest
    // ====================================================================

    #[test]
    fn page_request_defaults_to_limit_50() {
        let pr = PageRequest::new(None, None).unwrap();
        assert!(pr.after.is_none(), "default request should have no cursor");
        assert_eq!(pr.limit, 50, "default limit must be 50");
    }

    #[test]
    fn page_request_clamps_limit_to_valid_range() {
        let high = PageRequest::new(None, Some(999)).unwrap();
        assert_eq!(high.limit, 200, "limit above 200 must be clamped");

        let low = PageRequest::new(None, Some(-5)).unwrap();
        assert_eq!(low.limit, 1, "negative limit must be clamped to 1");

        let zero = PageRequest::new(None, Some(0)).unwrap();
        assert_eq!(zero.limit, 1, "zero limit must be clamped to 1");
    }

    #[test]
    fn page_request_rejects_invalid_cursors() {
        let result = PageRequest::new(Some("not-a-valid-cursor!!!".into()), Some(10));
        assert!(result.is_err(), "invalid base64 cursor must be rejected");

        let bad_json = URL_SAFE_NO_PAD.encode(b"this is not json");
        let result = PageRequest::new(Some(bad_json), Some(10));
        assert!(result.is_err(), "non-JSON cursor must be rejected");

        let missing_id = URL_SAFE_NO_PAD.encode(b"{\"position\":1}");
        let result = PageRequest::new(Some(missing_id), Some(10));
        assert!(result.is_err(), "cursor missing 'id' must be rejected");
    }

    // ====================================================================
    // list_children
    // ====================================================================

    #[tokio::test]
    async fn list_children_returns_first_page() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
        for i in 1..=5_i64 {
            let id = format!("CHILD{i:03}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("child {i}"),
                Some("PARENT01"),
                Some(i),
            )
            .await;
        }

        let page = PageRequest::new(None, Some(2)).unwrap();
        let resp = list_children(&pool, Some("PARENT01"), &page).await.unwrap();

        assert_eq!(resp.items.len(), 2, "page size must be respected");
        assert!(resp.has_more, "more items remain");
        assert!(
            resp.next_cursor.is_some(),
            "cursor must be provided when has_more"
        );
        assert_eq!(
            resp.items[0].id, "CHILD001",
            "first item should be CHILD001"
        );
        assert_eq!(
            resp.items[1].id, "CHILD002",
            "second item should be CHILD002"
        );
    }

    #[tokio::test]
    async fn list_children_continues_from_cursor() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
        for i in 1..=5_i64 {
            let id = format!("CHILD{i:03}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("child {i}"),
                Some("PARENT01"),
                Some(i),
            )
            .await;
        }

        let p1 = PageRequest::new(None, Some(2)).unwrap();
        let r1 = list_children(&pool, Some("PARENT01"), &p1).await.unwrap();

        let p2 = PageRequest::new(r1.next_cursor, Some(2)).unwrap();
        let r2 = list_children(&pool, Some("PARENT01"), &p2).await.unwrap();

        assert_eq!(r2.items.len(), 2, "second page should return 2 items");
        assert!(r2.has_more, "more items remain after second page");
        assert_eq!(
            r2.items[0].id, "CHILD003",
            "cursor must skip past first page"
        );
        assert_eq!(
            r2.items[1].id, "CHILD004",
            "second page second item should be CHILD004"
        );
    }

    #[tokio::test]
    async fn list_children_last_page_has_no_cursor() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
        for i in 1..=5_i64 {
            let id = format!("CHILD{i:03}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("child {i}"),
                Some("PARENT01"),
                Some(i),
            )
            .await;
        }

        let r1 = list_children(
            &pool,
            Some("PARENT01"),
            &PageRequest::new(None, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        let r2 = list_children(
            &pool,
            Some("PARENT01"),
            &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        let r3 = list_children(
            &pool,
            Some("PARENT01"),
            &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();

        assert_eq!(r3.items.len(), 1, "last page must contain remaining item");
        assert!(!r3.has_more, "last page must have has_more = false");
        assert!(r3.next_cursor.is_none(), "last page must have no cursor");
        assert_eq!(
            r3.items[0].id, "CHILD005",
            "last page should contain CHILD005"
        );
    }

    #[tokio::test]
    async fn list_children_returns_empty_when_parent_has_no_children() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_children(&pool, Some("PARENT01"), &page).await.unwrap();

        assert!(resp.items.is_empty(), "childless parent must return empty");
        assert!(
            !resp.has_more,
            "empty result should not indicate more pages"
        );
        assert!(
            resp.next_cursor.is_none(),
            "empty result should have no cursor"
        );
    }

    #[tokio::test]
    async fn list_children_lists_top_level_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TOPLVL01", "page", "page 1", None, Some(1)).await;
        insert_block(&pool, "TOPLVL02", "page", "page 2", None, Some(2)).await;
        insert_block(
            &pool,
            "CHILD001",
            "content",
            "child",
            Some("TOPLVL01"),
            Some(1),
        )
        .await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_children(&pool, None, &page).await.unwrap();

        assert_eq!(
            resp.items.len(),
            2,
            "only top-level blocks (parent_id IS NULL)"
        );
        assert_eq!(
            resp.items[0].id, "TOPLVL01",
            "first top-level block by position"
        );
        assert_eq!(
            resp.items[1].id, "TOPLVL02",
            "second top-level block by position"
        );
    }

    #[tokio::test]
    async fn list_children_excludes_soft_deleted() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
        insert_block(
            &pool,
            "CHILD001",
            "content",
            "alive",
            Some("PARENT01"),
            Some(1),
        )
        .await;
        insert_block(
            &pool,
            "CHILD002",
            "content",
            "deleted",
            Some("PARENT01"),
            Some(2),
        )
        .await;
        insert_block(
            &pool,
            "CHILD003",
            "content",
            "alive too",
            Some("PARENT01"),
            Some(3),
        )
        .await;
        soft_delete_block(&pool, "CHILD002", FIXED_DELETED_AT).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_children(&pool, Some("PARENT01"), &page).await.unwrap();

        assert_eq!(resp.items.len(), 2, "soft-deleted child must be excluded");
        assert_eq!(resp.items[0].id, "CHILD001", "first alive child present");
        assert_eq!(
            resp.items[1].id, "CHILD003",
            "second alive child present, CHILD002 excluded"
        );
    }

    #[tokio::test]
    async fn list_children_sentinel_positions_sort_after_positioned() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
        insert_block(
            &pool,
            "CHILD001",
            "content",
            "c1",
            Some("PARENT01"),
            Some(1),
        )
        .await;
        insert_block(
            &pool,
            "CHILD002",
            "content",
            "c2",
            Some("PARENT01"),
            Some(2),
        )
        .await;
        // P-18: Use sentinel value instead of NULL for tag-like blocks
        insert_block(
            &pool,
            "TAG00001",
            "tag",
            "tag1",
            Some("PARENT01"),
            Some(NULL_POSITION_SENTINEL),
        )
        .await;
        insert_block(
            &pool,
            "TAG00002",
            "tag",
            "tag2",
            Some("PARENT01"),
            Some(NULL_POSITION_SENTINEL),
        )
        .await;

        // Page 1: positioned children first
        let p1 = PageRequest::new(None, Some(2)).unwrap();
        let r1 = list_children(&pool, Some("PARENT01"), &p1).await.unwrap();
        assert_eq!(
            r1.items.len(),
            2,
            "page 1 should return 2 positioned children"
        );
        assert!(r1.has_more, "page 1 should have more items");
        assert_eq!(r1.items[0].id, "CHILD001", "positioned children come first");
        assert_eq!(r1.items[1].id, "CHILD002", "second positioned child");

        // Page 2: sentinel-position children via cursor
        let p2 = PageRequest::new(r1.next_cursor, Some(2)).unwrap();
        let r2 = list_children(&pool, Some("PARENT01"), &p2).await.unwrap();
        assert_eq!(
            r2.items.len(),
            2,
            "page 2 should return 2 sentinel-position items"
        );
        assert!(!r2.has_more, "page 2 should be the last page");
        assert_eq!(
            r2.items[0].id, "TAG00001",
            "sentinel-position items come after"
        );
        assert_eq!(r2.items[1].id, "TAG00002", "second sentinel-position item");
    }

    #[tokio::test]
    async fn list_children_same_position_tiebreaks_by_id() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "CHILD_AA", "content", "a", Some("PARENT01"), Some(5)).await;
        insert_block(&pool, "CHILD_BB", "content", "b", Some("PARENT01"), Some(5)).await;
        insert_block(&pool, "CHILD_CC", "content", "c", Some("PARENT01"), Some(5)).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_children(&pool, Some("PARENT01"), &page).await.unwrap();

        assert_eq!(
            resp.items.len(),
            3,
            "all three same-position items returned"
        );
        assert_eq!(resp.items[0].id, "CHILD_AA", "id ASC tiebreaker");
        assert_eq!(resp.items[1].id, "CHILD_BB", "second by id tiebreaker");
        assert_eq!(resp.items[2].id, "CHILD_CC", "third by id tiebreaker");
    }

    #[tokio::test]
    async fn list_children_exhaustive_walk_returns_all_items_once() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
        for i in 1..=13_i64 {
            let id = format!("CHILD{i:03}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("c{i}"),
                Some("PARENT01"),
                Some(i),
            )
            .await;
        }

        let mut all_ids = Vec::new();
        let mut cursor = None;
        loop {
            let page = PageRequest::new(cursor, Some(3)).unwrap();
            let resp = list_children(&pool, Some("PARENT01"), &page).await.unwrap();
            all_ids.extend(resp.items.iter().map(|b| b.id.clone()));
            if !resp.has_more {
                break;
            }
            cursor = resp.next_cursor;
        }

        let expected: Vec<String> = (1..=13).map(|i| format!("CHILD{i:03}")).collect();
        assert_eq!(
            all_ids, expected,
            "exhaustive walk must return every child exactly once, in order"
        );
    }

    // ====================================================================
    // list_by_type
    // ====================================================================

    #[tokio::test]
    async fn list_by_type_returns_only_matching_type() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE0001", "page", "Page 1", None, None).await;
        insert_block(&pool, "PAGE0002", "page", "Page 2", None, None).await;
        insert_block(&pool, "CONT0001", "content", "Content 1", None, None).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_by_type(&pool, "page", &page).await.unwrap();

        assert_eq!(resp.items.len(), 2, "only page-type blocks");
        assert!(
            resp.items.iter().all(|b| b.block_type == "page"),
            "all items must be page type"
        );
    }

    #[tokio::test]
    async fn list_by_type_paginates_with_cursor() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=5_i64 {
            let id = format!("PAGE{i:04}");
            insert_block(&pool, &id, "page", &format!("Page {i}"), None, None).await;
        }

        let r1 = list_by_type(&pool, "page", &PageRequest::new(None, Some(2)).unwrap())
            .await
            .unwrap();
        assert_eq!(r1.items.len(), 2, "page 1 should return 2 items");
        assert!(r1.has_more, "page 1 should indicate more pages");
        assert_eq!(r1.items[0].id, "PAGE0001", "page 1 first item");
        assert_eq!(r1.items[1].id, "PAGE0002", "page 1 second item");

        let r2 = list_by_type(
            &pool,
            "page",
            &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r2.items.len(), 2, "page 2 should return 2 items");
        assert!(r2.has_more, "page 2 should indicate more pages");
        assert_eq!(r2.items[0].id, "PAGE0003", "page 2 first item");
        assert_eq!(r2.items[1].id, "PAGE0004", "page 2 second item");

        let r3 = list_by_type(
            &pool,
            "page",
            &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r3.items.len(), 1, "last page should return 1 item");
        assert!(!r3.has_more, "last page should not indicate more");
        assert!(r3.next_cursor.is_none(), "last page should have no cursor");
        assert_eq!(r3.items[0].id, "PAGE0005", "last page item");
    }

    #[tokio::test]
    async fn list_by_type_excludes_soft_deleted() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE0001", "page", "Page 1", None, None).await;
        insert_block(&pool, "PAGE0002", "page", "Page 2", None, None).await;
        insert_block(&pool, "PAGE0003", "page", "Page 3", None, None).await;
        soft_delete_block(&pool, "PAGE0002", FIXED_DELETED_AT).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_by_type(&pool, "page", &page).await.unwrap();

        assert_eq!(resp.items.len(), 2, "soft-deleted block must be excluded");
        assert_eq!(resp.items[0].id, "PAGE0001", "first alive page block");
        assert_eq!(
            resp.items[1].id, "PAGE0003",
            "second alive page block, PAGE0002 excluded"
        );
    }

    #[tokio::test]
    async fn list_by_type_returns_empty_for_unknown_type() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE0001", "page", "Page 1", None, None).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_by_type(&pool, "nonexistent_type", &page)
            .await
            .unwrap();

        assert!(resp.items.is_empty(), "unknown type must return empty");
        assert!(!resp.has_more, "empty result should not indicate more");
        assert!(
            resp.next_cursor.is_none(),
            "empty result should have no cursor"
        );
    }

    // ====================================================================
    // list_trash
    // ====================================================================

    #[tokio::test]
    async fn list_trash_returns_empty_when_nothing_deleted() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLOCK001", "content", "alive", None, None).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_trash(&pool, &page).await.unwrap();

        assert!(resp.items.is_empty(), "no deleted blocks → empty trash");
        assert!(!resp.has_more, "empty trash should not indicate more");
        assert!(
            resp.next_cursor.is_none(),
            "empty trash should have no cursor"
        );
    }

    #[tokio::test]
    async fn list_trash_orders_by_deleted_at_descending() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TRASH001", "content", "a", None, None).await;
        insert_block(&pool, "TRASH002", "content", "b", None, None).await;
        insert_block(&pool, "TRASH003", "content", "c", None, None).await;

        soft_delete_block(&pool, "TRASH001", "2025-01-01T00:00:00+00:00").await;
        soft_delete_block(&pool, "TRASH002", "2025-01-03T00:00:00+00:00").await;
        soft_delete_block(&pool, "TRASH003", "2025-01-02T00:00:00+00:00").await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_trash(&pool, &page).await.unwrap();

        assert_eq!(resp.items.len(), 3, "all deleted blocks should be returned");
        assert_eq!(resp.items[0].id, "TRASH002", "most recently deleted first");
        assert_eq!(resp.items[1].id, "TRASH003", "second most recently deleted");
        assert_eq!(resp.items[2].id, "TRASH001", "earliest deleted last");
    }

    #[tokio::test]
    async fn list_trash_paginates_with_cursor() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=5_i64 {
            let id = format!("TRASH{i:03}");
            insert_block(&pool, &id, "content", &format!("trash {i}"), None, None).await;
            let ts = format!("2025-01-{i:02}T00:00:00+00:00");
            soft_delete_block(&pool, &id, &ts).await;
        }

        // Page 1: most recent → TRASH005, TRASH004
        let r1 = list_trash(&pool, &PageRequest::new(None, Some(2)).unwrap())
            .await
            .unwrap();
        assert_eq!(r1.items.len(), 2, "trash page 1 should return 2 items");
        assert!(r1.has_more, "trash page 1 should indicate more");
        assert_eq!(r1.items[0].id, "TRASH005", "most recent trash item first");
        assert_eq!(r1.items[1].id, "TRASH004", "second most recent trash item");

        // Page 2: TRASH003, TRASH002
        let r2 = list_trash(&pool, &PageRequest::new(r1.next_cursor, Some(2)).unwrap())
            .await
            .unwrap();
        assert_eq!(r2.items.len(), 2, "trash page 2 should return 2 items");
        assert!(r2.has_more, "trash page 2 should indicate more");
        assert_eq!(r2.items[0].id, "TRASH003", "trash page 2 first item");
        assert_eq!(r2.items[1].id, "TRASH002", "trash page 2 second item");

        // Page 3 (last): TRASH001
        let r3 = list_trash(&pool, &PageRequest::new(r2.next_cursor, Some(2)).unwrap())
            .await
            .unwrap();
        assert_eq!(r3.items.len(), 1, "trash last page should return 1 item");
        assert!(!r3.has_more, "trash last page should not indicate more");
        assert!(
            r3.next_cursor.is_none(),
            "trash last page should have no cursor"
        );
        assert_eq!(r3.items[0].id, "TRASH001", "oldest trash item last");
    }

    #[tokio::test]
    async fn list_trash_excludes_conflict_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "NORMAL01", "content", "normal", None, None).await;
        insert_block(&pool, "CONFLCT1", "content", "conflict", None, None).await;

        soft_delete_block(&pool, "NORMAL01", FIXED_DELETED_AT).await;
        soft_delete_block(&pool, "CONFLCT1", FIXED_DELETED_AT).await;

        sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
            .bind("CONFLCT1")
            .execute(&pool)
            .await
            .unwrap();

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_trash(&pool, &page).await.unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "conflict blocks must be excluded from trash"
        );
        assert_eq!(
            resp.items[0].id, "NORMAL01",
            "only non-conflict block in trash"
        );
    }

    // ====================================================================
    // Cursor stability
    // ====================================================================

    #[tokio::test]
    async fn cursor_stable_after_concurrent_inserts() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
        for i in 1..=5_i64 {
            let id = format!("CHILD{i:03}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("c{i}"),
                Some("PARENT01"),
                Some(i * 2),
            )
            .await;
        }

        // Get first page → CHILD001(pos=2), CHILD002(pos=4)
        let r1 = list_children(
            &pool,
            Some("PARENT01"),
            &PageRequest::new(None, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            r1.items[0].id, "CHILD001",
            "page 1 first item before insert"
        );
        assert_eq!(
            r1.items[1].id, "CHILD002",
            "page 1 second item before insert"
        );
        let saved_cursor = r1.next_cursor.clone();

        // Insert before cursor (pos=3) and after (pos=100)
        insert_block(
            &pool,
            "NEWCHILD",
            "content",
            "new",
            Some("PARENT01"),
            Some(3),
        )
        .await;
        insert_block(
            &pool,
            "NEWCHLD2",
            "content",
            "new2",
            Some("PARENT01"),
            Some(100),
        )
        .await;

        // Resume with old cursor — must skip past pos=4
        let r2 = list_children(
            &pool,
            Some("PARENT01"),
            &PageRequest::new(saved_cursor, Some(10)).unwrap(),
        )
        .await
        .unwrap();

        let ids: Vec<&str> = r2.items.iter().map(|b| b.id.as_str()).collect();
        assert!(
            !ids.contains(&"CHILD001"),
            "cursor must skip already-seen items"
        );
        assert!(
            !ids.contains(&"CHILD002"),
            "CHILD002 was already seen in page 1"
        );
        assert!(
            !ids.contains(&"NEWCHILD"),
            "items before cursor position must be skipped"
        );
        assert!(
            ids.contains(&"CHILD003"),
            "CHILD003 should appear after cursor"
        );
        assert!(
            ids.contains(&"CHILD004"),
            "CHILD004 should appear after cursor"
        );
        assert!(
            ids.contains(&"CHILD005"),
            "CHILD005 should appear after cursor"
        );
        assert!(ids.contains(&"NEWCHLD2"), "items after cursor must appear");
    }

    // ====================================================================
    // list_by_tag
    // ====================================================================

    #[tokio::test]
    async fn list_by_tag_returns_only_tagged_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG00001", "tag", "important", None, None).await;
        insert_block(&pool, "BLOCK001", "content", "block 1", None, None).await;
        insert_block(&pool, "BLOCK002", "content", "block 2", None, None).await;
        insert_block(&pool, "BLOCK003", "content", "block 3", None, None).await;

        insert_tag_association(&pool, "BLOCK001", "TAG00001").await;
        insert_tag_association(&pool, "BLOCK003", "TAG00001").await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_by_tag(&pool, "TAG00001", &page).await.unwrap();

        assert_eq!(resp.items.len(), 2, "only tagged blocks must be returned");
        assert_eq!(resp.items[0].id, "BLOCK001", "first tagged block");
        assert_eq!(resp.items[1].id, "BLOCK003", "second tagged block");
    }

    #[tokio::test]
    async fn list_by_tag_paginates_with_cursor() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG00001", "tag", "important", None, None).await;
        for i in 1..=5_i64 {
            let id = format!("BLOCK{i:03}");
            insert_block(&pool, &id, "content", &format!("b{i}"), None, None).await;
            insert_tag_association(&pool, &id, "TAG00001").await;
        }

        let r1 = list_by_tag(&pool, "TAG00001", &PageRequest::new(None, Some(2)).unwrap())
            .await
            .unwrap();
        assert_eq!(r1.items.len(), 2, "tag page 1 should return 2 items");
        assert!(r1.has_more, "tag page 1 should indicate more");
        assert_eq!(r1.items[0].id, "BLOCK001", "tag page 1 first item");
        assert_eq!(r1.items[1].id, "BLOCK002", "tag page 1 second item");

        let r2 = list_by_tag(
            &pool,
            "TAG00001",
            &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r2.items.len(), 2, "tag page 2 should return 2 items");
        assert!(r2.has_more, "tag page 2 should indicate more");
        assert_eq!(r2.items[0].id, "BLOCK003", "tag page 2 first item");
        assert_eq!(r2.items[1].id, "BLOCK004", "tag page 2 second item");

        let r3 = list_by_tag(
            &pool,
            "TAG00001",
            &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r3.items.len(), 1, "tag last page should return 1 item");
        assert!(!r3.has_more, "tag last page should not indicate more");
        assert!(
            r3.next_cursor.is_none(),
            "tag last page should have no cursor"
        );
        assert_eq!(r3.items[0].id, "BLOCK005", "tag last page item");
    }

    #[tokio::test]
    async fn list_by_tag_excludes_soft_deleted_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG00001", "tag", "important", None, None).await;
        insert_block(&pool, "BLOCK001", "content", "alive", None, None).await;
        insert_block(&pool, "BLOCK002", "content", "deleted", None, None).await;

        insert_tag_association(&pool, "BLOCK001", "TAG00001").await;
        insert_tag_association(&pool, "BLOCK002", "TAG00001").await;
        soft_delete_block(&pool, "BLOCK002", FIXED_DELETED_AT).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_by_tag(&pool, "TAG00001", &page).await.unwrap();

        assert_eq!(resp.items.len(), 1, "soft-deleted block must be excluded");
        assert_eq!(
            resp.items[0].id, "BLOCK001",
            "only alive tagged block returned"
        );
    }

    #[tokio::test]
    async fn list_by_tag_returns_empty_for_unknown_tag() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLOCK001", "content", "untagged", None, None).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_by_tag(&pool, "NONEXISTENT_TAG", &page).await.unwrap();

        assert!(resp.items.is_empty(), "unknown tag must return empty");
        assert!(!resp.has_more, "empty tag result should not indicate more");
    }

    // ====================================================================
    // query_by_property
    // ====================================================================

    /// Helper: insert a block_properties row directly.
    async fn insert_property(pool: &SqlitePool, block_id: &str, key: &str, value_text: &str) {
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
            .bind(block_id)
            .bind(key)
            .bind(value_text)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn query_by_property_returns_matching_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLOCK001", "content", "task 1", None, None).await;
        insert_block(&pool, "BLOCK002", "content", "task 2", None, None).await;
        insert_block(&pool, "BLOCK003", "content", "no prop", None, None).await;

        insert_property(&pool, "BLOCK001", "todo", "TODO").await;
        insert_property(&pool, "BLOCK002", "todo", "DONE").await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = query_by_property(&pool, "todo", None, None, "eq", &page)
            .await
            .unwrap();

        assert_eq!(resp.items.len(), 2, "only blocks with 'todo' property");
        assert_eq!(
            resp.items[0].id, "BLOCK001",
            "first block with todo property"
        );
        assert_eq!(
            resp.items[1].id, "BLOCK002",
            "second block with todo property"
        );
    }

    #[tokio::test]
    async fn query_by_property_filters_by_value() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLOCK001", "content", "task 1", None, None).await;
        insert_block(&pool, "BLOCK002", "content", "task 2", None, None).await;

        insert_property(&pool, "BLOCK001", "todo", "TODO").await;
        insert_property(&pool, "BLOCK002", "todo", "DONE").await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = query_by_property(&pool, "todo", Some("TODO"), None, "eq", &page)
            .await
            .unwrap();

        assert_eq!(resp.items.len(), 1, "only block with todo=TODO");
        assert_eq!(resp.items[0].id, "BLOCK001", "block matching value filter");
    }

    #[tokio::test]
    async fn query_by_property_paginates_with_cursor() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=5_i64 {
            let id = format!("BLOCK{i:03}");
            insert_block(&pool, &id, "content", &format!("b{i}"), None, None).await;
            insert_property(&pool, &id, "status", "active").await;
        }

        let r1 = query_by_property(
            &pool,
            "status",
            None,
            None,
            "eq",
            &PageRequest::new(None, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r1.items.len(), 2, "property page 1 should return 2 items");
        assert!(r1.has_more, "property page 1 should indicate more");
        assert_eq!(r1.items[0].id, "BLOCK001", "property page 1 first item");
        assert_eq!(r1.items[1].id, "BLOCK002", "property page 1 second item");

        let r2 = query_by_property(
            &pool,
            "status",
            None,
            None,
            "eq",
            &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r2.items.len(), 2, "property page 2 should return 2 items");
        assert!(r2.has_more, "property page 2 should indicate more");
        assert_eq!(r2.items[0].id, "BLOCK003", "property page 2 first item");
        assert_eq!(r2.items[1].id, "BLOCK004", "property page 2 second item");

        let r3 = query_by_property(
            &pool,
            "status",
            None,
            None,
            "eq",
            &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r3.items.len(), 1, "property last page should return 1 item");
        assert!(!r3.has_more, "property last page should not indicate more");
        assert!(
            r3.next_cursor.is_none(),
            "property last page should have no cursor"
        );
        assert_eq!(r3.items[0].id, "BLOCK005", "property last page item");
    }

    #[tokio::test]
    async fn query_by_property_returns_empty_for_nonexistent_key() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLOCK001", "content", "no props", None, None).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = query_by_property(&pool, "nonexistent_key", None, None, "eq", &page)
            .await
            .unwrap();

        assert!(resp.items.is_empty(), "nonexistent key must return empty");
        assert!(
            !resp.has_more,
            "empty property result should not indicate more"
        );
        assert!(
            resp.next_cursor.is_none(),
            "empty property result should have no cursor"
        );
    }

    #[tokio::test]
    async fn query_by_property_excludes_soft_deleted() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLOCK001", "content", "alive", None, None).await;
        insert_block(&pool, "BLOCK002", "content", "deleted", None, None).await;

        insert_property(&pool, "BLOCK001", "todo", "TODO").await;
        insert_property(&pool, "BLOCK002", "todo", "TODO").await;
        soft_delete_block(&pool, "BLOCK002", FIXED_DELETED_AT).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = query_by_property(&pool, "todo", None, None, "eq", &page)
            .await
            .unwrap();

        assert_eq!(resp.items.len(), 1, "soft-deleted block must be excluded");
        assert_eq!(
            resp.items[0].id, "BLOCK001",
            "only alive block with property"
        );
    }

    // ====================================================================
    // list_agenda
    // ====================================================================

    #[tokio::test]
    async fn list_agenda_returns_blocks_for_matching_date() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLOCK001", "content", "meeting", None, None).await;
        insert_block(&pool, "BLOCK002", "content", "deadline", None, None).await;
        insert_block(&pool, "BLOCK003", "content", "other day", None, None).await;

        insert_agenda_entry(&pool, "2025-01-15", "BLOCK001", "property:scheduled").await;
        insert_agenda_entry(&pool, "2025-01-15", "BLOCK002", "property:deadline").await;
        insert_agenda_entry(&pool, "2025-01-16", "BLOCK003", "property:scheduled").await;

        let page = PageRequest::new(None, Some(10)).unwrap();

        let resp = list_agenda(&pool, "2025-01-15", None, &page).await.unwrap();
        assert_eq!(resp.items.len(), 2, "only blocks for Jan 15");
        assert_eq!(
            resp.items[0].id, "BLOCK001",
            "first agenda block for Jan 15"
        );
        assert_eq!(
            resp.items[1].id, "BLOCK002",
            "second agenda block for Jan 15"
        );

        let resp2 = list_agenda(&pool, "2025-01-16", None, &page).await.unwrap();
        assert_eq!(resp2.items.len(), 1, "only blocks for Jan 16");
        assert_eq!(resp2.items[0].id, "BLOCK003", "agenda block for Jan 16");
    }

    #[tokio::test]
    async fn list_agenda_returns_empty_for_date_with_no_entries() {
        let (pool, _dir) = test_pool().await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_agenda(&pool, "2025-12-31", None, &page).await.unwrap();

        assert!(
            resp.items.is_empty(),
            "date with no entries must return empty"
        );
        assert!(!resp.has_more, "empty agenda should not indicate more");
    }

    #[tokio::test]
    async fn list_agenda_paginates_with_cursor() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=5_i64 {
            let id = format!("BLOCK{i:03}");
            insert_block(&pool, &id, "content", &format!("event {i}"), None, None).await;
            insert_agenda_entry(&pool, "2025-01-15", &id, "property:due").await;
        }

        let r1 = list_agenda(
            &pool,
            "2025-01-15",
            None,
            &PageRequest::new(None, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r1.items.len(), 2, "agenda page 1 should return 2 items");
        assert!(r1.has_more, "agenda page 1 should indicate more");
        assert_eq!(r1.items[0].id, "BLOCK001", "agenda page 1 first item");
        assert_eq!(r1.items[1].id, "BLOCK002", "agenda page 1 second item");

        let r2 = list_agenda(
            &pool,
            "2025-01-15",
            None,
            &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r2.items.len(), 2, "agenda page 2 should return 2 items");
        assert!(r2.has_more, "agenda page 2 should indicate more");
        assert_eq!(r2.items[0].id, "BLOCK003", "agenda page 2 first item");
        assert_eq!(r2.items[1].id, "BLOCK004", "agenda page 2 second item");

        let r3 = list_agenda(
            &pool,
            "2025-01-15",
            None,
            &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r3.items.len(), 1, "agenda last page should return 1 item");
        assert!(!r3.has_more, "agenda last page should not indicate more");
        assert!(
            r3.next_cursor.is_none(),
            "agenda last page should have no cursor"
        );
        assert_eq!(r3.items[0].id, "BLOCK005", "agenda last page item");
    }

    #[tokio::test]
    async fn list_agenda_excludes_soft_deleted() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLOCK001", "content", "meeting", None, None).await;
        insert_block(&pool, "BLOCK002", "content", "cancelled", None, None).await;
        insert_block(&pool, "BLOCK003", "content", "deadline", None, None).await;

        insert_agenda_entry(&pool, "2025-01-15", "BLOCK001", "property:scheduled").await;
        insert_agenda_entry(&pool, "2025-01-15", "BLOCK002", "property:scheduled").await;
        insert_agenda_entry(&pool, "2025-01-15", "BLOCK003", "property:deadline").await;

        soft_delete_block(&pool, "BLOCK002", FIXED_DELETED_AT).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_agenda(&pool, "2025-01-15", None, &page).await.unwrap();

        assert_eq!(
            resp.items.len(),
            2,
            "soft-deleted block must be excluded from agenda"
        );
        assert_eq!(resp.items[0].id, "BLOCK001", "first alive agenda block");
        assert_eq!(
            resp.items[1].id, "BLOCK003",
            "second alive agenda block, BLOCK002 excluded"
        );
    }

    // ====================================================================
    // insta snapshot tests — BlockRow and PageResponse
    // ====================================================================

    /// Snapshot a PageResponse<BlockRow> from list_children.
    /// All data is deterministic (manually inserted IDs/content).
    #[tokio::test]
    async fn snapshot_page_response_list_children() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "SNAP_PAR", "page", "parent page", None, Some(0)).await;
        insert_block(
            &pool,
            "SNAP_CH1",
            "content",
            "first child",
            Some("SNAP_PAR"),
            Some(1),
        )
        .await;
        insert_block(
            &pool,
            "SNAP_CH2",
            "content",
            "second child",
            Some("SNAP_PAR"),
            Some(2),
        )
        .await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_children(&pool, Some("SNAP_PAR"), &page).await.unwrap();

        insta::assert_yaml_snapshot!(resp);
    }

    /// Snapshot a PageResponse<BlockRow> with pagination (has_more = true).
    #[tokio::test]
    async fn snapshot_page_response_with_cursor() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "SNAP_PAR2", "page", "parent", None, Some(0)).await;
        for i in 1..=3_i64 {
            let id = format!("SNAP_C{i:02}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("child {i}"),
                Some("SNAP_PAR2"),
                Some(i),
            )
            .await;
        }

        let page = PageRequest::new(None, Some(2)).unwrap();
        let resp = list_children(&pool, Some("SNAP_PAR2"), &page)
            .await
            .unwrap();

        insta::assert_yaml_snapshot!(resp, {
            ".next_cursor" => "[CURSOR]",
        });
    }

    // ====================================================================
    // list_backlinks
    // ====================================================================

    /// Insert a block_links row directly.
    async fn insert_block_link(pool: &SqlitePool, source_id: &str, target_id: &str) {
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(source_id)
            .bind(target_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Insert an op_log entry directly for history tests.
    async fn insert_op_log_entry(
        pool: &SqlitePool,
        device_id: &str,
        seq: i64,
        op_type: &str,
        payload: &str,
        created_at: &str,
    ) {
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(device_id)
        .bind(seq)
        .bind("test-hash-placeholder")
        .bind(op_type)
        .bind(payload)
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Mark a block as a conflict.
    async fn set_conflict(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_list_backlinks_basic() {
        let (pool, _dir) = test_pool().await;

        // Target block and source blocks
        insert_block(&pool, "TARGET01", "page", "target page", None, None).await;
        insert_block(&pool, "SOURCE01", "content", "links to target", None, None).await;
        insert_block(&pool, "SOURCE02", "content", "also links", None, None).await;
        insert_block(&pool, "UNLINKED", "content", "no link", None, None).await;

        insert_block_link(&pool, "SOURCE01", "TARGET01").await;
        insert_block_link(&pool, "SOURCE02", "TARGET01").await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_backlinks(&pool, "TARGET01", &page).await.unwrap();

        assert_eq!(resp.items.len(), 2, "only linked blocks must be returned");
        assert_eq!(resp.items[0].id, "SOURCE01", "first backlink source");
        assert_eq!(resp.items[1].id, "SOURCE02", "second backlink source");
        assert!(!resp.has_more, "all backlinks fit in one page");
        assert!(
            resp.next_cursor.is_none(),
            "single page should have no cursor"
        );
    }

    #[tokio::test]
    async fn test_list_backlinks_pagination() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TARGET01", "page", "target", None, None).await;
        for i in 1..=5_i64 {
            let id = format!("SRC{i:05}");
            insert_block(&pool, &id, "content", &format!("source {i}"), None, None).await;
            insert_block_link(&pool, &id, "TARGET01").await;
        }

        // Page 1
        let r1 = list_backlinks(&pool, "TARGET01", &PageRequest::new(None, Some(2)).unwrap())
            .await
            .unwrap();
        assert_eq!(r1.items.len(), 2, "backlinks page 1 should return 2 items");
        assert!(r1.has_more, "backlinks page 1 should indicate more");
        assert_eq!(r1.items[0].id, "SRC00001", "backlinks page 1 first item");
        assert_eq!(r1.items[1].id, "SRC00002", "backlinks page 1 second item");

        // Page 2
        let r2 = list_backlinks(
            &pool,
            "TARGET01",
            &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r2.items.len(), 2, "backlinks page 2 should return 2 items");
        assert!(r2.has_more, "backlinks page 2 should indicate more");
        assert_eq!(r2.items[0].id, "SRC00003", "backlinks page 2 first item");
        assert_eq!(r2.items[1].id, "SRC00004", "backlinks page 2 second item");

        // Page 3 (last)
        let r3 = list_backlinks(
            &pool,
            "TARGET01",
            &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            r3.items.len(),
            1,
            "backlinks last page should return 1 item"
        );
        assert!(!r3.has_more, "backlinks last page should not indicate more");
        assert!(
            r3.next_cursor.is_none(),
            "backlinks last page should have no cursor"
        );
        assert_eq!(r3.items[0].id, "SRC00005", "backlinks last page item");
    }

    #[tokio::test]
    async fn test_list_backlinks_excludes_deleted() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TARGET01", "page", "target", None, None).await;
        insert_block(&pool, "SOURCE01", "content", "alive", None, None).await;
        insert_block(&pool, "SOURCE02", "content", "deleted", None, None).await;
        insert_block(&pool, "SOURCE03", "content", "alive too", None, None).await;

        insert_block_link(&pool, "SOURCE01", "TARGET01").await;
        insert_block_link(&pool, "SOURCE02", "TARGET01").await;
        insert_block_link(&pool, "SOURCE03", "TARGET01").await;

        soft_delete_block(&pool, "SOURCE02", FIXED_DELETED_AT).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_backlinks(&pool, "TARGET01", &page).await.unwrap();

        assert_eq!(
            resp.items.len(),
            2,
            "soft-deleted source block must be excluded"
        );
        assert_eq!(resp.items[0].id, "SOURCE01", "first alive backlink source");
        assert_eq!(resp.items[1].id, "SOURCE03", "second alive backlink source");
    }

    #[tokio::test]
    async fn test_list_backlinks_empty() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TARGET01", "page", "target page", None, None).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_backlinks(&pool, "TARGET01", &page).await.unwrap();

        assert!(
            resp.items.is_empty(),
            "target with no links must return empty"
        );
        assert!(!resp.has_more, "empty backlinks should not indicate more");
        assert!(
            resp.next_cursor.is_none(),
            "empty backlinks should have no cursor"
        );
    }

    // ====================================================================
    // list_block_history
    // ====================================================================

    #[tokio::test]
    async fn test_list_block_history_basic() {
        let (pool, _dir) = test_pool().await;

        let payload = r#"{"block_id":"HIST_BLK","block_type":"content","content":"hello"}"#;
        insert_op_log_entry(
            &pool,
            "device-1",
            1,
            "create_block",
            payload,
            "2025-01-01T00:00:00Z",
        )
        .await;

        let edit_payload = r#"{"block_id":"HIST_BLK","to_text":"updated"}"#;
        insert_op_log_entry(
            &pool,
            "device-1",
            2,
            "edit_block",
            edit_payload,
            "2025-01-01T01:00:00Z",
        )
        .await;

        // Unrelated op (different block)
        let other_payload = r#"{"block_id":"OTHER_BLK","content":"other"}"#;
        insert_op_log_entry(
            &pool,
            "device-1",
            3,
            "create_block",
            other_payload,
            "2025-01-01T02:00:00Z",
        )
        .await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_block_history(&pool, "HIST_BLK", &page).await.unwrap();

        assert_eq!(resp.items.len(), 2, "only ops for HIST_BLK");
        // Newest first (seq DESC)
        assert_eq!(resp.items[0].seq, 2, "newest op first");
        assert_eq!(
            resp.items[0].op_type, "edit_block",
            "newest op should be edit_block"
        );
        assert_eq!(resp.items[1].seq, 1, "oldest op seq should be 1");
        assert_eq!(
            resp.items[1].op_type, "create_block",
            "oldest op should be create_block"
        );
        assert!(!resp.has_more, "all history fits in one page");
    }

    #[tokio::test]
    async fn test_list_block_history_pagination() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=5_i64 {
            let payload = format!(r#"{{"block_id":"HIST_BLK","to_text":"v{i}"}}"#);
            insert_op_log_entry(
                &pool,
                "device-1",
                i,
                "edit_block",
                &payload,
                &format!("2025-01-01T{i:02}:00:00Z"),
            )
            .await;
        }

        // Page 1: newest first → seq 5, 4
        let r1 = list_block_history(&pool, "HIST_BLK", &PageRequest::new(None, Some(2)).unwrap())
            .await
            .unwrap();
        assert_eq!(r1.items.len(), 2, "history page 1 should return 2 items");
        assert!(r1.has_more, "history page 1 should indicate more");
        assert_eq!(r1.items[0].seq, 5, "history page 1 first seq");
        assert_eq!(r1.items[1].seq, 4, "history page 1 second seq");

        // Page 2: seq 3, 2
        let r2 = list_block_history(
            &pool,
            "HIST_BLK",
            &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r2.items.len(), 2, "history page 2 should return 2 items");
        assert!(r2.has_more, "history page 2 should indicate more");
        assert_eq!(r2.items[0].seq, 3, "history page 2 first seq");
        assert_eq!(r2.items[1].seq, 2, "history page 2 second seq");

        // Page 3 (last): seq 1
        let r3 = list_block_history(
            &pool,
            "HIST_BLK",
            &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(r3.items.len(), 1, "history last page should return 1 item");
        assert!(!r3.has_more, "history last page should not indicate more");
        assert!(
            r3.next_cursor.is_none(),
            "history last page should have no cursor"
        );
        assert_eq!(r3.items[0].seq, 1, "history last page seq");
    }

    #[tokio::test]
    async fn test_list_block_history_empty() {
        let (pool, _dir) = test_pool().await;

        // No ops in op_log at all
        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_block_history(&pool, "NONEXISTENT", &page)
            .await
            .unwrap();

        assert!(
            resp.items.is_empty(),
            "block with no history must return empty"
        );
        assert!(!resp.has_more, "empty history should not indicate more");
        assert!(
            resp.next_cursor.is_none(),
            "empty history should have no cursor"
        );
    }

    #[tokio::test]
    async fn test_list_block_history_all_op_types() {
        let (pool, _dir) = test_pool().await;

        let ops = [
            (
                1,
                "create_block",
                r#"{"block_id":"BLK01","block_type":"content","content":"hi"}"#,
            ),
            (
                2,
                "edit_block",
                r#"{"block_id":"BLK01","to_text":"updated"}"#,
            ),
            (3, "add_tag", r#"{"block_id":"BLK01","tag_id":"TAG01"}"#),
            (4, "remove_tag", r#"{"block_id":"BLK01","tag_id":"TAG01"}"#),
            (
                5,
                "move_block",
                r#"{"block_id":"BLK01","new_parent_id":null,"new_position":1}"#,
            ),
        ];

        for (seq, op_type, payload) in &ops {
            insert_op_log_entry(
                &pool,
                "device-1",
                *seq,
                op_type,
                payload,
                "2025-01-01T00:00:00Z",
            )
            .await;
        }

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_block_history(&pool, "BLK01", &page).await.unwrap();

        assert_eq!(
            resp.items.len(),
            5,
            "all op types for the block must be returned"
        );
        let op_types: Vec<&str> = resp.items.iter().map(|e| e.op_type.as_str()).collect();
        assert!(
            op_types.contains(&"create_block"),
            "create_block op should appear"
        );
        assert!(
            op_types.contains(&"edit_block"),
            "edit_block op should appear"
        );
        assert!(op_types.contains(&"add_tag"), "add_tag op should appear");
        assert!(
            op_types.contains(&"remove_tag"),
            "remove_tag op should appear"
        );
        assert!(
            op_types.contains(&"move_block"),
            "move_block op should appear"
        );
    }

    // ====================================================================
    // list_conflicts
    // ====================================================================

    #[tokio::test]
    async fn test_list_conflicts_basic() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "NORMAL01", "content", "normal", None, None).await;
        insert_block(&pool, "CONFLCT1", "content", "conflict 1", None, None).await;
        insert_block(&pool, "CONFLCT2", "content", "conflict 2", None, None).await;

        set_conflict(&pool, "CONFLCT1").await;
        set_conflict(&pool, "CONFLCT2").await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_conflicts(&pool, &page).await.unwrap();

        assert_eq!(resp.items.len(), 2, "only conflict blocks");
        assert_eq!(resp.items[0].id, "CONFLCT1", "first conflict block");
        assert_eq!(resp.items[1].id, "CONFLCT2", "second conflict block");
        assert!(
            resp.items.iter().all(|b| b.is_conflict),
            "all returned blocks must be conflicts"
        );
        assert!(!resp.has_more, "all conflicts fit in one page");
    }

    #[tokio::test]
    async fn test_list_conflicts_excludes_deleted() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "CONFLCT1", "content", "alive conflict", None, None).await;
        insert_block(&pool, "CONFLCT2", "content", "deleted conflict", None, None).await;

        set_conflict(&pool, "CONFLCT1").await;
        set_conflict(&pool, "CONFLCT2").await;
        soft_delete_block(&pool, "CONFLCT2", FIXED_DELETED_AT).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_conflicts(&pool, &page).await.unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "soft-deleted conflict must be excluded"
        );
        assert_eq!(resp.items[0].id, "CONFLCT1", "only alive conflict block");
    }

    #[tokio::test]
    async fn test_list_conflicts_empty() {
        let (pool, _dir) = test_pool().await;

        // Only normal blocks, no conflicts
        insert_block(&pool, "NORMAL01", "content", "normal", None, None).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_conflicts(&pool, &page).await.unwrap();

        assert!(
            resp.items.is_empty(),
            "no conflict blocks must return empty"
        );
        assert!(!resp.has_more, "empty conflicts should not indicate more");
        assert!(
            resp.next_cursor.is_none(),
            "empty conflicts should have no cursor"
        );
    }

    #[tokio::test]
    async fn test_list_conflicts_pagination() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=5_i64 {
            let id = format!("CONFLCT{i}");
            insert_block(&pool, &id, "content", &format!("conflict {i}"), None, None).await;
            set_conflict(&pool, &id).await;
        }

        // Page 1
        let r1 = list_conflicts(&pool, &PageRequest::new(None, Some(2)).unwrap())
            .await
            .unwrap();
        assert_eq!(r1.items.len(), 2, "conflicts page 1 should return 2 items");
        assert!(r1.has_more, "conflicts page 1 should indicate more");
        assert_eq!(r1.items[0].id, "CONFLCT1", "conflicts page 1 first item");
        assert_eq!(r1.items[1].id, "CONFLCT2", "conflicts page 1 second item");

        // Page 2
        let r2 = list_conflicts(&pool, &PageRequest::new(r1.next_cursor, Some(2)).unwrap())
            .await
            .unwrap();
        assert_eq!(r2.items.len(), 2, "conflicts page 2 should return 2 items");
        assert!(r2.has_more, "conflicts page 2 should indicate more");
        assert_eq!(r2.items[0].id, "CONFLCT3", "conflicts page 2 first item");
        assert_eq!(r2.items[1].id, "CONFLCT4", "conflicts page 2 second item");

        // Page 3 (last)
        let r3 = list_conflicts(&pool, &PageRequest::new(r2.next_cursor, Some(2)).unwrap())
            .await
            .unwrap();
        assert_eq!(
            r3.items.len(),
            1,
            "conflicts last page should return 1 item"
        );
        assert!(!r3.has_more, "conflicts last page should not indicate more");
        assert!(
            r3.next_cursor.is_none(),
            "conflicts last page should have no cursor"
        );
        assert_eq!(r3.items[0].id, "CONFLCT5", "conflicts last page item");
    }

    // ====================================================================
    // insta snapshot tests — HistoryEntry
    // ====================================================================

    /// Snapshot a PageResponse<HistoryEntry> from list_block_history.
    #[tokio::test]
    async fn snapshot_history_entry_response() {
        let (pool, _dir) = test_pool().await;

        let payload = r#"{"block_id":"SNAP_HIS","block_type":"content","content":"snap"}"#;
        insert_op_log_entry(
            &pool,
            "snap-device",
            1,
            "create_block",
            payload,
            "2025-06-15T12:00:00Z",
        )
        .await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_block_history(&pool, "SNAP_HIS", &page).await.unwrap();

        insta::assert_yaml_snapshot!(resp);
    }

    // ====================================================================
    // F01-fix: multi-device list_block_history
    // ====================================================================

    #[tokio::test]
    async fn test_list_block_history_multi_device_pagination() {
        let (pool, _dir) = test_pool().await;

        // Two devices with OVERLAPPING seq values for the same block.
        // PK is (device_id, seq), so seq alone is NOT globally unique.
        let payload = r#"{"block_id":"MULTI_BLK","block_type":"content","content":"hello"}"#;

        // device-A: seq 1, 2
        insert_op_log_entry(
            &pool,
            "device-A",
            1,
            "create_block",
            payload,
            "2025-01-01T00:00:00Z",
        )
        .await;
        insert_op_log_entry(
            &pool,
            "device-A",
            2,
            "edit_block",
            r#"{"block_id":"MULTI_BLK","to_text":"v2"}"#,
            "2025-01-01T01:00:00Z",
        )
        .await;

        // device-B: seq 1, 2 (same seq values, different device)
        insert_op_log_entry(
            &pool,
            "device-B",
            1,
            "edit_block",
            r#"{"block_id":"MULTI_BLK","to_text":"v3"}"#,
            "2025-01-01T02:00:00Z",
        )
        .await;
        insert_op_log_entry(
            &pool,
            "device-B",
            2,
            "edit_block",
            r#"{"block_id":"MULTI_BLK","to_text":"v4"}"#,
            "2025-01-01T03:00:00Z",
        )
        .await;

        // Paginate with limit=1 so every op lands on its own page.
        // Expected order: (seq DESC, device_id DESC) → (2,B), (2,A), (1,B), (1,A)
        let mut all_entries: Vec<(i64, String)> = Vec::new();
        let mut cursor = None;
        loop {
            let page = PageRequest::new(cursor, Some(1)).unwrap();
            let resp = list_block_history(&pool, "MULTI_BLK", &page).await.unwrap();
            for entry in &resp.items {
                all_entries.push((entry.seq, entry.device_id.clone()));
            }
            if !resp.has_more {
                break;
            }
            cursor = resp.next_cursor;
        }

        assert_eq!(
            all_entries.len(),
            4,
            "all 4 ops must be returned (2 devices × 2 seq values)"
        );
        // Ordered by (seq DESC, device_id DESC)
        assert_eq!(
            all_entries[0],
            (2, "device-B".into()),
            "first: seq=2, device-B"
        );
        assert_eq!(
            all_entries[1],
            (2, "device-A".into()),
            "second: seq=2, device-A"
        );
        assert_eq!(
            all_entries[2],
            (1, "device-B".into()),
            "third: seq=1, device-B"
        );
        assert_eq!(
            all_entries[3],
            (1, "device-A".into()),
            "fourth: seq=1, device-A"
        );
    }

    // ====================================================================
    // F08-fix: cursor validation for list_trash
    // ====================================================================

    #[tokio::test]
    async fn list_trash_rejects_cursor_without_deleted_at() {
        let (pool, _dir) = test_pool().await;

        // A cursor that has no deleted_at — e.g. from a non-trash query.
        let bad_cursor = Cursor {
            id: "BLOCK001".into(),
            position: None,
            deleted_at: None, // missing!
            seq: None,
            rank: None,
        }
        .encode()
        .unwrap();

        let page = PageRequest::new(Some(bad_cursor), Some(10)).unwrap();
        let result = list_trash(&pool, &page).await;

        assert!(
            result.is_err(),
            "cursor without deleted_at must be rejected for trash query"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("cursor missing deleted_at"),
            "error message must mention missing deleted_at, got: {err_msg}"
        );
    }

    // ====================================================================
    // F07-fix: list_by_tag excludes conflict blocks
    // ====================================================================

    #[tokio::test]
    async fn list_by_tag_excludes_conflict_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG00001", "tag", "important", None, None).await;
        insert_block(&pool, "BLOCK001", "content", "normal", None, None).await;
        insert_block(&pool, "BLOCK002", "content", "conflict", None, None).await;

        insert_tag_association(&pool, "BLOCK001", "TAG00001").await;
        insert_tag_association(&pool, "BLOCK002", "TAG00001").await;

        set_conflict(&pool, "BLOCK002").await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_by_tag(&pool, "TAG00001", &page).await.unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "conflict blocks must be excluded from list_by_tag"
        );
        assert_eq!(
            resp.items[0].id, "BLOCK001",
            "only non-conflict tagged block"
        );
    }

    // ====================================================================
    // Cursor stability after deletes (#37)
    // ====================================================================

    /// Cursor-based keyset pagination must remain stable when rows are
    /// soft-deleted between page fetches.
    ///
    /// Scenario:
    /// 1. Create 10 children (C01–C10) under a parent.
    /// 2. Fetch the first page (limit=5), obtaining a cursor after C05.
    /// 3. Soft-delete C03 (before the cursor).
    /// 4. Fetch page 2 using the cursor — must return C06–C10 without
    ///    duplicates or gaps, even though C03 is now gone.
    ///
    /// This works because keyset pagination uses `(position, id) > cursor`
    /// rather than offset-based `SKIP N`, so deleted rows before the cursor
    /// do not shift subsequent page boundaries.
    #[tokio::test]
    async fn cursor_stability_after_delete() {
        let (pool, _dir) = test_pool().await;

        // Create parent + 10 children
        insert_block(&pool, "CSPAR001", "page", "parent", None, Some(0)).await;
        for i in 1..=10_i64 {
            let id = format!("CS_C{i:03}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("child {i}"),
                Some("CSPAR001"),
                Some(i),
            )
            .await;
        }

        // Page 1: fetch first 5 children (limit=5)
        let p1 = PageRequest::new(None, Some(5)).unwrap();
        let r1 = list_children(&pool, Some("CSPAR001"), &p1).await.unwrap();

        assert_eq!(r1.items.len(), 5, "page 1 must return 5 items");
        assert!(r1.has_more, "page 1 must have more items");
        assert_eq!(r1.items[0].id, "CS_C001", "page 1 should start at C001");
        assert_eq!(r1.items[4].id, "CS_C005", "page 1 should end at C005");

        // Soft-delete C03 (a block BEFORE the cursor position).
        // This was already returned in page 1, so it shouldn't affect page 2.
        soft_delete_block(&pool, "CS_C003", FIXED_DELETED_AT).await;

        // Page 2: continue from cursor — must see C06..C10 (keyset skips
        // past C05 regardless of deleted rows before it).
        let p2 = PageRequest::new(r1.next_cursor, Some(5)).unwrap();
        let r2 = list_children(&pool, Some("CSPAR001"), &p2).await.unwrap();

        assert_eq!(r2.items.len(), 5, "page 2 must return 5 items (C06–C10)");
        assert!(!r2.has_more, "page 2 is the last page");
        assert_eq!(r2.items[0].id, "CS_C006", "page 2 must start at C06");
        assert_eq!(r2.items[4].id, "CS_C010", "page 2 must end at C10");

        // C03 must NOT appear in page 2 (it's soft-deleted and was before
        // the cursor anyway). Page 1 already returned it before deletion.
        let page2_ids: Vec<&str> = r2.items.iter().map(|b| b.id.as_str()).collect();
        assert!(
            !page2_ids.contains(&"CS_C003"),
            "soft-deleted C03 must not appear in page 2"
        );

        // Verify no duplicates between page 1 and page 2
        let mut all_ids: Vec<String> = r1.items.iter().map(|b| b.id.clone()).collect();
        all_ids.extend(r2.items.iter().map(|b| b.id.clone()));
        let unique_count = {
            let mut set = std::collections::HashSet::new();
            all_ids
                .iter()
                .filter(|id| set.insert((*id).clone()))
                .count()
        };
        assert_eq!(unique_count, all_ids.len(), "no duplicate IDs across pages");

        // Verify a fresh full walk (no cursor) skips the deleted C03
        let fresh_page = PageRequest::new(None, Some(20)).unwrap();
        let fresh = list_children(&pool, Some("CSPAR001"), &fresh_page)
            .await
            .unwrap();
        assert_eq!(
            fresh.items.len(),
            9,
            "full walk after delete must return 9 items (C01–C10 minus C03)"
        );
        let fresh_ids: Vec<&str> = fresh.items.iter().map(|b| b.id.as_str()).collect();
        assert!(
            !fresh_ids.contains(&"CS_C003"),
            "deleted C03 must be excluded from fresh walk"
        );
    }

    // ======================================================================
    // list_children: next_cursor with exactly limit+1 items (line 174)
    // ======================================================================

    /// When exactly `limit + 1` items exist, has_more is true and next_cursor
    /// is set. This exercises the `build_page_response` cursor construction
    /// path (line 165-167) and the next_cursor field assignment (line 173).
    #[tokio::test]
    async fn list_children_exactly_limit_plus_one_returns_next_cursor() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "LP_PAR", "page", "parent", None, Some(1)).await;

        // Insert exactly 3 children (limit will be 2 → 3 = limit + 1)
        for i in 1..=3_i64 {
            let id = format!("LP_C{i:03}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("child {i}"),
                Some("LP_PAR"),
                Some(i),
            )
            .await;
        }

        let page = PageRequest::new(None, Some(2)).unwrap();
        let resp = list_children(&pool, Some("LP_PAR"), &page).await.unwrap();

        assert_eq!(resp.items.len(), 2, "should return exactly limit items");
        assert!(resp.has_more, "has_more must be true with limit+1 items");
        assert!(
            resp.next_cursor.is_some(),
            "next_cursor must be set when has_more is true"
        );
    }

    /// When exactly `limit` items exist (no extra), has_more is false and
    /// next_cursor is None. This is the boundary condition for the cursor
    /// path — the extra-row check finds no overflow.
    #[tokio::test]
    async fn list_children_exactly_limit_items_returns_no_next_cursor() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "LE_PAR", "page", "parent", None, Some(1)).await;

        // Insert exactly 2 children (limit = 2 → fetch 3, get 2 → no overflow)
        for i in 1..=2_i64 {
            let id = format!("LE_C{i:03}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("child {i}"),
                Some("LE_PAR"),
                Some(i),
            )
            .await;
        }

        let page = PageRequest::new(None, Some(2)).unwrap();
        let resp = list_children(&pool, Some("LE_PAR"), &page).await.unwrap();

        assert_eq!(resp.items.len(), 2, "should return all 2 items");
        assert!(!resp.has_more, "has_more must be false when no overflow");
        assert!(
            resp.next_cursor.is_none(),
            "next_cursor must be None when has_more is false"
        );
    }

    // ====================================================================
    // CTE oracle: verify optimized (no IFNULL) query matches original
    // ====================================================================

    /// Oracle: the old IFNULL-based list_children query (pre-P-18).
    /// Preserved for correctness verification against the new plain-position query.
    async fn list_children_ifnull_oracle(
        pool: &SqlitePool,
        parent_id: Option<&str>,
        page: &PageRequest,
    ) -> Result<PageResponse<BlockRow>, AppError> {
        let fetch_limit = page.limit + 1;

        let (cursor_flag, cursor_pos, cursor_id): (Option<i64>, i64, &str) =
            match page.after.as_ref() {
                Some(c) => (Some(1), c.position.unwrap_or(NULL_POSITION_SENTINEL), &c.id),
                None => (None, 0, ""),
            };

        let rows = sqlx::query_as::<_, BlockRow>(
            r#"SELECT id, block_type, content, parent_id, position,
                    deleted_at, is_conflict,
                    conflict_type, todo_state, priority, due_date, scheduled_date
             FROM blocks
             WHERE parent_id IS ?1 AND deleted_at IS NULL
               AND (?2 IS NULL OR (
                    IFNULL(position, ?6) > ?3
                    OR (IFNULL(position, ?6) = ?3 AND id > ?4)))
             ORDER BY IFNULL(position, ?6) ASC, id ASC
             LIMIT ?5"#,
        )
        .bind(parent_id)
        .bind(cursor_flag)
        .bind(cursor_pos)
        .bind(cursor_id)
        .bind(fetch_limit)
        .bind(NULL_POSITION_SENTINEL)
        .fetch_all(pool)
        .await?;

        build_page_response(rows, page.limit, |last| Cursor {
            id: last.id.clone(),
            position: Some(last.position.unwrap_or(NULL_POSITION_SENTINEL)),
            deleted_at: None,
            seq: None,
            rank: None,
        })
    }

    /// CTE oracle test: verify the new plain-position query produces identical
    /// results to the old IFNULL-based query on the same dataset.
    #[tokio::test]
    async fn list_children_optimized_matches_ifnull_oracle() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;

        // Mix of positioned and sentinel-positioned blocks
        insert_block(
            &pool,
            "CHILD001",
            "content",
            "c1",
            Some("PARENT01"),
            Some(1),
        )
        .await;
        insert_block(
            &pool,
            "CHILD002",
            "content",
            "c2",
            Some("PARENT01"),
            Some(2),
        )
        .await;
        insert_block(
            &pool,
            "CHILD003",
            "content",
            "c3",
            Some("PARENT01"),
            Some(5),
        )
        .await;
        insert_block(
            &pool,
            "CHILD004",
            "content",
            "c4",
            Some("PARENT01"),
            Some(5),
        )
        .await;
        // Sentinel-positioned blocks (simulating former NULL positions after migration)
        insert_block(
            &pool,
            "TAG00001",
            "tag",
            "tag1",
            Some("PARENT01"),
            Some(NULL_POSITION_SENTINEL),
        )
        .await;
        insert_block(
            &pool,
            "TAG00002",
            "tag",
            "tag2",
            Some("PARENT01"),
            Some(NULL_POSITION_SENTINEL),
        )
        .await;

        // Walk all pages with both implementations and collect results
        let mut new_ids = Vec::new();
        let mut old_ids = Vec::new();
        let mut new_cursor = None;
        let mut old_cursor = None;
        loop {
            let new_page = PageRequest::new(new_cursor.clone(), Some(2)).unwrap();
            let old_page = PageRequest::new(old_cursor.clone(), Some(2)).unwrap();

            let new_resp = list_children(&pool, Some("PARENT01"), &new_page)
                .await
                .unwrap();
            let old_resp = list_children_ifnull_oracle(&pool, Some("PARENT01"), &old_page)
                .await
                .unwrap();

            // Each page should return the same items
            let new_page_ids: Vec<&str> = new_resp.items.iter().map(|b| b.id.as_str()).collect();
            let old_page_ids: Vec<&str> = old_resp.items.iter().map(|b| b.id.as_str()).collect();
            assert_eq!(
                new_page_ids, old_page_ids,
                "page results must match between optimized and oracle query"
            );

            new_ids.extend(new_page_ids.iter().map(|s| s.to_string()));
            old_ids.extend(old_page_ids.iter().map(|s| s.to_string()));

            assert_eq!(
                new_resp.has_more, old_resp.has_more,
                "has_more must match between optimized and oracle query"
            );

            if !new_resp.has_more {
                break;
            }
            new_cursor = new_resp.next_cursor;
            old_cursor = old_resp.next_cursor;
        }

        assert_eq!(
            new_ids, old_ids,
            "full walk must produce identical results for optimized and oracle queries"
        );
        assert_eq!(new_ids.len(), 6, "must return all 6 blocks");
    }
}

#[cfg(test)]
mod proptest_tests {
    use super::*;
    use proptest::prelude::*;

    /// Strategy for arbitrary Cursor values.
    fn arb_cursor() -> impl Strategy<Value = Cursor> {
        (
            "[a-zA-Z0-9_-]{1,40}",                 // id
            proptest::option::of(0i64..=i64::MAX), // position
            proptest::option::of("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\+00:00"), // deleted_at
            proptest::option::of(1i64..100000),   // seq
            proptest::option::of(-100.0f64..0.0), // rank (FTS ranks are negative)
        )
            .prop_map(|(id, position, deleted_at, seq, rank)| Cursor {
                id,
                position,
                deleted_at,
                seq,
                rank,
            })
    }

    proptest! {
        /// Cursor encode/decode is a perfect round-trip for any valid cursor.
        #[test]
        fn cursor_encode_decode_roundtrip(cursor in arb_cursor()) {
            let encoded = cursor.encode().expect("encode must succeed");
            let decoded = Cursor::decode(&encoded).expect("decode must succeed");
            prop_assert_eq!(&cursor.id, &decoded.id);
            prop_assert_eq!(cursor.position, decoded.position);
            prop_assert_eq!(&cursor.deleted_at, &decoded.deleted_at);
            prop_assert_eq!(cursor.seq, decoded.seq);
            // Compare rank with tolerance for floating-point
            match (cursor.rank, decoded.rank) {
                (Some(a), Some(b)) => prop_assert!((a - b).abs() < 1e-9,
                    "rank mismatch: {} vs {}", a, b),
                (None, None) => {}
                _ => prop_assert!(false, "rank Some/None mismatch"),
            }
        }

        /// Encoding is deterministic: the same cursor always produces the same string.
        #[test]
        fn cursor_encode_deterministic(cursor in arb_cursor()) {
            let enc1 = cursor.encode().unwrap();
            let enc2 = cursor.encode().unwrap();
            prop_assert_eq!(&enc1, &enc2, "encoding must be deterministic");
        }
    }
}
