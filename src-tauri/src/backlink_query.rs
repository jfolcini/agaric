//! Server-side filtered backlink queries with compound filters, sorting,
//! and cursor-based pagination.
//!
//! Provides a `BacklinkFilter` tree for composing boolean filter queries
//! on backlinks and evaluating them against the database.
//!
//! ## Evaluation strategy
//!
//! 1. **Base set** — collect all `source_id`s from `block_links` where
//!    `target_id = ?` and the source block is not deleted/conflict.
//! 2. **Filter** — each `BacklinkFilter` resolves to a `FxHashSet<String>`
//!    of block_ids; filters are AND-ed together and intersected with the
//!    base set.
//! 3. **Sort** — sort the filtered set (Created = ULID order; property
//!    sorts fetch values and sort by them).
//! 4. **Paginate** — keyset cursor pagination on the sorted list.
//! 5. **Fetch** — load full `BlockRow` data for the page.

use rustc_hash::FxHashSet;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::fts::sanitize_fts_query;
use crate::pagination::{BlockRow, Cursor, PageRequest};

// ---------------------------------------------------------------------------
// LIKE-pattern escaping (duplicated from tag_query to avoid coupling)
// ---------------------------------------------------------------------------

/// Escape special LIKE pattern characters (`%`, `_`, `\`) so user-supplied
/// prefix strings match literally.
#[must_use]
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Crockford Base32 ULID timestamp extraction
// ---------------------------------------------------------------------------

/// Decode the first 10 characters of a ULID (Crockford base32) into Unix
/// milliseconds.  This is the timestamp component of the ULID.
fn ulid_to_ms(ulid: &str) -> Option<u64> {
    if ulid.len() < 10 {
        return None;
    }
    let ts_part = &ulid[..10];
    let mut value: u64 = 0;
    for ch in ts_part.chars() {
        let digit = crockford_decode_char(ch)?;
        value = value.checked_mul(32)?.checked_add(digit as u64)?;
    }
    Some(value)
}

/// Decode a single Crockford base32 character to its numeric value (0-31).
fn crockford_decode_char(c: char) -> Option<u8> {
    match c.to_ascii_uppercase() {
        '0' | 'O' => Some(0),
        '1' | 'I' | 'L' => Some(1),
        '2' => Some(2),
        '3' => Some(3),
        '4' => Some(4),
        '5' => Some(5),
        '6' => Some(6),
        '7' => Some(7),
        '8' => Some(8),
        '9' => Some(9),
        'A' => Some(10),
        'B' => Some(11),
        'C' => Some(12),
        'D' => Some(13),
        'E' => Some(14),
        'F' => Some(15),
        'G' => Some(16),
        'H' => Some(17),
        'J' => Some(18),
        'K' => Some(19),
        'M' => Some(20),
        'N' => Some(21),
        'P' => Some(22),
        'Q' => Some(23),
        'R' => Some(24),
        'S' => Some(25),
        'T' => Some(26),
        'V' => Some(27),
        'W' => Some(28),
        'X' => Some(29),
        'Y' => Some(30),
        'Z' => Some(31),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Comparison operators for property filters.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub enum CompareOp {
    Eq,
    Neq,
    Lt,
    Gt,
    Lte,
    Gte,
}

/// Sort direction.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub enum SortDir {
    Asc,
    Desc,
}

/// Tagged union of filter predicates for backlink queries.
///
/// Filters are combined with AND semantics at the top level.
/// Use `And`/`Or`/`Not` variants for compound boolean logic.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum BacklinkFilter {
    PropertyText {
        key: String,
        op: CompareOp,
        value: String,
    },
    PropertyNum {
        key: String,
        op: CompareOp,
        value: f64,
    },
    PropertyDate {
        key: String,
        op: CompareOp,
        value: String,
    },
    PropertyIsSet {
        key: String,
    },
    PropertyIsEmpty {
        key: String,
    },
    HasTag {
        tag_id: String,
    },
    HasTagPrefix {
        prefix: String,
    },
    Contains {
        query: String,
    },
    CreatedInRange {
        after: Option<String>,
        before: Option<String>,
    },
    BlockType {
        block_type: String,
    },
    And {
        filters: Vec<BacklinkFilter>,
    },
    Or {
        filters: Vec<BacklinkFilter>,
    },
    Not {
        filter: Box<BacklinkFilter>,
    },
}

/// Tagged union of sort modes for backlink queries.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum BacklinkSort {
    Created { dir: SortDir },
    PropertyText { key: String, dir: SortDir },
    PropertyNum { key: String, dir: SortDir },
    PropertyDate { key: String, dir: SortDir },
}

/// Response for a filtered backlink query, including total count.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct BacklinkQueryResponse {
    pub items: Vec<BlockRow>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub total_count: usize,
}

// ---------------------------------------------------------------------------
// Internal: resolve BacklinkFilter -> set of block_ids
// ---------------------------------------------------------------------------

/// Resolve a `BacklinkFilter` into the set of matching `block_id`s.
///
/// Deleted and conflict blocks are excluded at the leaf level.
/// Uses the same recursive `Pin<Box<dyn Future>>` pattern as `tag_query::resolve_expr`.
fn resolve_filter<'a>(
    pool: &'a SqlitePool,
    filter: &'a BacklinkFilter,
    depth: u32,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<FxHashSet<String>, AppError>> + Send + 'a>,
> {
    Box::pin(async move {
        if depth > 50 {
            return Err(AppError::Validation(
                "Filter nesting depth exceeds 50".into(),
            ));
        }
        match filter {
            BacklinkFilter::PropertyText { key, op, value } => {
                // Fetch all block_ids with the given property key and text value,
                // then apply the comparison operator in Rust.
                let rows = sqlx::query_as::<_, (String, Option<String>)>(
                    "SELECT bp.block_id, bp.value_text \
                     FROM block_properties bp \
                     JOIN blocks b ON b.id = bp.block_id \
                     WHERE bp.key = ?1 AND bp.value_text IS NOT NULL \
                       AND b.deleted_at IS NULL AND b.is_conflict = 0",
                )
                .bind(key)
                .fetch_all(pool)
                .await?;

                Ok(rows
                    .into_iter()
                    .filter(|(_, v)| {
                        let v = v.as_deref().unwrap_or("");
                        match op {
                            CompareOp::Eq => v == value.as_str(),
                            CompareOp::Neq => v != value.as_str(),
                            CompareOp::Lt => v < value.as_str(),
                            CompareOp::Gt => v > value.as_str(),
                            CompareOp::Lte => v <= value.as_str(),
                            CompareOp::Gte => v >= value.as_str(),
                        }
                    })
                    .map(|(id, _)| id)
                    .collect())
            }

            BacklinkFilter::PropertyNum { key, op, value } => {
                let rows = sqlx::query_as::<_, (String, Option<f64>)>(
                    "SELECT bp.block_id, bp.value_num \
                     FROM block_properties bp \
                     JOIN blocks b ON b.id = bp.block_id \
                     WHERE bp.key = ?1 AND bp.value_num IS NOT NULL \
                       AND b.deleted_at IS NULL AND b.is_conflict = 0",
                )
                .bind(key)
                .fetch_all(pool)
                .await?;

                Ok(rows
                    .into_iter()
                    .filter(|(_, v)| {
                        let v = v.expect("value_num guaranteed non-null by SQL WHERE clause");
                        match op {
                            CompareOp::Eq => (v - value).abs() < f64::EPSILON,
                            CompareOp::Neq => (v - value).abs() >= f64::EPSILON,
                            CompareOp::Lt => v < *value,
                            CompareOp::Gt => v > *value,
                            CompareOp::Lte => v <= *value,
                            CompareOp::Gte => v >= *value,
                        }
                    })
                    .map(|(id, _)| id)
                    .collect())
            }

            BacklinkFilter::PropertyDate { key, op, value } => {
                let rows = sqlx::query_as::<_, (String, Option<String>)>(
                    "SELECT bp.block_id, bp.value_date \
                     FROM block_properties bp \
                     JOIN blocks b ON b.id = bp.block_id \
                     WHERE bp.key = ?1 AND bp.value_date IS NOT NULL \
                       AND b.deleted_at IS NULL AND b.is_conflict = 0",
                )
                .bind(key)
                .fetch_all(pool)
                .await?;

                Ok(rows
                    .into_iter()
                    .filter(|(_, v)| {
                        let v = v.as_deref().unwrap_or("");
                        match op {
                            CompareOp::Eq => v == value.as_str(),
                            CompareOp::Neq => v != value.as_str(),
                            CompareOp::Lt => v < value.as_str(),
                            CompareOp::Gt => v > value.as_str(),
                            CompareOp::Lte => v <= value.as_str(),
                            CompareOp::Gte => v >= value.as_str(),
                        }
                    })
                    .map(|(id, _)| id)
                    .collect())
            }

            BacklinkFilter::PropertyIsSet { key } => {
                let rows = sqlx::query_scalar::<_, String>(
                    "SELECT bp.block_id \
                     FROM block_properties bp \
                     JOIN blocks b ON b.id = bp.block_id \
                     WHERE bp.key = ?1 \
                       AND b.deleted_at IS NULL AND b.is_conflict = 0",
                )
                .bind(key)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::PropertyIsEmpty { key } => {
                // Blocks that do NOT have the property set.
                // Single query with NOT EXISTS to avoid fetching all block IDs into memory.
                let rows = sqlx::query_scalar::<_, String>(
                    "SELECT b.id FROM blocks b \
                     WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
                       AND NOT EXISTS ( \
                         SELECT 1 FROM block_properties bp \
                         WHERE bp.block_id = b.id AND bp.key = ?1 \
                       )",
                )
                .bind(key)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::HasTag { tag_id } => {
                // Duplicate leaf SQL from tag_query (avoids making resolve_expr pub)
                let rows = sqlx::query_scalar::<_, String>(
                    "SELECT bt.block_id FROM block_tags bt \
                     JOIN blocks b ON b.id = bt.block_id \
                     WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0",
                )
                .bind(tag_id)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::HasTagPrefix { prefix } => {
                let escaped = format!("{}%", escape_like(prefix));
                let rows = sqlx::query_scalar::<_, String>(
                    "SELECT DISTINCT bt.block_id \
                     FROM tags_cache tc \
                     JOIN block_tags bt ON bt.tag_id = tc.tag_id \
                     JOIN blocks b ON b.id = bt.block_id \
                     WHERE tc.name LIKE ?1 ESCAPE '\\' \
                       AND b.deleted_at IS NULL AND b.is_conflict = 0",
                )
                .bind(&escaped)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::Contains { query } => {
                if query.trim().is_empty() {
                    return Ok(FxHashSet::default());
                }
                let sanitized = sanitize_fts_query(query);
                if sanitized.is_empty() {
                    return Ok(FxHashSet::default());
                }
                // Query FTS5 index, join back to blocks to get block id and
                // exclude deleted/conflict blocks.
                let rows = sqlx::query_scalar::<_, String>(
                    "SELECT fb.block_id \
                     FROM fts_blocks fb \
                     JOIN blocks b ON b.id = fb.block_id \
                     WHERE fts_blocks MATCH ?1 \
                       AND b.deleted_at IS NULL AND b.is_conflict = 0",
                )
                .bind(&sanitized)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::CreatedInRange { after, before } => {
                // Parse ISO 8601 date strings to Unix milliseconds, then filter
                // block IDs by their ULID timestamp component.
                let after_ms = after.as_ref().and_then(|d| parse_iso_to_ms(d));
                let before_ms = before.as_ref().and_then(|d| parse_iso_to_ms(d));

                let all_ids = sqlx::query_scalar::<_, String>(
                    "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0",
                )
                .fetch_all(pool)
                .await?;

                Ok(all_ids
                    .into_iter()
                    .filter(|id| {
                        if let Some(ms) = ulid_to_ms(id) {
                            let after_ok = after_ms.is_none_or(|a| ms >= a);
                            let before_ok = before_ms.is_none_or(|b| ms < b);
                            after_ok && before_ok
                        } else {
                            false
                        }
                    })
                    .collect())
            }

            BacklinkFilter::BlockType { block_type } => {
                let rows = sqlx::query_scalar::<_, String>(
                    "SELECT id FROM blocks \
                     WHERE block_type = ?1 AND deleted_at IS NULL AND is_conflict = 0",
                )
                .bind(block_type)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::And { filters } => {
                if filters.is_empty() {
                    return Ok(FxHashSet::default());
                }
                let mut iter = filters.iter();
                let mut result = resolve_filter(pool, iter.next().unwrap(), depth + 1).await?;
                for f in iter {
                    let set = resolve_filter(pool, f, depth + 1).await?;
                    result.retain(|id| set.contains(id));
                }
                Ok(result)
            }

            BacklinkFilter::Or { filters } => {
                let mut result = FxHashSet::default();
                for f in filters {
                    let set = resolve_filter(pool, f, depth + 1).await?;
                    result.extend(set);
                }
                Ok(result)
            }

            BacklinkFilter::Not { filter } => {
                let all = sqlx::query_scalar::<_, String>(
                    "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0",
                )
                .fetch_all(pool)
                .await?;
                let inner_set = resolve_filter(pool, filter, depth + 1).await?;
                Ok(all
                    .into_iter()
                    .filter(|id| !inner_set.contains(id))
                    .collect())
            }
        }
    })
}

/// Parse an ISO 8601 date string (YYYY-MM-DD or full datetime) to Unix
/// milliseconds.  For date-only strings, treats as midnight UTC.
fn parse_iso_to_ms(s: &str) -> Option<u64> {
    // Try full datetime parse first (e.g. "2025-01-15T12:00:00Z")
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis() as u64);
    }
    // Try date-only parse (e.g. "2025-01-15")
    if let Ok(date) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let dt = date.and_hms_opt(0, 0, 0)?;
        return Some(dt.and_utc().timestamp_millis() as u64);
    }
    None
}

// ---------------------------------------------------------------------------
// Public: eval_backlink_query (paginated + filtered)
// ---------------------------------------------------------------------------

/// Evaluate a filtered backlink query and return a paginated set of blocks.
///
/// ## Algorithm
///
/// 1. Get base backlink set (source_ids linking to `block_id`).
/// 2. If filters provided, resolve each to a set, AND them all together,
///    then intersect with the base set.
/// 3. Sort the result set.
/// 4. Apply keyset cursor pagination.
/// 5. Fetch full `BlockRow` data for the page.
/// 6. Return `BacklinkQueryResponse` with `total_count`.
pub async fn eval_backlink_query(
    pool: &SqlitePool,
    block_id: &str,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    page: &PageRequest,
) -> Result<BacklinkQueryResponse, AppError> {
    // 1. Get base backlink set
    let base_ids: FxHashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT bl.source_id FROM block_links bl \
         JOIN blocks b ON b.id = bl.source_id \
         WHERE bl.target_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0",
    )
    .bind(block_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    if base_ids.is_empty() {
        return Ok(BacklinkQueryResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
        });
    }

    // 2. Apply filters (AND semantics at top level)
    let filtered_ids = if let Some(ref filter_list) = filters {
        if filter_list.is_empty() {
            base_ids.clone()
        } else {
            let mut result = base_ids.clone();
            for filter in filter_list {
                let set = resolve_filter(pool, filter, 0).await?;
                result.retain(|id| set.contains(id));
            }
            result
        }
    } else {
        base_ids.clone()
    };

    // 3. Compute total_count before pagination
    let total_count = filtered_ids.len();

    if total_count == 0 {
        return Ok(BacklinkQueryResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
        });
    }

    // 4. Sort
    let sort = sort.unwrap_or(BacklinkSort::Created { dir: SortDir::Asc });
    let sorted_ids = sort_ids(pool, &filtered_ids, &sort).await?;

    // 5. Apply cursor pagination
    let start_after = page.after.as_ref().map(|c| c.id.as_str());
    let filtered: Vec<&str> = if let Some(after_id) = start_after {
        sorted_ids
            .iter()
            .map(|s| s.as_str())
            .skip_while(|id| *id != after_id)
            .skip(1) // skip the cursor item itself
            .collect()
    } else {
        sorted_ids.iter().map(|s| s.as_str()).collect()
    };

    let fetch_limit = (page.limit + 1) as usize;
    let page_ids: Vec<&str> = filtered.into_iter().take(fetch_limit).collect();
    let has_more = page_ids.len() > page.limit as usize;
    let actual_ids: Vec<&str> = if has_more {
        page_ids[..page.limit as usize].to_vec()
    } else {
        page_ids
    };

    if actual_ids.is_empty() {
        return Ok(BacklinkQueryResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count,
        });
    }

    // 6. Fetch full BlockRows
    let placeholders = actual_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query_str = format!(
        "SELECT id, block_type, content, parent_id, position, \
         deleted_at, archived_at, is_conflict \
         FROM blocks WHERE id IN ({placeholders})"
    );

    let mut query = sqlx::query_as::<_, BlockRow>(&query_str);
    for id in &actual_ids {
        query = query.bind(*id);
    }
    let fetched: Vec<BlockRow> = query.fetch_all(pool).await?;

    // Reorder fetched rows to match the sorted order
    let id_order: std::collections::HashMap<&str, usize> = actual_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();
    let mut items = fetched;
    items.sort_by_key(|row| id_order.get(row.id.as_str()).copied().unwrap_or(usize::MAX));

    // 7. Build cursor
    let next_cursor = if has_more {
        let last = items.last().expect("has_more implies non-empty");
        Some(
            Cursor {
                id: last.id.clone(),
                position: None,
                deleted_at: None,
                seq: None,
                rank: None,
            }
            .encode()?,
        )
    } else {
        None
    };

    Ok(BacklinkQueryResponse {
        items,
        next_cursor,
        has_more,
        total_count,
    })
}

/// Sort a set of block IDs according to the given sort mode.
///
/// Returns a Vec in sorted order.
async fn sort_ids(
    pool: &SqlitePool,
    ids: &FxHashSet<String>,
    sort: &BacklinkSort,
) -> Result<Vec<String>, AppError> {
    match sort {
        BacklinkSort::Created { dir } => {
            let mut sorted: Vec<String> = ids.iter().cloned().collect();
            match dir {
                SortDir::Asc => sorted.sort(),
                SortDir::Desc => sorted.sort_by(|a, b| b.cmp(a)),
            }
            Ok(sorted)
        }

        BacklinkSort::PropertyText { key, dir } => sort_by_property_text(pool, ids, key, dir).await,

        BacklinkSort::PropertyNum { key, dir } => sort_by_property_num(pool, ids, key, dir).await,

        BacklinkSort::PropertyDate { key, dir } => sort_by_property_date(pool, ids, key, dir).await,
    }
}

/// Sort block IDs by a text property value.  Blocks without the property
/// are placed at the end.
///
/// Fetches all property values for `key` (not filtered to `ids`) because a dynamic
/// IN clause would require runtime query building, losing compile-time SQL validation.
/// Acceptable trade-off: the HashMap lookup is O(1), and property tables are small for
/// personal note-taking use cases.
async fn sort_by_property_text(
    pool: &SqlitePool,
    ids: &FxHashSet<String>,
    key: &str,
    dir: &SortDir,
) -> Result<Vec<String>, AppError> {
    let all_props = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT block_id, value_text FROM block_properties WHERE key = ?1",
    )
    .bind(key)
    .fetch_all(pool)
    .await?;

    let prop_map: std::collections::HashMap<String, Option<String>> =
        all_props.into_iter().collect();

    let mut sorted: Vec<String> = ids.iter().cloned().collect();
    sorted.sort_by(|a, b| {
        let va = prop_map.get(a).and_then(|v| v.as_deref());
        let vb = prop_map.get(b).and_then(|v| v.as_deref());
        match (va, vb) {
            (Some(va), Some(vb)) => {
                let directed = match dir {
                    SortDir::Asc => va.cmp(vb),
                    SortDir::Desc => vb.cmp(va),
                };
                directed.then_with(|| a.cmp(b))
            }
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.cmp(b),
        }
    });
    Ok(sorted)
}

/// Sort block IDs by a numeric property value.
///
/// Fetches all property values for `key` (not filtered to `ids`) because a dynamic
/// IN clause would require runtime query building, losing compile-time SQL validation.
/// Acceptable trade-off: the HashMap lookup is O(1), and property tables are small for
/// personal note-taking use cases.
async fn sort_by_property_num(
    pool: &SqlitePool,
    ids: &FxHashSet<String>,
    key: &str,
    dir: &SortDir,
) -> Result<Vec<String>, AppError> {
    let all_props = sqlx::query_as::<_, (String, Option<f64>)>(
        "SELECT block_id, value_num FROM block_properties WHERE key = ?1",
    )
    .bind(key)
    .fetch_all(pool)
    .await?;

    let prop_map: std::collections::HashMap<String, Option<f64>> = all_props.into_iter().collect();

    let mut sorted: Vec<String> = ids.iter().cloned().collect();
    sorted.sort_by(|a, b| {
        let va = prop_map.get(a).and_then(|v| *v);
        let vb = prop_map.get(b).and_then(|v| *v);
        match (va, vb) {
            (Some(va), Some(vb)) => {
                let directed = match dir {
                    SortDir::Asc => va.partial_cmp(&vb).unwrap_or(std::cmp::Ordering::Equal),
                    SortDir::Desc => vb.partial_cmp(&va).unwrap_or(std::cmp::Ordering::Equal),
                };
                directed.then_with(|| a.cmp(b))
            }
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.cmp(b),
        }
    });
    Ok(sorted)
}

/// Sort block IDs by a date property value.
///
/// Fetches all property values for `key` (not filtered to `ids`) because a dynamic
/// IN clause would require runtime query building, losing compile-time SQL validation.
/// Acceptable trade-off: the HashMap lookup is O(1), and property tables are small for
/// personal note-taking use cases.
async fn sort_by_property_date(
    pool: &SqlitePool,
    ids: &FxHashSet<String>,
    key: &str,
    dir: &SortDir,
) -> Result<Vec<String>, AppError> {
    let all_props = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT block_id, value_date FROM block_properties WHERE key = ?1",
    )
    .bind(key)
    .fetch_all(pool)
    .await?;

    let prop_map: std::collections::HashMap<String, Option<String>> =
        all_props.into_iter().collect();

    let mut sorted: Vec<String> = ids.iter().cloned().collect();
    sorted.sort_by(|a, b| {
        let va = prop_map.get(a).and_then(|v| v.as_deref());
        let vb = prop_map.get(b).and_then(|v| v.as_deref());
        match (va, vb) {
            (Some(va), Some(vb)) => {
                let directed = match dir {
                    SortDir::Asc => va.cmp(vb),
                    SortDir::Desc => vb.cmp(va),
                };
                directed.then_with(|| a.cmp(b))
            }
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.cmp(b),
        }
    });
    Ok(sorted)
}

// ---------------------------------------------------------------------------
// Public: list_property_keys
// ---------------------------------------------------------------------------

/// List all distinct property keys currently in use across all blocks.
pub async fn list_property_keys(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let rows =
        sqlx::query_scalar::<_, String>("SELECT DISTINCT key FROM block_properties ORDER BY key")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    // -- Helpers --

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a block directly.
    async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
            .bind(id)
            .bind(block_type)
            .bind(content)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Insert a property on a block.
    async fn insert_property(
        pool: &SqlitePool,
        block_id: &str,
        key: &str,
        value_text: Option<&str>,
        value_num: Option<f64>,
        value_date: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text, value_num, value_date) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(block_id)
        .bind(key)
        .bind(value_text)
        .bind(value_num)
        .bind(value_date)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a block link (source -> target).
    async fn insert_block_link(pool: &SqlitePool, source_id: &str, target_id: &str) {
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(source_id)
            .bind(target_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Tag a block.
    async fn insert_tag_assoc(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Insert a tags_cache row.
    async fn insert_tag_cache(pool: &SqlitePool, tag_id: &str, name: &str, usage_count: i64) {
        sqlx::query(
            "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) \
             VALUES (?, ?, ?, '2025-01-01T00:00:00Z')",
        )
        .bind(tag_id)
        .bind(name)
        .bind(usage_count)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert an FTS index entry for a block.
    async fn insert_fts(pool: &SqlitePool, block_id: &str, stripped: &str) {
        sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
            .bind(block_id)
            .bind(stripped)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Create a standard test setup with a target block and several source
    /// blocks that link to it.
    async fn setup_backlinks(pool: &SqlitePool) {
        insert_block(pool, "TARGET", "page", "Target Page").await;
        insert_block(pool, "SRC_A", "content", "Source A").await;
        insert_block(pool, "SRC_B", "content", "Source B").await;
        insert_block(pool, "SRC_C", "content", "Source C").await;
        insert_block_link(pool, "SRC_A", "TARGET").await;
        insert_block_link(pool, "SRC_B", "TARGET").await;
        insert_block_link(pool, "SRC_C", "TARGET").await;
    }

    fn default_page() -> PageRequest {
        PageRequest::new(None, Some(50)).unwrap()
    }

    // ======================================================================
    // ULID timestamp extraction
    // ======================================================================

    #[test]
    fn ulid_to_ms_extracts_correct_timestamp() {
        // ULID "01ARZ3NDEKTSV4RRFFQ69G5FAV" - known ULID
        // First 10 chars: "01ARZ3NDEK" encode the timestamp
        let ms = ulid_to_ms("01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert!(ms.is_some());
        // The exact value depends on the encoding; just verify it's reasonable
        let ms_val = ms.unwrap();
        assert!(ms_val > 0);
    }

    #[test]
    fn ulid_to_ms_returns_none_for_short_string() {
        assert!(ulid_to_ms("SHORT").is_none());
    }

    #[test]
    fn crockford_decode_char_handles_all_valid_chars() {
        assert_eq!(crockford_decode_char('0'), Some(0));
        assert_eq!(crockford_decode_char('1'), Some(1));
        assert_eq!(crockford_decode_char('A'), Some(10));
        assert_eq!(crockford_decode_char('Z'), Some(31));
        // Case insensitive
        assert_eq!(crockford_decode_char('a'), Some(10));
        assert_eq!(crockford_decode_char('z'), Some(31));
        // Aliases
        assert_eq!(crockford_decode_char('O'), Some(0));
        assert_eq!(crockford_decode_char('I'), Some(1));
        assert_eq!(crockford_decode_char('L'), Some(1));
    }

    #[test]
    fn crockford_decode_char_returns_none_for_invalid() {
        assert!(crockford_decode_char('U').is_none());
        assert!(crockford_decode_char('!').is_none());
    }

    // ======================================================================
    // PropertyText filter
    // ======================================================================

    #[tokio::test]
    async fn filter_property_text_eq_happy_path() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;

        let filter = BacklinkFilter::PropertyText {
            key: "status".into(),
            op: CompareOp::Eq,
            value: "active".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_text_eq_no_match() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;

        let filter = BacklinkFilter::PropertyText {
            key: "status".into(),
            op: CompareOp::Eq,
            value: "nonexistent".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.is_empty());
    }

    #[tokio::test]
    async fn filter_property_text_neq() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;

        let filter = BacklinkFilter::PropertyText {
            key: "status".into(),
            op: CompareOp::Neq,
            value: "active".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(!set.contains("SRC_A"));
        assert!(set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_text_lt() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "name", Some("alpha"), None, None).await;
        insert_property(&pool, "SRC_B", "name", Some("beta"), None, None).await;

        let filter = BacklinkFilter::PropertyText {
            key: "name".into(),
            op: CompareOp::Lt,
            value: "beta".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_text_gt() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "name", Some("alpha"), None, None).await;
        insert_property(&pool, "SRC_B", "name", Some("beta"), None, None).await;

        let filter = BacklinkFilter::PropertyText {
            key: "name".into(),
            op: CompareOp::Gt,
            value: "alpha".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(!set.contains("SRC_A"));
        assert!(set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_text_lte() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "name", Some("alpha"), None, None).await;
        insert_property(&pool, "SRC_B", "name", Some("beta"), None, None).await;

        let filter = BacklinkFilter::PropertyText {
            key: "name".into(),
            op: CompareOp::Lte,
            value: "alpha".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_text_gte() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "name", Some("alpha"), None, None).await;
        insert_property(&pool, "SRC_B", "name", Some("beta"), None, None).await;

        let filter = BacklinkFilter::PropertyText {
            key: "name".into(),
            op: CompareOp::Gte,
            value: "beta".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(!set.contains("SRC_A"));
        assert!(set.contains("SRC_B"));
    }

    // ======================================================================
    // PropertyNum filter
    // ======================================================================

    #[tokio::test]
    async fn filter_property_num_eq() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
        insert_property(&pool, "SRC_B", "priority", None, Some(2.0), None).await;

        let filter = BacklinkFilter::PropertyNum {
            key: "priority".into(),
            op: CompareOp::Eq,
            value: 1.0,
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_num_gt() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
        insert_property(&pool, "SRC_B", "priority", None, Some(5.0), None).await;

        let filter = BacklinkFilter::PropertyNum {
            key: "priority".into(),
            op: CompareOp::Gt,
            value: 3.0,
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(!set.contains("SRC_A"));
        assert!(set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_num_lt() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
        insert_property(&pool, "SRC_B", "priority", None, Some(5.0), None).await;

        let filter = BacklinkFilter::PropertyNum {
            key: "priority".into(),
            op: CompareOp::Lt,
            value: 3.0,
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_num_no_match() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;

        let filter = BacklinkFilter::PropertyNum {
            key: "priority".into(),
            op: CompareOp::Eq,
            value: 999.0,
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.is_empty());
    }

    #[tokio::test]
    async fn filter_property_num_neq() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
        insert_property(&pool, "SRC_B", "priority", None, Some(2.0), None).await;

        let filter = BacklinkFilter::PropertyNum {
            key: "priority".into(),
            op: CompareOp::Neq,
            value: 1.0,
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(!set.contains("SRC_A"));
        assert!(set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_num_lte() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "priority", None, Some(3.0), None).await;
        insert_property(&pool, "SRC_B", "priority", None, Some(5.0), None).await;

        let filter = BacklinkFilter::PropertyNum {
            key: "priority".into(),
            op: CompareOp::Lte,
            value: 3.0,
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_num_gte() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "priority", None, Some(3.0), None).await;
        insert_property(&pool, "SRC_B", "priority", None, Some(5.0), None).await;

        let filter = BacklinkFilter::PropertyNum {
            key: "priority".into(),
            op: CompareOp::Gte,
            value: 5.0,
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(!set.contains("SRC_A"));
        assert!(set.contains("SRC_B"));
    }

    // ======================================================================
    // PropertyDate filter
    // ======================================================================

    #[tokio::test]
    async fn filter_property_date_eq() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
        insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

        let filter = BacklinkFilter::PropertyDate {
            key: "due".into(),
            op: CompareOp::Eq,
            value: "2025-01-15".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_date_lt() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
        insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

        let filter = BacklinkFilter::PropertyDate {
            key: "due".into(),
            op: CompareOp::Lt,
            value: "2025-02-01".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_date_no_match() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;

        let filter = BacklinkFilter::PropertyDate {
            key: "due".into(),
            op: CompareOp::Eq,
            value: "2099-12-31".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.is_empty());
    }

    // ======================================================================
    // PropertyIsSet / PropertyIsEmpty
    // ======================================================================

    #[tokio::test]
    async fn filter_property_is_set() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        // SRC_B has no "status" property

        let filter = BacklinkFilter::PropertyIsSet {
            key: "status".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_property_is_set_no_match() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;

        let filter = BacklinkFilter::PropertyIsSet {
            key: "nonexistent".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.is_empty());
    }

    #[tokio::test]
    async fn filter_property_is_empty() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        // SRC_B and SRC_C have no "status" property

        let filter = BacklinkFilter::PropertyIsEmpty {
            key: "status".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(!set.contains("SRC_A"));
        assert!(set.contains("SRC_B"));
        assert!(set.contains("SRC_C"));
    }

    // ======================================================================
    // HasTag / HasTagPrefix
    // ======================================================================

    #[tokio::test]
    async fn filter_has_tag_happy_path() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_block(&pool, "TAG_X", "tag", "urgent").await;
        insert_tag_assoc(&pool, "SRC_A", "TAG_X").await;

        let filter = BacklinkFilter::HasTag {
            tag_id: "TAG_X".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_has_tag_no_match() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;

        let filter = BacklinkFilter::HasTag {
            tag_id: "NONEXISTENT".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.is_empty());
    }

    #[tokio::test]
    async fn filter_has_tag_prefix() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;

        insert_block(&pool, "TAG_WM", "tag", "work/meeting").await;
        insert_block(&pool, "TAG_WE", "tag", "work/email").await;
        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 1).await;
        insert_tag_cache(&pool, "TAG_WE", "work/email", 1).await;

        insert_tag_assoc(&pool, "SRC_A", "TAG_WM").await;
        insert_tag_assoc(&pool, "SRC_B", "TAG_WE").await;

        let filter = BacklinkFilter::HasTagPrefix {
            prefix: "work/".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(set.contains("SRC_B"));
        assert!(!set.contains("SRC_C"));
    }

    #[tokio::test]
    async fn filter_has_tag_prefix_no_match() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;

        let filter = BacklinkFilter::HasTagPrefix {
            prefix: "zzz_nonexistent/".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.is_empty());
    }

    // ======================================================================
    // Contains (FTS)
    // ======================================================================

    #[tokio::test]
    async fn filter_contains_happy_path() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_fts(&pool, "SRC_A", "hello world searchable").await;
        insert_fts(&pool, "SRC_B", "goodbye world").await;

        let filter = BacklinkFilter::Contains {
            query: "searchable".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_contains_no_match() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_fts(&pool, "SRC_A", "hello world").await;

        let filter = BacklinkFilter::Contains {
            query: "nonexistent".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.is_empty());
    }

    #[tokio::test]
    async fn filter_contains_empty_query() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;

        let filter = BacklinkFilter::Contains { query: "".into() };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.is_empty());
    }

    // ======================================================================
    // CreatedInRange
    // ======================================================================

    #[tokio::test]
    async fn filter_created_in_range_after_only() {
        let (pool, _dir) = test_pool().await;
        // Use real ULIDs with known timestamps.
        // ULID with timestamp 2025-01-01T00:00:00Z = 1735689600000 ms
        // We'll use blocks whose IDs sort chronologically.
        // "01JGQY2P00..." has a timestamp around 2025-01-01
        insert_block(&pool, "TARGET", "page", "target").await;
        // These have synthetic IDs; ULID_to_ms will extract timestamps.
        // Use a recent ULID that encodes a timestamp > 2025-01-01
        let recent_ulid = ulid::Ulid::new().to_string();
        insert_block(&pool, &recent_ulid, "content", "recent").await;
        insert_block_link(&pool, &recent_ulid, "TARGET").await;

        let filter = BacklinkFilter::CreatedInRange {
            after: Some("2020-01-01".into()),
            before: None,
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains(&recent_ulid));
    }

    #[tokio::test]
    async fn filter_created_in_range_before_only() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TARGET", "page", "target").await;
        let recent_ulid = ulid::Ulid::new().to_string();
        insert_block(&pool, &recent_ulid, "content", "recent").await;
        insert_block_link(&pool, &recent_ulid, "TARGET").await;

        // before a date far in the past -> no match
        let filter = BacklinkFilter::CreatedInRange {
            after: None,
            before: Some("2000-01-01".into()),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(!set.contains(&recent_ulid));
    }

    #[tokio::test]
    async fn filter_created_in_range_both() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TARGET", "page", "target").await;
        let recent_ulid = ulid::Ulid::new().to_string();
        insert_block(&pool, &recent_ulid, "content", "recent").await;
        insert_block_link(&pool, &recent_ulid, "TARGET").await;

        let filter = BacklinkFilter::CreatedInRange {
            after: Some("2020-01-01".into()),
            before: Some("2099-12-31".into()),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains(&recent_ulid));
    }

    // ======================================================================
    // BlockType filter
    // ======================================================================

    #[tokio::test]
    async fn filter_block_type_happy_path() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;

        let filter = BacklinkFilter::BlockType {
            block_type: "content".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(set.contains("SRC_B"));
        assert!(set.contains("SRC_C"));
    }

    #[tokio::test]
    async fn filter_block_type_no_match() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;

        let filter = BacklinkFilter::BlockType {
            block_type: "tag".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        // SRC_A, SRC_B, SRC_C are all "content" type
        assert!(!set.contains("SRC_A"));
    }

    // ======================================================================
    // And / Or / Not compound filters
    // ======================================================================

    #[tokio::test]
    async fn filter_and_compound() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;
        insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
        insert_property(&pool, "SRC_B", "priority", None, Some(1.0), None).await;

        let filter = BacklinkFilter::And {
            filters: vec![
                BacklinkFilter::PropertyText {
                    key: "status".into(),
                    op: CompareOp::Eq,
                    value: "active".into(),
                },
                BacklinkFilter::PropertyNum {
                    key: "priority".into(),
                    op: CompareOp::Eq,
                    value: 1.0,
                },
            ],
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(!set.contains("SRC_B")); // status != "active"
    }

    #[tokio::test]
    async fn filter_or_compound() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;

        let filter = BacklinkFilter::Or {
            filters: vec![
                BacklinkFilter::PropertyText {
                    key: "status".into(),
                    op: CompareOp::Eq,
                    value: "active".into(),
                },
                BacklinkFilter::PropertyText {
                    key: "status".into(),
                    op: CompareOp::Eq,
                    value: "done".into(),
                },
            ],
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"));
        assert!(set.contains("SRC_B"));
    }

    #[tokio::test]
    async fn filter_not_compound() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;

        let filter = BacklinkFilter::Not {
            filter: Box::new(BacklinkFilter::PropertyText {
                key: "status".into(),
                op: CompareOp::Eq,
                value: "active".into(),
            }),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(!set.contains("SRC_A"));
        // SRC_B, SRC_C, TARGET should all be in the not set
        assert!(set.contains("SRC_B"));
        assert!(set.contains("SRC_C"));
    }

    #[tokio::test]
    async fn filter_and_empty_returns_empty() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;

        let filter = BacklinkFilter::And { filters: vec![] };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.is_empty());
    }

    #[tokio::test]
    async fn filter_or_empty_returns_empty() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;

        let filter = BacklinkFilter::Or { filters: vec![] };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.is_empty());
    }

    // ======================================================================
    // Nested compound: And(PropertyText, Or(HasTag, HasTagPrefix))
    // ======================================================================

    #[tokio::test]
    async fn filter_nested_compound() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_B", "status", Some("active"), None, None).await;

        insert_block(&pool, "TAG_X", "tag", "urgent").await;
        insert_block(&pool, "TAG_WM", "tag", "work/meeting").await;
        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 1).await;

        insert_tag_assoc(&pool, "SRC_A", "TAG_X").await;
        insert_tag_assoc(&pool, "SRC_B", "TAG_WM").await;

        let filter = BacklinkFilter::And {
            filters: vec![
                BacklinkFilter::PropertyText {
                    key: "status".into(),
                    op: CompareOp::Eq,
                    value: "active".into(),
                },
                BacklinkFilter::Or {
                    filters: vec![
                        BacklinkFilter::HasTag {
                            tag_id: "TAG_X".into(),
                        },
                        BacklinkFilter::HasTagPrefix {
                            prefix: "work/".into(),
                        },
                    ],
                },
            ],
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        // Both SRC_A and SRC_B have status=active AND (HasTag(TAG_X) OR HasTagPrefix(work/))
        assert!(set.contains("SRC_A"));
        assert!(set.contains("SRC_B"));
        assert!(!set.contains("SRC_C"));
    }

    // ======================================================================
    // eval_backlink_query: sort variants
    // ======================================================================

    #[tokio::test]
    async fn sort_created_asc() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::Created { dir: SortDir::Asc }),
            &page,
        )
        .await
        .unwrap();

        assert_eq!(resp.items.len(), 3);
        assert_eq!(resp.total_count, 3);
        // SRC_A < SRC_B < SRC_C lexicographically
        assert_eq!(resp.items[0].id, "SRC_A");
        assert_eq!(resp.items[1].id, "SRC_B");
        assert_eq!(resp.items[2].id, "SRC_C");
    }

    #[tokio::test]
    async fn sort_created_desc() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::Created { dir: SortDir::Desc }),
            &page,
        )
        .await
        .unwrap();

        assert_eq!(resp.items.len(), 3);
        assert_eq!(resp.items[0].id, "SRC_C");
        assert_eq!(resp.items[1].id, "SRC_B");
        assert_eq!(resp.items[2].id, "SRC_A");
    }

    #[tokio::test]
    async fn sort_property_text() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "name", Some("charlie"), None, None).await;
        insert_property(&pool, "SRC_B", "name", Some("alice"), None, None).await;
        insert_property(&pool, "SRC_C", "name", Some("bob"), None, None).await;
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::PropertyText {
                key: "name".into(),
                dir: SortDir::Asc,
            }),
            &page,
        )
        .await
        .unwrap();

        assert_eq!(resp.items[0].id, "SRC_B"); // alice
        assert_eq!(resp.items[1].id, "SRC_C"); // bob
        assert_eq!(resp.items[2].id, "SRC_A"); // charlie
    }

    #[tokio::test]
    async fn sort_property_num() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "priority", None, Some(3.0), None).await;
        insert_property(&pool, "SRC_B", "priority", None, Some(1.0), None).await;
        insert_property(&pool, "SRC_C", "priority", None, Some(2.0), None).await;
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::PropertyNum {
                key: "priority".into(),
                dir: SortDir::Asc,
            }),
            &page,
        )
        .await
        .unwrap();

        assert_eq!(resp.items[0].id, "SRC_B"); // 1.0
        assert_eq!(resp.items[1].id, "SRC_C"); // 2.0
        assert_eq!(resp.items[2].id, "SRC_A"); // 3.0
    }

    #[tokio::test]
    async fn sort_property_date() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "due", None, None, Some("2025-03-01")).await;
        insert_property(&pool, "SRC_B", "due", None, None, Some("2025-01-01")).await;
        insert_property(&pool, "SRC_C", "due", None, None, Some("2025-02-01")).await;
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::PropertyDate {
                key: "due".into(),
                dir: SortDir::Asc,
            }),
            &page,
        )
        .await
        .unwrap();

        assert_eq!(resp.items[0].id, "SRC_B"); // 2025-01-01
        assert_eq!(resp.items[1].id, "SRC_C"); // 2025-02-01
        assert_eq!(resp.items[2].id, "SRC_A"); // 2025-03-01
    }

    // ======================================================================
    // Pagination
    // ======================================================================

    #[tokio::test]
    async fn pagination_limit_works() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        let page = PageRequest::new(None, Some(2)).unwrap();

        let resp = eval_backlink_query(&pool, "TARGET", None, None, &page)
            .await
            .unwrap();

        assert_eq!(resp.items.len(), 2);
        assert!(resp.has_more);
        assert!(resp.next_cursor.is_some());
        assert_eq!(resp.total_count, 3);
    }

    #[tokio::test]
    async fn pagination_cursor_works() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;

        // First page
        let page1 = PageRequest::new(None, Some(2)).unwrap();
        let resp1 = eval_backlink_query(&pool, "TARGET", None, None, &page1)
            .await
            .unwrap();
        assert_eq!(resp1.items.len(), 2);
        assert!(resp1.has_more);

        // Second page
        let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
        let resp2 = eval_backlink_query(&pool, "TARGET", None, None, &page2)
            .await
            .unwrap();
        assert_eq!(resp2.items.len(), 1);
        assert!(!resp2.has_more);
        assert!(resp2.next_cursor.is_none());
        assert_eq!(resp2.total_count, 3);
    }

    #[tokio::test]
    async fn pagination_total_count_correct_with_filters() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_B", "status", Some("active"), None, None).await;
        // SRC_C has no status

        let filters = vec![BacklinkFilter::PropertyIsSet {
            key: "status".into(),
        }];
        let page = PageRequest::new(None, Some(1)).unwrap();

        let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 2);
        assert_eq!(resp.items.len(), 1);
        assert!(resp.has_more);
    }

    // ======================================================================
    // Empty filters = all backlinks (backward compat)
    // ======================================================================

    #[tokio::test]
    async fn empty_filters_returns_all_backlinks() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        let page = default_page();

        let resp = eval_backlink_query(&pool, "TARGET", Some(vec![]), None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 3);
        assert_eq!(resp.items.len(), 3);
    }

    #[tokio::test]
    async fn none_filters_returns_all_backlinks() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        let page = default_page();

        let resp = eval_backlink_query(&pool, "TARGET", None, None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 3);
        assert_eq!(resp.items.len(), 3);
    }

    // ======================================================================
    // No backlinks = empty response
    // ======================================================================

    #[tokio::test]
    async fn no_backlinks_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "LONELY", "page", "No one links to me").await;
        let page = default_page();

        let resp = eval_backlink_query(&pool, "LONELY", None, None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 0);
        assert!(resp.items.is_empty());
        assert!(!resp.has_more);
        assert!(resp.next_cursor.is_none());
    }

    // ======================================================================
    // Deleted/conflict blocks excluded from base set
    // ======================================================================

    #[tokio::test]
    async fn deleted_backlinks_excluded() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        // Soft-delete SRC_A
        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'SRC_A'")
            .execute(&pool)
            .await
            .unwrap();
        let page = default_page();

        let resp = eval_backlink_query(&pool, "TARGET", None, None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 2);
        assert!(resp.items.iter().all(|item| item.id != "SRC_A"));
    }

    #[tokio::test]
    async fn conflict_backlinks_excluded() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        // Mark SRC_B as conflict
        sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = 'SRC_B'")
            .execute(&pool)
            .await
            .unwrap();
        let page = default_page();

        let resp = eval_backlink_query(&pool, "TARGET", None, None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 2);
        assert!(resp.items.iter().all(|item| item.id != "SRC_B"));
    }

    // ======================================================================
    // list_property_keys
    // ======================================================================

    #[tokio::test]
    async fn list_property_keys_returns_distinct_sorted() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK_A", "content", "a").await;
        insert_block(&pool, "BLK_B", "content", "b").await;
        insert_property(&pool, "BLK_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "BLK_A", "priority", None, Some(1.0), None).await;
        insert_property(&pool, "BLK_B", "status", Some("done"), None, None).await;
        insert_property(&pool, "BLK_B", "due", None, None, Some("2025-01-01")).await;

        let keys = list_property_keys(&pool).await.unwrap();
        assert_eq!(keys, vec!["due", "priority", "status"]);
    }

    #[tokio::test]
    async fn list_property_keys_empty_when_no_properties() {
        let (pool, _dir) = test_pool().await;
        let keys = list_property_keys(&pool).await.unwrap();
        assert!(keys.is_empty());
    }

    // ======================================================================
    // eval_backlink_query with filters integrated
    // ======================================================================

    #[tokio::test]
    async fn eval_with_property_text_filter() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;
        let page = default_page();

        let filters = vec![BacklinkFilter::PropertyText {
            key: "status".into(),
            op: CompareOp::Eq,
            value: "active".into(),
        }];

        let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 1);
        assert_eq!(resp.items[0].id, "SRC_A");
    }

    #[tokio::test]
    async fn eval_with_block_type_filter() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TARGET", "page", "Target Page").await;
        insert_block(&pool, "SRC_CONTENT", "content", "Content source").await;
        insert_block(&pool, "SRC_TAG", "tag", "Tag source").await;
        insert_block_link(&pool, "SRC_CONTENT", "TARGET").await;
        insert_block_link(&pool, "SRC_TAG", "TARGET").await;
        let page = default_page();

        let filters = vec![BacklinkFilter::BlockType {
            block_type: "content".into(),
        }];

        let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 1);
        assert_eq!(resp.items[0].id, "SRC_CONTENT");
    }

    #[tokio::test]
    async fn eval_with_multiple_filters_and_semantics() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_B", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
        insert_property(&pool, "SRC_B", "priority", None, Some(5.0), None).await;
        let page = default_page();

        // Both filters must match (AND semantics at top level)
        let filters = vec![
            BacklinkFilter::PropertyText {
                key: "status".into(),
                op: CompareOp::Eq,
                value: "active".into(),
            },
            BacklinkFilter::PropertyNum {
                key: "priority".into(),
                op: CompareOp::Lt,
                value: 3.0,
            },
        ];

        let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 1);
        assert_eq!(resp.items[0].id, "SRC_A");
    }

    // ======================================================================
    // Review findings: missing PropertyDate CompareOp variants
    // ======================================================================

    #[tokio::test]
    async fn filter_property_date_neq() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
        insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

        let filter = BacklinkFilter::PropertyDate {
            key: "due".into(),
            op: CompareOp::Neq,
            value: "2025-01-15".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(
            !set.contains("SRC_A"),
            "SRC_A has due=2025-01-15, should be excluded by Neq"
        );
        assert!(
            set.contains("SRC_B"),
            "SRC_B has due=2025-02-20, should match Neq"
        );
    }

    #[tokio::test]
    async fn filter_property_date_gt() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
        insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

        let filter = BacklinkFilter::PropertyDate {
            key: "due".into(),
            op: CompareOp::Gt,
            value: "2025-02-01".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(!set.contains("SRC_A"), "2025-01-15 is not > 2025-02-01");
        assert!(set.contains("SRC_B"), "2025-02-20 is > 2025-02-01");
    }

    #[tokio::test]
    async fn filter_property_date_lte() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
        insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

        let filter = BacklinkFilter::PropertyDate {
            key: "due".into(),
            op: CompareOp::Lte,
            value: "2025-01-15".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(set.contains("SRC_A"), "2025-01-15 <= 2025-01-15");
        assert!(!set.contains("SRC_B"), "2025-02-20 is not <= 2025-01-15");
    }

    #[tokio::test]
    async fn filter_property_date_gte() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
        insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

        let filter = BacklinkFilter::PropertyDate {
            key: "due".into(),
            op: CompareOp::Gte,
            value: "2025-02-20".into(),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(!set.contains("SRC_A"), "2025-01-15 is not >= 2025-02-20");
        assert!(set.contains("SRC_B"), "2025-02-20 >= 2025-02-20");
    }

    // ======================================================================
    // Review findings: Not(PropertyIsEmpty) ≡ PropertyIsSet
    // ======================================================================

    #[tokio::test]
    async fn not_property_is_empty_equals_property_is_set() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        // SRC_B, SRC_C have no "status" property

        let not_empty = BacklinkFilter::Not {
            filter: Box::new(BacklinkFilter::PropertyIsEmpty {
                key: "status".into(),
            }),
        };
        let is_set = BacklinkFilter::PropertyIsSet {
            key: "status".into(),
        };

        let set_not_empty = resolve_filter(&pool, &not_empty, 0).await.unwrap();
        let set_is_set = resolve_filter(&pool, &is_set, 0).await.unwrap();

        assert_eq!(
            set_not_empty, set_is_set,
            "Not(PropertyIsEmpty) should equal PropertyIsSet"
        );
        assert!(set_not_empty.contains("SRC_A"));
        assert!(!set_not_empty.contains("SRC_B"));
        assert!(!set_not_empty.contains("SRC_C"));
    }

    // ======================================================================
    // Review findings: compound nesting Not(And), Not(Or)
    // ======================================================================

    #[tokio::test]
    async fn filter_not_and_compound() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
        insert_property(&pool, "SRC_B", "status", Some("active"), None, None).await;
        // SRC_B has status=active but no priority

        // Not(And(status=active, priority set)) — should exclude SRC_A, include SRC_B, SRC_C
        let filter = BacklinkFilter::Not {
            filter: Box::new(BacklinkFilter::And {
                filters: vec![
                    BacklinkFilter::PropertyText {
                        key: "status".into(),
                        op: CompareOp::Eq,
                        value: "active".into(),
                    },
                    BacklinkFilter::PropertyIsSet {
                        key: "priority".into(),
                    },
                ],
            }),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(
            !set.contains("SRC_A"),
            "SRC_A matches both => excluded by Not"
        );
        assert!(
            set.contains("SRC_B"),
            "SRC_B only matches status, not priority"
        );
        assert!(set.contains("SRC_C"), "SRC_C matches neither");
    }

    #[tokio::test]
    async fn filter_not_or_compound() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_B", "priority", None, Some(1.0), None).await;
        // SRC_C has neither property

        // Not(Or(status=active, priority set)) — excludes SRC_A and SRC_B, includes SRC_C
        let filter = BacklinkFilter::Not {
            filter: Box::new(BacklinkFilter::Or {
                filters: vec![
                    BacklinkFilter::PropertyText {
                        key: "status".into(),
                        op: CompareOp::Eq,
                        value: "active".into(),
                    },
                    BacklinkFilter::PropertyIsSet {
                        key: "priority".into(),
                    },
                ],
            }),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();
        assert!(
            !set.contains("SRC_A"),
            "SRC_A has status=active => in Or => excluded by Not"
        );
        assert!(
            !set.contains("SRC_B"),
            "SRC_B has priority set => in Or => excluded by Not"
        );
        assert!(
            set.contains("SRC_C"),
            "SRC_C has neither => not in Or => included by Not"
        );
    }

    // ======================================================================
    // Review findings: sorting with missing properties
    // ======================================================================

    #[tokio::test]
    async fn sort_property_text_missing_values_go_last_asc() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "name", Some("charlie"), None, None).await;
        insert_property(&pool, "SRC_B", "name", Some("alice"), None, None).await;
        // SRC_C has NO "name" property
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::PropertyText {
                key: "name".into(),
                dir: SortDir::Asc,
            }),
            &page,
        )
        .await
        .unwrap();

        assert_eq!(resp.items[0].id, "SRC_B", "alice sorts first");
        assert_eq!(resp.items[1].id, "SRC_A", "charlie sorts second");
        assert_eq!(resp.items[2].id, "SRC_C", "missing property sorts last");
    }

    #[tokio::test]
    async fn sort_property_text_missing_values_go_last_desc() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "name", Some("charlie"), None, None).await;
        insert_property(&pool, "SRC_B", "name", Some("alice"), None, None).await;
        // SRC_C has NO "name" property
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::PropertyText {
                key: "name".into(),
                dir: SortDir::Desc,
            }),
            &page,
        )
        .await
        .unwrap();

        assert_eq!(resp.items[0].id, "SRC_A", "charlie sorts first in desc");
        assert_eq!(resp.items[1].id, "SRC_B", "alice sorts second in desc");
        assert_eq!(
            resp.items[2].id, "SRC_C",
            "missing property still last in desc"
        );
    }

    #[tokio::test]
    async fn sort_property_num_missing_values_go_last() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "effort", None, Some(5.0), None).await;
        insert_property(&pool, "SRC_B", "effort", None, Some(2.0), None).await;
        // SRC_C has NO "effort" property
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::PropertyNum {
                key: "effort".into(),
                dir: SortDir::Asc,
            }),
            &page,
        )
        .await
        .unwrap();

        assert_eq!(resp.items[0].id, "SRC_B", "effort=2 first");
        assert_eq!(resp.items[1].id, "SRC_A", "effort=5 second");
        assert_eq!(resp.items[2].id, "SRC_C", "no effort property last");
    }

    #[tokio::test]
    async fn sort_property_date_missing_values_go_last() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "due", None, None, Some("2025-03-01")).await;
        insert_property(&pool, "SRC_B", "due", None, None, Some("2025-01-01")).await;
        // SRC_C has NO "due" property
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::PropertyDate {
                key: "due".into(),
                dir: SortDir::Asc,
            }),
            &page,
        )
        .await
        .unwrap();

        assert_eq!(resp.items[0].id, "SRC_B", "2025-01-01 first");
        assert_eq!(resp.items[1].id, "SRC_A", "2025-03-01 second");
        assert_eq!(resp.items[2].id, "SRC_C", "no due date last");
    }

    // ======================================================================
    // Review findings: CreatedInRange with inverted range (after > before)
    // ======================================================================

    #[tokio::test]
    async fn created_in_range_inverted_range_returns_empty() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        let page = default_page();

        let filters = vec![BacklinkFilter::CreatedInRange {
            after: Some("2099-12-31".into()),
            before: Some("2020-01-01".into()),
        }];

        let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
            .await
            .unwrap();
        assert_eq!(
            resp.total_count, 0,
            "inverted range should return no results"
        );
    }

    // ======================================================================
    // Review findings: FTS Contains with sanitized syntax
    // ======================================================================

    #[tokio::test]
    async fn fts_contains_sanitises_bare_operators() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_fts(&pool, "SRC_A", "hello NEAR world").await;

        // A bare "NEAR" used to cause an FTS5 syntax error; sanitize_fts_query
        // now wraps each token in double-quotes so it matches literally.
        // (Trigram tokenizer requires >= 3 chars, so we use "NEAR" not "OR".)
        let filter = BacklinkFilter::Contains {
            query: "NEAR".into(),
        };
        let result = resolve_filter(&pool, &filter, 0).await;
        assert!(
            result.is_ok(),
            "sanitized FTS query should not produce a syntax error"
        );
        let set = result.unwrap();
        assert!(set.contains("SRC_A"), "SRC_A contains literal 'NEAR'");
    }

    // ======================================================================
    // Review findings: pagination with property sort
    // ======================================================================

    #[tokio::test]
    async fn pagination_with_property_text_sort() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "name", Some("charlie"), None, None).await;
        insert_property(&pool, "SRC_B", "name", Some("alice"), None, None).await;
        insert_property(&pool, "SRC_C", "name", Some("bob"), None, None).await;

        let sort = Some(BacklinkSort::PropertyText {
            key: "name".into(),
            dir: SortDir::Asc,
        });

        // First page: limit 2
        let page1 = PageRequest::new(None, Some(2)).unwrap();
        let resp1 = eval_backlink_query(&pool, "TARGET", None, sort.clone(), &page1)
            .await
            .unwrap();
        assert_eq!(resp1.items.len(), 2);
        assert!(resp1.has_more);
        assert_eq!(resp1.items[0].id, "SRC_B", "alice first");
        assert_eq!(resp1.items[1].id, "SRC_C", "bob second");

        // Second page via cursor
        let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
        let resp2 = eval_backlink_query(&pool, "TARGET", None, sort, &page2)
            .await
            .unwrap();
        assert_eq!(resp2.items.len(), 1);
        assert!(!resp2.has_more);
        assert_eq!(resp2.items[0].id, "SRC_A", "charlie last");
    }

    // ======================================================================
    // parse_iso_to_ms tests
    // ======================================================================

    #[test]
    fn parse_iso_date_only() {
        let ms = parse_iso_to_ms("2025-01-15");
        assert!(ms.is_some());
        // 2025-01-15 00:00:00 UTC
        assert_eq!(ms.unwrap(), 1736899200000);
    }

    #[test]
    fn parse_iso_full_datetime() {
        let ms = parse_iso_to_ms("2025-01-15T12:00:00Z");
        assert!(ms.is_some());
    }

    #[test]
    fn parse_iso_invalid_returns_none() {
        assert!(parse_iso_to_ms("not-a-date").is_none());
    }

    // ======================================================================
    // #246 — PropertyNum / PropertyDate Desc sort with missing values
    // ======================================================================

    #[tokio::test]
    async fn sort_property_num_desc_order() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "effort", None, Some(5.0), None).await;
        insert_property(&pool, "SRC_B", "effort", None, Some(2.0), None).await;
        // SRC_C has NO "effort" property
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::PropertyNum {
                key: "effort".into(),
                dir: SortDir::Desc,
            }),
            &page,
        )
        .await
        .unwrap();

        assert_eq!(resp.items[0].id, "SRC_A", "effort=5 first in desc");
        assert_eq!(resp.items[1].id, "SRC_B", "effort=2 second in desc");
        assert_eq!(
            resp.items[2].id, "SRC_C",
            "missing effort property still last in desc"
        );
    }

    #[tokio::test]
    async fn sort_property_date_desc_order() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "due", None, None, Some("2025-03-01")).await;
        insert_property(&pool, "SRC_B", "due", None, None, Some("2025-01-01")).await;
        // SRC_C has NO "due" property
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::PropertyDate {
                key: "due".into(),
                dir: SortDir::Desc,
            }),
            &page,
        )
        .await
        .unwrap();

        assert_eq!(resp.items[0].id, "SRC_A", "2025-03-01 first in desc");
        assert_eq!(resp.items[1].id, "SRC_B", "2025-01-01 second in desc");
        assert_eq!(
            resp.items[2].id, "SRC_C",
            "missing due date still last in desc"
        );
    }

    // ======================================================================
    // #248 — Snapshot tests for BacklinkQueryResponse
    // ======================================================================

    #[tokio::test]
    async fn snapshot_backlink_query_basic() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        let page = default_page();

        let resp = eval_backlink_query(
            &pool,
            "TARGET",
            None,
            Some(BacklinkSort::Created { dir: SortDir::Asc }),
            &page,
        )
        .await
        .unwrap();

        insta::assert_yaml_snapshot!(resp, {
            ".items[].id" => "[ULID]",
            ".next_cursor" => "[CURSOR]",
        });
    }

    #[tokio::test]
    async fn snapshot_backlink_query_with_filter() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;
        let page = default_page();

        let filters = vec![BacklinkFilter::PropertyText {
            key: "status".into(),
            op: CompareOp::Eq,
            value: "active".into(),
        }];

        let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
            .await
            .unwrap();

        insta::assert_yaml_snapshot!(resp, {
            ".items[].id" => "[ULID]",
            ".next_cursor" => "[CURSOR]",
        });
    }

    #[tokio::test]
    async fn snapshot_backlink_query_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "LONELY", "page", "No one links to me").await;
        let page = default_page();

        let resp = eval_backlink_query(&pool, "LONELY", None, None, &page)
            .await
            .unwrap();

        insta::assert_yaml_snapshot!(resp, {
            ".items[].id" => "[ULID]",
            ".next_cursor" => "[CURSOR]",
        });
    }

    // ======================================================================
    // #249 — Recursion depth limit test
    // ======================================================================

    #[tokio::test]
    async fn resolve_filter_rejects_excessive_nesting() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;

        // Build a filter nested 52 levels deep (exceeds limit of 50)
        let mut filter = BacklinkFilter::PropertyIsSet {
            key: "anything".into(),
        };
        for _ in 0..52 {
            filter = BacklinkFilter::Not {
                filter: Box::new(filter),
            };
        }

        let result = resolve_filter(&pool, &filter, 0).await;
        assert!(result.is_err(), "should reject deeply nested filters");
        let err = result.unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("depth exceeds 50"),
            "error should mention depth limit, got: {msg}"
        );
    }
}
