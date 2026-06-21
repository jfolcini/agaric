//! state / priority / due / scheduled / property predicate
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
//! ## Property column matching (#properties-typed-always)
//!
//! `prop:KEY=VALUE` matching is **TYPED**: the value is parsed to the
//! single most-specific `PropertyValue` (finite `f64` → `Num`/`value_num`;
//! ISO `YYYY-MM-DD` → `Date`/`value_date`; otherwise `Text`/`value_text`;
//! `Ref` is never auto-inferred — search has no ref syntax) and compiled to
//! a SINGLE-column match through the shared
//! `SearchProjection::compile_has_property`, exactly like every other
//! surface (Pages browser, advanced query, backlinks). This module only
//! RESOLVES the property filters into the `MetadataPredicates` bundle
//! (`property_includes` / `property_excludes`); the typed inference and SQL
//! emission live in `crate::fts::filter_builder` (`infer_property_value` +
//! `add_property_via_projection`). This SUPERSEDES the previous untyped
//! four-column OR (which bound one user value four ways across
//! `value_text`/`value_num`/`value_date`/`value_ref`).

use crate::domain::search_types::{
    DateFilter, DateOp, NamedDateRange, SearchFilter, SearchPropertyFilter,
};
use crate::error::AppError;
use crate::error::validation_code::{INVALID_DATE_FILTER, prefixed};
use crate::filters::primitive::LastEditedSpec;
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
    /// Resolved `excluded_state_filter`. Empty + flag-false
    /// means "no exclusion". SQL emits
    /// `(col IS NULL OR col NOT IN (...))`; the `IS NULL` branch is
    /// always included so blocks with no state aren't accidentally
    /// excluded from a "not DONE" query. The `not-state:none`
    /// sentinel flips [`Self::excluded_state_not_null`] (and emits
    /// `col IS NOT NULL`).
    pub excluded_state_values: Vec<String>,
    pub excluded_state_not_null: bool,
    /// Symmetric to [`Self::excluded_state_values`] /
    /// [`Self::excluded_state_not_null`] for `blocks.priority`.
    pub excluded_priority_values: Vec<String>,
    pub excluded_priority_not_null: bool,
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
    /// #1320-C — resolved `last-edited:` time-window predicate. `None`
    /// means "no filter". Unlike the other fields here, this one is NOT
    /// emitted by `append_metadata_sql` — it is compiled through
    /// `SearchProjection::compile_last_edited` and spliced via the
    /// builder's `add_last_edited_via_projection` (the projection emits
    /// hardcoded `b.id` references, so it bypasses the alias-parameterised
    /// metadata SQL). Carried on this bundle purely so it threads through
    /// every search surface (FTS / regex / filter-only / partitioned)
    /// alongside the rest of the metadata, with no new function signatures.
    pub last_edited: Option<LastEditedSpec>,
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
            && self.excluded_state_values.is_empty()
            && !self.excluded_state_not_null
            && self.excluded_priority_values.is_empty()
            && !self.excluded_priority_not_null
            && self.due.is_none()
            && self.scheduled.is_none()
            && self.property_includes.is_empty()
            && self.property_excludes.is_empty()
            && self.last_edited.is_none()
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

    // Excluded_state_filter; `none` flips to `IS NOT NULL`.
    for s in &filter.excluded_state_filter {
        if s.eq_ignore_ascii_case("none") {
            out.excluded_state_not_null = true;
        } else {
            out.excluded_state_values.push(s.clone());
        }
    }

    // Excluded_priority_filter; same shape.
    for p in &filter.excluded_priority_filter {
        if p.eq_ignore_ascii_case("none") {
            out.excluded_priority_not_null = true;
        } else {
            out.excluded_priority_values.push(p.clone());
        }
    }

    if let Some(df) = &filter.due_filter {
        out.due = Some(resolve_date_filter(df, today)?);
    }
    if let Some(df) = &filter.scheduled_filter {
        out.scheduled = Some(resolve_date_filter(df, today)?);
    }

    // BE-8 — reject an empty `prop:` key, matching the
    // dedicated `query_by_property_inner` command's contract ("property
    // key must not be empty"). Without this, an empty key produced a
    // `bp.key = ''` clause that silently matches nothing — a confusing
    // no-result outcome instead of a clear validation error. We check
    // both the include and exclude sets.
    for pf in filter
        .property_filters
        .iter()
        .chain(filter.excluded_property_filters.iter())
    {
        if pf.key.trim().is_empty() {
            return Err(AppError::Validation(
                "property key must not be empty".into(),
            ));
        }
    }

    // Property filters carry through verbatim; SQL composition site
    // handles the EXISTS / NOT EXISTS construction.
    out.property_includes = filter.property_filters.clone();
    out.property_excludes = filter.excluded_property_filters.clone();

    // #1320-C — `last-edited:` window. Carried verbatim; the builder
    // splices it through `SearchProjection::compile_last_edited`. Unlike the
    // pages-view path (which runs `validate_last_edited_date`), the search
    // path does NOT pre-validate the bounds: `compile_last_edited`'s `to_ms`
    // debug-asserts and falls back to `0` on a malformed bound (release: an
    // empty result; never an injection — the bound is always a bound `?`).
    out.last_edited = filter.last_edited.clone();

    Ok(out)
}

/// Resolve one [`DateFilter`] into a [`DatePredicate`].
fn resolve_date_filter(df: &DateFilter, today: NaiveDate) -> Result<DatePredicate, AppError> {
    match df {
        DateFilter::Named(range) => Ok(resolve_named_range(*range, today)),
        DateFilter::Op { op, date } => {
            let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| {
                AppError::Validation(prefixed(
                    INVALID_DATE_FILTER,
                    &format!("expected YYYY-MM-DD, got '{date}'"),
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
            let last = NaiveDate::from_ymd_opt(ny, nm, 1).map_or(today, |d| d - Duration::days(1));
            DatePredicate::Range {
                from: to_iso(first),
                to: to_iso(last),
            }
        }
    }
}

// #properties-typed-always — the legacy untyped property SQL
// (`append_metadata_sql` + `append_property_match` + `parse_prop_value` +
// `parse_ulid` + `PropParsedValue` + the `MetaBind` nullable-bind machinery)
// has been DELETED. The search `prop:KEY=VALUE` filter previously matched a
// single user value four ways at once across `value_text`/`value_num`/
// `value_date`/`value_ref` (an untyped four-column OR). It now travels —
// like every OTHER surface (Pages browser, advanced query, backlinks) —
// through the shared TYPED `SearchProjection::compile_has_property`, which
// matches the SINGLE column chosen from the inferred `PropertyValue`. The
// `SearchPropertyFilter` → typed-`PropertyValue` inference lives in
// `crate::fts::filter_builder::infer_property_value`; the splice lives in
// `StructuralFilterBuilder::add_property_via_projection` /
// `add_excluded_property_via_projection`. `MetadataPredicates` still carries
// `property_includes` / `property_excludes` verbatim (resolved in
// `prepare_metadata_with_today`); only the SQL-emission site moved.

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
    use crate::domain::search_types::{NamedDateRange, SearchFilter, SearchPropertyFilter};

    fn fixed_today() -> NaiveDate {
        // 2026-05-18 is a Monday — pinned so `this-week` math is stable.
        NaiveDate::from_ymd_opt(2026, 5, 18).unwrap()
    }

    // #properties-typed-always — `parse_prop_value_rejects_non_finite_numbers`
    // and `property_key_is_trimmed_before_binding` were RETIRED here: the value
    // typing (incl. the #383 non-finite-rejection) and the BE-8 key-trim now
    // live in `crate::fts::filter_builder` (`infer_property_value` /
    // `add_property_predicate`) and are covered by the typed parity tests
    // there. This module no longer emits property SQL or owns `MetaBind`.

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

    /// BE-8 — an empty (or whitespace-only) `prop:` key is
    /// rejected, matching `query_by_property_inner`'s contract.
    #[test]
    fn empty_property_key_is_rejected() {
        // Empty include key.
        let f = SearchFilter {
            property_filters: vec![SearchPropertyFilter {
                key: String::new(),
                value: "x".into(),
            }],
            ..Default::default()
        };
        assert!(
            matches!(
                prepare_metadata_with_today(&f, fixed_today()),
                Err(AppError::Validation(_))
            ),
            "empty include prop key must be rejected"
        );

        // Whitespace-only exclude key.
        let f = SearchFilter {
            excluded_property_filters: vec![SearchPropertyFilter {
                key: "   ".into(),
                value: "x".into(),
            }],
            ..Default::default()
        };
        assert!(
            matches!(
                prepare_metadata_with_today(&f, fixed_today()),
                Err(AppError::Validation(_))
            ),
            "whitespace-only exclude prop key must be rejected"
        );
    }

    // -----------------------------------------------------------------
    // Excluded state / priority resolution
    // -----------------------------------------------------------------

    #[test]
    fn excluded_state_values_route_to_predicate() {
        let f = SearchFilter {
            excluded_state_filter: vec!["DONE".into(), "CANCELLED".into()],
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert_eq!(
            m.excluded_state_values,
            vec!["DONE".to_string(), "CANCELLED".to_string()]
        );
        assert!(!m.excluded_state_not_null);
        assert!(!m.is_empty());
    }

    #[test]
    fn excluded_state_none_sentinel_flips_to_not_null() {
        let f = SearchFilter {
            excluded_state_filter: vec!["none".into(), "TODO".into()],
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert!(m.excluded_state_not_null);
        assert_eq!(m.excluded_state_values, vec!["TODO".to_string()]);
    }

    #[test]
    fn excluded_priority_case_insensitive_none() {
        let f = SearchFilter {
            excluded_priority_filter: vec!["NONE".into()],
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        assert!(m.excluded_priority_not_null);
        assert!(m.excluded_priority_values.is_empty());
    }

    // #1280 B2 — the `state:` / `excluded_state` / `priority:` /
    // `excluded_priority` SQL emission moved OFF `append_metadata_sql` and onto
    // `SearchProjection::compile_state` / `compile_priority` (which delegate to
    // the canonical A2 `PagesProjection` SQL). The byte-shape of that SQL is
    // proved by A2's projection oracle tests + the `priority_*_via_projection`
    // parity tests in `fts::filter_builder`; the search-path wiring + row
    // equivalence is proved by the B2 DB tests in `fts::tests`. The former
    // `excluded_state_sql_emits_null_inclusive_not_in` /
    // `excluded_state_none_sentinel_sql_emits_is_not_null` /
    // `excluded_priority_combined_with_values_and_null_sentinel` SQL-shape
    // tests were retired here because `append_metadata_sql` no longer emits
    // state or priority. The RESOLUTION tests
    // (`excluded_state_values_route_to_predicate` /
    // `excluded_state_none_sentinel_flips_to_not_null`) remain — they cover
    // `prepare_metadata`, which is unchanged.

    // #properties-typed-always — the legacy `prop:` four-column-OR SQL tests
    // (`prop_text_value_binds_four_columns` /
    // `prop_numeric_value_binds_num_variant` /
    // `prop_iso_date_value_binds_date_variant` /
    // `prop_ulid_value_binds_ref_variant_uppercased` /
    // `prop_empty_value_is_key_presence_only` /
    // `prop_exclude_emits_not_exists_with_four_column_or` /
    // `parse_prop_value_rejects_non_ulid_strings`) were RETIRED here:
    // `append_metadata_sql` / `append_property_match` / `parse_prop_value` /
    // `parse_ulid` no longer exist. Property SQL is now compiled TYPED through
    // `SearchProjection::compile_has_property`; the replacement parity
    // snapshots live in `fts::filter_builder` (`property_*_via_projection_*`),
    // and the search-path row equivalence is proved by the typed DB tests in
    // `commands::tests::metadata_filter_tests`. The property RESOLUTION test
    // (`property_filters_passthrough`) remains above — `prepare_metadata` still
    // carries the filters verbatim into `MetadataPredicates`, unchanged.
}
