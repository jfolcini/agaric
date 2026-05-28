//! Sorting utilities for backlink queries: sort block ID sets by creation
//! time or by text/numeric/date property values.
//!
//! Property-value sorts are pushed entirely into SQL (issue #112 sub-item
//! 1): the database returns the IDs already ordered by
//! `value_{text,num,date} [ASC|DESC] NULLS LAST, b.id ASC`, eliminating
//! the prior fetch-into-`FxHashMap` + Rust comparator dance. Pinning the
//! tiebreaker on `b.id` keeps cursor pagination (which walks the sorted
//! list looking for the cursor ID) deterministic across runs.

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

        BacklinkSort::PropertyText { key, dir } => {
            sort_by_property_column(pool, ids, key, dir, "value_text").await
        }

        BacklinkSort::PropertyNum { key, dir } => {
            sort_by_property_column(pool, ids, key, dir, "value_num").await
        }

        BacklinkSort::PropertyDate { key, dir } => {
            sort_by_property_column(pool, ids, key, dir, "value_date").await
        }
    }
}

/// SQL-side property sort. The query joins the candidate ID set against
/// `block_properties(key = ?)` and orders by the requested column with
/// `NULLS LAST`; rows that share a value (or both lack the property)
/// fall back to ascending `b.id` so the output is fully deterministic.
///
/// `column` is a static `&'static str` (`"value_text"` / `"value_num"`
/// / `"value_date"`) chosen by the caller — never user input — so
/// splicing it into the SQL string is safe. Same goes for the
/// `ASC`/`DESC` direction.
async fn sort_by_property_column(
    pool: &SqlitePool,
    ids: &FxHashSet<String>,
    key: &str,
    dir: &SortDir,
    column: &'static str,
) -> Result<Vec<String>, AppError> {
    if ids.is_empty() {
        return Ok(vec![]);
    }

    let direction = match dir {
        SortDir::Asc => "ASC",
        SortDir::Desc => "DESC",
    };

    // Pack the candidate IDs into a single JSON-array bind and let
    // SQLite expand them via `json_each`. This sidesteps the
    // `SQLITE_MAX_VARIABLE_NUMBER` ceiling regardless of set size, so
    // there's no need for the small/large split that the per-column
    // fetchers used to keep.
    let id_vec: Vec<&str> = ids.iter().map(String::as_str).collect();
    let json_ids = serde_json::to_string(&id_vec)?;

    let sql = format!(
        "SELECT b.id \
         FROM blocks b \
         LEFT JOIN block_properties bp \
           ON bp.block_id = b.id AND bp.key = ? \
         WHERE b.id IN (SELECT value FROM json_each(?)) \
         ORDER BY bp.{column} {direction} NULLS LAST, b.id ASC"
    );

    let rows: Vec<(String,)> = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(key)
        .bind(&json_ids)
        .fetch_all(pool)
        .await?;

    Ok(rows.into_iter().map(|(id,)| id).collect())
}
