//! Agenda command handlers.

use std::collections::HashMap;

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::ReadPool;
use crate::error::AppError;
use crate::pagination::ProjectedAgendaEntry;

use super::*;

/// Count agenda items per date for a batch of dates in a single query.
///
/// Returns a `HashMap<date, count>` for dates that have at least one matching
/// agenda entry whose owning block is not soft-deleted.
///
/// # Errors
///
/// - [`AppError::Validation`] — any date fails `YYYY-MM-DD` validation
#[instrument(skip(pool, dates), err)]
pub async fn count_agenda_batch_inner(
    pool: &SqlitePool,
    dates: Vec<String>,
) -> Result<HashMap<String, usize>, AppError> {
    if dates.is_empty() {
        return Ok(HashMap::new());
    }
    // Validate all dates
    for d in &dates {
        validate_date_format(d)?;
    }
    // Build IN clause with bind parameters
    let placeholders: String = dates
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT ac.date, COUNT(*) as cnt \
         FROM agenda_cache ac \
         JOIN blocks b ON b.id = ac.block_id \
         WHERE ac.date IN ({placeholders}) \
           AND b.deleted_at IS NULL \
         GROUP BY ac.date"
    );
    let mut query = sqlx::query_as::<_, (String, i64)>(&sql);
    for d in &dates {
        query = query.bind(d);
    }
    let rows = query.fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        // cnt is a non-negative count from SQL; safe to convert
        .map(|(date, cnt)| (date, usize::try_from(cnt).unwrap_or(0)))
        .collect())
}

/// Count agenda items per (date, source) for a batch of dates.
///
/// Returns a nested map: `date -> source -> count`. Only includes entries
/// whose owning block is not soft-deleted.
///
/// # Errors
///
/// - [`AppError::Validation`] — any date fails `YYYY-MM-DD` validation
#[instrument(skip(pool, dates), err)]
pub async fn count_agenda_batch_by_source_inner(
    pool: &SqlitePool,
    dates: Vec<String>,
) -> Result<HashMap<String, HashMap<String, usize>>, AppError> {
    if dates.is_empty() {
        return Ok(HashMap::new());
    }
    for d in &dates {
        validate_date_format(d)?;
    }
    let dates_json = serde_json::to_string(&dates)?;
    let sql = "SELECT ac.date, ac.source, COUNT(*) as cnt \
         FROM agenda_cache ac \
         JOIN blocks b ON b.id = ac.block_id \
         WHERE ac.date IN (SELECT value FROM json_each(?1)) \
           AND b.deleted_at IS NULL \
         GROUP BY ac.date, ac.source";
    let rows = sqlx::query_as::<_, (String, String, i64)>(sql)
        .bind(dates_json)
        .fetch_all(pool)
        .await?;
    let mut result: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for (date, source, cnt) in rows {
        // cnt is a non-negative count from SQL; safe to convert
        result
            .entry(date)
            .or_default()
            .insert(source, usize::try_from(cnt).unwrap_or(0));
    }
    Ok(result)
}

/// Compute projected future agenda entries for repeating tasks.
///
/// First tries the `projected_agenda_cache` table (populated by the background
/// materializer). If the cache is empty, falls back to the original on-the-fly
/// computation for first-run or pre-cache scenarios.
///
/// Returns at most `limit` entries (default 200, max 500).
#[instrument(skip(pool), err)]
pub async fn list_projected_agenda_inner(
    pool: &SqlitePool,
    start_date: String,
    end_date: String,
    limit: Option<i64>,
) -> Result<Vec<ProjectedAgendaEntry>, AppError> {
    validate_date_format(&start_date)?;
    validate_date_format(&end_date)?;

    // limit is clamped to [1, 500], always positive; safe to convert
    let cap = usize::try_from(limit.unwrap_or(200).clamp(1, 500)).unwrap_or(200);

    // Parse date range boundaries
    let range_start = chrono::NaiveDate::parse_from_str(&start_date, "%Y-%m-%d")
        .map_err(|_| AppError::Validation("invalid start_date".into()))?;
    let range_end = chrono::NaiveDate::parse_from_str(&end_date, "%Y-%m-%d")
        .map_err(|_| AppError::Validation("invalid end_date".into()))?;

    if range_start > range_end {
        return Err(AppError::Validation(
            "start_date must be <= end_date".into(),
        ));
    }

    // Try cache first — a single query replaces the O(n*m) projection loop.
    // cap is at most 500; fits in i64
    #[allow(clippy::cast_possible_wrap)]
    let cache_limit = cap as i64;
    #[allow(clippy::type_complexity)]
    let cached: Vec<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        bool,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT pac.block_id, pac.projected_date, pac.source,
                b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict, b.conflict_type,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id
         FROM projected_agenda_cache pac
         JOIN blocks b ON b.id = pac.block_id
         WHERE pac.projected_date >= ?1
           AND pac.projected_date <= ?2
           AND b.deleted_at IS NULL
           AND b.is_conflict = 0
           AND NOT EXISTS (
               SELECT 1 FROM block_properties tp
               WHERE tp.block_id = b.page_id AND tp.key = 'template'
           )
         ORDER BY pac.projected_date ASC
         LIMIT ?3",
    )
    .bind(&start_date)
    .bind(&end_date)
    .bind(cache_limit)
    .fetch_all(pool)
    .await?;

    if !cached.is_empty() {
        let entries: Vec<ProjectedAgendaEntry> = cached
            .into_iter()
            .map(|row| {
                use crate::pagination::BlockRow;
                ProjectedAgendaEntry {
                    block: BlockRow {
                        id: row.3,
                        block_type: row.4,
                        content: row.5,
                        parent_id: row.6,
                        position: row.7,
                        deleted_at: row.8,
                        is_conflict: row.9,
                        conflict_type: row.10,
                        todo_state: row.11,
                        priority: row.12,
                        due_date: row.13,
                        scheduled_date: row.14,
                        page_id: row.15,
                    },
                    projected_date: row.1,
                    source: row.2,
                }
            })
            .collect();
        return Ok(entries);
    }

    // Fallback: on-the-fly computation (first run before cache is populated).
    list_projected_agenda_on_the_fly(pool, range_start, range_end, cap).await
}

/// On-the-fly projection of repeating tasks (original algorithm).
///
/// Used as a fallback when `projected_agenda_cache` is empty (e.g. first boot
/// before the materializer has populated the cache).
async fn list_projected_agenda_on_the_fly(
    pool: &SqlitePool,
    range_start: chrono::NaiveDate,
    range_end: chrono::NaiveDate,
    cap: usize,
) -> Result<Vec<ProjectedAgendaEntry>, AppError> {
    // Find repeating blocks: non-DONE, non-deleted, has repeat property,
    // has at least one date column.
    // LEFT JOINs fetch repeat-until / repeat-count / repeat-seq in the same
    // round-trip, eliminating per-block N+1 queries.
    //
    // Template-page filter (FEAT-5a, spec line 812): blocks whose owning
    // page has a `template` property are excluded so template scaffolding
    // never surfaces in agenda / Google Calendar results.  `b.page_id`
    // is the denormalised root-page column (migration 0027).
    let rows = sqlx::query_as!(
        RepeatingBlockRow,
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at, b.is_conflict as "is_conflict: bool",
                b.conflict_type, b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id,
                bp.value_text AS repeat_rule,
                bp_until.value_date AS repeat_until,
                bp_count.value_num AS repeat_count,
                bp_seq.value_num AS repeat_seq
         FROM blocks b
         JOIN block_properties bp ON bp.block_id = b.id AND bp.key = 'repeat'
         LEFT JOIN block_properties bp_until ON bp_until.block_id = b.id AND bp_until.key = 'repeat-until'
         LEFT JOIN block_properties bp_count ON bp_count.block_id = b.id AND bp_count.key = 'repeat-count'
         LEFT JOIN block_properties bp_seq ON bp_seq.block_id = b.id AND bp_seq.key = 'repeat-seq'
         WHERE b.deleted_at IS NULL
           AND b.is_conflict = 0
           AND (b.todo_state IS NULL OR b.todo_state != 'DONE')
           AND bp.value_text IS NOT NULL
           AND (b.due_date IS NOT NULL OR b.scheduled_date IS NOT NULL)
           AND NOT EXISTS (
               SELECT 1 FROM block_properties tp
               WHERE tp.block_id = b.page_id AND tp.key = 'template'
           )"#,
    )
    .fetch_all(pool)
    .await?;

    let mut entries: Vec<ProjectedAgendaEntry> = Vec::new();

    for block in &rows {
        if entries.len() >= cap {
            break;
        }

        // Get the repeat rule (pre-fetched via JOIN)
        let rule = match &block.repeat_rule {
            Some(r) if !r.is_empty() => r.clone(),
            _ => continue,
        };

        // Get end conditions (pre-fetched via LEFT JOINs)
        let repeat_until = block.repeat_until.clone();
        let repeat_count = block.repeat_count;
        let repeat_seq = block.repeat_seq;

        let until_date = repeat_until
            .as_deref()
            .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());

        // repeat_count and repeat_seq are non-negative f64 from SQLite; safe to truncate
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let remaining = match (repeat_count, repeat_seq) {
            (Some(count), Some(seq)) if count > seq => Some((count - seq) as usize),
            (Some(count), None) => Some(count as usize),
            (Some(_), Some(_)) => Some(0usize), // already exhausted
            _ => None,                          // no limit
        };

        // Parse mode and interval from rule
        let trimmed = rule.trim().to_lowercase();
        let (mode, interval) = if let Some(rest) = trimmed.strip_prefix(".+") {
            ("dot_plus", rest)
        } else if let Some(rest) = trimmed.strip_prefix("++") {
            ("plus_plus", rest)
        } else {
            ("default", trimmed.as_str())
        };

        let today = chrono::Local::now().date_naive();

        // Project for each date source (due_date, scheduled_date)
        let sources: Vec<(&str, &str)> = [
            block.due_date.as_deref().map(|d| ("due_date", d)),
            block
                .scheduled_date
                .as_deref()
                .map(|d| ("scheduled_date", d)),
        ]
        .into_iter()
        .flatten()
        .collect();

        for (source_name, date_str) in sources {
            if entries.len() >= cap {
                break;
            }

            let Ok(base) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") else {
                continue;
            };

            // Determine starting point based on mode
            let mut current = match mode {
                "dot_plus" => {
                    // .+ mode: shift from today (completion-based)
                    today
                }
                "plus_plus" => {
                    // ++ mode: advance from original date until > today
                    let mut c = base;
                    for _ in 0..10_000 {
                        c = match crate::recurrence::shift_date_once(c, interval) {
                            Some(d) => d,
                            None => break,
                        };
                        if c > today {
                            break;
                        }
                    }
                    // c is now the first future cadence date;
                    // we need to include it, so go back one step
                    // by setting current = base and fast-forwarding
                    // Actually: set current so that first shift_date_once
                    // in the loop produces c. We can't easily reverse,
                    // so pre-add c if in range, then continue from c.
                    c
                }
                _ => base, // Default: shift from original date
            };

            let mut projected_count = 0usize;
            let max_remaining = remaining.unwrap_or(usize::MAX);

            // For ++ mode, the caught-up date itself is the first projection.
            // The main loop shifts before checking, so it would skip `current`.
            // Pre-add it if it falls within the requested range.
            if mode == "plus_plus"
                && projected_count < max_remaining
                && entries.len() < cap
                && current >= range_start
                && current <= range_end
            {
                if let Some(until) = until_date {
                    if current <= until {
                        entries.push(ProjectedAgendaEntry {
                            block: block.to_block_row(),
                            projected_date: current.format("%Y-%m-%d").to_string(),
                            source: source_name.to_string(),
                        });
                        projected_count += 1;
                    }
                } else {
                    entries.push(ProjectedAgendaEntry {
                        block: block.to_block_row(),
                        projected_date: current.format("%Y-%m-%d").to_string(),
                        source: source_name.to_string(),
                    });
                    projected_count += 1;
                }
            }

            // Safety limit to prevent infinite loops
            for _ in 0..10_000 {
                if entries.len() >= cap || projected_count >= max_remaining {
                    break;
                }

                current = match crate::recurrence::shift_date_once(current, interval) {
                    Some(d) => d,
                    None => break,
                };

                // Check until-date end condition
                if let Some(until) = until_date {
                    if current > until {
                        break;
                    }
                }

                // Past end of range
                if current > range_end {
                    break;
                }

                // Within range — add entry
                if current >= range_start {
                    entries.push(ProjectedAgendaEntry {
                        block: block.to_block_row(),
                        projected_date: current.format("%Y-%m-%d").to_string(),
                        source: source_name.to_string(),
                    });
                    projected_count += 1;
                }
            }
        }
    }

    // Sort by projected_date, then block_id for determinism
    entries.sort_by(|a, b| {
        a.projected_date
            .cmp(&b.projected_date)
            .then_with(|| a.block.id.cmp(&b.block.id))
    });

    // Truncate to cap after sort
    entries.truncate(cap);

    Ok(entries)
}

/// Tauri command: batch-count agenda items per date. Delegates to [`count_agenda_batch_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn count_agenda_batch(
    read_pool: State<'_, ReadPool>,
    dates: Vec<String>,
) -> Result<HashMap<String, usize>, AppError> {
    count_agenda_batch_inner(&read_pool.0, dates)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch-count agenda items per (date, source). Delegates to [`count_agenda_batch_by_source_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn count_agenda_batch_by_source(
    read_pool: State<'_, ReadPool>,
    dates: Vec<String>,
) -> Result<HashMap<String, HashMap<String, usize>>, AppError> {
    count_agenda_batch_by_source_inner(&read_pool.0, dates)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list projected future occurrences of repeating tasks.
/// Delegates to [`list_projected_agenda_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_projected_agenda(
    pool: State<'_, ReadPool>,
    start_date: String,
    end_date: String,
    limit: Option<i64>,
) -> Result<Vec<ProjectedAgendaEntry>, AppError> {
    list_projected_agenda_inner(&pool.0, start_date, end_date, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// List undated tasks: blocks with todo_state but no due_date and no scheduled_date.
/// Cursor-paginated.
#[instrument(skip(pool), err)]
pub async fn list_undated_tasks_inner(
    pool: &SqlitePool,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    use crate::pagination;
    let page_req = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_undated_tasks(pool, &page_req).await
}

/// Tauri command: list undated tasks. Delegates to [`list_undated_tasks_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_undated_tasks(
    pool: State<'_, ReadPool>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    list_undated_tasks_inner(&pool.0, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}
