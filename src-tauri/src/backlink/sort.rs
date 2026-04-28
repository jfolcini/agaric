//! Sorting utilities for backlink queries: sort block ID sets by creation
//! time or by text/numeric/date property values.

use rustc_hash::FxHashSet;
use sqlx::SqlitePool;
use std::cmp::Ordering;
use std::collections::HashMap;

use super::types::{BacklinkSort, SortDir};
use super::SMALL_IN_LIMIT;
use crate::error::AppError;

/// Sort a set of block IDs according to the given sort mode.
///
/// Returns a Vec in sorted order.
pub(crate) async fn sort_ids(
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

        BacklinkSort::PropertyText { key, dir } => {
            if ids.is_empty() {
                return Ok(vec![]);
            }
            let id_vec: Vec<&str> = ids.iter().map(String::as_str).collect();
            let prop_map = fetch_text_props_for_ids(pool, key, &id_vec).await?;
            Ok(sort_with_property_map(ids, dir, &prop_map))
        }

        BacklinkSort::PropertyNum { key, dir } => {
            if ids.is_empty() {
                return Ok(vec![]);
            }
            let id_vec: Vec<&str> = ids.iter().map(String::as_str).collect();
            let prop_map = fetch_num_props_for_ids(pool, key, &id_vec).await?;
            Ok(sort_with_property_map(ids, dir, &prop_map))
        }

        BacklinkSort::PropertyDate { key, dir } => {
            if ids.is_empty() {
                return Ok(vec![]);
            }
            let id_vec: Vec<&str> = ids.iter().map(String::as_str).collect();
            let prop_map = fetch_date_props_for_ids(pool, key, &id_vec).await?;
            Ok(sort_with_property_map(ids, dir, &prop_map))
        }
    }
}

// ---------------------------------------------------------------------------
// Generic comparator (MAINT-148d)
// ---------------------------------------------------------------------------

/// Sort `ids` by the values in `prop_map` (`block_id → Option<V>`),
/// generic over the value type `V: PartialOrd`.
///
/// All three former `sort_by_property_{text,num,date}` helpers shared the
/// same comparator shape:
///
/// 1. Some-before-None ordering (blocks without the property sink to the
///    end), and
/// 2. fall back on lexicographic block-id order whenever values tie or
///    both sides lack the property.
///
/// The fetch step (`fetch_*_props_for_ids`) varies by `value_text` /
/// `value_num` / `value_date` and stays per-column, but the comparator
/// itself is column-agnostic and lives here under a single roof —
/// future tweaks (e.g. the H-21 deterministic-tiebreaker fix) edit one
/// site instead of three.
fn sort_with_property_map<V>(
    ids: &FxHashSet<String>,
    dir: &SortDir,
    prop_map: &HashMap<String, Option<V>>,
) -> Vec<String>
where
    V: PartialOrd,
{
    let mut sorted: Vec<String> = ids.iter().cloned().collect();
    sorted.sort_by(|a, b| {
        let va = prop_map.get(a.as_str()).and_then(Option::as_ref);
        let vb = prop_map.get(b.as_str()).and_then(Option::as_ref);
        match (va, vb) {
            (Some(va), Some(vb)) => {
                let directed = match dir {
                    SortDir::Asc => va.partial_cmp(vb).unwrap_or(Ordering::Equal),
                    SortDir::Desc => vb.partial_cmp(va).unwrap_or(Ordering::Equal),
                };
                directed.then_with(|| a.cmp(b))
            }
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => a.cmp(b),
        }
    });
    sorted
}

// ---------------------------------------------------------------------------
// Per-column fetchers
// ---------------------------------------------------------------------------

/// Fetch text property values for a set of block IDs.
/// Uses bind-parameter IN clause for ≤`SMALL_IN_LIMIT` IDs, `json_each` for larger sets.
async fn fetch_text_props_for_ids(
    pool: &SqlitePool,
    key: &str,
    ids: &[&str],
) -> Result<HashMap<String, Option<String>>, AppError> {
    if ids.len() <= SMALL_IN_LIMIT {
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

/// Fetch numeric property values for a set of block IDs.
/// Uses bind-parameter IN clause for ≤`SMALL_IN_LIMIT` IDs, `json_each` for larger sets.
async fn fetch_num_props_for_ids(
    pool: &SqlitePool,
    key: &str,
    ids: &[&str],
) -> Result<HashMap<String, Option<f64>>, AppError> {
    if ids.len() <= SMALL_IN_LIMIT {
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

/// Fetch date property values for a set of block IDs.
/// Uses bind-parameter IN clause for ≤`SMALL_IN_LIMIT` IDs, `json_each` for larger sets.
async fn fetch_date_props_for_ids(
    pool: &SqlitePool,
    key: &str,
    ids: &[&str],
) -> Result<HashMap<String, Option<String>>, AppError> {
    if ids.len() <= SMALL_IN_LIMIT {
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
