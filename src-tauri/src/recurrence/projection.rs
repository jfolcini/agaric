//! Shared per-block recurrence-date projection (MAINT-196).
//!
//! Pure date math, no DB access. Used by both the projected-agenda cache
//! rebuild (`cache::projected_agenda::project_block_into`) and the
//! on-the-fly projection (`commands::agenda::list_projected_agenda_on_the_fly`).
//!
//! Before MAINT-196 the per-block recurrence projection lived inline in
//! both callsites and silently drifted: the parity test
//! `projected_agenda_cached_equals_on_the_fly` recorded a 112-vs-110
//! mismatch on the `.+1w` (dot_plus) surface. Consolidating the logic
//! here removes the drift surface entirely; every callsite passes
//! identical inputs to one function and emits via a closure, so the
//! callsite-specific concerns (Vec append vs cursor/BTreeMap insert)
//! stay outside the recurrence math.
//!
//! Contract: see [`project_block_dates`]. The caller decides
//! `range_start` / `range_end` and what to do with each emitted
//! `(date, source_name)` tuple.
//!
//! Source-strings are stable: `"due_date"` and `"scheduled_date"`. Both
//! the cache table and the API model embed those literal strings, so
//! changing them is a wire-compat break.

/// Project one repeating block's occurrence dates within
/// `[range_start, range_end]`.
///
/// The caller decides what to do with each `(projected_date, source_name)`
/// tuple via `emit`. The helper itself owns the recurrence semantics:
///
/// - Trims and lowercases `repeat_rule`; empty / whitespace-only rules
///   produce zero emissions.
/// - Dispatches on the prefix:
///     * `.+` → `dot_plus` (completion-based — start advancing from
///       `today`).
///     * `++` → `plus_plus` (skip-past-today — start at the original
///       date, advance one step at a time until the result is strictly
///       greater than `today`, then pre-emit that caught-up date and
///       continue advancing).
///     * otherwise → `default` (shift from the original date).
/// - Pre-emits the caught-up date for `plus_plus` if it falls within
///   `[range_start, range_end]` and is not past `repeat_until`.
/// - 10 000-iteration safety bound per `(block, source)` so a
///   pathological rule cannot infinite-loop.
/// - #680 / PEND-24 H2: for `plus_plus`, if the catch-up loop exhausts
///   the safety bound (or `shift_date_once` overflows) WITHOUT reaching
///   a date strictly after `today`, the source is skipped entirely — no
///   occurrence is emitted. Emitting the stale past `current` would be a
///   silent data bug; this mirrors the string parser
///   (`parser::shift_date`), which raises `Err(AppError::Validation)`
///   for the identical input class.
/// - End conditions:
///     * `until_date` — stop once `current > until_date`.
///     * `remaining` — stop once we've emitted (or attempted to emit)
///       `remaining` projections. Counted **regardless** of whether the
///       caller's `emit` closure accepted the entry, so the count
///       semantics survive a cursor / size-cap reject downstream.
/// - Range clipping:
///     * `current > range_end` → break (no more emissions can land).
///     * `current >= range_start` → emit; otherwise advance silently
///       and keep iterating.
///
/// Source iteration order is fixed: `due_date` first, then
/// `scheduled_date`. Both the cache and on-the-fly paths previously
/// pushed in this order, so preserving it here keeps the parity test
/// observable.
///
/// `remaining` is pre-computed by the caller from
/// `repeat_count - repeat_seq` (see callsites). `None` means unbounded.
///
/// # Drift notes (MAINT-196)
///
/// The two pre-refactor callsites diverged on one subtle detail:
/// the cache previously clipped emissions against `today..horizon`
/// (`if current >= today && current <= horizon`) while the on-the-fly
/// path clipped against `range_start..range_end`. For a `dot_plus`
/// rule like `.+1w` starting at `today`, the first emit happens on the
/// **next** week boundary (because the loop shifts before the
/// emit-check), so a difference in clip boundary by even one day at
/// either end produces a 1-2 entry drift in long windows. The new
/// shared signature pushes the clip boundaries onto the caller —
/// the cache passes `range_start = today, range_end = today + 365d`
/// and the on-the-fly path passes its caller-supplied range
/// directly — so both paths see one set of bounds and one comparator.
//
// `too_many_arguments` is deliberate here: each argument corresponds to
// one columnar input the two callsites already destructure off
// `RepeatingBlockRow` / `CacheRepeatingRow`. Wrapping them in a struct
// would just move the boilerplate elsewhere without changing the
// shape — both callsites pass every field. The shared-helper contract
// is meant to be the loud signature, not a hidden struct.
#[allow(clippy::too_many_arguments)]
pub(crate) fn project_block_dates<F>(
    due_date: Option<&str>,
    scheduled_date: Option<&str>,
    repeat_rule: &str,
    repeat_until: Option<chrono::NaiveDate>,
    remaining: Option<usize>,
    today: chrono::NaiveDate,
    range_start: chrono::NaiveDate,
    range_end: chrono::NaiveDate,
    mut emit: F,
) where
    F: FnMut(chrono::NaiveDate, &'static str),
{
    let trimmed_rule = repeat_rule.trim().to_lowercase();
    if trimmed_rule.is_empty() {
        return;
    }

    // Parse mode and interval from the rule string. The interval is a
    // borrow into `trimmed_rule` so we keep `trimmed_rule` alive for
    // the duration of the projection.
    let (mode, interval) = if let Some(rest) = trimmed_rule.strip_prefix(".+") {
        ("dot_plus", rest)
    } else if let Some(rest) = trimmed_rule.strip_prefix("++") {
        ("plus_plus", rest)
    } else {
        ("default", trimmed_rule.as_str())
    };

    // Source iteration: due_date, then scheduled_date. Fixed order so
    // both callsites observe the same emission sequence (the cache's
    // `INSERT OR IGNORE` and the on-the-fly's BTreeMap dedupe both
    // tolerate duplicates, but a fixed source order keeps the cap /
    // cursor pagination deterministic when `remaining` cuts mid-source).
    let sources: [(Option<&str>, &'static str); 2] =
        [(due_date, "due_date"), (scheduled_date, "scheduled_date")];

    for (date_opt, source_name) in sources {
        let Some(date_str) = date_opt else { continue };
        let Ok(base) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") else {
            continue;
        };

        // Determine the starting point based on mode.
        let mut current = match mode {
            "dot_plus" => today,
            "plus_plus" => {
                // Advance from `base` one step at a time until strictly
                // greater than today. The caught-up date is pre-emitted
                // below, then the main loop continues from it.
                //
                // #680 / PEND-24 H2: the catch-up can fail to reach a
                // future date in two ways — the 10 000-step budget
                // elapses without `c > today` (e.g. `++1d` against an
                // `original` decades in the past), or `shift_date_once`
                // returns `None` mid-loop (single-step `NaiveDate`
                // arithmetic overflow). In either case `c` is left as a
                // STALE PAST date. Pre-fix, the pre-emit block below and
                // the main loop still ran against that stale date, so the
                // projection silently emitted a past occurrence.
                //
                // The string parser (`parser::shift_date`) treats this
                // SAME input class as a hard `Err(AppError::Validation)`
                // ("cap exceeded" / "arithmetic overflow"). This
                // emit-driven projection has no error channel, so the
                // consistent "loud failure" here is to SKIP the source
                // entirely: produce no occurrence rather than a stale one.
                // We track whether we actually caught up and `continue`
                // to the next source when we did not.
                let mut c = base;
                let mut caught_up = false;
                for _ in 0..10_000 {
                    c = match crate::recurrence::shift_date_once(c, interval) {
                        Some(d) => d,
                        // Single-step overflow: cannot reach a valid
                        // future date, so abandon this source rather than
                        // emitting the stale `c`.
                        None => break,
                    };
                    if c > today {
                        caught_up = true;
                        break;
                    }
                }
                if !caught_up {
                    // Cap exhausted or overflow without `c > today`: skip
                    // emission (mirrors the parser's `Err(Validation)`).
                    continue;
                }
                c
            }
            _ => base,
        };

        let mut projected_count = 0usize;
        let max_remaining = remaining.unwrap_or(usize::MAX);

        // For `++` mode, pre-emit the caught-up date itself when it
        // lands inside the requested range and is not past `until_date`.
        // The main loop shifts before emit-checking, so without this
        // pre-emit the caught-up date would be silently skipped.
        if mode == "plus_plus"
            && projected_count < max_remaining
            && current >= range_start
            && current <= range_end
        {
            let past_until = repeat_until.is_some_and(|until| current > until);
            if !past_until {
                emit(current, source_name);
                projected_count += 1;
            }
        }

        // Main projection loop with the 10 000-step safety bound.
        for _ in 0..10_000 {
            if projected_count >= max_remaining {
                break;
            }

            current = match crate::recurrence::shift_date_once(current, interval) {
                Some(d) => d,
                None => break,
            };

            if let Some(until) = repeat_until
                && current > until
            {
                break;
            }

            if current > range_end {
                break;
            }

            if current >= range_start {
                emit(current, source_name);
                projected_count += 1;
            }
        }
    }
}
