//! Recurrence (repeat-rule) logic for recurring tasks.
//!
//! This module extracts the date-shifting and recurrence state machine from
//! `commands::set_todo_state_inner` so it can be tested in isolation and
//! kept separate from the command dispatch plumbing.
//!
//! Public API consumed by `commands.rs`:
//! - [`shift_date`] — compute the next occurrence date from a rule string
//! - [`handle_recurrence`] — full recurrence flow (DB reads, end-condition
//!   checks, sibling creation) called when a task transitions to DONE

use chrono::Datelike;
use sqlx::SqlitePool;

use crate::commands::{create_block_in_tx, get_block_inner, is_valid_iso_date, set_property_in_tx};
use crate::materializer::Materializer;
use crate::op_log;

// ---------------------------------------------------------------------------
// Pure date helpers
// ---------------------------------------------------------------------------

/// Return the number of days in the given month of the given year.
fn days_in_month(year: i32, month: u32) -> u32 {
    chrono::NaiveDate::from_ymd_opt(
        if month == 12 { year + 1 } else { year },
        if month == 12 { 1 } else { month + 1 },
        1,
    )
    .map(|d| d.pred_opt().unwrap().day())
    .unwrap_or(28)
}

/// Shift a `YYYY-MM-DD` date string by a recurrence interval once from
/// the given base date.
///
/// Returns the shifted date or `None` if parsing fails.
pub(crate) fn shift_date_once(base: chrono::NaiveDate, interval: &str) -> Option<chrono::NaiveDate> {
    let year = base.year();
    let month = base.month();
    let day = base.day();

    let shifted = match interval {
        "daily" => base + chrono::Duration::days(1),
        "weekly" => base + chrono::Duration::days(7),
        "monthly" => {
            let new_month = if month == 12 { 1 } else { month + 1 };
            let new_year = if month == 12 { year + 1 } else { year };
            let max_day = days_in_month(new_year, new_month);
            chrono::NaiveDate::from_ymd_opt(new_year, new_month, day.min(max_day))?
        }
        _ => {
            // Parse +Nd, +Nw, +Nm patterns (the leading '+' is already stripped
            // by the caller for `.+` and `++` modes, but may still be present
            // for the default `+` mode).
            let num_unit = interval.strip_prefix('+').unwrap_or(interval);
            if num_unit.len() < 2 {
                return None;
            }
            let (num_str, unit) = num_unit.split_at(num_unit.len() - 1);
            let n: i64 = num_str.parse().ok()?;
            match unit {
                "d" => base + chrono::Duration::days(n),
                "w" => base + chrono::Duration::days(n * 7),
                "m" => {
                    let total_months = (year as i64 * 12 + month as i64 - 1) + n;
                    let new_year = (total_months / 12) as i32;
                    let new_month = (total_months % 12 + 1) as u32;
                    let max_day = days_in_month(new_year, new_month);
                    chrono::NaiveDate::from_ymd_opt(new_year, new_month, day.min(max_day))?
                }
                _ => return None,
            }
        }
    };

    Some(shifted)
}

/// Shift a `YYYY-MM-DD` date string by a recurrence interval.
///
/// Supported mode prefixes:
/// - (none) or `+` — shift from the original date once (default)
/// - `.+` — shift from today's date (completion-based recurrence)
/// - `++` — shift from the original date repeatedly until result > today
///
/// Supported intervals (after prefix):
/// - `daily`  — every day
/// - `weekly` — every 7 days
/// - `monthly` — every month (same day-of-month, clamped)
/// - `+Nd` / `Nd` — every N days
/// - `+Nw` / `Nw` — every N weeks
/// - `+Nm` / `Nm` — every N months
pub(crate) fn shift_date(date: &str, rule: &str) -> Option<String> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let year: i32 = parts[0].parse().ok()?;
    let month: u32 = parts[1].parse().ok()?;
    let day: u32 = parts[2].parse().ok()?;

    let original = chrono::NaiveDate::from_ymd_opt(year, month, day)?;
    let today = chrono::Local::now().date_naive();

    let trimmed = rule.trim().to_lowercase();

    // Determine mode and strip prefix
    let (mode, interval) = if let Some(rest) = trimmed.strip_prefix(".+") {
        ("dot_plus", rest)
    } else if let Some(rest) = trimmed.strip_prefix("++") {
        ("plus_plus", rest)
    } else {
        // Default mode: `+` prefix or bare keyword
        ("default", trimmed.as_str())
    };

    let shifted = match mode {
        "dot_plus" => {
            // Shift from today, not from the original date
            shift_date_once(today, interval)?
        }
        "plus_plus" => {
            // Keep shifting from original until result > today
            let mut current = original;
            // Safety limit to avoid infinite loops on bad data
            for _ in 0..10_000 {
                current = shift_date_once(current, interval)?;
                if current > today {
                    break;
                }
            }
            current
        }
        _ => {
            // Default: shift from original date once
            shift_date_once(original, interval)?
        }
    };

    Some(shifted.format("%Y-%m-%d").to_string())
}

// ---------------------------------------------------------------------------
// Recurrence handler (async, DB-dependent)
// ---------------------------------------------------------------------------

/// Handle recurrence when a task transitions to DONE.
///
/// This checks for a `repeat` property on the block and, if present:
/// 1. Pre-computes shifted dates for end-condition checks
/// 2. Evaluates end conditions (`repeat-until`, `repeat-count`/`repeat-seq`)
/// 3. Creates a new sibling block with TODO state and shifted dates
/// 4. Copies recurrence properties to the new block
///
/// Returns `Ok(true)` if a sibling was created, `Ok(false)` if recurrence
/// was skipped (no repeat rule, end condition met, etc.).
pub(crate) async fn handle_recurrence(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: &str,
) -> Result<bool, crate::error::AppError> {
    // Check for repeat property
    let repeat_rule: Option<String> = sqlx::query_scalar(
        "SELECT value_text FROM block_properties WHERE block_id = ?1 AND key = 'repeat'",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;

    let rule = match repeat_rule {
        Some(r) => r,
        None => return Ok(false),
    };

    // Fetch the original block (with updated DONE state)
    let original = get_block_inner(pool, block_id.to_string()).await?;

    // Pre-compute shifted dates for end-condition checks
    let shifted_due = original
        .due_date
        .as_ref()
        .and_then(|d| shift_date(d, &rule));
    let shifted_sched = original
        .scheduled_date
        .as_ref()
        .and_then(|d| shift_date(d, &rule));

    // The "reference" shifted date used for end-condition comparison:
    // prefer due_date, fall back to scheduled_date.
    let reference_date = shifted_due.as_deref().or(shifted_sched.as_deref());

    // --- End condition: repeat-until ---
    let repeat_until: Option<String> = sqlx::query_scalar(
        "SELECT value_date FROM block_properties WHERE block_id = ?1 AND key = 'repeat-until'",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;

    if let Some(ref until_str) = repeat_until {
        if let Some(ref_date) = reference_date {
            // Simple lexicographic comparison works for YYYY-MM-DD strings
            if ref_date > until_str.as_str() {
                // Shifted date is past the repeat-until deadline — stop recurring
                return Ok(false);
            }
        }
    }

    // --- End condition: repeat-count / repeat-seq ---
    let repeat_count: Option<f64> = sqlx::query_scalar(
        "SELECT value_num FROM block_properties WHERE block_id = ?1 AND key = 'repeat-count'",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;

    let repeat_seq: Option<f64> = sqlx::query_scalar(
        "SELECT value_num FROM block_properties WHERE block_id = ?1 AND key = 'repeat-seq'",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;

    if let Some(count) = repeat_count {
        let current_seq = repeat_seq.unwrap_or(0.0) as i64;
        let max_count = count as i64;
        if current_seq >= max_count {
            // Already exhausted the repeat count — stop recurring
            return Ok(false);
        }
    }

    // --- Resolve repeat-origin for the chain ---
    let repeat_origin: Option<String> = sqlx::query_scalar(
        "SELECT value_ref FROM block_properties WHERE block_id = ?1 AND key = 'repeat-origin'",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;
    // Use existing origin, or this block is the first in the chain
    let origin_id = repeat_origin.unwrap_or_else(|| block_id.to_string());

    // --- Create the recurrence sibling ---
    // Single transaction for entire recurrence sequence
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut op_records: Vec<op_log::OpRecord> = Vec::new();

    // Create next occurrence as a sibling
    let (new_block, op) = create_block_in_tx(
        &mut tx,
        device_id,
        original.block_type.clone(),
        original.content.unwrap_or_default(),
        original.parent_id.clone(),
        original.position.map(|p| p + 1),
    )
    .await?;
    op_records.push(op);

    // Set TODO state on new block
    let (_, op) = set_property_in_tx(
        &mut tx,
        device_id,
        new_block.id.clone(),
        "todo_state",
        Some("TODO".to_string()),
        None,
        None,
        None,
    )
    .await?;
    op_records.push(op);

    // Copy repeat property to new block
    let (_, op) = set_property_in_tx(
        &mut tx,
        device_id,
        new_block.id.clone(),
        "repeat",
        Some(rule.clone()),
        None,
        None,
        None,
    )
    .await?;
    op_records.push(op);

    // Shift due_date if present
    if let Some(shifted) = shifted_due {
        if !is_valid_iso_date(&shifted) {
            tracing::warn!("shifted due_date '{shifted}' is not valid YYYY-MM-DD, skipping");
        } else {
            match set_property_in_tx(
                &mut tx,
                device_id,
                new_block.id.clone(),
                "due_date",
                None,
                None,
                Some(shifted),
                None,
            )
            .await
            {
                Ok((_, op)) => op_records.push(op),
                Err(e) => {
                    tracing::warn!(error = %e, "failed to shift due_date for recurring block")
                }
            }
        }
    }

    // Shift scheduled_date if present
    if let Some(shifted) = shifted_sched {
        if !is_valid_iso_date(&shifted) {
            tracing::warn!(
                "shifted scheduled_date '{shifted}' is not valid YYYY-MM-DD, skipping"
            );
        } else {
            match set_property_in_tx(
                &mut tx,
                device_id,
                new_block.id.clone(),
                "scheduled_date",
                None,
                None,
                Some(shifted),
                None,
            )
            .await
            {
                Ok((_, op)) => op_records.push(op),
                Err(e) => {
                    tracing::warn!(error = %e, "failed to shift scheduled_date for recurring block")
                }
            }
        }
    }

    // Copy repeat-until to new block if present
    if let Some(ref until_str) = repeat_until {
        match set_property_in_tx(
            &mut tx,
            device_id,
            new_block.id.clone(),
            "repeat-until",
            None,
            None,
            Some(until_str.clone()),
            None,
        )
        .await
        {
            Ok((_, op)) => op_records.push(op),
            Err(e) => {
                tracing::warn!(error = %e, "failed to copy repeat-until to recurring block")
            }
        }
    }

    // Copy repeat-count and increment repeat-seq on new block
    if let Some(count) = repeat_count {
        let current_seq = repeat_seq.unwrap_or(0.0) as i64;
        let next_seq = current_seq + 1;

        // Copy repeat-count
        match set_property_in_tx(
            &mut tx,
            device_id,
            new_block.id.clone(),
            "repeat-count",
            None,
            Some(count),
            None,
            None,
        )
        .await
        {
            Ok((_, op)) => op_records.push(op),
            Err(e) => {
                tracing::warn!(error = %e, "failed to copy repeat-count to recurring block")
            }
        }

        // Set incremented repeat-seq
        match set_property_in_tx(
            &mut tx,
            device_id,
            new_block.id.clone(),
            "repeat-seq",
            None,
            Some(next_seq as f64),
            None,
            None,
        )
        .await
        {
            Ok((_, op)) => op_records.push(op),
            Err(e) => {
                tracing::warn!(error = %e, "failed to set repeat-seq on recurring block")
            }
        }
    }

    // Set repeat-origin on new block (points to original block in chain)
    match set_property_in_tx(
        &mut tx,
        device_id,
        new_block.id.clone(),
        "repeat-origin",
        None,
        None,
        None,
        Some(origin_id),
    )
    .await
    {
        Ok((_, op)) => op_records.push(op),
        Err(e) => {
            tracing::warn!(error = %e, "failed to set repeat-origin on recurring block")
        }
    }

    tx.commit().await?;

    // Dispatch all ops after commit
    for op in &op_records {
        let _ = materializer.dispatch_background(op);
    }

    Ok(true)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shift_date_default_mode_shifts_from_original() {
        // Default (+) mode: shift from the original date
        assert_eq!(shift_date("2025-06-15", "daily"), Some("2025-06-16".into()));
        assert_eq!(
            shift_date("2025-06-15", "weekly"),
            Some("2025-06-22".into())
        );
        assert_eq!(shift_date("2025-06-15", "+3d"), Some("2025-06-18".into()));
    }

    #[test]
    fn shift_date_dot_plus_prefix_uses_today_as_base() {
        // .+ mode: shift from today, not from the original date
        let today = chrono::Local::now().date_naive();
        let expected = today + chrono::Duration::days(7);
        let expected_str = expected.format("%Y-%m-%d").to_string();

        // Use a date far in the past — with .+ the result should be based on today
        let result = shift_date("2020-01-01", ".+weekly").unwrap();
        assert_eq!(
            result, expected_str,
            ".+weekly should shift from today, not from 2020-01-01"
        );

        // Also test with .+daily
        let expected_daily = (today + chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        let result_daily = shift_date("2020-01-01", ".+daily").unwrap();
        assert_eq!(
            result_daily, expected_daily,
            ".+daily should shift from today"
        );

        // .+3d
        let expected_3d = (today + chrono::Duration::days(3))
            .format("%Y-%m-%d")
            .to_string();
        let result_3d = shift_date("2020-01-01", ".+3d").unwrap();
        assert_eq!(result_3d, expected_3d, ".+3d should shift from today");
    }

    #[test]
    fn shift_date_plus_plus_prefix_advances_to_future() {
        // ++ mode: keep shifting from original until result > today
        let today = chrono::Local::now().date_naive();

        // Use a date that's ~3 weeks in the past
        let past = today - chrono::Duration::days(21);
        let past_str = past.format("%Y-%m-%d").to_string();

        let result = shift_date(&past_str, "++weekly").unwrap();
        let result_date = chrono::NaiveDate::parse_from_str(&result, "%Y-%m-%d").unwrap();

        assert!(
            result_date > today,
            "++weekly should advance past today, got {result} (today = {})",
            today.format("%Y-%m-%d")
        );

        // The result should be within 7 days after today (since we're stepping weekly)
        let max_expected = today + chrono::Duration::days(7);
        assert!(
            result_date <= max_expected,
            "++weekly result should be at most 7 days after today, got {result}"
        );
    }

    #[test]
    fn shift_date_plus_plus_daily_advances_to_future() {
        let today = chrono::Local::now().date_naive();

        // 10 days in the past
        let past = today - chrono::Duration::days(10);
        let past_str = past.format("%Y-%m-%d").to_string();

        let result = shift_date(&past_str, "++daily").unwrap();
        let result_date = chrono::NaiveDate::parse_from_str(&result, "%Y-%m-%d").unwrap();

        assert!(
            result_date > today,
            "++daily should advance past today, got {result}"
        );
        // Should be exactly tomorrow (today + 1) since we step by 1 day
        let expected = today + chrono::Duration::days(1);
        assert_eq!(
            result_date, expected,
            "++daily from 10 days ago should land on tomorrow"
        );
    }

    #[test]
    fn days_in_month_known_values() {
        assert_eq!(days_in_month(2025, 1), 31); // January
        assert_eq!(days_in_month(2025, 2), 28); // February (non-leap)
        assert_eq!(days_in_month(2024, 2), 29); // February (leap)
        assert_eq!(days_in_month(2025, 4), 30); // April
        assert_eq!(days_in_month(2025, 12), 31); // December
    }

    #[test]
    fn shift_date_once_monthly_clamps_day() {
        // Jan 31 + 1 month → Feb 28 (non-leap)
        let base = chrono::NaiveDate::from_ymd_opt(2025, 1, 31).unwrap();
        let result = shift_date_once(base, "monthly").unwrap();
        assert_eq!(result, chrono::NaiveDate::from_ymd_opt(2025, 2, 28).unwrap());
    }

    #[test]
    fn shift_date_once_custom_intervals() {
        let base = chrono::NaiveDate::from_ymd_opt(2025, 6, 15).unwrap();

        assert_eq!(
            shift_date_once(base, "3d"),
            Some(chrono::NaiveDate::from_ymd_opt(2025, 6, 18).unwrap())
        );
        assert_eq!(
            shift_date_once(base, "2w"),
            Some(chrono::NaiveDate::from_ymd_opt(2025, 6, 29).unwrap())
        );
        assert_eq!(
            shift_date_once(base, "2m"),
            Some(chrono::NaiveDate::from_ymd_opt(2025, 8, 15).unwrap())
        );
    }

    #[test]
    fn shift_date_returns_none_for_bad_input() {
        assert_eq!(shift_date("not-a-date", "daily"), None);
        assert_eq!(shift_date("2025-06-15", "xyz"), None);
        assert_eq!(shift_date("2025-06-15", ""), None);
    }

    #[test]
    fn shift_date_monthly_from_string() {
        assert_eq!(
            shift_date("2025-01-31", "monthly"),
            Some("2025-02-28".into())
        );
        assert_eq!(
            shift_date("2025-06-15", "monthly"),
            Some("2025-07-15".into())
        );
    }
}
