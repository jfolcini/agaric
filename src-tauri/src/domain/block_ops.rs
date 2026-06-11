//! Neutral tx-scoped / domain helpers (#642).
//!
//! Holds the cleanly-movable block-domain helpers that lower layers need
//! without reaching up into `crate::commands`. Currently the pure ISO-date
//! validators consumed by `crate::recurrence` (and the command surface).
//!
//! ## What lives here vs what stayed in `commands`
//!
//! - **Moved here**: [`validate_date_format`] and [`is_valid_iso_date`] —
//!   both pure (only `AppError` + `chrono`), no DB / op_log / payload
//!   coupling, and [`is_valid_iso_date`] is one of the three symbols
//!   `recurrence/compute.rs` imported from `crate::commands`.
//! - **Stayed in `commands::blocks::crud`** (TODO(#642 follow-up)):
//!   `create_block_in_tx` and `set_property_in_tx`. Despite the
//!   `…_in_tx` names they are the *command cores* for create-block and
//!   set-property: they build `OpPayload` / `CreateBlockPayload` /
//!   `SetPropertyPayload`, append to the `op_log`, call command-local
//!   validators (`validate_property_value`), and depend on
//!   `is_reserved_property_key`, the `ancestors_cte_standard!` macro and
//!   the `recompute_pages_cache_counts_for_pages` materializer path. They
//!   are NOT pure "tx + db row" helpers, so moving them would be a large,
//!   high-ripple change for no extra cycle-break benefit (the
//!   `commands → fts → domain` edge is already one-way once the search
//!   types and `is_valid_iso_date` move). They remain re-exportable from
//!   `crate::commands` for `recurrence`, which keeps importing those two
//!   from `crate::commands` — see the issue follow-up note.

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
/// MAINT-163: chrono's `%Y-%m-%d` accepts non-zero-padded forms like
/// `2025-1-1` and 2-digit years like `25-1-1`. Pre-validate the strict
/// shape (`\d{4}-\d{2}-\d{2}`) before delegating calendar validity to
/// chrono — otherwise these slip through and downstream callers get
/// surprising "valid" dates that the canonical date format invariant
/// rejects.
pub(crate) fn validate_date_format(s: &str) -> Result<(), AppError> {
    let bytes = s.as_bytes();
    let shape_ok = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !shape_ok {
        return Err(AppError::Validation(format!(
            "expected YYYY-MM-DD format with calendar-valid date, got '{s}'"
        )));
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| {
            AppError::Validation(format!(
                "expected YYYY-MM-DD format with calendar-valid date, got '{s}'"
            ))
        })
}

/// I-CommandsCRUD-8: previously a separate structural validator that
/// drifted from `validate_date_format`. Now delegates so there is one
/// source of truth for ISO-date validation across the commands surface.
pub(crate) fn is_valid_iso_date(s: &str) -> bool {
    validate_date_format(s).is_ok()
}
