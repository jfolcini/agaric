//! Recurrence rule-string parsing — re-export shim (#2621 THE INVERSION).
//!
//! The `shift_date` rule-string wrapper moved down into
//! [`agaric_engine::recurrence`] so the recurrence-sibling core (also moved to
//! the engine) can reach it without an upward app dependency. It is re-exported
//! here so every existing `super::parser::shift_date` / `crate::recurrence::…`
//! reference in the app crate resolves unchanged.
//!
//! The pure interval-shift math it builds on
//! ([`agaric_store::recurrence_math::shift_date_once`] and the calendar-rail
//! helpers) lives one layer further down (#2621).

// Currently only the recurrence test suites (`tests::…`, `tests.rs`) reach
// `shift_date` through this path; production callers go through the moved
// recurrence core in `agaric_engine`. The re-export is kept crate-wide (rather
// than `#[cfg(test)]`) so any future `super::parser::shift_date` /
// `crate::recurrence::…` caller resolves unchanged — hence the `allow`.
#[allow(unused_imports)]
pub(crate) use agaric_engine::recurrence::shift_date;
