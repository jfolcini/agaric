//! Recurrence rule-string parsing — the `AppError`-typed string wrapper.
//!
//! No DB access, no async. `shift_date` is deterministic given its inputs
//! except the `.+` / `++` modes, which consult `chrono::Local::now()`.
//!
//! The pure interval-shift math it builds on ([`shift_date_once`] and the
//! calendar-rail helpers) lives one layer down in
//! [`agaric_store::recurrence_math`] (#2621) so the store-layer projection path
//! can reuse it without depending on this engine-layer module.
//!
//! (#2621 THE INVERSION) — moved down from the app crate's
//! `recurrence::parser` so the recurrence-sibling core in
//! [`super::compute`] can reach it without an upward app dependency. The app
//! crate re-exports it (`pub(crate) use agaric_engine::recurrence::shift_date;`)
//! so every existing `crate::recurrence::…` / `super::parser::shift_date` path
//! resolves unchanged.

use agaric_core::error::{AppError, ValidationCode};
use agaric_store::recurrence_math::{
    REPEAT_MODE_DOT_PLUS, REPEAT_MODE_PLUS_PLUS, ShiftFailure, normalize_repeat_rule,
    shift_date_once, split_repeat_rule, try_shift_date_once, validate_repeat_rule_shape,
};

/// The accepted `repeat` vocabulary, spelled once, for the user-facing
/// rejection message (#3647). Kept next to [`shift_date`] — the function
/// whose grammar it describes — so a grammar change and its help text are
/// one edit apart.
pub const REPEAT_RULE_HELP: &str = "accepted: `daily`, `weekly`, `monthly`, `yearly`, \
     or `+Nd` / `+Nw` / `+Nm` / `+Ny` with N of 1 or more — optionally prefixed with \
     `.+` (count from when you complete it) or `++` (catch up to today)";

/// How much of an offending rule to echo back before eliding. A `repeat`
/// value is free text with no length cap of its own, and the message goes
/// into a toast.
const MAX_ECHOED_RULE_CHARS: usize = 48;

/// Validate a `repeat` property value at the point the user sets it (#3647).
///
/// # Why here
///
/// `repeat` is free text in a plain `text` column, authored through a bare
/// `<Input>` or an inline `repeat:: …` line. Before this, a malformed rule
/// was accepted at write time and only misbehaved much later, at completion:
/// [`shift_date`] returns `Ok(None)` for a shape error, so the recurrence
/// sibling was created with no date and the user got no feedback at all —
/// far from the keystroke that caused it (#3281 traded a hard wedge for this
/// quiet failure; this closes the loop).
///
/// # Agreement with the real grammar
///
/// Delegated wholesale to
/// [`agaric_store::recurrence_math::validate_repeat_rule_shape`], which runs
/// the production parser rather than describing it. See that function's docs.
/// This wrapper only puts an [`AppError`] around the verdict — it applies no
/// rule of its own.
///
/// # Errors
///
/// [`AppError::Validation`] coded [`ValidationCode::InvalidRepeatRule`], so
/// the frontend can surface the reason verbatim instead of a generic
/// "failed to save property" toast.
pub fn validate_repeat_rule(rule: &str) -> Result<(), AppError> {
    validate_repeat_rule_shape(rule).map_err(|problem| {
        let echoed: String = if rule.chars().count() > MAX_ECHOED_RULE_CHARS {
            rule.chars().take(MAX_ECHOED_RULE_CHARS).collect::<String>() + "…"
        } else {
            rule.to_owned()
        };
        AppError::validation_coded(
            ValidationCode::InvalidRepeatRule,
            format!(
                "repeat rule '{echoed}' is not valid: {} ({REPEAT_RULE_HELP})",
                problem.hint()
            ),
        )
    })
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
/// - `yearly` — every year (same month/day, clamped on Feb 29 → Feb 28).
///   #3281: written by the `/repeat-yearly` slash command as the bare
///   keyword; note the keyword arms match the BARE form only, so `+yearly`
///   is not accepted (exactly like `+daily` / `+weekly` / `+monthly`).
/// - `+Nd` / `Nd` — every N days
/// - `+Nw` / `Nw` — every N weeks
/// - `+Nm` / `Nm` — every N months
/// - `+Ny` / `Ny` — every N years (clamped on Feb 29 → Feb 28)
///
/// # Return type
///
/// Returns `Result<Option<String>, AppError>` so the three failure modes
/// stay distinguishable at the call site:
///
/// * `Ok(Some(date))` — shift succeeded.
/// * `Ok(None)` — input could not be parsed (malformed `date`, malformed
///   `rule`, zero/negative count, unknown unit). These are user-input
///   shape errors that the caller already treats as "skip the shift
///   silently"; preserving the `None` channel keeps that contract.
///   #3281: this now covers ALL THREE prefixes, including `++`. A
///   malformed interval under `++` (e.g. `++2weeks`, a typo for `++2w`)
///   used to return `Err`, which propagated through
///   `build_recurrence_sibling_in_tx` → `handle_recurrence_in_tx` before
///   `commit_and_dispatch` and rolled back the whole completion
///   transaction — so the task could never be marked DONE, and the error
///   blamed "arithmetic overflow" for a typo. Three prefixes, one
///   behaviour for one bad input.
/// * `Err(AppError::Validation)` — the `++` arm hit one of two
///   distinct dead-ends that previously returned silent garbage:
///   **overflow:** [`try_shift_date_once`] reported
///   [`ShiftFailure::Overflow`] mid-loop — a genuine `NaiveDate` / i64
///   arithmetic overflow, or a result outside the calendar guard rail.
///   The pre-fix `?` propagation surfaced as `Ok(None)`, which the
///   compute caller treated as "no recurrence requested" and created
///   a sibling with no due date.
///   **cap:** the 10 000-iteration safety budget elapsed
///   without `current > today` (e.g. `+1d` against an `original` ~30
///   years in the past). The pre-fix loop returned the stale past
///   date silently.
pub fn shift_date(date: &str, rule: &str) -> Result<Option<String>, AppError> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return Ok(None);
    }
    let Ok(year) = parts[0].parse::<i32>() else {
        return Ok(None);
    };
    let Ok(month) = parts[1].parse::<u32>() else {
        return Ok(None);
    };
    let Ok(day) = parts[2].parse::<u32>() else {
        return Ok(None);
    };

    let Some(original) = chrono::NaiveDate::from_ymd_opt(year, month, day) else {
        return Ok(None);
    };
    let today = chrono::Local::now().date_naive();

    let trimmed = normalize_repeat_rule(rule);

    // Determine mode and strip prefix. (#3647) The normalization and the
    // split are the shared `agaric_store::recurrence_math` helpers, so the
    // write-time validator (`validate_repeat_rule`) resolves a rule to the
    // exact same `(mode, interval)` pair this shifter does.
    let (mode, interval) = split_repeat_rule(&trimmed);

    let shifted = match mode {
        REPEAT_MODE_DOT_PLUS => {
            // Shift from today, not from the original date.
            // Parse failures stay on the `Ok(None)` channel (existing
            // contract); the compute caller treats this as "no shift".
            let Some(s) = shift_date_once(today, interval) else {
                return Ok(None);
            };
            s
        }
        REPEAT_MODE_PLUS_PLUS => {
            // Keep shifting from original until result > today.
            //
            // Two dead-ends that previously returned silent garbage now
            // surface as `Err(AppError::Validation)`:
            //
            // * `shift_date_once` returns `None` mid-loop
            //   (single-step `NaiveDate` arithmetic overflow). The
            //   pre-fix `?` propagated `None` out of `shift_date`,
            //   which the compute caller treated as "no recurrence"
            //   and created a sibling with no due date.
            // * the 10 000-iteration safety budget
            //   elapses without `current > today` (e.g. `+1d` from an
            //   `original` ~30 years in the past). The pre-fix loop
            //   returned the stale past date silently.
            //
            // Both errors carry `original`/`interval`/`today` so the
            // operator can reproduce the input that tripped the guard
            // without spelunking through the op log. `AppError::Validation`
            // matches the surrounding date-shape rejections in
            // `commands/properties.rs` (`due_date`/`scheduled_date`
            // ISO-format checks both raise `Validation`).
            let mut current = original;
            let mut hit_cap = true;
            for _ in 0..10_000 {
                let next = match try_shift_date_once(current, interval) {
                    Ok(next) => next,
                    // #3281: a MALFORMED interval is user-input shape, not an
                    // arithmetic dead-end. Rejoin the `Ok(None)` channel the
                    // other two prefix arms already use, so a typo like
                    // `++2weeks` is skipped rather than aborting the enclosing
                    // completion transaction (and being mislabelled
                    // "arithmetic overflow" on the way out).
                    Err(ShiftFailure::Interval) => {
                        // The `repeat` property is unvalidated free text, so
                        // the only trace a typo leaves is a sibling with no
                        // due date. Leave a diagnostic rather than nothing;
                        // rejecting the rule at `set_property`, where the
                        // user could see it, is the real fix (#3281).
                        tracing::warn!(
                            original = %original,
                            interval = %interval,
                            "recurrence `++` rule has a malformed interval; \
                             skipping the shift (the sibling will have no date)"
                        );
                        return Ok(None);
                    }
                    // Genuine `NaiveDate` / calendar-rail dead-end: still a
                    // hard error, now named accurately.
                    Err(ShiftFailure::Overflow) => {
                        return Err(AppError::validation(format!(
                            "recurrence ++ date arithmetic overflow: original={original} \
                             interval={interval} at={current}"
                        )));
                    }
                };
                current = next;
                if current > today {
                    hit_cap = false;
                    break;
                }
            }
            if hit_cap {
                // Cap exhausted without catching up to
                // today; previously returned a stale past date.
                return Err(AppError::validation(format!(
                    "recurrence ++ cap exceeded: original={original} interval={interval} today={today}"
                )));
            }
            current
        }
        _ => {
            // Default: shift from original date once. Parse failures
            // stay on the `Ok(None)` channel (existing contract).
            let Some(s) = shift_date_once(original, interval) else {
                return Ok(None);
            };
            s
        }
    };

    Ok(Some(shifted.format("%Y-%m-%d").to_string()))
}

#[cfg(test)]
mod tests_m80 {
    //! Table-driven tests for `+Ny` (yearly) recurrence support.

    use super::shift_date;

    #[test]
    fn shift_date_yearly_table() {
        // (input_date, rule, expected_result, description)
        let cases: &[(&str, &str, Option<&str>, &str)] = &[
            // Plain yearly shift on a non-leap-edge date
            (
                "2025-04-26",
                "+1y",
                Some("2026-04-26"),
                "+1y from 2025-04-26 → 2026-04-26",
            ),
            // Leap day → next non-leap year clamps to Feb 28
            (
                "2024-02-29",
                "+1y",
                Some("2025-02-28"),
                "+1y from 2024-02-29 (leap) → 2025-02-28 (no Feb 29 in 2025)",
            ),
            // Leap day → next leap year keeps Feb 29
            (
                "2028-02-29",
                "+4y",
                Some("2032-02-29"),
                "+4y from 2028-02-29 (leap) → 2032-02-29 (also leap)",
            ),
            (
                "2024-02-29",
                "+4y",
                Some("2028-02-29"),
                "+4y from 2024-02-29 (leap) → 2028-02-29 (also leap)",
            ),
            // Multi-year shift on a year-end date
            (
                "2025-12-31",
                "+2y",
                Some("2027-12-31"),
                "+2y from 2025-12-31 → 2027-12-31",
            ),
            // Zero count: matches `+0d`/`+0w`/`+0m` behaviour (returns None;
            // Org-mode recurrence never goes "nowhere").
            (
                "2025-04-26",
                "+0y",
                None,
                "+0y returns None (matches m/w/d zero-count behaviour)",
            ),
            // Negative count: matches `+-1d` etc., rejected at parse time.
            ("2025-04-26", "+-1y", None, "+-1y (negative) returns None"),
            // Malformed numeric portion
            (
                "2025-04-26",
                "+abcy",
                None,
                "+abcy (non-numeric count) returns None",
            ),
        ];

        for (date, rule, expected, desc) in cases {
            // `shift_date` returns
            // `Result<Option<String>, AppError>`. None of these table
            // cases exercise the `++` arm, so all rows expect `Ok(_)`;
            // the `Option` then captures the parse-success vs
            // parse-failure split that the table was designed around.
            let actual = shift_date(date, rule).expect("non-`++` rules never return Err");
            let expected_owned = expected.map(std::string::ToString::to_string);
            assert_eq!(actual, expected_owned, "{desc}");
        }
    }
}

#[cfg(test)]
mod repeat_rule_validation_tests_3647 {
    //! (#3647) The write-time `repeat` gate, tested where BOTH downstream
    //! consumers of the grammar are visible: the completion-time string
    //! shifter ([`shift_date`]) and the read-time projector
    //! ([`project_block_dates`]).
    //!
    //! The headline test is the differential: for every rule in a corpus
    //! spanning the whole documented grammar plus a spread of real typos, the
    //! validator's verdict must equal "recurrence actually does something with
    //! this rule". That is the property the issue asks for — a validator that
    //! is stricter than the engine silently refuses rules that work, and one
    //! that is looser puts the failure back where the user cannot see it.

    use super::{REPEAT_RULE_HELP, shift_date, validate_repeat_rule};
    use agaric_core::error::{AppError, ValidationCode};
    use agaric_store::recurrence_math::project_block_dates;

    /// Every rule form the app can produce or a user can plausibly type.
    /// Large counts that leave the `[1900, 2200]` calendar rail are excluded
    /// deliberately: they are well-formed rules whose ARITHMETIC dead-ends,
    /// a distinction covered by
    /// `recurrence_math::repeat_rule_shape_tests::arithmetic_overflow_is_not_a_grammar_error`.
    const CORPUS: &[&str] = &[
        // --- the documented vocabulary -------------------------------
        "daily",
        "weekly",
        "monthly",
        "yearly",
        "+1d",
        "+3d",
        "+2w",
        "+6m",
        "+1y",
        "1d",
        "3w",
        "2m",
        "1y",
        ".+daily",
        ".+weekly",
        ".+monthly",
        ".+yearly",
        ".+1d",
        ".+3w",
        ".+2m",
        "++daily",
        "++weekly",
        "++monthly",
        "++yearly",
        "++1d",
        "++2w",
        "++6m",
        // --- normalization ------------------------------------------
        "  daily  ",
        "DAILY",
        "++2W",
        // --- typos and junk ------------------------------------------
        "",
        "   ",
        "+",
        "++",
        ".+",
        "+daily",
        "+weekly",
        "+yearly",
        "++ 1d",
        ".+ 1w",
        "2 w",
        "+0d",
        "0w",
        "-1d",
        "+-3w",
        "3.5d",
        "5x",
        "12q",
        "w",
        "+d",
        "invalid",
        "++2weeks",
        "FREQ=DAILY",
        "every day",
    ];

    /// A base date one day in the past: near enough that the clock-consulting
    /// `++` arm catches up in a single step (no 10 000-iteration cap, no
    /// calendar-rail overflow) for every count in the corpus.
    fn base() -> chrono::NaiveDate {
        chrono::Local::now().date_naive() - chrono::Duration::days(1)
    }

    /// Does the completion-time shifter produce a next occurrence?
    fn shifter_honours(rule: &str) -> bool {
        let base_str = base().format("%Y-%m-%d").to_string();
        matches!(shift_date(&base_str, rule), Ok(Some(_)))
    }

    /// Does the read-time projector emit at least one occurrence?
    fn projector_emits(rule: &str) -> bool {
        let today = chrono::Local::now().date_naive();
        let base_str = base().format("%Y-%m-%d").to_string();
        let mut emitted = 0usize;
        project_block_dates(
            Some(&base_str),
            None,
            rule,
            None,
            None,
            today,
            today - chrono::Duration::days(2),
            today + chrono::Duration::days(800),
            Some(2),
            |_date, _source| emitted += 1,
        );
        emitted > 0
    }

    /// THE agreement test. `validate_repeat_rule` must accept a rule if and
    /// only if the recurrence engine honours it — no second grammar, no
    /// drift. It holds by construction (the validator runs the production
    /// interval parser rather than describing it); this pins that
    /// construction against both consumers so a future edit to either side
    /// cannot quietly separate them.
    #[test]
    fn validator_accepts_exactly_what_recurrence_honours_3647() {
        for rule in CORPUS {
            let accepted = validate_repeat_rule(rule).is_ok();
            assert_eq!(
                accepted,
                shifter_honours(rule),
                "`{rule}`: the write-time gate and the completion-time shifter \
                 disagree (accepted={accepted})"
            );
            assert_eq!(
                accepted,
                projector_emits(rule),
                "`{rule}`: the write-time gate and the read-time projector \
                 disagree (accepted={accepted})"
            );
        }
    }

    /// Regression floor: every form the shipped UI can write must survive the
    /// gate. A validator that is too strict is the real risk here — it would
    /// break slash commands that work today.
    #[test]
    fn every_shipped_repeat_form_is_accepted_3647() {
        // The exact `value_text` each `/repeat-*` slash command writes
        // (`REPEAT_COMMANDS` in src/lib/slash-commands.ts → `handleRepeat`),
        // plus the numeric forms `formatRepeatLabel` renders and the two
        // examples in the property drawer's syntax-help popover
        // (`property.repeatHelpExample`).
        let shipped = [
            "daily",
            "weekly",
            "monthly",
            "yearly",
            ".+daily",
            ".+weekly",
            ".+monthly",
            "++daily",
            "++weekly",
            "++monthly",
            // `formatRepeatLabel`'s custom-interval branch: /^(\d+)([dwmy])$/
            // with and without the `+`, under each anchoring prefix.
            "+3d",
            "3d",
            "+2w",
            "2w",
            "+2m",
            "2m",
            "+2y",
            "2y",
            ".+1w",
            "++1d",
        ];
        for rule in shipped {
            assert!(
                validate_repeat_rule(rule).is_ok(),
                "`{rule}` is written by the shipped UI and MUST stay accepted: {:?}",
                validate_repeat_rule(rule)
            );
        }
    }

    /// The rejection has to tell the user what is wrong with THEIR rule, not
    /// merely that something is: the offending text, a specific reason, and
    /// the accepted vocabulary. And it must be machine-discriminable so the
    /// frontend can show it instead of a generic toast.
    #[test]
    fn rejection_names_the_rule_the_reason_and_the_vocabulary_3647() {
        let cases: &[(&str, &str)] = &[
            ("++ 1d", "space"),
            ("+daily", "no `+`"),
            ("+0d", "1 or more"),
            ("5x", "one of d, w, m, y"),
            ("++2weeks", "not a keyword"),
            ("++", "not followed by an interval"),
            ("   ", "empty"),
        ];
        for (rule, reason_fragment) in cases {
            let err = validate_repeat_rule(rule).expect_err("must be rejected");
            assert_eq!(
                err.validation_code(),
                Some(ValidationCode::InvalidRepeatRule),
                "`{rule}` must carry the coded sub-kind so the frontend can \
                 surface the message verbatim"
            );
            let AppError::Validation { message, .. } = &err else {
                panic!("expected a Validation error for `{rule}`, got {err:?}");
            };
            assert!(
                message.contains(reason_fragment),
                "`{rule}`: message must explain the problem (`{reason_fragment}`), got: {message}"
            );
            assert!(
                message.contains(REPEAT_RULE_HELP),
                "`{rule}`: message must list the accepted vocabulary, got: {message}"
            );
            // The user's own text is echoed so a toast is self-contained.
            let trimmed = rule.trim();
            assert!(
                trimmed.is_empty() || message.contains(trimmed),
                "`{rule}`: message must echo the offending rule, got: {message}"
            );
        }
    }

    /// A pathological value must not produce a pathological toast.
    #[test]
    fn absurdly_long_rule_is_elided_in_the_message_3647() {
        let long = "z".repeat(5_000);
        let err = validate_repeat_rule(&long).expect_err("junk must be rejected");
        let AppError::Validation { message, .. } = &err else {
            panic!("expected a Validation error, got {err:?}");
        };
        assert!(
            message.len() < 500,
            "the message must elide an oversized rule, got {} chars",
            message.len()
        );
        assert!(
            message.contains('…'),
            "elision must be marked, got: {message}"
        );
    }
}
