//! Pure ISO-date (`YYYY-MM-DD`) validators.
//!
//! Foundation-shaped date-string validation shared by the block write-path
//! (`agaric_engine::block_ops`), the recurrence projector
//! (`agaric_engine::recurrence`), and the app command surface
//! (`crate::commands::{journal, agenda, properties, blocks::queries}`). They
//! depend only on [`crate::error::AppError`] + `chrono`, so they sit at the
//! bottom of the DAG (#2633) rather than in the engine layer where they used
//! to live (`agaric_engine::block_ops`). `agaric_engine::block_ops` re-exports
//! both (`pub use agaric_core::date_validation::…`) so every existing
//! `block_ops::validate_date_format` / `crate::domain::block_ops::…` call site
//! resolves unchanged.

use crate::error::AppError;

/// Validate that `s` parses as a calendar-valid `YYYY-MM-DD` date.
///
/// I-CommandsCRUD-6: previously did only structural validation (month
/// 01–12, day 01–31) and explicitly accepted impossible combinations
/// (Feb 30, Apr 31), relying on downstream callers to handle them. The
/// agenda path (`list_projected_agenda_inner`) re-parsed via
/// `NaiveDate::parse_from_str` and rejected with a different error
/// shape — inconsistent failure for the same input depending on which
/// command consumed it.
///
/// Now uses `NaiveDate::parse_from_str` directly so impossible dates
/// are rejected at the boundary with a single canonical error message.
/// The agenda re-parse becomes redundant and can be removed in a
/// follow-up; this change keeps the validator's return type stable so
/// existing callers don't need updating.
///
/// Chrono's `%Y-%m-%d` accepts non-zero-padded forms like
/// `2025-1-1` and 2-digit years like `25-1-1`. Pre-validate the strict
/// shape (`\d{4}-\d{2}-\d{2}`) before delegating calendar validity to
/// chrono — otherwise these slip through and downstream callers get
/// surprising "valid" dates that the canonical date format invariant
/// rejects.
pub fn validate_date_format(s: &str) -> Result<(), AppError> {
    let bytes = s.as_bytes();
    let shape_ok = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !shape_ok {
        return Err(AppError::validation(format!(
            "expected YYYY-MM-DD format with calendar-valid date, got '{s}'"
        )));
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| {
            AppError::validation(format!(
                "expected YYYY-MM-DD format with calendar-valid date, got '{s}'"
            ))
        })
}

/// I-CommandsCRUD-8: previously a separate structural validator that
/// drifted from `validate_date_format`. Now delegates so there is one
/// source of truth for ISO-date validation across the commands surface.
pub fn is_valid_iso_date(s: &str) -> bool {
    validate_date_format(s).is_ok()
}

#[cfg(test)]
mod tests {
    use super::{is_valid_iso_date, validate_date_format};

    #[test]
    fn rejects_impossible_calendar_dates() {
        // Feb 30 / Apr 31 are structurally shaped but calendar-invalid; the
        // pre-#642 structural-only validator accepted them.
        assert!(validate_date_format("2025-02-30").is_err());
        assert!(validate_date_format("2025-04-31").is_err());
    }

    #[test]
    fn leap_year_rules() {
        // 2024 is a leap year (Feb 29 valid); 2025 is not.
        assert!(validate_date_format("2024-02-29").is_ok());
        assert!(validate_date_format("2025-02-29").is_err());
    }

    #[test]
    fn rejects_non_strict_shapes() {
        // chrono's `%Y-%m-%d` alone would accept these; the strict shape
        // pre-check rejects non-zero-padded / short-year forms.
        for bad in [
            "2025-1-1",
            "25-1-1",
            "2025/01/01",
            "2025-01-01T00:00:00",
            "",
        ] {
            assert!(
                validate_date_format(bad).is_err(),
                "expected `{bad}` to be rejected"
            );
        }
    }

    #[test]
    fn accepts_valid_iso_dates() {
        for good in ["2025-01-01", "2000-12-31", "2026-07-18"] {
            assert!(
                validate_date_format(good).is_ok(),
                "expected `{good}` to be valid"
            );
        }
    }

    #[test]
    fn is_valid_iso_date_delegates_to_validate_date_format() {
        // The two must never drift: `is_valid_iso_date` is a thin `.is_ok()`
        // over `validate_date_format` (I-CommandsCRUD-8).
        for input in ["2025-01-01", "2025-02-30", "2025-1-1", "not-a-date"] {
            assert_eq!(
                is_valid_iso_date(input),
                validate_date_format(input).is_ok(),
                "delegation invariant broken for `{input}`"
            );
        }
    }
}
