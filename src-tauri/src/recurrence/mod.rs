//! Recurrence (repeat-rule) logic for recurring tasks.
//!
//! This module extracts the date-shifting and recurrence state machine from
//! `commands::set_todo_state_inner` so it can be tested in isolation and
//! kept separate from the command dispatch plumbing.
//!
//! Public API consumed by the rest of the crate:
//! - [`shift_date`] — compute the next occurrence date from a rule string
//! - [`handle_recurrence`] — full recurrence flow (DB reads, end-condition
//!   checks, sibling creation) called when a task transitions to DONE
//!
//! The pure interval shift ([`agaric_store::recurrence_math::shift_date_once`]) and
//! per-block projection ([`agaric_store::recurrence_math::project_block_dates`]) live
//! one layer down in `recurrence_math` (#2621); the latter is re-exported here
//! for the app-layer callers that still reach it as `crate::recurrence::…`.
//!
//! Module layout:
//! - `parser` — pure rule-string parsing and date math (RRULE-like)
//! - `compute` — async next-occurrence flow (DB reads + sibling creation)

mod compute;
mod parser;

#[cfg(test)]
mod tests;

// Preserve the public API surface expected by callers
// (`crate::recurrence::handle_recurrence`).
// `shift_date` is currently module-internal (used only by
// `compute::handle_recurrence` and the tests inside this module).
// `handle_recurrence` (the pool-based wrapper) is no longer called from
// production after H-4 — `set_todo_state_inner` runs the recurrence inside
// its own `CommandTx` via `handle_recurrence_in_tx`. The wrapper is kept
// for tests in `compute::tests_h17_m77` and for ad-hoc consumers that
// might surface in the future; `#[allow(dead_code)]` is set on the wrapper
// itself rather than re-exporting it crate-wide and triggering a warning.
pub(crate) use compute::handle_recurrence_in_tx;
// The pure interval-shift math and per-block date projection moved down into
// `agaric_store::recurrence_math` (#2621) so the store-layer projected-agenda cache
// can reuse them without depending on this app-layer module. Only
// `project_block_dates` is still reached through this module
// (`crate::recurrence::project_block_dates`, by `commands::agenda`), so it is
// re-exported here; `shift_date_once` is consumed directly from
// `agaric_store::recurrence_math` by `parser::shift_date` and the tests, so it needs
// no re-export. The shared projection is used by both the cache rebuild and
// the on-the-fly fallback so the two paths cannot drift.
pub(crate) use agaric_store::recurrence_math::project_block_dates;
