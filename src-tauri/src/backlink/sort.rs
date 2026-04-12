//! Sorting utilities for backlink queries: sort block ID sets by creation
//! time or by text/numeric/date property values.

use rustc_hash::FxHashSet;
use sqlx::SqlitePool;

use super::types::{BacklinkSort, SortDir};
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

    let id_vec: Vec<&str> = ids.iter().map(String::as_str).collect();
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

    let id_vec: Vec<&str> = ids.iter().map(String::as_str).collect();
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

    let id_vec: Vec<&str> = ids.iter().map(String::as_str).collect();
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
