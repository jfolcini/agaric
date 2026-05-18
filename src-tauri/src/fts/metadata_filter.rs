//! PEND-53 — state / priority / due / scheduled / property predicate
//! SQL composition for `search_blocks`.
//!
//! Sits next to [`super::glob_filter`] in shape: a pure pre-processing
//! helper that turns the wire-side `SearchFilter` fields into a
//! [`MetadataPredicates`] bundle ready to be appended to the dynamic
//! SQL emitted by [`super::search::search_fts`] and
//! [`super::toggle_filter::regex_mode_query`].
//!
//! The work split:
//!
//! - **Validation** happens here, at the boundary, so unparseable
//!   dates / unknown bucket keywords surface as
//!   [`AppError::Validation`] with an `InvalidDateFilter:` prefix the
//!   frontend can key on (mirrors `InvalidGlob:` / `InvalidRegex:`).
//! - **SQL composition** stays in `search.rs` and `toggle_filter.rs`
//!   because the dynamic placeholder index (`?N`) is local to each
//!   query. This module hands the caller the resolved values; the
//!   caller decides which `?N` slot they land in.
//!
//! ## Date resolution
//!
//! Named buckets resolve against `chrono::Local::today()` at prepare
//! time. Tests inject a fixed `today` via [`prepare_metadata_with_today`]
//! so date-clock churn doesn't flake the snapshot suite.
//!
//! ## Property column allowlist
//!
//! v1 matches `block_properties.value_text` only (locked in by the
//! plan's "Locked-in decisions" #4 — `block_properties` has five
//! mutually-exclusive value columns per migration `0062`'s CHECK; v1
//! ships text-only for the common user-typed property case). A
//! follow-up plan revisits numeric/date/reference search.

use crate::commands::queries::{
    DateFilter, DateOp, NamedDateRange, SearchFilter, SearchPropertyFilter,
};
use crate::error::AppError;
use chrono::{Datelike, Duration, NaiveDate, Weekday};

/// Pre-validated metadata predicates ready for SQL composition.
///
/// Every field here corresponds to one new bind set the dynamic SQL
/// builders in `search.rs` / `toggle_filter.rs` append after the
/// existing glob/space/tag clauses. The caller threads the field
/// values into the next available placeholder slot.
#[derive(Debug, Clone, Default)]
pub struct MetadataPredicates {
    /// Resolved `state_filter` — empty means "no filter". The literal
    /// keyword `none` (case-insensitive) is split out into
    /// [`Self::state_is_null`] so the SQL emits a proper `IS NULL`
    /// branch instead of comparing `todo_state = 'none'`. Note: a
    /// real custom state literally named `"none"` is treated as the
    /// sentinel — documented in `docs/SEARCH.md`.
    pub state_values: Vec<String>,
    pub state_is_null: bool,
    /// Resolved `priority_filter` — same `none`-sentinel handling as
    /// [`Self::state_values`].
    pub priority_values: Vec<String>,
    pub priority_is_null: bool,
    /// Resolved due-date predicate. `Some(DatePredicate::IsNull)` means
    /// "due_date IS NULL"; `Some(DatePredicate::Range { ... })` is the
    /// inclusive `[from, to]` window for bucket keywords; `Some(Op
    /// { ... })` is the comparison-form. `None` means "no filter".
    pub due: Option<DatePredicate>,
    /// Resolved scheduled-date predicate. Same shape as [`Self::due`].
    pub scheduled: Option<DatePredicate>,
    /// AND-joined include property predicates. Each entry becomes one
    /// `EXISTS (SELECT 1 FROM block_properties …)` sub-select.
    pub property_includes: Vec<SearchPropertyFilter>,
    /// AND-joined exclude property predicates. Each entry becomes one
    /// `NOT EXISTS (...)` sub-select.
    pub property_excludes: Vec<SearchPropertyFilter>,
}

/// Resolved date predicate ready for SQL composition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatePredicate {
    /// `column IS NULL`.
    IsNull,
    /// `column BETWEEN ? AND ?` — inclusive both ends, ISO dates.
    Range { from: String, to: String },
    /// `column <op> ?` — comparison-form filter.
    Op { op: DateOp, date: String },
}

impl MetadataPredicates {
    /// `true` iff every field is the empty default — the SQL builder
    /// short-circuits the whole metadata-clause block in that case.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.state_values.is_empty()
            && !self.state_is_null
            && self.priority_values.is_empty()
            && !self.priority_is_null
            && self.due.is_none()
            && self.scheduled.is_none()
            && self.property_includes.is_empty()
            && self.property_excludes.is_empty()
    }
}

/// Top-level entry: resolve [`SearchFilter`]'s metadata fields against
/// today's date.
///
/// # Errors
///
/// Returns [`AppError::Validation`] with an `InvalidDateFilter:` prefix
/// for any unparseable ISO date or unknown bucket keyword.
pub fn prepare_metadata(filter: &SearchFilter) -> Result<MetadataPredicates, AppError> {
    let today = chrono::Local::now().date_naive();
    prepare_metadata_with_today(filter, today)
}

/// Test-injected `today` variant of [`prepare_metadata`]. Production
/// callers use the top-level entry; tests pin a fixed date to keep the
/// snapshot suite stable.
pub fn prepare_metadata_with_today(
    filter: &SearchFilter,
    today: NaiveDate,
) -> Result<MetadataPredicates, AppError> {
    let mut out = MetadataPredicates::default();

    // state_filter — split out the `none` sentinel.
    for s in &filter.state_filter {
        if s.eq_ignore_ascii_case("none") {
            out.state_is_null = true;
        } else {
            out.state_values.push(s.clone());
        }
    }

    // priority_filter — same shape.
    for p in &filter.priority_filter {
        if p.eq_ignore_ascii_case("none") {
            out.priority_is_null = true;
        } else {
            out.priority_values.push(p.clone());
        }
    }

    if let Some(df) = &filter.due_filter {
        out.due = Some(resolve_date_filter(df, today)?);
    }
    if let Some(df) = &filter.scheduled_filter {
        out.scheduled = Some(resolve_date_filter(df, today)?);
    }

    // Property filters carry through verbatim; SQL composition site
    // handles the EXISTS / NOT EXISTS construction.
    out.property_includes = filter.property_filters.clone();
    out.property_excludes = filter.excluded_property_filters.clone();

    Ok(out)
}

/// Resolve one [`DateFilter`] into a [`DatePredicate`].
fn resolve_date_filter(df: &DateFilter, today: NaiveDate) -> Result<DatePredicate, AppError> {
    match df {
        DateFilter::Named(range) => Ok(resolve_named_range(*range, today)),
        DateFilter::Op { op, date } => {
            let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| {
                AppError::Validation(format!(
                    "InvalidDateFilter: expected YYYY-MM-DD, got '{date}'"
                ))
            })?;
            Ok(DatePredicate::Op {
                op: *op,
                date: parsed.format("%Y-%m-%d").to_string(),
            })
        }
    }
}

/// Resolve a [`NamedDateRange`] to a concrete [`DatePredicate`] given
/// `today`. Weeks are Mon..Sun (the convention agenda views already use
/// — see `chrono::Weekday::Mon` references in agenda/property tests).
fn resolve_named_range(range: NamedDateRange, today: NaiveDate) -> DatePredicate {
    let to_iso = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    match range {
        NamedDateRange::None => DatePredicate::IsNull,
        NamedDateRange::Today => DatePredicate::Range {
            from: to_iso(today),
            to: to_iso(today),
        },
        NamedDateRange::Yesterday => {
            let y = today - Duration::days(1);
            DatePredicate::Range {
                from: to_iso(y),
                to: to_iso(y),
            }
        }
        NamedDateRange::Overdue => DatePredicate::Op {
            op: DateOp::Lt,
            date: to_iso(today),
        },
        NamedDateRange::Older => {
            // 30-day window — anything more than 30 days in the past.
            let cutoff = today - Duration::days(30);
            DatePredicate::Op {
                op: DateOp::Lt,
                date: to_iso(cutoff),
            }
        }
        NamedDateRange::ThisWeek => {
            let monday = monday_of(today);
            let sunday = monday + Duration::days(6);
            DatePredicate::Range {
                from: to_iso(monday),
                to: to_iso(sunday),
            }
        }
        NamedDateRange::NextWeek => {
            let monday = monday_of(today) + Duration::days(7);
            let sunday = monday + Duration::days(6);
            DatePredicate::Range {
                from: to_iso(monday),
                to: to_iso(sunday),
            }
        }
        NamedDateRange::ThisMonth => {
            let first = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
            // Last day of month: first day of next month - 1.
            let (ny, nm) = if today.month() == 12 {
                (today.year() + 1, 1)
            } else {
                (today.year(), today.month() + 1)
            };
            let last = NaiveDate::from_ymd_opt(ny, nm, 1)
                .map(|d| d - Duration::days(1))
                .unwrap_or(today);
            DatePredicate::Range {
                from: to_iso(first),
                to: to_iso(last),
            }
        }
    }
}

/// Append the metadata-predicate SQL clauses to `sql` and return the
/// ordered list of bind values the caller must `.bind()` after the
/// existing positional parameters.
///
/// `next_param` is mutated in lock-step so the caller can keep
/// appending further clauses after this. `block_alias` is the parent
/// table alias (`"b"` in `search_fts`; same in `regex_mode_query`).
///
/// The SQL shape mirrors the plan's design section:
///
/// ```text
/// AND <state IS NULL / IN (...) clause>
/// AND <priority IS NULL / IN (...) clause>
/// AND <due_date predicate>
/// AND <scheduled_date predicate>
/// AND EXISTS (SELECT 1 FROM block_properties …)   -- include
/// AND NOT EXISTS (SELECT 1 FROM block_properties …) -- exclude
/// ```
///
/// Each `EXISTS` carries its own `key=?` / `value_text=?` clause; the
/// `(key, value_text)` partial index `idx_block_props_key_text`
/// (migration 0004) covers it.
pub fn append_metadata_sql(
    sql: &mut String,
    next_param: &mut usize,
    meta: &MetadataPredicates,
    block_alias: &str,
) -> Vec<String> {
    let mut binds: Vec<String> = Vec::new();

    // state ------------------------------------------------------------
    append_text_in_or_null(
        sql,
        next_param,
        &mut binds,
        &meta.state_values,
        meta.state_is_null,
        &format!("{block_alias}.todo_state"),
    );

    // priority ---------------------------------------------------------
    append_text_in_or_null(
        sql,
        next_param,
        &mut binds,
        &meta.priority_values,
        meta.priority_is_null,
        &format!("{block_alias}.priority"),
    );

    // due_date ---------------------------------------------------------
    if let Some(pred) = &meta.due {
        append_date_predicate(
            sql,
            next_param,
            &mut binds,
            pred,
            &format!("{block_alias}.due_date"),
        );
    }

    // scheduled_date ---------------------------------------------------
    if let Some(pred) = &meta.scheduled {
        append_date_predicate(
            sql,
            next_param,
            &mut binds,
            pred,
            &format!("{block_alias}.scheduled_date"),
        );
    }

    // property includes ------------------------------------------------
    for pf in &meta.property_includes {
        let key_idx = *next_param;
        *next_param += 1;
        if pf.value.is_empty() {
            // Key presence only.
            sql.push_str(&format!(
                "\n           AND EXISTS (SELECT 1 FROM block_properties bp \
                  WHERE bp.block_id = {block_alias}.id AND bp.key = ?{key_idx})"
            ));
            binds.push(pf.key.clone());
        } else {
            let val_idx = *next_param;
            *next_param += 1;
            sql.push_str(&format!(
                "\n           AND EXISTS (SELECT 1 FROM block_properties bp \
                  WHERE bp.block_id = {block_alias}.id \
                    AND bp.key = ?{key_idx} \
                    AND bp.value_text = ?{val_idx})"
            ));
            binds.push(pf.key.clone());
            binds.push(pf.value.clone());
        }
    }

    // property excludes ------------------------------------------------
    for pf in &meta.property_excludes {
        let key_idx = *next_param;
        *next_param += 1;
        if pf.value.is_empty() {
            sql.push_str(&format!(
                "\n           AND NOT EXISTS (SELECT 1 FROM block_properties bp \
                  WHERE bp.block_id = {block_alias}.id AND bp.key = ?{key_idx})"
            ));
            binds.push(pf.key.clone());
        } else {
            let val_idx = *next_param;
            *next_param += 1;
            sql.push_str(&format!(
                "\n           AND NOT EXISTS (SELECT 1 FROM block_properties bp \
                  WHERE bp.block_id = {block_alias}.id \
                    AND bp.key = ?{key_idx} \
                    AND bp.value_text = ?{val_idx})"
            ));
            binds.push(pf.key.clone());
            binds.push(pf.value.clone());
        }
    }

    binds
}

fn append_text_in_or_null(
    sql: &mut String,
    next_param: &mut usize,
    binds: &mut Vec<String>,
    values: &[String],
    is_null: bool,
    column: &str,
) {
    if values.is_empty() && !is_null {
        return;
    }
    // Build the disjunction: (column IN (?, ?, ...) OR column IS NULL).
    let mut parts: Vec<String> = Vec::new();
    if !values.is_empty() {
        let placeholders: Vec<String> = values
            .iter()
            .map(|_| {
                let idx = *next_param;
                *next_param += 1;
                format!("?{idx}")
            })
            .collect();
        parts.push(format!("{column} IN ({})", placeholders.join(", ")));
        for v in values {
            binds.push(v.clone());
        }
    }
    if is_null {
        parts.push(format!("{column} IS NULL"));
    }
    sql.push_str(&format!("\n           AND ({})", parts.join(" OR ")));
}

fn append_date_predicate(
    sql: &mut String,
    next_param: &mut usize,
    binds: &mut Vec<String>,
    pred: &DatePredicate,
    column: &str,
) {
    match pred {
        DatePredicate::IsNull => {
            sql.push_str(&format!("\n           AND {column} IS NULL"));
        }
        DatePredicate::Range { from, to } => {
            let from_idx = *next_param;
            *next_param += 1;
            let to_idx = *next_param;
            *next_param += 1;
            sql.push_str(&format!(
                "\n           AND {column} IS NOT NULL AND {column} BETWEEN ?{from_idx} AND ?{to_idx}"
            ));
            binds.push(from.clone());
            binds.push(to.clone());
        }
        DatePredicate::Op { op, date } => {
            let idx = *next_param;
            *next_param += 1;
            sql.push_str(&format!(
                "\n           AND {column} IS NOT NULL AND {column} {} ?{idx}",
                op.as_sql()
            ));
            binds.push(date.clone());
        }
    }
}

fn monday_of(d: NaiveDate) -> NaiveDate {
    let offset = match d.weekday() {
        Weekday::Mon => 0,
        Weekday::Tue => 1,
        Weekday::Wed => 2,
        Weekday::Thu => 3,
        Weekday::Fri => 4,
        Weekday::Sat => 5,
        Weekday::Sun => 6,
    };
    d - Duration::days(offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::queries::{NamedDateRange, SearchFilter};

    fn fixed_today() -> NaiveDate {
        // 2026-05-18 is a Monday — pinned so `this-week` math is stable.
        NaiveDate::from_ymd_opt(2026, 5, 18).unwrap()
    }

    #[test]
    fn empty_filter_yields_empty_predicates() {
        let f = SearchFilter::default();
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert!(m.is_empty(), "default filter must be empty");
    }

    #[test]
    fn state_none_routes_to_is_null() {
        let f = SearchFilter {
            state_filter: vec!["TODO".into(), "none".into()],
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert_eq!(m.state_values, vec!["TODO".to_string()]);
        assert!(m.state_is_null);
    }

    #[test]
    fn priority_case_insensitive_none() {
        let f = SearchFilter {
            priority_filter: vec!["NONE".into()],
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert!(m.priority_is_null);
        assert!(m.priority_values.is_empty());
    }

    #[test]
    fn due_named_today_resolves_to_range() {
        let f = SearchFilter {
            due_filter: Some(DateFilter::Named(NamedDateRange::Today)),
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert_eq!(
            m.due,
            Some(DatePredicate::Range {
                from: "2026-05-18".into(),
                to: "2026-05-18".into(),
            })
        );
    }

    #[test]
    fn due_overdue_resolves_to_lt_today() {
        let f = SearchFilter {
            due_filter: Some(DateFilter::Named(NamedDateRange::Overdue)),
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert_eq!(
            m.due,
            Some(DatePredicate::Op {
                op: DateOp::Lt,
                date: "2026-05-18".into(),
            })
        );
    }

    #[test]
    fn due_this_week_mon_sun_range() {
        let f = SearchFilter {
            due_filter: Some(DateFilter::Named(NamedDateRange::ThisWeek)),
            ..Default::default()
        };
        // 2026-05-18 is a Monday — start of the week.
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert_eq!(
            m.due,
            Some(DatePredicate::Range {
                from: "2026-05-18".into(),
                to: "2026-05-24".into(),
            })
        );
    }

    #[test]
    fn due_this_week_mid_week_still_resolves_to_mon_sun() {
        let f = SearchFilter {
            due_filter: Some(DateFilter::Named(NamedDateRange::ThisWeek)),
            ..Default::default()
        };
        // 2026-05-20 is a Wednesday.
        let wed = NaiveDate::from_ymd_opt(2026, 5, 20).unwrap();
        let m = prepare_metadata_with_today(&f, wed).unwrap();
        assert_eq!(
            m.due,
            Some(DatePredicate::Range {
                from: "2026-05-18".into(),
                to: "2026-05-24".into(),
            })
        );
    }

    #[test]
    fn due_this_month_resolves_to_first_last() {
        let f = SearchFilter {
            due_filter: Some(DateFilter::Named(NamedDateRange::ThisMonth)),
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert_eq!(
            m.due,
            Some(DatePredicate::Range {
                from: "2026-05-01".into(),
                to: "2026-05-31".into(),
            })
        );
    }

    #[test]
    fn due_this_month_december_rolls_over_year() {
        let f = SearchFilter {
            due_filter: Some(DateFilter::Named(NamedDateRange::ThisMonth)),
            ..Default::default()
        };
        let dec31 = NaiveDate::from_ymd_opt(2026, 12, 31).unwrap();
        let m = prepare_metadata_with_today(&f, dec31).unwrap();
        assert_eq!(
            m.due,
            Some(DatePredicate::Range {
                from: "2026-12-01".into(),
                to: "2026-12-31".into(),
            })
        );
    }

    #[test]
    fn due_op_form_validates_iso_date() {
        let f = SearchFilter {
            due_filter: Some(DateFilter::Op {
                op: DateOp::Gte,
                date: "2026-01-01".into(),
            }),
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert_eq!(
            m.due,
            Some(DatePredicate::Op {
                op: DateOp::Gte,
                date: "2026-01-01".into(),
            })
        );
    }

    #[test]
    fn due_op_form_rejects_garbage_date() {
        let f = SearchFilter {
            due_filter: Some(DateFilter::Op {
                op: DateOp::Eq,
                date: "2026-13-99".into(),
            }),
            ..Default::default()
        };
        let err = prepare_metadata_with_today(&f, fixed_today()).unwrap_err();
        match err {
            AppError::Validation(msg) => {
                assert!(
                    msg.starts_with("InvalidDateFilter:"),
                    "expected InvalidDateFilter prefix, got: {msg}"
                );
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn scheduled_named_none_routes_to_is_null() {
        let f = SearchFilter {
            scheduled_filter: Some(DateFilter::Named(NamedDateRange::None)),
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert_eq!(m.scheduled, Some(DatePredicate::IsNull));
    }

    #[test]
    fn property_filters_passthrough() {
        let f = SearchFilter {
            property_filters: vec![SearchPropertyFilter {
                key: "status".into(),
                value: "done".into(),
            }],
            excluded_property_filters: vec![SearchPropertyFilter {
                key: "archived".into(),
                value: "true".into(),
            }],
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert_eq!(m.property_includes.len(), 1);
        assert_eq!(m.property_includes[0].key, "status");
        assert_eq!(m.property_includes[0].value, "done");
        assert_eq!(m.property_excludes.len(), 1);
        assert_eq!(m.property_excludes[0].key, "archived");
    }
}
