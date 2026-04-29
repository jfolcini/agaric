//! Filter evaluation for backlink queries: recursive filter resolver,
//! LIKE-pattern escaping, ISO date parsing, and ULID timestamp utilities.

use futures_util::future::try_join_all;
use rustc_hash::FxHashSet;
use sqlx::SqlitePool;

use super::types::{BacklinkFilter, CompareOp};
use super::SMALL_IN_LIMIT;
use crate::error::AppError;
use crate::fts::sanitize_fts_query;
use crate::tag_query::{resolve_tag_leaves, resolve_tag_prefix_leaves};

// ---------------------------------------------------------------------------
// Crockford Base32 ULID timestamp extraction
// ---------------------------------------------------------------------------

/// Decode the first 10 characters of a ULID (Crockford base32) into Unix
/// milliseconds.  This is the timestamp component of the ULID.
#[cfg(test)]
pub(crate) fn ulid_to_ms(ulid: &str) -> Option<u64> {
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
#[cfg(test)]
pub(crate) fn crockford_decode_char(c: char) -> Option<u8> {
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
pub(crate) fn ms_to_ulid_prefix(ms: u64) -> String {
    let mut chars = [b'0'; 10];
    let mut value = ms;
    for i in (0..10).rev() {
        chars[i] = CROCKFORD_ENCODE[(value & 0x1F) as usize];
        value >>= 5;
    }
    // I-Search-17 SAFETY: every byte in `chars` is sourced from
    // `CROCKFORD_ENCODE`, which is a `&[u8; 32]` of ASCII characters by
    // construction (`b"0123456789ABCDEFGHJKMNPQRSTVWXYZ"`). ASCII is a
    // strict subset of UTF-8, so `from_utf8` cannot fail. The `unwrap` is
    // therefore panic-free; future readers should not "fix" it by
    // propagating the error.
    String::from_utf8(chars.to_vec()).unwrap()
}

// ---------------------------------------------------------------------------
// Internal: resolve BacklinkFilter -> set of block_ids
// ---------------------------------------------------------------------------

/// Resolve a `BacklinkFilter` into the set of matching `block_id`s.
///
/// Deleted and conflict blocks are excluded at the leaf level.
/// Uses the same recursive `Pin<Box<dyn Future>>` pattern as `tag_query::resolve_expr`.
pub(crate) fn resolve_filter<'a>(
    pool: &'a SqlitePool,
    filter: &'a BacklinkFilter,
    depth: u32,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<FxHashSet<String>, AppError>> + Send + 'a>,
> {
    resolve_filter_with_candidates(pool, filter, depth, None)
}

/// Like [`resolve_filter`] but accepts an optional **candidate set**.
///
/// When `candidates` is `Some`, certain negative filters (e.g.
/// `PropertyIsEmpty`) scope their SQL query to the candidate set via
/// `json_each()` instead of scanning the entire `blocks` table.  This
/// avoids materialising thousands of rows only to intersect them in Rust.
pub(crate) fn resolve_filter_with_candidates<'a>(
    pool: &'a SqlitePool,
    filter: &'a BacklinkFilter,
    depth: u32,
    candidates: Option<&'a FxHashSet<String>>,
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
                            CompareOp::Contains => v.contains(value.as_str()),
                            CompareOp::StartsWith => v.starts_with(value.as_str()),
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
                            CompareOp::Contains | CompareOp::StartsWith => false,
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
                            CompareOp::Contains => v.contains(value.as_str()),
                            CompareOp::StartsWith => v.starts_with(value.as_str()),
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
                //
                // When a candidate set is provided, scope the query to only
                // those IDs via json_each() — avoids scanning the entire
                // blocks table just to intersect in Rust afterwards.
                if let Some(cands) = candidates {
                    if cands.is_empty() {
                        return Ok(FxHashSet::default());
                    }
                    let json_ids = serde_json::to_string(&cands.iter().collect::<Vec<_>>())?;
                    let rows = sqlx::query_scalar::<_, String>(
                        "SELECT value AS id FROM json_each(?1) \
                         WHERE CAST(value AS TEXT) NOT IN \
                           (SELECT block_id FROM block_properties WHERE key = ?2)",
                    )
                    .bind(&json_ids)
                    .bind(key)
                    .fetch_all(pool)
                    .await?;
                    return Ok(rows.into_iter().collect());
                }

                // Fallback: no candidate set — scan all non-deleted blocks.
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

            BacklinkFilter::TodoState { state } => {
                let rows: Vec<(String,)> = sqlx::query_as(
                    "SELECT id FROM blocks WHERE todo_state = ? AND deleted_at IS NULL AND is_conflict = 0",
                )
                .bind(state)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().map(|r| r.0).collect())
            }

            BacklinkFilter::Priority { level } => {
                let rows: Vec<(String,)> = sqlx::query_as(
                    "SELECT id FROM blocks WHERE priority = ? AND deleted_at IS NULL AND is_conflict = 0",
                )
                .bind(level)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().map(|r| r.0).collect())
            }

            BacklinkFilter::DueDate { op, value } => {
                let sql = match op {
                    CompareOp::Eq => "SELECT id FROM blocks WHERE due_date = ? AND deleted_at IS NULL AND is_conflict = 0",
                    CompareOp::Neq => "SELECT id FROM blocks WHERE due_date != ? AND due_date IS NOT NULL AND deleted_at IS NULL AND is_conflict = 0",
                    CompareOp::Lt => "SELECT id FROM blocks WHERE due_date < ? AND due_date IS NOT NULL AND deleted_at IS NULL AND is_conflict = 0",
                    CompareOp::Lte => "SELECT id FROM blocks WHERE due_date <= ? AND due_date IS NOT NULL AND deleted_at IS NULL AND is_conflict = 0",
                    CompareOp::Gt => "SELECT id FROM blocks WHERE due_date > ? AND due_date IS NOT NULL AND deleted_at IS NULL AND is_conflict = 0",
                    CompareOp::Gte => "SELECT id FROM blocks WHERE due_date >= ? AND due_date IS NOT NULL AND deleted_at IS NULL AND is_conflict = 0",
                    CompareOp::Contains | CompareOp::StartsWith => {
                        return Err(AppError::Validation(format!(
                            "DueDate filter does not support {op:?} operator"
                        )));
                    }
                };
                let rows: Vec<(String,)> = sqlx::query_as(sql).bind(value).fetch_all(pool).await?;
                Ok(rows.into_iter().map(|r| r.0).collect())
            }

            BacklinkFilter::HasTag { tag_id } => {
                // MAINT-143: shares leaf SQL with `tag_query::resolve_expr`
                // (UX-250 inline-ref union semantics). The single source of
                // truth is `tag_query::resolve_tag_leaves`.
                let rows = resolve_tag_leaves(pool, tag_id, false).await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::HasTagPrefix { prefix } => {
                // MAINT-143: shares leaf SQL with `tag_query::resolve_expr`
                // (UX-250 inline-ref union semantics). The single source of
                // truth is `tag_query::resolve_tag_prefix_leaves`.
                let rows = resolve_tag_prefix_leaves(pool, prefix, false).await?;
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
                // I-Search-9: when a candidate set is provided, scope the
                // query to those IDs via json_each() instead of loading
                // every active block of the given type into memory.  For
                // common types like "content" the unscoped path can return
                // 10K+ rows that get discarded by the subsequent
                // intersection in `eval_backlink_query`.
                if let Some(cands) = candidates {
                    if cands.is_empty() {
                        return Ok(FxHashSet::default());
                    }
                    let json_ids = serde_json::to_string(&cands.iter().collect::<Vec<_>>())?;
                    let rows = sqlx::query_scalar::<_, String>(
                        "SELECT id FROM blocks \
                         WHERE block_type = ?1 \
                           AND deleted_at IS NULL AND is_conflict = 0 \
                           AND id IN (SELECT value FROM json_each(?2))",
                    )
                    .bind(block_type)
                    .bind(&json_ids)
                    .fetch_all(pool)
                    .await?;
                    return Ok(rows.into_iter().collect());
                }

                // Fallback: no candidate set — scan every active block of
                // this type.  Kept for callers that don't (yet) thread a
                // candidate set through; And/Or combinators currently
                // resolve sub-filters via the no-candidate `resolve_filter`
                // helper.
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
                let result: FxHashSet<String>;

                if !included.is_empty() {
                    // Get all descendants of included pages.
                    // Positional IN-bind for ≤SMALL_IN_LIMIT, json_each fallback
                    // above the threshold (L-84).
                    result = fetch_descendants_of(pool, included).await?;

                    // Apply exclusion on top of included set if needed
                    if !excluded.is_empty() {
                        let excluded_set = fetch_descendants_of(pool, excluded).await?;
                        // Shadow with filtered result (result is not mut)
                        let mut result = result;
                        result.retain(|id| !excluded_set.contains(id));
                        return Ok(result);
                    }
                } else if !excluded.is_empty() {
                    // Exclusion-only: push exclusion into SQL to avoid loading full table.
                    // Positional IN-bind for ≤SMALL_IN_LIMIT, json_each fallback
                    // above the threshold (L-84).
                    if excluded.len() <= SMALL_IN_LIMIT {
                        let placeholders = std::iter::repeat_n("?", excluded.len())
                            .collect::<Vec<_>>()
                            .join(",");
                        let sql = format!(
                            "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0 \
                             AND id NOT IN ( \
                               WITH RECURSIVE desc(id, depth) AS ( \
                                 SELECT id, 0 FROM blocks WHERE id IN ({placeholders}) AND deleted_at IS NULL AND is_conflict = 0 \
                                 UNION ALL \
                                 SELECT b.id, d.depth + 1 FROM blocks b JOIN desc d ON b.parent_id = d.id WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100 \
                               ) SELECT id FROM desc \
                             )"
                        );
                        let mut q = sqlx::query_scalar::<_, String>(&sql);
                        for id in excluded {
                            q = q.bind(id);
                        }
                        result = q.fetch_all(pool).await?.into_iter().collect();
                    } else {
                        let json_ids = serde_json::to_string(&excluded)?;
                        let rows = sqlx::query_scalar::<_, String>(
                            "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0 \
                             AND id NOT IN ( \
                               WITH RECURSIVE desc(id, depth) AS ( \
                                 SELECT value AS id, 0 AS depth FROM json_each(?1) \
                                 UNION ALL \
                                 SELECT b.id, d.depth + 1 FROM blocks b JOIN desc d ON b.parent_id = d.id WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100 \
                               ) SELECT id FROM desc \
                             )",
                        )
                        .bind(&json_ids)
                        .fetch_all(pool)
                        .await?;
                        result = rows.into_iter().collect();
                    }
                } else {
                    // No inclusion AND no exclusion — all blocks
                    result = sqlx::query_scalar::<_, String>(
                        "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0",
                    )
                    .fetch_all(pool)
                    .await?
                    .into_iter()
                    .collect();
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
                // builds, so cap at SMALL_IN_LIMIT to be safe.
                if inner_set.len() <= SMALL_IN_LIMIT {
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

/// Recursive-CTE walk that returns every descendant (including the seed
/// roots themselves) of a list of `page_id`s, filtering out deleted /
/// conflict rows and bounding recursion depth at 100 (AGENTS.md
/// invariant #9).
///
/// Uses a positional `IN (?,?,…)` clause when `roots.len() <=
/// SMALL_IN_LIMIT`, falling back to `IN (SELECT value FROM json_each(?))`
/// for larger inputs to dodge SQLite's variable-binding ceiling. (L-84)
async fn fetch_descendants_of(
    pool: &SqlitePool,
    roots: &[String],
) -> Result<FxHashSet<String>, AppError> {
    if roots.is_empty() {
        return Ok(FxHashSet::default());
    }
    if roots.len() <= SMALL_IN_LIMIT {
        let placeholders = std::iter::repeat_n("?", roots.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "WITH RECURSIVE desc(id, depth) AS ( \
                SELECT id, 0 FROM blocks WHERE id IN ({placeholders}) AND deleted_at IS NULL AND is_conflict = 0 \
                UNION ALL \
                SELECT b.id, d.depth + 1 FROM blocks b JOIN desc d ON b.parent_id = d.id WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100 \
            ) SELECT id FROM desc"
        );
        let mut q = sqlx::query_scalar::<_, String>(&sql);
        for id in roots {
            q = q.bind(id);
        }
        Ok(q.fetch_all(pool).await?.into_iter().collect())
    } else {
        let json_ids = serde_json::to_string(&roots)?;
        let rows = sqlx::query_scalar::<_, String>(
            "WITH RECURSIVE desc(id, depth) AS ( \
                SELECT b.id, 0 FROM blocks b \
                JOIN json_each(?1) j ON j.value = b.id \
                WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
                UNION ALL \
                SELECT b.id, d.depth + 1 FROM blocks b JOIN desc d ON b.parent_id = d.id WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100 \
            ) SELECT id FROM desc",
        )
        .bind(&json_ids)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().collect())
    }
}

/// Parse an ISO 8601 date string (YYYY-MM-DD or full datetime) to Unix
/// milliseconds.  For date-only strings, treats as midnight UTC.
pub(crate) fn parse_iso_to_ms(s: &str) -> Option<u64> {
    // Try full datetime parse first (e.g. "2025-01-15T12:00:00Z")
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        // Timestamps for valid dates are always non-negative
        return Some(dt.timestamp_millis().cast_unsigned());
    }
    // Try date-only parse (e.g. "2025-01-15")
    if let Ok(date) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let dt = date.and_hms_opt(0, 0, 0)?;
        // Timestamps for valid dates are always non-negative
        return Some(dt.and_utc().timestamp_millis().cast_unsigned());
    }
    None
}
