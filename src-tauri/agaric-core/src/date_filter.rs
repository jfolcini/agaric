//! Leaf date-filter value types for the `search_blocks` family.
//!
//! [`DateFilter`] / [`NamedDateRange`] / [`DateOp`] are self-contained wire
//! shapes — plain enums deriving only `serde` + `specta::Type`, with no
//! reference to any store/engine type. They moved DOWN into `agaric-core`
//! (#2633) from `agaric_store::search_types`, where the composite
//! `SearchFilter` (which couples to `SpaceScope` / `LastEditedSpec`) still
//! lives and re-exports these three (`pub use agaric_core::date_filter::…`).
//! Every `crate::search_types::DateFilter` / `agaric_store::search_types::…`
//! / `crate::commands::queries::…` call site — and the `tauri-specta`
//! collection — resolves unchanged, and the generated TS bindings stay
//! byte-for-byte identical (specta keys the emitted type on its name, not its
//! defining crate).

use serde::{Deserialize, Serialize};
use specta::Type;

/// Date-filter shape used by [`SearchFilter::due_filter`] /
/// [`SearchFilter::scheduled_filter`].
///
/// Two variants:
///
/// - [`DateFilter::Named`] — bucket keyword resolved at query time
///   against `chrono::Local::today()` (or the cell-injected clock in
///   tests). Vocabulary: `overdue`, `today`, `yesterday`, `this-week`,
///   `this-month`, `next-week`, `older`, `none`. Unknown keywords are
///   rejected as an `InvalidDateFilter`-coded validation error (#2251).
/// - [`DateFilter::Op`] — explicit comparison operator (`<`, `<=`, `=`,
///   `>=`, `>`) followed by an ISO `YYYY-MM-DD` date. The frontend
///   parser accepts the same shape (`due:>=2026-01-01`).
///
/// `#[serde(rename_all = "camelCase")]` on the enum variants keeps the
/// wire shape ergonomic for the TS side: the AST projection emits
/// `{ named: "today" }` or `{ op: { op: "gte", date: "2026-01-01" } }`.
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DateFilter {
    /// Named bucket — resolved to a date predicate at query time.
    Named(NamedDateRange),
    /// Explicit comparison operator + ISO date.
    Op {
        /// One of [`DateOp::Lt`] / [`DateOp::Lte`] / [`DateOp::Eq`] /
        /// [`DateOp::Gte`] / [`DateOp::Gt`].
        op: DateOp,
        /// ISO `YYYY-MM-DD`. Calendar-validated at the SQL composition
        /// boundary; invalid dates yield `Validation` errors coded `InvalidDateFilter
        /// …")`.
        date: String,
    },
}

/// Named date buckets recognised by [`DateFilter::Named`].
///
/// Resolution semantics (today = `chrono::Local::today()`):
///
/// - `Overdue`   → column `< today AND column IS NOT NULL`.
/// - `Today`     → column `= today`.
/// - `Yesterday` → column `= today - 1d`.
/// - `ThisWeek`  → column `BETWEEN start_of_week AND end_of_week` (Mon..Sun).
/// - `ThisMonth` → column `BETWEEN start_of_month AND end_of_month`.
/// - `NextWeek`  → column `BETWEEN start_of_next_week AND end_of_next_week`.
/// - `Older`     → column `< today - 30d AND column IS NOT NULL`.
/// - `None`      → column `IS NULL`. Used by `state:none` analogue —
///   "show blocks with no scheduled/due date".
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NamedDateRange {
    Overdue,
    Today,
    Yesterday,
    ThisWeek,
    ThisMonth,
    NextWeek,
    Older,
    None,
}

/// Comparison operator for [`DateFilter::Op`]. Mirrors the
/// frontend parser shape (`<`, `<=`, `=`, `>=`, `>`).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DateOp {
    Lt,
    Lte,
    Eq,
    Gte,
    Gt,
}

impl DateOp {
    /// SQL operator string.
    #[must_use]
    pub fn as_sql(self) -> &'static str {
        match self {
            DateOp::Lt => "<",
            DateOp::Lte => "<=",
            DateOp::Eq => "=",
            DateOp::Gte => ">=",
            DateOp::Gt => ">",
        }
    }
}
