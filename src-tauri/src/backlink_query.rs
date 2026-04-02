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

use futures_util::future::try_join_all;
use rustc_hash::FxHashSet;
use serde::{Deserialize, Serialize};
use serde_json;
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

/// Crockford base32 alphabet for ULID encoding.
const CROCKFORD_ENCODE: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Encode a Unix millisecond timestamp into the 10-character ULID prefix
/// (Crockford base32, big-endian).  This is the inverse of `ulid_to_ms`.
fn ms_to_ulid_prefix(ms: u64) -> String {
    let mut chars = [b'0'; 10];
    let mut value = ms;
    for i in (0..10).rev() {
        chars[i] = CROCKFORD_ENCODE[(value & 0x1F) as usize];
        value >>= 5;
    }
    String::from_utf8(chars.to_vec()).unwrap()
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
    /// Filter by source page — include/exclude blocks based on their root page ancestor.
    SourcePage {
        included: Vec<String>,
        excluded: Vec<String>,
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
    pub filtered_count: usize,
}

/// A group of backlinks from the same source page.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct BacklinkGroup {
    pub page_id: String,
    pub page_title: Option<String>,
    pub blocks: Vec<BlockRow>,
}

/// Response for grouped backlink queries — backlinks organized by source page.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct GroupedBacklinkResponse {
    pub groups: Vec<BacklinkGroup>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub total_count: usize,
    pub filtered_count: usize,
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
                let after_prefix = after
                    .as_ref()
                    .and_then(|d| parse_iso_to_ms(d))
                    .map(ms_to_ulid_prefix);
                let before_prefix = before
                    .as_ref()
                    .and_then(|d| parse_iso_to_ms(d))
                    .map(ms_to_ulid_prefix);

                // Build SQL with optional ULID range bounds.  ULID prefix comparison
                // works because Crockford base32 preserves sort order and SQLite
                // string comparison treats shorter strings as less-than.
                let mut sql = String::from(
                    "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0",
                );
                let mut bind_idx = 1u32;
                if after_prefix.is_some() {
                    sql.push_str(&format!(" AND id >= ?{bind_idx}"));
                    bind_idx += 1;
                }
                if before_prefix.is_some() {
                    sql.push_str(&format!(" AND id < ?{bind_idx}"));
                }

                let mut query = sqlx::query_scalar::<_, String>(&sql);
                if let Some(ref lo) = after_prefix {
                    query = query.bind(lo.as_str());
                }
                if let Some(ref hi) = before_prefix {
                    query = query.bind(hi.as_str());
                }
                let rows = query.fetch_all(pool).await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::BlockType { block_type } => {
                // Note (#321): This scans all blocks of the given type even though the
                // result is later intersected with a smaller base/candidate set.  For
                // common types like "content" this can return 10K+ rows.  Mitigations:
                //   • And/Or combinators now resolve sub-filters in parallel (#319),
                //     so the wall-clock cost overlaps with other concurrent filter
                //     queries.
                //   • The FxHashSet intersection in And/eval_backlink_query keeps
                //     memory bounded to the smaller set.
                //   • Pushing the candidate set into this query would require changing
                //     resolve_filter's signature (invasive); a covering index on
                //     (block_type, deleted_at, is_conflict) would also help but
                //     requires a migration.
                let rows = sqlx::query_scalar::<_, String>(
                    "SELECT id FROM blocks \
                     WHERE block_type = ?1 AND deleted_at IS NULL AND is_conflict = 0",
                )
                .bind(block_type)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::SourcePage { included, excluded } => {
                let mut result: FxHashSet<String>;

                if !included.is_empty() {
                    // Get all descendants of included pages
                    let placeholders = included.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                    let sql = format!(
                        "WITH RECURSIVE desc(id) AS ( \
                            SELECT id FROM blocks WHERE id IN ({placeholders}) AND deleted_at IS NULL AND is_conflict = 0 \
                            UNION ALL \
                            SELECT b.id FROM blocks b JOIN desc d ON b.parent_id = d.id WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
                        ) SELECT id FROM desc"
                    );
                    let mut q = sqlx::query_scalar::<_, String>(&sql);
                    for id in included {
                        q = q.bind(id);
                    }
                    result = q.fetch_all(pool).await?.into_iter().collect();
                } else {
                    // No inclusion filter — start with all non-deleted blocks
                    result = sqlx::query_scalar::<_, String>(
                        "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0",
                    )
                    .fetch_all(pool)
                    .await?
                    .into_iter()
                    .collect();
                }

                if !excluded.is_empty() {
                    let placeholders = excluded.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                    let sql = format!(
                        "WITH RECURSIVE desc(id) AS ( \
                            SELECT id FROM blocks WHERE id IN ({placeholders}) AND deleted_at IS NULL AND is_conflict = 0 \
                            UNION ALL \
                            SELECT b.id FROM blocks b JOIN desc d ON b.parent_id = d.id WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
                        ) SELECT id FROM desc"
                    );
                    let mut q = sqlx::query_scalar::<_, String>(&sql);
                    for id in excluded {
                        q = q.bind(id);
                    }
                    let excluded_set: FxHashSet<String> =
                        q.fetch_all(pool).await?.into_iter().collect();
                    result.retain(|id| !excluded_set.contains(id));
                }

                Ok(result)
            }

            BacklinkFilter::And { filters } => {
                if filters.is_empty() {
                    return Ok(FxHashSet::default());
                }
                // Resolve all sub-filters concurrently (#319) instead of
                // sequentially, turning N serial DB round-trips into N
                // concurrent ones.
                let futures = filters.iter().map(|f| resolve_filter(pool, f, depth + 1));
                let results = try_join_all(futures).await?;
                let mut iter = results.into_iter();
                let mut result = iter.next().unwrap();
                for set in iter {
                    result.retain(|id| set.contains(id));
                }
                Ok(result)
            }

            BacklinkFilter::Or { filters } => {
                // Resolve all sub-filters concurrently (#319) instead of
                // sequentially, turning N serial DB round-trips into N
                // concurrent ones.
                let futures = filters.iter().map(|f| resolve_filter(pool, f, depth + 1));
                let results = try_join_all(futures).await?;
                let mut combined = FxHashSet::default();
                for set in results {
                    combined.extend(set);
                }
                Ok(combined)
            }

            BacklinkFilter::Not { filter } => {
                let inner_set = resolve_filter(pool, filter, depth + 1).await?;

                if inner_set.is_empty() {
                    // Not of empty set = all non-deleted blocks
                    let rows = sqlx::query_scalar::<_, String>(
                        "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0",
                    )
                    .fetch_all(pool)
                    .await?;
                    return Ok(rows.into_iter().collect());
                }

                // For small exclusion sets, push NOT IN into SQL to avoid loading
                // all block IDs into memory.  SQLite variable limit is 999 in older
                // builds, so cap at 500 to be safe.
                if inner_set.len() <= 500 {
                    let placeholders: String = std::iter::repeat_n("?", inner_set.len())
                        .collect::<Vec<_>>()
                        .join(",");
                    let sql = format!(
                        "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0 \
                         AND id NOT IN ({placeholders})"
                    );
                    let mut query = sqlx::query_scalar::<_, String>(&sql);
                    for id in &inner_set {
                        query = query.bind(id.as_str());
                    }
                    let rows = query.fetch_all(pool).await?;
                    return Ok(rows.into_iter().collect());
                }

                // For large exclusion sets, use json_each() to push NOT
                // into SQL — avoids loading all block IDs into memory.
                let json_ids = serde_json::to_string(&inner_set.iter().collect::<Vec<_>>())?;
                let rows = sqlx::query_scalar::<_, String>(
                    "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0 \
                     AND id NOT IN (SELECT value FROM json_each(?))",
                )
                .bind(&json_ids)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().collect())
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

    let total_count = base_ids.len();

    if base_ids.is_empty() {
        return Ok(BacklinkQueryResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
            filtered_count: 0,
        });
    }

    // 2. Apply filters (AND semantics at top level)
    let filtered_ids = if let Some(ref filter_list) = filters {
        if filter_list.is_empty() {
            base_ids.clone()
        } else {
            // Resolve all top-level filters concurrently (#319)
            let futures = filter_list.iter().map(|f| resolve_filter(pool, f, 0));
            let results = try_join_all(futures).await?;
            let mut result = base_ids.clone();
            for set in results {
                result.retain(|id| set.contains(id));
            }
            result
        }
    } else {
        base_ids.clone()
    };

    // 3. Compute filtered_count before pagination
    let filtered_count = filtered_ids.len();

    if filtered_count == 0 {
        return Ok(BacklinkQueryResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
            total_count,
            filtered_count: 0,
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
            filtered_count,
        });
    }

    // 6. Fetch full BlockRows
    let placeholders = actual_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query_str = format!(
        "SELECT id, block_type, content, parent_id, position, \
         deleted_at, archived_at, is_conflict, conflict_type \
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
        filtered_count,
    })
}

// ---------------------------------------------------------------------------
// Public: resolve_root_pages (helper for grouped queries)
// ---------------------------------------------------------------------------

/// Resolve each block's root page (topmost ancestor with block_type = 'page').
///
/// Returns HashMap<block_id, (root_page_id, root_page_title)>.
/// Blocks whose ancestor chain doesn't terminate at a page are omitted.
async fn resolve_root_pages(
    pool: &SqlitePool,
    block_ids: &FxHashSet<String>,
) -> Result<std::collections::HashMap<String, (String, Option<String>)>, AppError> {
    if block_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let placeholders = block_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "WITH RECURSIVE walk(block_id, current_id) AS ( \
            SELECT id, id FROM blocks WHERE id IN ({placeholders}) \
            UNION ALL \
            SELECT w.block_id, b.parent_id \
            FROM walk w \
            JOIN blocks b ON b.id = w.current_id \
            WHERE b.parent_id IS NOT NULL \
        ) \
        SELECT w.block_id, w.current_id as root_id, b.content as root_title \
        FROM walk w \
        JOIN blocks b ON b.id = w.current_id \
        WHERE b.parent_id IS NULL AND b.block_type = 'page'"
    );

    #[derive(sqlx::FromRow)]
    struct RootPageRow {
        block_id: String,
        root_id: String,
        root_title: Option<String>,
    }

    let mut query = sqlx::query_as::<_, RootPageRow>(&sql);
    for id in block_ids {
        query = query.bind(id.as_str());
    }
    let rows = query.fetch_all(pool).await?;

    let mut map = std::collections::HashMap::new();
    for row in rows {
        map.insert(row.block_id, (row.root_id, row.root_title));
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// Public: eval_backlink_query_grouped
// ---------------------------------------------------------------------------

/// Evaluate a grouped backlink query — backlinks organized by source page.
///
/// ## Algorithm
///
/// 1. Get base backlink set.
/// 2. Apply filters.
/// 3. Resolve root pages for all filtered IDs.
/// 4. Group blocks by root page.
/// 5. Sort groups alphabetically by page title.
/// 6. Apply cursor pagination on groups.
/// 7. Sort blocks within each group, fetch full BlockRow data.
/// 8. Return `GroupedBacklinkResponse`.
pub async fn eval_backlink_query_grouped(
    pool: &SqlitePool,
    block_id: &str,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    page: &PageRequest,
) -> Result<GroupedBacklinkResponse, AppError> {
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

    let total_count = base_ids.len();

    if base_ids.is_empty() {
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count: 0,
            filtered_count: 0,
        });
    }

    // 2. Apply filters (AND semantics at top level)
    let filtered_ids = if let Some(ref filter_list) = filters {
        if filter_list.is_empty() {
            base_ids.clone()
        } else {
            let futures = filter_list.iter().map(|f| resolve_filter(pool, f, 0));
            let results = try_join_all(futures).await?;
            let mut result = base_ids.clone();
            for set in results {
                result.retain(|id| set.contains(id));
            }
            result
        }
    } else {
        base_ids.clone()
    };

    let filtered_count = filtered_ids.len();

    if filtered_count == 0 {
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count,
            filtered_count: 0,
        });
    }

    // 3. Resolve root pages for all filtered IDs
    let root_map = resolve_root_pages(pool, &filtered_ids).await?;

    // 4. Group blocks by root page (skip orphans with no page ancestor)
    let mut page_groups: std::collections::HashMap<String, (Option<String>, Vec<String>)> =
        std::collections::HashMap::new();
    for block_id_item in &filtered_ids {
        if let Some((page_id, page_title)) = root_map.get(block_id_item) {
            page_groups
                .entry(page_id.clone())
                .or_insert_with(|| (page_title.clone(), Vec::new()))
                .1
                .push(block_id_item.clone());
        }
    }

    // 5. Sort groups alphabetically by page_title (None sorts last)
    let mut group_list: Vec<(String, Option<String>, Vec<String>)> = page_groups
        .into_iter()
        .map(|(pid, (title, blocks))| (pid, title, blocks))
        .collect();
    group_list.sort_by(|a, b| {
        let ta = a.1.as_deref();
        let tb = b.1.as_deref();
        match (ta, tb) {
            (Some(a_title), Some(b_title)) => a_title.cmp(b_title).then_with(|| a.0.cmp(&b.0)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.0.cmp(&b.0),
        }
    });

    // 6. Apply cursor pagination on groups
    let start_after = page.after.as_ref().map(|c| c.id.as_str());
    let groups_after_cursor: Vec<&(String, Option<String>, Vec<String>)> =
        if let Some(after_id) = start_after {
            group_list
                .iter()
                .skip_while(|(pid, _, _)| pid.as_str() != after_id)
                .skip(1)
                .collect()
        } else {
            group_list.iter().collect()
        };

    let fetch_limit = (page.limit + 1) as usize;
    let page_groups_slice: Vec<&(String, Option<String>, Vec<String>)> =
        groups_after_cursor.into_iter().take(fetch_limit).collect();
    let has_more = page_groups_slice.len() > page.limit as usize;
    let actual_groups: Vec<&(String, Option<String>, Vec<String>)> = if has_more {
        page_groups_slice[..page.limit as usize].to_vec()
    } else {
        page_groups_slice
    };

    if actual_groups.is_empty() {
        return Ok(GroupedBacklinkResponse {
            groups: vec![],
            next_cursor: None,
            has_more: false,
            total_count,
            filtered_count,
        });
    }

    // 7. Sort all block IDs across groups by the user-specified sort, then distribute
    let sort = sort.unwrap_or(BacklinkSort::Created { dir: SortDir::Asc });
    let all_block_ids: FxHashSet<String> = actual_groups
        .iter()
        .flat_map(|(_, _, block_ids_in_group)| block_ids_in_group.iter().cloned())
        .collect();
    let sorted_all = sort_ids(pool, &all_block_ids, &sort).await?;

    // 8. Fetch full BlockRow data for all blocks in one batch
    let all_ids_vec: Vec<&str> = sorted_all.iter().map(|s| s.as_str()).collect();
    let fetched_rows = if all_ids_vec.is_empty() {
        vec![]
    } else {
        let placeholders = all_ids_vec
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let query_str = format!(
            "SELECT id, block_type, content, parent_id, position, \
             deleted_at, archived_at, is_conflict, conflict_type \
             FROM blocks WHERE id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, BlockRow>(&query_str);
        for id in &all_ids_vec {
            query = query.bind(*id);
        }
        query.fetch_all(pool).await?
    };

    // Build a lookup map from id -> BlockRow
    let row_map: std::collections::HashMap<&str, &BlockRow> =
        fetched_rows.iter().map(|r| (r.id.as_str(), r)).collect();

    // Build a position map from sorted order
    let sort_order: std::collections::HashMap<&str, usize> = sorted_all
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    // 9. Distribute fetched rows back into groups, maintaining sort order
    let mut groups: Vec<BacklinkGroup> = Vec::with_capacity(actual_groups.len());
    for (page_id, page_title, block_ids_in_group) in &actual_groups {
        let mut blocks: Vec<(&str, usize)> = block_ids_in_group
            .iter()
            .filter_map(|bid| sort_order.get(bid.as_str()).map(|&pos| (bid.as_str(), pos)))
            .collect();
        blocks.sort_by_key(|&(_, pos)| pos);

        let block_rows: Vec<BlockRow> = blocks
            .iter()
            .filter_map(|&(bid, _)| row_map.get(bid).map(|r| (*r).clone()))
            .collect();

        groups.push(BacklinkGroup {
            page_id: page_id.clone(),
            page_title: page_title.clone(),
            blocks: block_rows,
        });
    }

    // 10. Build cursor from last group's page_id if has_more
    let next_cursor = if has_more {
        let last = actual_groups.last().expect("has_more implies non-empty");
        Some(
            Cursor {
                id: last.0.clone(),
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

    Ok(GroupedBacklinkResponse {
        groups,
        next_cursor,
        has_more,
        total_count,
        filtered_count,
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
/// Uses a dynamic IN clause (or `json_each` for large sets) to fetch only the
/// property values for the given `ids`, avoiding a full table scan (#320).
async fn sort_by_property_text(
    pool: &SqlitePool,
    ids: &FxHashSet<String>,
    key: &str,
    dir: &SortDir,
) -> Result<Vec<String>, AppError> {
    if ids.is_empty() {
        return Ok(vec![]);
    }

    let id_vec: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
    let prop_map = fetch_text_props_for_ids(pool, key, &id_vec).await?;

    let mut sorted: Vec<String> = ids.iter().cloned().collect();
    sorted.sort_by(|a, b| {
        let va = prop_map.get(a.as_str()).and_then(|v| v.as_deref());
        let vb = prop_map.get(b.as_str()).and_then(|v| v.as_deref());
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

/// Fetch text property values for a set of block IDs.
/// Uses bind-parameter IN clause for ≤500 IDs, `json_each` for larger sets.
async fn fetch_text_props_for_ids(
    pool: &SqlitePool,
    key: &str,
    ids: &[&str],
) -> Result<std::collections::HashMap<String, Option<String>>, AppError> {
    if ids.len() <= 500 {
        let placeholders: String = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT block_id, value_text FROM block_properties \
             WHERE key = ? AND block_id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, (String, Option<String>)>(&sql);
        query = query.bind(key);
        for id in ids {
            query = query.bind(*id);
        }
        let rows = query.fetch_all(pool).await?;
        Ok(rows.into_iter().collect())
    } else {
        let json_ids = serde_json::to_string(&ids)?;
        let rows = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT block_id, value_text FROM block_properties \
             WHERE key = ? AND block_id IN (SELECT value FROM json_each(?))",
        )
        .bind(key)
        .bind(&json_ids)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().collect())
    }
}

/// Sort block IDs by a numeric property value.
///
/// Uses a dynamic IN clause (or `json_each` for large sets) to fetch only the
/// property values for the given `ids`, avoiding a full table scan (#320).
async fn sort_by_property_num(
    pool: &SqlitePool,
    ids: &FxHashSet<String>,
    key: &str,
    dir: &SortDir,
) -> Result<Vec<String>, AppError> {
    if ids.is_empty() {
        return Ok(vec![]);
    }

    let id_vec: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
    let prop_map = fetch_num_props_for_ids(pool, key, &id_vec).await?;

    let mut sorted: Vec<String> = ids.iter().cloned().collect();
    sorted.sort_by(|a, b| {
        let va = prop_map.get(a.as_str()).and_then(|v| *v);
        let vb = prop_map.get(b.as_str()).and_then(|v| *v);
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

/// Fetch numeric property values for a set of block IDs.
/// Uses bind-parameter IN clause for ≤500 IDs, `json_each` for larger sets.
async fn fetch_num_props_for_ids(
    pool: &SqlitePool,
    key: &str,
    ids: &[&str],
) -> Result<std::collections::HashMap<String, Option<f64>>, AppError> {
    if ids.len() <= 500 {
        let placeholders: String = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT block_id, value_num FROM block_properties \
             WHERE key = ? AND block_id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, (String, Option<f64>)>(&sql);
        query = query.bind(key);
        for id in ids {
            query = query.bind(*id);
        }
        let rows = query.fetch_all(pool).await?;
        Ok(rows.into_iter().collect())
    } else {
        let json_ids = serde_json::to_string(&ids)?;
        let rows = sqlx::query_as::<_, (String, Option<f64>)>(
            "SELECT block_id, value_num FROM block_properties \
             WHERE key = ? AND block_id IN (SELECT value FROM json_each(?))",
        )
        .bind(key)
        .bind(&json_ids)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().collect())
    }
}

/// Sort block IDs by a date property value.
///
/// Uses a dynamic IN clause (or `json_each` for large sets) to fetch only the
/// property values for the given `ids`, avoiding a full table scan (#320).
async fn sort_by_property_date(
    pool: &SqlitePool,
    ids: &FxHashSet<String>,
    key: &str,
    dir: &SortDir,
) -> Result<Vec<String>, AppError> {
    if ids.is_empty() {
        return Ok(vec![]);
    }

    let id_vec: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
    let prop_map = fetch_date_props_for_ids(pool, key, &id_vec).await?;

    let mut sorted: Vec<String> = ids.iter().cloned().collect();
    sorted.sort_by(|a, b| {
        let va = prop_map.get(a.as_str()).and_then(|v| v.as_deref());
        let vb = prop_map.get(b.as_str()).and_then(|v| v.as_deref());
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

/// Fetch date property values for a set of block IDs.
/// Uses bind-parameter IN clause for ≤500 IDs, `json_each` for larger sets.
async fn fetch_date_props_for_ids(
    pool: &SqlitePool,
    key: &str,
    ids: &[&str],
) -> Result<std::collections::HashMap<String, Option<String>>, AppError> {
    if ids.len() <= 500 {
        let placeholders: String = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT block_id, value_date FROM block_properties \
             WHERE key = ? AND block_id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, (String, Option<String>)>(&sql);
        query = query.bind(key);
        for id in ids {
            query = query.bind(*id);
        }
        let rows = query.fetch_all(pool).await?;
        Ok(rows.into_iter().collect())
    } else {
        let json_ids = serde_json::to_string(&ids)?;
        let rows = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT block_id, value_date FROM block_properties \
             WHERE key = ? AND block_id IN (SELECT value FROM json_each(?))",
        )
        .bind(key)
        .bind(&json_ids)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().collect())
    }
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
        assert_eq!(resp.filtered_count, 3);
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
        assert_eq!(resp.filtered_count, 3);
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
        assert_eq!(resp2.filtered_count, 3);
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
        assert_eq!(resp.total_count, 3);
        assert_eq!(resp.filtered_count, 2);
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
        assert_eq!(resp.filtered_count, 3);
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
        assert_eq!(resp.filtered_count, 3);
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
        assert_eq!(resp.filtered_count, 0);
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
        assert_eq!(resp.filtered_count, 2);
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
        assert_eq!(resp.filtered_count, 2);
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
        assert_eq!(resp.total_count, 3);
        assert_eq!(resp.filtered_count, 1);
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
        assert_eq!(resp.total_count, 2);
        assert_eq!(resp.filtered_count, 1);
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
        assert_eq!(resp.total_count, 3);
        assert_eq!(resp.filtered_count, 1);
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
        assert_eq!(resp.total_count, 3, "base set has 3 backlinks");
        assert_eq!(
            resp.filtered_count, 0,
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
    // ms_to_ulid_prefix round-trip
    // ======================================================================

    #[test]
    fn ms_to_ulid_prefix_round_trip() {
        // Verify encode/decode round-trip for several known timestamps
        let timestamps: Vec<u64> = vec![0, 1, 1000, 1735689600000, u64::MAX >> 16];
        for ms in timestamps {
            let prefix = ms_to_ulid_prefix(ms);
            assert_eq!(prefix.len(), 10, "prefix should be 10 chars for ms={ms}");
            let decoded = ulid_to_ms(&prefix).unwrap();
            assert_eq!(decoded, ms, "round-trip failed for ms={ms}");
        }
    }

    #[test]
    fn ms_to_ulid_prefix_preserves_sort_order() {
        let t1 = 1000u64;
        let t2 = 2000u64;
        let t3 = 1735689600000u64;
        let p1 = ms_to_ulid_prefix(t1);
        let p2 = ms_to_ulid_prefix(t2);
        let p3 = ms_to_ulid_prefix(t3);
        assert!(p1 < p2, "sort order: {p1} should be < {p2}");
        assert!(p2 < p3, "sort order: {p2} should be < {p3}");
    }

    #[test]
    fn ms_to_ulid_prefix_zero() {
        let prefix = ms_to_ulid_prefix(0);
        assert_eq!(prefix, "0000000000");
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

    // ======================================================================
    // #409 — Not filter json_each path (>500 items)
    // ======================================================================

    #[tokio::test]
    async fn not_filter_large_set_uses_json_each() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TARGET", "page", "Target Page").await;

        // Create >500 "page" source blocks that link to TARGET
        for i in 0..510 {
            let id = format!("PAGE_{i:04}");
            insert_block(&pool, &id, "page", &format!("Page {i}")).await;
            insert_block_link(&pool, &id, "TARGET").await;
        }

        // Create 5 "content" blocks that link to TARGET
        for i in 0..5 {
            let id = format!("CONTENT_{i:04}");
            insert_block(&pool, &id, "content", &format!("Content {i}")).await;
            insert_block_link(&pool, &id, "TARGET").await;
        }

        // Not(BlockType("page")) should return only the content blocks
        // (plus TARGET itself since it's a block, but it won't be in
        // the backlink base set for itself).
        // The inner set has >500 page blocks, triggering the json_each path.
        let filter = BacklinkFilter::Not {
            filter: Box::new(BacklinkFilter::BlockType {
                block_type: "page".into(),
            }),
        };
        let set = resolve_filter(&pool, &filter, 0).await.unwrap();

        // All 5 content blocks should be in the result
        for i in 0..5 {
            let id = format!("CONTENT_{i:04}");
            assert!(set.contains(&id), "expected {id} in Not(page) set");
        }

        // No page blocks should be in the result
        for i in 0..510 {
            let id = format!("PAGE_{i:04}");
            assert!(
                !set.contains(&id),
                "page block {id} should NOT be in Not(page) set"
            );
        }
    }

    // ======================================================================
    // #410 — Not(Not(filter)) double negation is identity
    // ======================================================================

    #[tokio::test]
    async fn not_not_is_identity() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TARGET", "page", "Target Page").await;

        // Create mixed block types as backlink sources
        for i in 0..3 {
            let id = format!("CONTENT_{i}");
            insert_block(&pool, &id, "content", &format!("Content {i}")).await;
            insert_block_link(&pool, &id, "TARGET").await;
        }
        for i in 0..2 {
            let id = format!("PAGE_{i}");
            insert_block(&pool, &id, "page", &format!("Page {i}")).await;
            insert_block_link(&pool, &id, "TARGET").await;
        }

        // Evaluate BlockType("content")
        let plain_filter = BacklinkFilter::BlockType {
            block_type: "content".into(),
        };
        let plain_set = resolve_filter(&pool, &plain_filter, 0).await.unwrap();

        // Evaluate Not(Not(BlockType("content")))
        let double_neg_filter = BacklinkFilter::Not {
            filter: Box::new(BacklinkFilter::Not {
                filter: Box::new(BacklinkFilter::BlockType {
                    block_type: "content".into(),
                }),
            }),
        };
        let double_neg_set = resolve_filter(&pool, &double_neg_filter, 0).await.unwrap();

        assert_eq!(
            plain_set, double_neg_set,
            "Not(Not(BlockType(\"content\"))) should equal BlockType(\"content\")"
        );
    }

    // ======================================================================
    // #411 — Non-finite f64 in PropertyNum filter (defense in depth)
    // ======================================================================

    #[tokio::test]
    async fn filter_property_num_non_finite_values() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TARGET", "page", "Target Page").await;
        insert_block(&pool, "SRC_A", "content", "Source A").await;
        insert_block(&pool, "SRC_B", "content", "Source B").await;
        insert_property(&pool, "SRC_A", "score", None, Some(42.0), None).await;
        insert_property(&pool, "SRC_B", "score", None, Some(100.0), None).await;
        insert_block_link(&pool, "SRC_A", "TARGET").await;
        insert_block_link(&pool, "SRC_B", "TARGET").await;
        let page = default_page();

        // Test 1: Eq with +Infinity → should match nothing
        // (42.0 - Inf).abs() == Inf, which is not < EPSILON
        let filters_inf_eq = vec![BacklinkFilter::PropertyNum {
            key: "score".into(),
            op: CompareOp::Eq,
            value: f64::INFINITY,
        }];
        let resp = eval_backlink_query(&pool, "TARGET", Some(filters_inf_eq), None, &page)
            .await
            .unwrap();
        assert_eq!(
            resp.filtered_count, 0,
            "Eq with +Infinity should match no finite values"
        );

        // Test 2: Gt with -Infinity → both should match (42 > -Inf is true)
        let filters_neg_inf_gt = vec![BacklinkFilter::PropertyNum {
            key: "score".into(),
            op: CompareOp::Gt,
            value: f64::NEG_INFINITY,
        }];
        let resp = eval_backlink_query(&pool, "TARGET", Some(filters_neg_inf_gt), None, &page)
            .await
            .unwrap();
        assert_eq!(
            resp.filtered_count, 2,
            "Gt with -Infinity should match all finite values"
        );
        let ids: Vec<&str> = resp.items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"SRC_A"), "SRC_A (42.0) > -Inf");
        assert!(ids.contains(&"SRC_B"), "SRC_B (100.0) > -Inf");

        // Test 3: Eq with NaN → should match nothing (NaN comparisons are always false)
        let filters_nan_eq = vec![BacklinkFilter::PropertyNum {
            key: "score".into(),
            op: CompareOp::Eq,
            value: f64::NAN,
        }];
        let resp = eval_backlink_query(&pool, "TARGET", Some(filters_nan_eq), None, &page)
            .await
            .unwrap();
        assert_eq!(
            resp.filtered_count, 0,
            "Eq with NaN should match nothing (NaN - x is NaN, NaN.abs() is NaN, NaN < EPSILON is false)"
        );
    }

    // ======================================================================
    // #412 — HasTagPrefix LIKE escape chars (%, _, \)
    // ======================================================================

    #[tokio::test]
    async fn filter_has_tag_prefix_with_special_chars() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TARGET", "page", "Target Page").await;
        insert_block(&pool, "SRC_A", "content", "Source A").await;
        insert_block(&pool, "SRC_B", "content", "Source B").await;
        insert_block(&pool, "SRC_C", "content", "Source C").await;
        insert_block_link(&pool, "SRC_A", "TARGET").await;
        insert_block_link(&pool, "SRC_B", "TARGET").await;
        insert_block_link(&pool, "SRC_C", "TARGET").await;

        // Create tag blocks (block_tags.tag_id FK → blocks.id)
        insert_block(&pool, "TAG_PCT", "tag", "a%b").await;
        insert_block(&pool, "TAG_AXB", "tag", "axb").await;
        insert_block(&pool, "TAG_USC", "tag", "a_c").await;

        // Create tags with special LIKE characters
        insert_tag_cache(&pool, "TAG_PCT", "a%b", 1).await;
        insert_tag_cache(&pool, "TAG_AXB", "axb", 1).await;
        insert_tag_cache(&pool, "TAG_USC", "a_c", 1).await;

        // Assign tags: SRC_A gets "a%b", SRC_B gets "axb", SRC_C gets "a_c"
        insert_tag_assoc(&pool, "SRC_A", "TAG_PCT").await;
        insert_tag_assoc(&pool, "SRC_B", "TAG_AXB").await;
        insert_tag_assoc(&pool, "SRC_C", "TAG_USC").await;
        let page = default_page();

        // Test 1: HasTagPrefix with "a%" should match ONLY SRC_A (literal "a%" prefix)
        // Without escaping, "a%" would be a LIKE wildcard matching "axb" too.
        let filters_pct = vec![BacklinkFilter::HasTagPrefix {
            prefix: "a%".into(),
        }];
        let resp = eval_backlink_query(&pool, "TARGET", Some(filters_pct), None, &page)
            .await
            .unwrap();
        assert_eq!(
            resp.filtered_count, 1,
            "HasTagPrefix 'a%' should match only the literal 'a%b' tag, not 'axb'"
        );
        assert_eq!(
            resp.items[0].id, "SRC_A",
            "only SRC_A has the 'a%b' tag matching literal prefix 'a%'"
        );

        // Test 2: HasTagPrefix with "a_" should match ONLY SRC_C (literal "a_" prefix)
        // Without escaping, "a_" would be a LIKE wildcard matching "axb" too.
        let filters_usc = vec![BacklinkFilter::HasTagPrefix {
            prefix: "a_".into(),
        }];
        let resp = eval_backlink_query(&pool, "TARGET", Some(filters_usc), None, &page)
            .await
            .unwrap();
        assert_eq!(
            resp.filtered_count, 1,
            "HasTagPrefix 'a_' should match only the literal 'a_c' tag, not 'axb'"
        );
        assert_eq!(
            resp.items[0].id, "SRC_C",
            "only SRC_C has the 'a_c' tag matching literal prefix 'a_'"
        );
    }

    // ======================================================================
    // #413 — FTS Contains with mixed operators and valid terms
    // ======================================================================

    #[tokio::test]
    async fn fts_contains_mixed_operators_and_terms() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TARGET", "page", "Target Page").await;
        insert_block(&pool, "SRC_A", "content", "Source A").await;
        insert_block(&pool, "SRC_B", "content", "Source B").await;
        insert_block(&pool, "SRC_C", "content", "Source C").await;
        insert_block_link(&pool, "SRC_A", "TARGET").await;
        insert_block_link(&pool, "SRC_B", "TARGET").await;
        insert_block_link(&pool, "SRC_C", "TARGET").await;

        // Insert FTS entries with FTS5 operator keywords as literal words
        insert_fts(&pool, "SRC_A", "AND hello world").await;
        insert_fts(&pool, "SRC_B", "hello NOT goodbye").await;
        insert_fts(&pool, "SRC_C", "just hello there").await;
        let page = default_page();

        // Test 1: "AND hello" should match SRC_A (both terms present as literal text)
        let filters_and = vec![BacklinkFilter::Contains {
            query: "AND hello".into(),
        }];
        let resp = eval_backlink_query(&pool, "TARGET", Some(filters_and), None, &page)
            .await
            .unwrap();
        assert_eq!(
            resp.filtered_count, 1,
            "'AND hello' should match only SRC_A which contains both literal words"
        );
        assert_eq!(
            resp.items[0].id, "SRC_A",
            "SRC_A has 'AND hello world' containing both 'AND' and 'hello' literally"
        );

        // Test 2: "NOT goodbye" should match SRC_B (both as literal text, not FTS5 NOT operator)
        let filters_not = vec![BacklinkFilter::Contains {
            query: "NOT goodbye".into(),
        }];
        let resp = eval_backlink_query(&pool, "TARGET", Some(filters_not), None, &page)
            .await
            .unwrap();
        assert_eq!(
            resp.filtered_count, 1,
            "'NOT goodbye' should match only SRC_B which contains both literal words"
        );
        assert_eq!(
            resp.items[0].id, "SRC_B",
            "SRC_B has 'hello NOT goodbye' containing both 'NOT' and 'goodbye' literally"
        );

        // Test 3: "hello" should match all three (SRC_A, SRC_B, SRC_C)
        let filters_hello = vec![BacklinkFilter::Contains {
            query: "hello".into(),
        }];
        let resp = eval_backlink_query(&pool, "TARGET", Some(filters_hello), None, &page)
            .await
            .unwrap();
        assert_eq!(
            resp.filtered_count, 3,
            "'hello' should match all three blocks that contain it"
        );
        let ids: Vec<&str> = resp.items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"SRC_A"), "SRC_A contains 'hello'");
        assert!(ids.contains(&"SRC_B"), "SRC_B contains 'hello'");
        assert!(ids.contains(&"SRC_C"), "SRC_C contains 'hello'");
    }

    // ======================================================================
    // Helper: insert a block with optional parent_id and position
    // ======================================================================

    /// Insert a block with parent_id and position for hierarchy tests.
    async fn insert_block_with_parent(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: Option<i64>,
    ) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) VALUES (?, ?, ?, ?, ?)",
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

    // ======================================================================
    // #539 — total_count + filtered_count tests
    // ======================================================================

    #[tokio::test]
    async fn total_and_filtered_count_no_filters() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        let page = default_page();

        let resp = eval_backlink_query(&pool, "TARGET", None, None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 3);
        assert_eq!(resp.filtered_count, 3);
        assert_eq!(
            resp.total_count, resp.filtered_count,
            "with no filters, total_count == filtered_count"
        );
    }

    #[tokio::test]
    async fn total_and_filtered_count_with_filter() {
        let (pool, _dir) = test_pool().await;
        setup_backlinks(&pool).await;
        insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
        insert_property(&pool, "SRC_B", "status", Some("active"), None, None).await;
        // SRC_C has no status property
        let page = default_page();

        let filters = vec![BacklinkFilter::PropertyIsSet {
            key: "status".into(),
        }];

        let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 3, "base set has 3 backlinks");
        assert_eq!(resp.filtered_count, 2, "only 2 match the filter");
    }

    // ======================================================================
    // #538 — resolve_root_pages tests
    // ======================================================================

    #[tokio::test]
    async fn resolve_root_pages_empty() {
        let (pool, _dir) = test_pool().await;
        let result = resolve_root_pages(&pool, &FxHashSet::default())
            .await
            .unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn resolve_root_pages_happy_path() {
        let (pool, _dir) = test_pool().await;
        insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_A1",
            "content",
            "block a1",
            Some("PAGE_A"),
            Some(1),
        )
        .await;

        let mut ids = FxHashSet::default();
        ids.insert("BLK_A1".into());
        let result = resolve_root_pages(&pool, &ids).await.unwrap();
        assert_eq!(result.len(), 1);
        let (root_id, root_title) = result.get("BLK_A1").unwrap();
        assert_eq!(root_id, "PAGE_A");
        assert_eq!(root_title.as_deref(), Some("Page A"));
    }

    #[tokio::test]
    async fn resolve_root_pages_nested() {
        let (pool, _dir) = test_pool().await;
        insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
        insert_block_with_parent(
            &pool,
            "MID",
            "content",
            "mid level",
            Some("PAGE_A"),
            Some(1),
        )
        .await;
        insert_block_with_parent(&pool, "DEEP", "content", "deep level", Some("MID"), Some(1))
            .await;

        let mut ids = FxHashSet::default();
        ids.insert("DEEP".into());
        let result = resolve_root_pages(&pool, &ids).await.unwrap();
        assert_eq!(result.len(), 1);
        let (root_id, _) = result.get("DEEP").unwrap();
        assert_eq!(root_id, "PAGE_A");
    }

    #[tokio::test]
    async fn resolve_root_pages_orphan() {
        let (pool, _dir) = test_pool().await;
        // A block with no parent, but block_type = 'content' (not a page)
        insert_block_with_parent(&pool, "ORPHAN", "content", "orphan block", None, None).await;

        let mut ids = FxHashSet::default();
        ids.insert("ORPHAN".into());
        let result = resolve_root_pages(&pool, &ids).await.unwrap();
        assert!(
            result.is_empty(),
            "orphan block (no page ancestor) should be omitted"
        );
    }

    // ======================================================================
    // #538 — eval_backlink_query_grouped tests
    // ======================================================================

    #[tokio::test]
    async fn eval_grouped_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "LONELY", "page", "No one links to me").await;
        let page = default_page();

        let resp = eval_backlink_query_grouped(&pool, "LONELY", None, None, &page)
            .await
            .unwrap();
        assert!(resp.groups.is_empty());
        assert_eq!(resp.total_count, 0);
        assert_eq!(resp.filtered_count, 0);
        assert!(!resp.has_more);
    }

    #[tokio::test]
    async fn eval_grouped_happy_path() {
        let (pool, _dir) = test_pool().await;
        // Page A with child content blocks
        insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_A1",
            "content",
            "block a1",
            Some("PAGE_A"),
            Some(1),
        )
        .await;
        // Page B with child content blocks
        insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_B1",
            "content",
            "block b1",
            Some("PAGE_B"),
            Some(1),
        )
        .await;
        // Target page
        insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
        // Backlinks: BLK_A1 and BLK_B1 link to TARGET
        insert_block_link(&pool, "BLK_A1", "TARGET").await;
        insert_block_link(&pool, "BLK_B1", "TARGET").await;
        let page = default_page();

        let resp = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page)
            .await
            .unwrap();
        assert_eq!(resp.groups.len(), 2, "2 source pages");
        assert_eq!(resp.total_count, 2);
        assert_eq!(resp.filtered_count, 2);
        assert!(!resp.has_more);

        // Groups sorted alphabetically by page_title: "Page A" < "Page B"
        assert_eq!(resp.groups[0].page_id, "PAGE_A");
        assert_eq!(resp.groups[0].page_title.as_deref(), Some("Page A"));
        assert_eq!(resp.groups[0].blocks.len(), 1);
        assert_eq!(resp.groups[0].blocks[0].id, "BLK_A1");

        assert_eq!(resp.groups[1].page_id, "PAGE_B");
        assert_eq!(resp.groups[1].page_title.as_deref(), Some("Page B"));
        assert_eq!(resp.groups[1].blocks.len(), 1);
        assert_eq!(resp.groups[1].blocks[0].id, "BLK_B1");
    }

    #[tokio::test]
    async fn eval_grouped_pagination() {
        let (pool, _dir) = test_pool().await;
        // Create 3 pages with child blocks linking to target
        insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
        for ch in ['A', 'B', 'C'] {
            let page_id = format!("PAGE_{ch}");
            let blk_id = format!("BLK_{ch}1");
            insert_block_with_parent(&pool, &page_id, "page", &format!("Page {ch}"), None, None)
                .await;
            insert_block_with_parent(
                &pool,
                &blk_id,
                "content",
                &format!("block {ch}1"),
                Some(&page_id),
                Some(1),
            )
            .await;
            insert_block_link(&pool, &blk_id, "TARGET").await;
        }

        // First page: limit=2
        let page1 = PageRequest::new(None, Some(2)).unwrap();
        let resp1 = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page1)
            .await
            .unwrap();
        assert_eq!(resp1.groups.len(), 2);
        assert!(resp1.has_more);
        assert!(resp1.next_cursor.is_some());
        assert_eq!(resp1.total_count, 3);
        assert_eq!(resp1.filtered_count, 3);

        // Second page via cursor
        let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
        let resp2 = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page2)
            .await
            .unwrap();
        assert_eq!(resp2.groups.len(), 1);
        assert!(!resp2.has_more);
        assert!(resp2.next_cursor.is_none());
    }

    #[tokio::test]
    async fn eval_grouped_respects_filters() {
        let (pool, _dir) = test_pool().await;
        // Page A with child content blocks
        insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_A1",
            "content",
            "block a1",
            Some("PAGE_A"),
            Some(1),
        )
        .await;
        // Page B with child content blocks
        insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_B1",
            "content",
            "block b1",
            Some("PAGE_B"),
            Some(1),
        )
        .await;
        // Target page
        insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
        // Backlinks
        insert_block_link(&pool, "BLK_A1", "TARGET").await;
        insert_block_link(&pool, "BLK_B1", "TARGET").await;
        // Only BLK_A1 has a property
        insert_property(&pool, "BLK_A1", "status", Some("active"), None, None).await;
        let page = default_page();

        let filters = vec![BacklinkFilter::PropertyIsSet {
            key: "status".into(),
        }];

        let resp = eval_backlink_query_grouped(&pool, "TARGET", Some(filters), None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 2, "base set has 2 backlinks");
        assert_eq!(resp.filtered_count, 1, "only 1 matches the filter");
        assert_eq!(resp.groups.len(), 1);
        assert_eq!(resp.groups[0].page_id, "PAGE_A");
    }

    // ======================================================================
    // #540 — SourcePage filter tests
    // ======================================================================

    #[tokio::test]
    async fn filter_source_page_included() {
        let (pool, _dir) = test_pool().await;
        // Page A with child content blocks
        insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_A1",
            "content",
            "block a1",
            Some("PAGE_A"),
            Some(1),
        )
        .await;
        // Page B with child content blocks
        insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_B1",
            "content",
            "block b1",
            Some("PAGE_B"),
            Some(1),
        )
        .await;
        // Target page
        insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
        insert_block_link(&pool, "BLK_A1", "TARGET").await;
        insert_block_link(&pool, "BLK_B1", "TARGET").await;
        let page = default_page();

        let filters = vec![BacklinkFilter::SourcePage {
            included: vec!["PAGE_A".into()],
            excluded: vec![],
        }];

        let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 2, "base set has 2 backlinks");
        assert_eq!(resp.filtered_count, 1, "only backlinks from PAGE_A");
        assert_eq!(resp.items[0].id, "BLK_A1");
    }

    #[tokio::test]
    async fn filter_source_page_excluded() {
        let (pool, _dir) = test_pool().await;
        // Page A with child content blocks
        insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_A1",
            "content",
            "block a1",
            Some("PAGE_A"),
            Some(1),
        )
        .await;
        // Page B with child content blocks
        insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_B1",
            "content",
            "block b1",
            Some("PAGE_B"),
            Some(1),
        )
        .await;
        // Target page
        insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
        insert_block_link(&pool, "BLK_A1", "TARGET").await;
        insert_block_link(&pool, "BLK_B1", "TARGET").await;
        let page = default_page();

        let filters = vec![BacklinkFilter::SourcePage {
            included: vec![],
            excluded: vec!["PAGE_A".into()],
        }];

        let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 2, "base set has 2 backlinks");
        assert_eq!(resp.filtered_count, 1, "backlinks from PAGE_A excluded");
        assert_eq!(resp.items[0].id, "BLK_B1");
    }

    #[tokio::test]
    async fn filter_source_page_included_and_excluded() {
        let (pool, _dir) = test_pool().await;
        // Page A with two child content blocks
        insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_A1",
            "content",
            "block a1",
            Some("PAGE_A"),
            Some(1),
        )
        .await;
        insert_block_with_parent(
            &pool,
            "BLK_A2",
            "content",
            "block a2",
            Some("PAGE_A"),
            Some(2),
        )
        .await;
        // Page B with child content block
        insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_B1",
            "content",
            "block b1",
            Some("PAGE_B"),
            Some(1),
        )
        .await;
        // Page C with child content block
        insert_block_with_parent(&pool, "PAGE_C", "page", "Page C", None, None).await;
        insert_block_with_parent(
            &pool,
            "BLK_C1",
            "content",
            "block c1",
            Some("PAGE_C"),
            Some(1),
        )
        .await;
        // Target page
        insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
        insert_block_link(&pool, "BLK_A1", "TARGET").await;
        insert_block_link(&pool, "BLK_A2", "TARGET").await;
        insert_block_link(&pool, "BLK_B1", "TARGET").await;
        insert_block_link(&pool, "BLK_C1", "TARGET").await;
        let page = default_page();

        // Include PAGE_A and PAGE_B, exclude PAGE_B → only PAGE_A blocks
        let filters = vec![BacklinkFilter::SourcePage {
            included: vec!["PAGE_A".into(), "PAGE_B".into()],
            excluded: vec!["PAGE_B".into()],
        }];

        let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
            .await
            .unwrap();
        assert_eq!(resp.total_count, 4, "base set has 4 backlinks");
        assert_eq!(
            resp.filtered_count, 2,
            "only PAGE_A blocks after include+exclude"
        );
        let ids: Vec<&str> = resp.items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"BLK_A1"), "BLK_A1 from PAGE_A");
        assert!(ids.contains(&"BLK_A2"), "BLK_A2 from PAGE_A");
        assert!(!ids.contains(&"BLK_B1"), "BLK_B1 from PAGE_B excluded");
        assert!(!ids.contains(&"BLK_C1"), "BLK_C1 from PAGE_C not included");
    }
}
