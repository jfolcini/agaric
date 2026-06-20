//! Filter evaluation for backlink queries: recursive filter resolver,
//! LIKE-pattern escaping, ISO date parsing, and ULID timestamp utilities.

use futures_util::future::try_join_all;
use rustc_hash::FxHashSet;
use sqlx::SqlitePool;

use super::projection::BacklinkProjection;
use super::types::{BacklinkFilter, CompareOp};
use super::{FTS_ROW_CAP, SMALL_IN_LIMIT};
use crate::error::AppError;
use crate::error::validation_code::{INVALID_DATE_FILTER, prefixed};
use crate::filters::primitive::{
    DatePredicate, FilterPrimitive, Projection, PropertyPredicate, PropertyValue,
};
use crate::fts::sanitize_fts_query;
use crate::sql_utils::escape_like;
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
/// Deleted blocks are excluded at the leaf level.
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
                // Build the comparison clause dynamically so SQLite
                // filters by operator rather than materialising every row
                // with this key and filtering in Rust.  Mirrors the pattern
                // in `pagination/properties.rs::query_by_property`.
                //
                // For LIKE-based operators (`Contains` / `StartsWith`) the
                // user-supplied `value` is escaped via `escape_like` and
                // the SQL uses `ESCAPE '\'` so `%` / `_` / `\` in the user
                // input match literally.
                let (sql_op, needs_escape) = match op {
                    CompareOp::Eq => ("=", false),
                    CompareOp::Neq => ("<>", false),
                    CompareOp::Lt => ("<", false),
                    CompareOp::Gt => (">", false),
                    CompareOp::Lte => ("<=", false),
                    CompareOp::Gte => (">=", false),
                    CompareOp::Contains | CompareOp::StartsWith => ("LIKE", true),
                };
                let bind_value: String = match op {
                    CompareOp::Contains => format!("%{}%", escape_like(value)),
                    CompareOp::StartsWith => format!("{}%", escape_like(value)),
                    _ => value.clone(),
                };
                let escape_clause = if needs_escape { " ESCAPE '\\'" } else { "" };
                let sql = format!(
                    "SELECT bp.block_id \
                     FROM block_properties bp \
                     JOIN blocks b ON b.id = bp.block_id \
                     WHERE bp.key = ?1 AND bp.value_text IS NOT NULL \
                       AND bp.value_text {sql_op} ?2{escape_clause} \
                       AND b.deleted_at IS NULL"
                );
                let rows = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.as_str()))
                    .bind(key)
                    .bind(&bind_value)
                    .fetch_all(pool)
                    .await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::PropertyNum { key, op, value } => {
                // Push operator comparison into SQL so SQLite filters
                // by operator rather than materialising every row with this
                // key and filtering in Rust.  Mirrors the `PropertyText` arm
                // above.
                //
                // Behaviour note: `Eq` now uses SQL `=` rather than the prior
                // `f64::EPSILON` Rust-side check.  This matches how
                // `pagination/properties.rs::query_by_property` compares
                // numeric properties.  `Contains` / `StartsWith` are
                // meaningless for numeric values and short-circuit to an
                // empty set (matching the prior `false` filter behaviour).
                let sql_op = match op {
                    CompareOp::Eq => "=",
                    CompareOp::Neq => "<>",
                    CompareOp::Lt => "<",
                    CompareOp::Gt => ">",
                    CompareOp::Lte => "<=",
                    CompareOp::Gte => ">=",
                    CompareOp::Contains | CompareOp::StartsWith => {
                        return Ok(FxHashSet::default());
                    }
                };
                let sql = format!(
                    "SELECT bp.block_id \
                     FROM block_properties bp \
                     JOIN blocks b ON b.id = bp.block_id \
                     WHERE bp.key = ?1 AND bp.value_num IS NOT NULL \
                       AND bp.value_num {sql_op} ?2 \
                       AND b.deleted_at IS NULL"
                );
                let rows = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.as_str()))
                    .bind(key)
                    .bind(*value)
                    .fetch_all(pool)
                    .await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::PropertyDate { key, op, value } => {
                // Push operator comparison into SQL so SQLite filters
                // by operator rather than materialising every row with this
                // key and filtering in Rust.  Mirrors the `PropertyText` arm
                // above.
                //
                // SQLite string comparison is lexicographic, which on
                // ISO-8601 date strings (YYYY-MM-DD…) preserves chronological
                // order and matches the prior Rust `&str` compare semantics.
                // `Contains` / `StartsWith` use the same `escape_like` +
                // `ESCAPE '\\'` shape as `PropertyText` so `%` / `_` / `\`
                // in user input match literally.
                let (sql_op, needs_escape) = match op {
                    CompareOp::Eq => ("=", false),
                    CompareOp::Neq => ("<>", false),
                    CompareOp::Lt => ("<", false),
                    CompareOp::Gt => (">", false),
                    CompareOp::Lte => ("<=", false),
                    CompareOp::Gte => (">=", false),
                    CompareOp::Contains | CompareOp::StartsWith => ("LIKE", true),
                };
                let bind_value: String = match op {
                    CompareOp::Contains => format!("%{}%", escape_like(value)),
                    CompareOp::StartsWith => format!("{}%", escape_like(value)),
                    _ => value.clone(),
                };
                let escape_clause = if needs_escape { " ESCAPE '\\'" } else { "" };
                let sql = format!(
                    "SELECT bp.block_id \
                     FROM block_properties bp \
                     JOIN blocks b ON b.id = bp.block_id \
                     WHERE bp.key = ?1 AND bp.value_date IS NOT NULL \
                       AND bp.value_date {sql_op} ?2{escape_clause} \
                       AND b.deleted_at IS NULL"
                );
                let rows = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.as_str()))
                    .bind(key)
                    .bind(&bind_value)
                    .fetch_all(pool)
                    .await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::PropertyIsSet { key } => {
                let rows = sqlx::query_scalar::<_, String>(
                    "SELECT bp.block_id \
                     FROM block_properties bp \
                     JOIN blocks b ON b.id = bp.block_id \
                     WHERE bp.key = ?1 \
                       AND b.deleted_at IS NULL",
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
                     WHERE b.deleted_at IS NULL \
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
                    "SELECT id FROM blocks WHERE todo_state = ? AND deleted_at IS NULL",
                )
                .bind(state)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().map(|r| r.0).collect())
            }

            BacklinkFilter::Priority { level } => {
                let rows: Vec<(String,)> = sqlx::query_as(
                    "SELECT id FROM blocks WHERE priority = ? AND deleted_at IS NULL",
                )
                .bind(level)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().map(|r| r.0).collect())
            }

            BacklinkFilter::DueDate { op, value } => {
                let sql = match op {
                    CompareOp::Eq => {
                        "SELECT id FROM blocks WHERE due_date = ? AND deleted_at IS NULL"
                    }
                    CompareOp::Neq => {
                        "SELECT id FROM blocks WHERE due_date != ? AND due_date IS NOT NULL AND deleted_at IS NULL"
                    }
                    CompareOp::Lt => {
                        "SELECT id FROM blocks WHERE due_date < ? AND due_date IS NOT NULL AND deleted_at IS NULL"
                    }
                    CompareOp::Lte => {
                        "SELECT id FROM blocks WHERE due_date <= ? AND due_date IS NOT NULL AND deleted_at IS NULL"
                    }
                    CompareOp::Gt => {
                        "SELECT id FROM blocks WHERE due_date > ? AND due_date IS NOT NULL AND deleted_at IS NULL"
                    }
                    CompareOp::Gte => {
                        "SELECT id FROM blocks WHERE due_date >= ? AND due_date IS NOT NULL AND deleted_at IS NULL"
                    }
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
                // Shares leaf SQL with `tag_query::resolve_expr`
                // (inline-ref union semantics). The single source of
                // truth is `tag_query::resolve_tag_leaves`.
                let rows = resolve_tag_leaves(pool, tag_id, false).await?;
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::HasTagPrefix { prefix } => {
                // Shares leaf SQL with `tag_query::resolve_expr`
                // (inline-ref union semantics). The single source of
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
                // exclude deleted blocks.
                //
                // #672 — cap the scan at `FTS_ROW_CAP` rows, matching
                // `eval_unlinked_references`. A short common token (e.g. "the")
                // matches a large fraction of the vault; without a cap every
                // matching id is materialised into the `FxHashSet` here and
                // then into a JSON bind downstream. We fetch `FTS_ROW_CAP + 1`
                // to detect truncation, then trim to `FTS_ROW_CAP` and warn.
                let fts_sql = format!(
                    "SELECT fb.block_id \
                     FROM fts_blocks fb \
                     JOIN blocks b ON b.id = fb.block_id \
                     WHERE fts_blocks MATCH ?1 \
                       AND b.deleted_at IS NULL \
                     ORDER BY fb.block_id \
                     LIMIT {}",
                    FTS_ROW_CAP + 1
                );
                let rows = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(fts_sql.as_str()))
                    .bind(&sanitized)
                    .fetch_all(pool)
                    .await?;
                if rows.len() > FTS_ROW_CAP {
                    tracing::warn!(
                        cap = FTS_ROW_CAP,
                        "backlink Contains filter truncated: the query matched more than \
                         the FTS row cap; results limited to the first {FTS_ROW_CAP} blocks"
                    );
                    return Ok(rows.into_iter().take(FTS_ROW_CAP).collect());
                }
                Ok(rows.into_iter().collect())
            }

            BacklinkFilter::CreatedInRange { after, before } => {
                // #670 — reject an unparseable bound loudly instead of silently
                // widening the filter to "all blocks".
                let after_prefix = resolve_range_bound(after.as_ref())?;
                let before_prefix = resolve_range_bound(before.as_ref())?;

                // Build SQL with optional ULID range bounds.  ULID prefix comparison
                // works because Crockford base32 preserves sort order and SQLite
                // string comparison treats shorter strings as less-than.
                let mut sql = String::from("SELECT id FROM blocks WHERE deleted_at IS NULL");
                let mut bind_idx = 1u32;
                if after_prefix.is_some() {
                    sql.push_str(&format!(" AND id >= ?{bind_idx}"));
                    bind_idx += 1;
                }
                if before_prefix.is_some() {
                    sql.push_str(&format!(" AND id < ?{bind_idx}"));
                }

                let mut query = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.as_str()));
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
                           AND deleted_at IS NULL \
                           AND id IN (SELECT value FROM json_each(?2))",
                    )
                    .bind(block_type)
                    .bind(&json_ids)
                    .fetch_all(pool)
                    .await?;
                    return Ok(rows.into_iter().collect());
                }

                // Fallback: no candidate set — scan every active block of
                // this type.  Reached when no candidate set is in scope:
                // top-level grouped queries, or nested inside `Or`/`Not`
                // (which deliberately stay unscoped — see those arms). The
                // `And` combinator now threads the parent candidate set
                // through its conjuncts (#379), so `And { BlockType, … }`
                // takes the scoped json_each path above instead of this
                // whole-vault scan.
                let rows = sqlx::query_scalar::<_, String>(
                    "SELECT id FROM blocks \
                     WHERE block_type = ?1 AND deleted_at IS NULL",
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
                    // Above the threshold.
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
                    // Above the threshold.
                    if excluded.len() <= SMALL_IN_LIMIT {
                        let placeholders = std::iter::repeat_n("?", excluded.len())
                            .collect::<Vec<_>>()
                            .join(",");
                        let sql = format!(
                            "SELECT id FROM blocks WHERE deleted_at IS NULL \
                             AND id NOT IN ( \
                               WITH RECURSIVE desc(id, depth) AS ( \
                                 SELECT id, 0 FROM blocks WHERE id IN ({placeholders}) AND deleted_at IS NULL \
                                 UNION ALL \
                                 SELECT b.id, d.depth + 1 FROM blocks b JOIN desc d ON b.parent_id = d.id WHERE b.deleted_at IS NULL AND d.depth < 100 \
                               ) SELECT id FROM desc \
                             )"
                        );
                        let mut q =
                            sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.as_str()));
                        for id in excluded {
                            q = q.bind(id);
                        }
                        result = q.fetch_all(pool).await?.into_iter().collect();
                    } else {
                        let json_ids = serde_json::to_string(&excluded)?;
                        let rows = sqlx::query_scalar::<_, String>(
                            "SELECT id FROM blocks WHERE deleted_at IS NULL \
                             AND id NOT IN ( \
                               WITH RECURSIVE desc(id, depth) AS ( \
                                 SELECT value AS id, 0 AS depth FROM json_each(?1) \
                                 UNION ALL \
                                 SELECT b.id, d.depth + 1 FROM blocks b JOIN desc d ON b.parent_id = d.id WHERE b.deleted_at IS NULL AND d.depth < 100 \
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
                        "SELECT id FROM blocks WHERE deleted_at IS NULL",
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
                // #379: thread the parent candidate set through every
                // conjunct. `And` is a set INTERSECTION, and the final
                // result is a subset of every conjunct — so scoping each
                // conjunct to `candidates` only drops ids that the
                // intersection (and, for the top-level caller, the outer
                // intersection against `candidates`) would drop anyway.
                // This is provably behaviour-preserving while letting
                // candidate-aware leaves (e.g. `BlockType`,
                // `PropertyIsEmpty`) scope their SQL to the candidate set
                // via `json_each` instead of scanning the whole vault and
                // discarding the surplus in Rust.
                //
                // Resolve all sub-filters concurrently (#319) instead of
                // sequentially, turning N serial DB round-trips into N
                // concurrent ones.
                let futures = filters
                    .iter()
                    .map(|f| resolve_filter_with_candidates(pool, f, depth + 1, candidates));
                let results = try_join_all(futures).await?;
                let mut iter = results.into_iter();
                let mut result = iter.next().unwrap();
                for set in iter {
                    result.retain(|id| set.contains(id));
                }
                Ok(result)
            }

            BacklinkFilter::Or { filters } => {
                // #379: `Or` is a set UNION, NOT an intersection. Scoping a
                // disjunct to `candidates` would WRONGLY drop matches that
                // lie outside `candidates` but should still appear in the
                // union (the union may legitimately exceed `candidates`,
                // and the parent And/intersection — if any — has not yet
                // been applied at this point). So we deliberately resolve
                // disjuncts UNSCOPED via the no-candidate `resolve_filter`
                // wrapper. Correctness is preserved; only perf is left on
                // the table for `Or` subtrees.
                //
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
                // #379: `Not` is a set COMPLEMENT over all non-deleted
                // blocks. Scoping the INNER filter to `candidates` would
                // shrink the set being complemented, which inverts to a
                // LARGER (wrong) complement. The complement itself must
                // also range over the whole vault, not `candidates`. So the
                // inner filter is resolved UNSCOPED. Correctness is
                // preserved; only perf is left on the table for `Not`.
                let inner_set = resolve_filter(pool, filter, depth + 1).await?;

                if inner_set.is_empty() {
                    // Not of empty set = all non-deleted blocks
                    let rows = sqlx::query_scalar::<_, String>(
                        "SELECT id FROM blocks WHERE deleted_at IS NULL",
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
                        "SELECT id FROM blocks WHERE deleted_at IS NULL \
                         AND id NOT IN ({placeholders})"
                    );
                    let mut query =
                        sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.as_str()));
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
                    "SELECT id FROM blocks WHERE deleted_at IS NULL \
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

// ---------------------------------------------------------------------------
// #346 P1: compile BacklinkFilter -> correlated SQL WHERE fragment
// ---------------------------------------------------------------------------

/// A single positional bind value for a compiled backlink filter fragment.
///
/// Mirrors the `filters::primitive::Bind` shape but only carries the two
/// scalar kinds the backlink leaves emit: text (ids, property text/date
/// values, LIKE patterns, JSON-array set bindings) and `f64` (numeric
/// property values). The `f64` variant exists so that `PropertyNum`'s value
/// keeps its native SQLite affinity rather than being stringified.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum FilterBind {
    Text(String),
    Num(f64),
}

/// A compiled boolean SQL fragment for a `BacklinkFilter` subtree, plus the
/// ordered positional binds it consumes.
///
/// The fragment is written against the OUTER query's source-block alias
/// `b` (e.g. `EXISTS (SELECT 1 FROM block_properties bp WHERE bp.block_id =
/// b.id …)` / `b.block_type = ?`). The outer query already enforces
/// `b.deleted_at IS NULL` and self-exclusion, so leaf fragments deliberately
/// do NOT re-filter those on `b` — matching the per-leaf semantics of
/// `resolve_filter_with_candidates` while avoiding a redundant predicate.
///
/// `sql` uses bare `?` placeholders (NOT `?N`) so the fragment can be
/// spliced into a larger `QueryBuilder` statement where the surrounding
/// base-query binds interleave with the fragment binds positionally.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CompiledFilter {
    pub sql: String,
    pub binds: Vec<FilterBind>,
}

impl CompiledFilter {
    /// A fragment that always evaluates false (empty-set leaf): empty FTS
    /// query, empty embedded id set, or a numeric `Contains`/`StartsWith`.
    fn never() -> Self {
        Self {
            sql: "1=0".to_string(),
            binds: Vec::new(),
        }
    }
}

/// Embed a pre-resolved id set as a correlated `b.id IN (SELECT value FROM
/// json_each(?))` membership test (or `1=0` when the set is empty).
///
/// Used by the hybrid leaves (`Contains`/`HasTag`/`HasTagPrefix`/
/// `SourcePage`) which are resolved ONCE via the existing helpers and then
/// embedded as a set — they must never be correlated per outer row (each
/// would re-run an FTS scan / tag union / recursive descendant walk).
fn membership_fragment(ids: &FxHashSet<String>) -> Result<CompiledFilter, AppError> {
    if ids.is_empty() {
        return Ok(CompiledFilter::never());
    }
    let json = serde_json::to_string(&ids.iter().collect::<Vec<_>>())?;
    Ok(CompiledFilter {
        sql: "b.id IN (SELECT value FROM json_each(?))".to_string(),
        binds: vec![FilterBind::Text(json)],
    })
}

/// #1280 — which typed `PropertyValue` to wrap a backlink property leaf's
/// value in when routing through the projection.
#[derive(Clone, Copy)]
enum PropValueKind {
    Text,
    Date,
}

/// #1280 — map a backlink `CompareOp` + typed `PropertyValue` to the shared
/// [`PropertyPredicate`] the projection compiles. The numeric short-circuit
/// (`Contains`/`StartsWith` on `Num` → `1=0`) is handled inside the
/// projection's `compile_has_property`, so this is a total mapping.
fn property_predicate(op: &CompareOp, value: PropertyValue) -> PropertyPredicate {
    match op {
        CompareOp::Eq => PropertyPredicate::Eq { value },
        CompareOp::Neq => PropertyPredicate::Ne { value },
        CompareOp::Lt => PropertyPredicate::Lt { value },
        CompareOp::Gt => PropertyPredicate::Gt { value },
        CompareOp::Lte => PropertyPredicate::Lte { value },
        CompareOp::Gte => PropertyPredicate::Gte { value },
        CompareOp::Contains => PropertyPredicate::Contains { value },
        CompareOp::StartsWith => PropertyPredicate::StartsWith { value },
    }
}

/// #1280 — compile a `has-property` predicate through the projection and
/// convert the result to a backlink [`CompiledFilter`].
fn route_has_property(key: &str, predicate: &PropertyPredicate) -> CompiledFilter {
    BacklinkProjection::to_compiled(BacklinkProjection.compile(&FilterPrimitive::HasProperty {
        key: key.to_string(),
        predicate: predicate.clone(),
    }))
}

/// #1280 — route a text/date property leaf (the `Text`/`Date`-valued
/// backlink property filters) through the projection.
fn route_property(
    key: &str,
    op: &CompareOp,
    value: String,
    kind: PropValueKind,
) -> Result<CompiledFilter, AppError> {
    let pv = match kind {
        PropValueKind::Text => PropertyValue::Text { value },
        PropValueKind::Date => PropertyValue::Date { value },
    };
    let pred = property_predicate(op, pv);
    Ok(route_has_property(key, &pred))
}

/// #1280 — map a comparison `CompareOp` (NOT `Neq`/`Contains`/`StartsWith`)
/// to the projection's [`DatePredicate`] for the `DueDate` leaf. `Eq → On`
/// (exact, matching the legacy DATE-exact `= ?`), `Lt → Before`,
/// `Lte → OnOrBefore`, `Gt → After`, `Gte → OnOrAfter`. Returns `None` for
/// the unsupported ops (the caller handles `Neq` inline + rejects the rest).
fn compare_op_to_date_predicate(op: &CompareOp, value: &str) -> Option<DatePredicate> {
    let date = value.to_string();
    match op {
        CompareOp::Eq => Some(DatePredicate::On { date }),
        CompareOp::Lt => Some(DatePredicate::Before { date }),
        CompareOp::Lte => Some(DatePredicate::OnOrBefore { date }),
        CompareOp::Gt => Some(DatePredicate::After { date }),
        CompareOp::Gte => Some(DatePredicate::OnOrAfter { date }),
        CompareOp::Neq | CompareOp::Contains | CompareOp::StartsWith => None,
    }
}

/// Compile a [`BacklinkFilter`] subtree into a correlated boolean SQL
/// fragment (against outer alias `b`) plus its ordered positional binds
/// (#346 P1).
///
/// This is the SQL-pushdown counterpart to [`resolve_filter`]: instead of
/// materialising each leaf to an `FxHashSet` and intersecting in Rust (which
/// for negative/broad leaves forces the whole-vault complement into memory),
/// every leaf becomes an `EXISTS`/column-compare/`IN (json_each)` fragment
/// that SQLite evaluates row-by-row in the outer backlink query.
///
/// **Parity contract:** each leaf fragment reproduces the EXACT operator,
/// `ESCAPE`, `IS NOT NULL` guard, and value-mangling of the corresponding
/// `resolve_filter_with_candidates` arm. The old path is retained as the
/// parity oracle (see `backlink::tests`).
///
/// **Hybrid leaves** (`Contains`, `HasTag`, `HasTagPrefix`, `SourcePage`) are
/// resolved once via the existing helpers and embedded as a `json_each` id
/// set rather than correlated per row — recursion / FTS / tag scans must not
/// run once per candidate source block.
pub(crate) fn compile_backlink_filter<'a>(
    pool: &'a SqlitePool,
    filter: &'a BacklinkFilter,
    depth: u32,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<CompiledFilter, AppError>> + Send + 'a>,
> {
    Box::pin(async move {
        if depth > 50 {
            return Err(AppError::Validation(
                "Filter nesting depth exceeds 50".into(),
            ));
        }
        match filter {
            // ── Routed leaves (#1280) — compiled via `BacklinkProjection`
            // through the shared `Projection` engine. Each produces SQL +
            // binds BYTE-IDENTICAL to the legacy inline arm (proven by the
            // `projection` byte-identity tests + the parity battery oracle).
            BacklinkFilter::PropertyText { key, op, value } => {
                route_property(key, op, value.clone(), PropValueKind::Text)
            }

            BacklinkFilter::PropertyNum { key, op, value } => {
                // `Contains`/`StartsWith` on a numeric value short-circuit to
                // the empty set (the projection emits `1=0`); the projection
                // handles this internally.
                let pred = property_predicate(op, PropertyValue::Num { value: *value });
                Ok(route_has_property(key, &pred))
            }

            BacklinkFilter::PropertyDate { key, op, value } => {
                route_property(key, op, value.clone(), PropValueKind::Date)
            }

            BacklinkFilter::PropertyIsSet { key } => {
                Ok(route_has_property(key, &PropertyPredicate::Exists))
            }

            BacklinkFilter::PropertyIsEmpty { key } => {
                Ok(route_has_property(key, &PropertyPredicate::NotExists))
            }

            BacklinkFilter::TodoState { state } => {
                let prim = FilterPrimitive::State {
                    values: vec![state.clone()],
                    is_null: false,
                    exclude: false,
                };
                Ok(BacklinkProjection::to_compiled(
                    BacklinkProjection.compile(&prim),
                ))
            }

            BacklinkFilter::Priority { level } => {
                let prim = FilterPrimitive::Priority {
                    priority: level.clone(),
                };
                Ok(BacklinkProjection::to_compiled(
                    BacklinkProjection.compile(&prim),
                ))
            }

            BacklinkFilter::DueDate { op, value } => {
                // `Eq`/`Lt`/`Gt`/`Lte`/`Gte` route through the projection's
                // `DatePredicate`. `Neq` has NO `DatePredicate` counterpart
                // (the vocabulary is `On/Before/After/OnOrBefore/OnOrAfter/
                // Between/IsNull`), so it stays inline — byte-identical to the
                // legacy `(b.due_date != ? AND b.due_date IS NOT NULL)`.
                // `Contains`/`StartsWith` keep the legacy loud rejection.
                match op {
                    CompareOp::Neq => Ok(CompiledFilter {
                        sql: "(b.due_date != ? AND b.due_date IS NOT NULL)".to_string(),
                        binds: vec![FilterBind::Text(value.clone())],
                    }),
                    CompareOp::Contains | CompareOp::StartsWith => Err(AppError::Validation(
                        format!("DueDate filter does not support {op:?} operator"),
                    )),
                    _ => {
                        let predicate =
                            compare_op_to_date_predicate(op, value).ok_or_else(|| {
                                AppError::Validation(format!(
                                    "DueDate filter does not support {op:?} operator"
                                ))
                            })?;
                        let prim = FilterPrimitive::DueDate { predicate };
                        Ok(BacklinkProjection::to_compiled(
                            BacklinkProjection.compile(&prim),
                        ))
                    }
                }
            }

            BacklinkFilter::CreatedInRange { after, before } => {
                // #670 — keep the loud rejection here so the resolver path and
                // the compiled path agree on validity BEFORE routing (the
                // projection itself treats an unparseable bound as absent).
                resolve_range_bound(after.as_ref())?;
                resolve_range_bound(before.as_ref())?;
                let prim = FilterPrimitive::Created {
                    after: after.clone(),
                    before: before.clone(),
                };
                Ok(BacklinkProjection::to_compiled(
                    BacklinkProjection.compile(&prim),
                ))
            }

            BacklinkFilter::BlockType { block_type } => {
                let prim = FilterPrimitive::BlockType {
                    values: vec![block_type.clone()],
                    exclude: false,
                };
                Ok(BacklinkProjection::to_compiled(
                    BacklinkProjection.compile(&prim),
                ))
            }

            // ── Hybrid leaves: pre-resolve once, embed as a json_each set ──
            BacklinkFilter::Contains { query } => {
                // Empty / whitespace-only / sanitizes-to-empty ⇒ empty set,
                // matching the resolver's early returns.
                if query.trim().is_empty() {
                    return Ok(CompiledFilter::never());
                }
                let sanitized = sanitize_fts_query(query);
                if sanitized.is_empty() {
                    return Ok(CompiledFilter::never());
                }
                let ids = resolve_filter(pool, filter, depth).await?;
                membership_fragment(&ids)
            }

            BacklinkFilter::HasTag { .. }
            | BacklinkFilter::HasTagPrefix { .. }
            | BacklinkFilter::SourcePage { .. } => {
                let ids = resolve_filter(pool, filter, depth).await?;
                membership_fragment(&ids)
            }

            // ── Boolean combinators ──
            BacklinkFilter::And { filters } => {
                // Preserve the resolver's empty-And semantics: it returns the
                // empty set (`1=0`), NOT the neutral "all" element.
                if filters.is_empty() {
                    return Ok(CompiledFilter::never());
                }
                let compiled = try_join_all(
                    filters
                        .iter()
                        .map(|f| compile_backlink_filter(pool, f, depth + 1)),
                )
                .await?;
                let mut binds = Vec::new();
                let parts: Vec<String> = compiled
                    .into_iter()
                    .map(|c| {
                        binds.extend(c.binds);
                        c.sql
                    })
                    .collect();
                Ok(CompiledFilter {
                    sql: format!("({})", parts.join(" AND ")),
                    binds,
                })
            }

            BacklinkFilter::Or { filters } => {
                // Resolver's empty-Or returns the empty set (the fold starts
                // from an empty accumulator and never unions anything), so an
                // empty `Or` is `1=0`, NOT `1=1`.
                if filters.is_empty() {
                    return Ok(CompiledFilter::never());
                }
                let compiled = try_join_all(
                    filters
                        .iter()
                        .map(|f| compile_backlink_filter(pool, f, depth + 1)),
                )
                .await?;
                let mut binds = Vec::new();
                let parts: Vec<String> = compiled
                    .into_iter()
                    .map(|c| {
                        binds.extend(c.binds);
                        c.sql
                    })
                    .collect();
                Ok(CompiledFilter {
                    sql: format!("({})", parts.join(" OR ")),
                    binds,
                })
            }

            BacklinkFilter::Not { filter: inner } => {
                // Three-valued-logic guard: the resolver's `Not` computes the
                // set complement over all non-deleted blocks, treating a leaf
                // that "doesn't apply" (e.g. `b.priority = ?` on a row whose
                // `priority` is NULL) as simply NOT matching the positive
                // filter — so it lands IN the complement. Raw SQL `NOT (…)`
                // does NOT: `b.priority = 'low'` is NULL on a NULL column,
                // and `NOT NULL` is NULL (treated as false in WHERE), which
                // would WRONGLY drop that row from the negation. Collapsing
                // the inner fragment with `COALESCE(…, 0)` forces NULL → false
                // BEFORE negating, so `NOT` yields true and the row joins the
                // complement — exactly matching the Rust set-difference. For
                // `EXISTS`/`NOT EXISTS`/boolean-combinator fragments (never
                // NULL) the COALESCE is a harmless no-op.
                let compiled = compile_backlink_filter(pool, inner, depth + 1).await?;
                Ok(CompiledFilter {
                    sql: format!("NOT COALESCE(({}), 0)", compiled.sql),
                    binds: compiled.binds,
                })
            }
        }
    })
}

/// Recursive-CTE walk that returns every descendant (including the seed
/// roots themselves) of a list of `page_id`s, filtering out deleted
/// rows and bounding recursion depth at 100 (AGENTS.md
/// invariant #9).
///
/// Uses a positional `IN (?,?,…)` clause when `roots.len() <=
/// SMALL_IN_LIMIT`, falling back to `IN (SELECT value FROM json_each(?))`
/// For larger inputs to dodge SQLite's variable-binding ceiling.
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
                SELECT id, 0 FROM blocks WHERE id IN ({placeholders}) AND deleted_at IS NULL \
                UNION ALL \
                SELECT b.id, d.depth + 1 FROM blocks b JOIN desc d ON b.parent_id = d.id WHERE b.deleted_at IS NULL AND d.depth < 100 \
            ) SELECT id FROM desc"
        );
        let mut q = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.as_str()));
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
                WHERE b.deleted_at IS NULL \
                UNION ALL \
                SELECT b.id, d.depth + 1 FROM blocks b JOIN desc d ON b.parent_id = d.id WHERE b.deleted_at IS NULL AND d.depth < 100 \
            ) SELECT id FROM desc",
        )
        .bind(&json_ids)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().collect())
    }
}

/// Resolve an optional `CreatedInRange` bound into an optional ULID prefix,
/// rejecting a present-but-unparseable bound loudly.
///
/// #670 — the old `bound.as_ref().and_then(parse_iso_to_ms).map(...)` chain
/// silently swallowed a malformed bound (`and_then` → `None`), degrading the
/// range filter to "all blocks" — the opposite of the user's intent. The
/// metadata date filter (`fts/metadata_filter.rs`) already rejects the same
/// input loudly with an `InvalidDateFilter:` validation error; this mirrors
/// that contract. `None` (bound absent) stays `Ok(None)`; only a present,
/// non-parseable string is an error.
fn resolve_range_bound(bound: Option<&String>) -> Result<Option<String>, AppError> {
    match bound {
        None => Ok(None),
        Some(raw) => match parse_iso_to_ms(raw) {
            Some(ms) => Ok(Some(ms_to_ulid_prefix(ms))),
            None => Err(AppError::Validation(prefixed(
                INVALID_DATE_FILTER,
                &format!("expected ISO 8601 date (YYYY-MM-DD or RFC 3339), got '{raw}'"),
            ))),
        },
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
