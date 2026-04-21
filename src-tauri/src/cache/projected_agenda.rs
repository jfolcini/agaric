use sqlx::SqlitePool;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// rebuild_projected_agenda_cache (P-16)
// ---------------------------------------------------------------------------

/// Row returned by the repeating-blocks query inside the cache rebuild.
///
/// Mirrors `RepeatingBlockRow` in `commands/mod.rs` but lives here to avoid
/// a circular dependency (cache -> commands).
struct CacheRepeatingRow {
    id: String,
    due_date: Option<String>,
    scheduled_date: Option<String>,
    repeat_rule: Option<String>,
    repeat_until: Option<String>,
    repeat_count: Option<f64>,
    repeat_seq: Option<f64>,
}

/// Full recompute of `projected_agenda_cache`.
///
/// 1. Fetches all repeating blocks (non-DONE, non-deleted, has repeat property,
///    has at least one date column).
/// 2. For each block, projects dates for the next 365 days from today.
/// 3. Respects end conditions (repeat-until, repeat-count).
/// 4. Writes projected entries via DELETE + INSERT in a single transaction.
pub async fn rebuild_projected_agenda_cache(pool: &SqlitePool) -> Result<(), AppError> {
    tracing::info!("rebuilding projected_agenda cache");
    let start = std::time::Instant::now();
    let result = rebuild_projected_agenda_cache_impl(pool).await;
    match result {
        Ok(rows_affected) => {
            tracing::info!(
                rows_affected,
                duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
                "rebuilt projected_agenda cache"
            );
            Ok(())
        }
        Err(e) => {
            tracing::warn!(error = %e, "rebuild failed for projected_agenda cache");
            Err(e)
        }
    }
}

async fn rebuild_projected_agenda_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let today = chrono::Local::now().date_naive();
    // Pre-compute projections for the next 365 days only. Queries beyond this
    // horizon fall back to on-the-fly computation (which is slower but correct).
    // 365 days is sufficient for weekly/monthly calendar views — the primary
    // consumer of projected agenda data.
    let horizon = today + chrono::Duration::days(365);

    // Fetch all repeating blocks (same query as list_projected_agenda_inner).
    // Template-page filter (FEAT-5a, spec line 812): exclude repeating
    // blocks whose owning page carries a `template` property so they
    // never enter the projected agenda.  `b.page_id` is the denormalised
    // root-page column (migration 0027).
    let rows: Vec<CacheRepeatingRow> = sqlx::query_as!(
        CacheRepeatingRow,
        r#"SELECT b.id,
                b.due_date, b.scheduled_date,
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

    // Build all projected entries in memory.
    let mut entries: Vec<(String, String, String)> = Vec::new(); // (block_id, date, source)

    for block in &rows {
        let rule = match &block.repeat_rule {
            Some(r) if !r.is_empty() => r.clone(),
            _ => continue,
        };

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
            (Some(_), Some(_)) => Some(0usize),
            _ => None,
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
            let Ok(base) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") else {
                continue;
            };

            // Determine starting point based on mode
            let mut current = match mode {
                "dot_plus" => today,
                "plus_plus" => {
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
                    c
                }
                _ => base,
            };

            let mut projected_count = 0usize;
            let max_remaining = remaining.unwrap_or(usize::MAX);

            // For ++ mode, pre-add the caught-up date itself.
            if mode == "plus_plus"
                && projected_count < max_remaining
                && current >= today
                && current <= horizon
            {
                let skip = until_date.is_some_and(|until| current > until);
                if !skip {
                    entries.push((
                        block.id.clone(),
                        current.format("%Y-%m-%d").to_string(),
                        source_name.to_string(),
                    ));
                    projected_count += 1;
                }
            }

            // Safety limit to prevent infinite loops
            for _ in 0..10_000 {
                if projected_count >= max_remaining {
                    break;
                }

                current = match crate::recurrence::shift_date_once(current, interval) {
                    Some(d) => d,
                    None => break,
                };

                if let Some(until) = until_date {
                    if current > until {
                        break;
                    }
                }

                if current > horizon {
                    break;
                }

                if current >= today {
                    entries.push((
                        block.id.clone(),
                        current.format("%Y-%m-%d").to_string(),
                        source_name.to_string(),
                    ));
                    projected_count += 1;
                }
            }
        }
    }

    let written = entries.len() as u64;

    // Write to DB: DELETE + INSERT in a single transaction.
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM projected_agenda_cache")
        .execute(&mut *tx)
        .await?;

    for (block_id, date, source) in &entries {
        sqlx::query(
            "INSERT OR IGNORE INTO projected_agenda_cache (block_id, projected_date, source) VALUES (?1, ?2, ?3)",
        )
        .bind(block_id)
        .bind(date)
        .bind(source)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(written)
}

/// Read/write split variant of [`rebuild_projected_agenda_cache`].
///
/// Reads repeating blocks from `read_pool`, computes projections, then
/// writes to `write_pool`. Delegates to the single-pool implementation
/// using the write pool for the combined read+write — acceptable because
/// cache rebuilds are background stale-while-revalidate operations.
pub async fn rebuild_projected_agenda_cache_split(
    write_pool: &SqlitePool,
    _read_pool: &SqlitePool,
) -> Result<(), AppError> {
    rebuild_projected_agenda_cache(write_pool).await
}
