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
//! ## Property column matching
//!
//! `prop:KEY=VALUE` matches **all four user-facing typed
//! columns** (`value_text`, `value_num`, `value_date`, `value_ref`)
//! with type-coerced bind variants. The user never has to know which
//! column their property lives in: the SQL emits a four-way OR with
//! `NULL`-bound branches for variants that didn't parse. The
//! mutually-exclusive CHECK on `block_properties` (migration 0062)
//! ensures at most one branch fires per row. `value_bool` is internal
//! (not user-typed) and remains out of scope.

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

/// Typed bind values emitted by [`append_metadata_sql`].
///
/// Property `prop:` matching now spans four typed columns
/// (`value_text` / `value_num` / `value_date` / `value_ref`), so the
/// bind list cannot be a flat `Vec<String>` any longer: nullable
/// number / date / ref variants must be able to bind SQL `NULL` when
/// the user's value doesn't parse as that type. Callers iterate and
/// dispatch on the variant when threading binds into the prepared
/// statement.
#[derive(Debug, Clone)]
pub enum MetaBind {
    /// Always-bound text value (e.g. state/priority literals,
    /// property key, property value bound to `value_text`).
    Str(String),
    /// Nullable text value. `None` binds SQL `NULL`. Used for the
    /// `value_date` and `value_ref` variants of `prop:` matching:
    /// when the user's value doesn't parse as a date / ULID, the
    /// bind is `NULL` so the `bp.value_<x> = ?` branch evaluates to
    /// `NULL` (treated as FALSE in the surrounding `WHERE`).
    NullableStr(Option<String>),
    /// Nullable f64 value for `value_num` matching. `None` binds
    /// SQL `NULL`.
    NullableF64(Option<f64>),
}

impl MetaBind {
    /// Apply this bind to a `sqlx::query::Query`. Dispatches on
    /// variant so each value lands in the parameter slot with its
    /// correct SQLite affinity.
    pub fn bind<'q, O>(
        &'q self,
        q: sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    ) -> sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments> {
        match self {
            MetaBind::Str(s) => q.bind(s),
            MetaBind::NullableStr(s) => q.bind(s),
            MetaBind::NullableF64(n) => q.bind(n),
        }
    }
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
) -> Vec<MetaBind> {
    let mut binds: Vec<MetaBind> = Vec::new();

    // #1280 B2 — `state` / `excluded_state` / `priority` / `excluded_priority`
    // / `due_date` / `scheduled_date` are NO LONGER emitted here: they are
    // compiled through `SearchProjection` (which delegates to the canonical A2
    // `PagesProjection` SQL) and spliced by
    // `StructuralFilterBuilder::add_metadata` via the `_via_projection`
    // helpers. The A2 SQL is byte-shape-identical to the legacy fragments this
    // function used to emit (`append_text_in_or_null` /
    // `append_text_not_in_or_not_null` / `append_date_predicate`), so the
    // cutover is behaviour-preserving. PROPERTY stays here: its four-column
    // (`value_text/num/date/ref`) OR diverges from the projection's
    // single-column `value_text` match.

    // property includes ------------------------------------------------
    for pf in &meta.property_includes {
        append_property_match(sql, next_param, &mut binds, pf, block_alias, false);
    }

    // property excludes ------------------------------------------------
    for pf in &meta.property_excludes {
        append_property_match(sql, next_param, &mut binds, pf, block_alias, true);
    }

    binds
}

/// Emit one `[NOT ]EXISTS` clause for a `prop:KEY=VALUE`
/// filter that matches across all four user-facing typed columns
/// (`value_text` / `value_num` / `value_date` / `value_ref`).
///
/// For `pf.value.is_empty()`, falls back to the key-presence-only
/// Shape (pre- behaviour). Otherwise emits a four-way OR with
/// type-coerced bind variants — `value_num` / `value_date` /
/// `value_ref` bind as `NULL` when the user's value doesn't parse as
/// that type, so the corresponding branch evaluates to `NULL`
/// (FALSE in `WHERE`) and only the `value_text` branch matches for
/// arbitrary strings (the v1 behaviour). The `block_properties`
/// `exactly_one_value` CHECK (migration 0062) guarantees at most one
/// branch can ever fire per row.
fn append_property_match(
    sql: &mut String,
    next_param: &mut usize,
    binds: &mut Vec<MetaBind>,
    pf: &SearchPropertyFilter,
    block_alias: &str,
    exclude: bool,
) {
    let keyword = if exclude { "NOT EXISTS" } else { "EXISTS" };

    // BE-8: bind the trimmed key so a whitespace-padded `prop:` key (which the
    // empty-key guard already trims before its is-empty check) matches the
    // stored, un-padded key instead of silently matching nothing.
    let key = pf.key.trim();

    let key_idx = *next_param;
    *next_param += 1;

    if pf.value.is_empty() {
        sql.push_str(&format!(
            "\n           AND {keyword} (SELECT 1 FROM block_properties bp \
              WHERE bp.block_id = {block_alias}.id AND bp.key = ?{key_idx})"
        ));
        binds.push(MetaBind::Str(key.to_string()));
        return;
    }

    let text_idx = *next_param;
    *next_param += 1;
    let num_idx = *next_param;
    *next_param += 1;
    let date_idx = *next_param;
    *next_param += 1;
    let ref_idx = *next_param;
    *next_param += 1;

    sql.push_str(&format!(
        "\n           AND {keyword} (SELECT 1 FROM block_properties bp \
          WHERE bp.block_id = {block_alias}.id \
            AND bp.key = ?{key_idx} \
            AND ( \
                 (bp.value_text IS NOT NULL AND bp.value_text = ?{text_idx}) \
              OR (bp.value_num  IS NOT NULL AND bp.value_num  = ?{num_idx}) \
              OR (bp.value_date IS NOT NULL AND bp.value_date = ?{date_idx}) \
              OR (bp.value_ref  IS NOT NULL AND bp.value_ref  = ?{ref_idx}) \
            ))"
    ));

    let parsed = parse_prop_value(&pf.value);
    binds.push(MetaBind::Str(key.to_string()));
    binds.push(MetaBind::Str(pf.value.clone()));
    binds.push(MetaBind::NullableF64(parsed.num));
    binds.push(MetaBind::NullableStr(parsed.date));
    binds.push(MetaBind::NullableStr(parsed.ref_));
}

/// Parsed-variant bundle for one `prop:KEY=VALUE` user input.
///
/// Each field is `Some` iff the raw value parses cleanly as that type;
/// otherwise `None`, which the caller binds as SQL `NULL` to make the
/// corresponding `bp.value_<x> = ?` branch FALSE.
#[derive(Debug, Clone, Default)]
struct PropParsedValue {
    num: Option<f64>,
    /// ISO `YYYY-MM-DD` if the raw parses as `NaiveDate`.
    date: Option<String>,
    /// Uppercased ULID if the raw is a 26-char Crockford base32 string.
    ref_: Option<String>,
}

fn parse_prop_value(raw: &str) -> PropParsedValue {
    PropParsedValue {
        // #383: reject non-finite parses (`inf`/`infinity`/`NaN`). `f64`'s
        // `FromStr` accepts those spellings, but `value_num` rows are always
        // finite, so an `=` against inf/NaN can never match (NaN `=` is even
        // FALSE against itself). Filtering them to `None` makes the numeric
        // branch bind SQL NULL — the same no-match outcome — without leaving
        // a non-finite literal in the bound parameters.
        num: raw.parse::<f64>().ok().filter(|n| n.is_finite()),
        date: NaiveDate::parse_from_str(raw, "%Y-%m-%d")
            .ok()
            .map(|d| d.format("%Y-%m-%d").to_string()),
        ref_: parse_ulid(raw),
    }
}

/// Recognise a ULID-shaped string and return its uppercased form.
///
/// Mirrors the lenient check in
/// [`crate::mcp::handler_utils::normalize_ulid_arg`]: 26-char +
/// ASCII alphanumeric. Strict-Crockford rejection of `I/L/O/U` is
/// intentionally NOT enforced — Agaric's existing decoder accepts
/// those characters as aliases, and `value_ref` rows may legitimately
/// contain them in older blocks. Anything that doesn't fit the
/// 26-char shape returns `None`, which makes the `value_ref` branch
/// of the four-column OR bind SQL `NULL` and contribute nothing.
fn parse_ulid(raw: &str) -> Option<String> {
    const ULID_LEN: usize = 26;
    if raw.len() != ULID_LEN {
        return None;
    }
    if !raw.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(raw.to_ascii_uppercase())
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
    use crate::domain::search_types::{NamedDateRange, SearchFilter, SearchPropertyFilter};

    fn fixed_today() -> NaiveDate {
        // 2026-05-18 is a Monday — pinned so `this-week` math is stable.
        NaiveDate::from_ymd_opt(2026, 5, 18).unwrap()
    }

    #[test]
    fn parse_prop_value_rejects_non_finite_numbers() {
        // #383: `f64::from_str` accepts `inf`/`infinity`/`NaN`, but a
        // `value_num` row is always finite so an `=` against those can never
        // match (NaN `=` is FALSE even against itself). The numeric branch
        // must therefore stay `None` for those inputs so it binds SQL NULL.
        for raw in ["inf", "+inf", "-inf", "infinity", "INFINITY", "NaN", "nan"] {
            let parsed = parse_prop_value(raw);
            assert!(
                parsed.num.is_none(),
                "non-finite input {raw:?} must not produce a numeric bind, got {:?}",
                parsed.num
            );
        }
        // Finite values still parse.
        assert_eq!(parse_prop_value("3.5").num, Some(3.5));
        assert_eq!(parse_prop_value("0").num, Some(0.0));
        assert_eq!(parse_prop_value("-42").num, Some(-42.0));
    }

    #[test]
    fn property_key_is_trimmed_before_binding() {
        // BE-8: a whitespace-padded `prop:` key must bind as its trimmed form
        // (matching the empty-key guard's trim) so it matches the stored,
        // un-padded key instead of silently matching nothing. Covers both the
        // key-only and key+value composition paths.
        let f = SearchFilter {
            property_filters: vec![
                SearchPropertyFilter {
                    key: "  status  ".into(),
                    value: String::new(),
                },
                SearchPropertyFilter {
                    key: " owner ".into(),
                    value: "me".into(),
                },
            ],
            ..Default::default()
        };
        let m = prepare_metadata_with_today(&f, fixed_today()).unwrap();
        let mut sql = String::new();
        let mut next_param = 1usize;
        let binds = append_metadata_sql(&mut sql, &mut next_param, &m, "b");
        let str_binds: Vec<&str> = binds
            .iter()
            .filter_map(|b| match b {
                MetaBind::Str(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            str_binds.contains(&"status"),
            "key-only path must bind the trimmed key, got {str_binds:?}"
        );
        assert!(
            str_binds.contains(&"owner"),
            "key+value path must bind the trimmed key, got {str_binds:?}"
        );
        assert!(
            !str_binds
                .iter()
                .any(|s| s.starts_with(' ') || s.ends_with(' ')),
            "no whitespace-padded key may be bound, got {str_binds:?}"
        );
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

    // -----------------------------------------------------------------
    // `prop:` four-column matching
    // -----------------------------------------------------------------

    #[test]
    fn prop_text_value_binds_four_columns() {
        let meta = MetadataPredicates {
            property_includes: vec![SearchPropertyFilter {
                key: "status".into(),
                value: "draft".into(),
            }],
            ..Default::default()
        };
        let mut sql = String::new();
        let mut p = 1usize;
        let binds = append_metadata_sql(&mut sql, &mut p, &meta, "b");
        // Four-way OR with all four column branches present.
        assert!(sql.contains("bp.value_text IS NOT NULL AND bp.value_text = ?2"));
        assert!(sql.contains("bp.value_num  IS NOT NULL AND bp.value_num  = ?3"));
        assert!(sql.contains("bp.value_date IS NOT NULL AND bp.value_date = ?4"));
        assert!(sql.contains("bp.value_ref  IS NOT NULL AND bp.value_ref  = ?5"));
        // 1 key + 4 typed value binds = 5 binds.
        assert_eq!(binds.len(), 5);
        // "draft" parses as text only → num / date / ref are NULL.
        assert!(matches!(&binds[0], MetaBind::Str(s) if s == "status"));
        assert!(matches!(&binds[1], MetaBind::Str(s) if s == "draft"));
        assert!(matches!(&binds[2], MetaBind::NullableF64(None)));
        assert!(matches!(&binds[3], MetaBind::NullableStr(None)));
        assert!(matches!(&binds[4], MetaBind::NullableStr(None)));
    }

    #[test]
    fn prop_numeric_value_binds_num_variant() {
        let meta = MetadataPredicates {
            property_includes: vec![SearchPropertyFilter {
                key: "priority".into(),
                value: "1".into(),
            }],
            ..Default::default()
        };
        let mut sql = String::new();
        let mut p = 1usize;
        let binds = append_metadata_sql(&mut sql, &mut p, &meta, "b");
        // value_text bind is always the verbatim user input.
        assert!(matches!(&binds[1], MetaBind::Str(s) if s == "1"));
        // value_num bind is Some(1.0).
        assert!(
            matches!(&binds[2], MetaBind::NullableF64(Some(n)) if (n - 1.0).abs() < f64::EPSILON)
        );
        // date / ref still NULL (this value doesn't parse as either).
        assert!(matches!(&binds[3], MetaBind::NullableStr(None)));
        assert!(matches!(&binds[4], MetaBind::NullableStr(None)));
        let _ = sql;
    }

    #[test]
    fn prop_iso_date_value_binds_date_variant() {
        let meta = MetadataPredicates {
            property_includes: vec![SearchPropertyFilter {
                key: "due-date".into(),
                value: "2026-05-17".into(),
            }],
            ..Default::default()
        };
        let mut sql = String::new();
        let mut p = 1usize;
        let binds = append_metadata_sql(&mut sql, &mut p, &meta, "b");
        // value_text bind is verbatim.
        assert!(matches!(&binds[1], MetaBind::Str(s) if s == "2026-05-17"));
        // num bind: "2026-05-17" is NOT a number — f64 parse fails.
        assert!(matches!(&binds[2], MetaBind::NullableF64(None)));
        // date bind: parses → Some("2026-05-17").
        assert!(matches!(&binds[3], MetaBind::NullableStr(Some(s)) if s == "2026-05-17"));
        // ref bind: not a 26-char ULID.
        assert!(matches!(&binds[4], MetaBind::NullableStr(None)));
        let _ = sql;
    }

    #[test]
    fn prop_ulid_value_binds_ref_variant_uppercased() {
        let lower = "01hkq2rwwwgm34rtgfe9xcryz4";
        assert_eq!(lower.len(), 26);
        let meta = MetadataPredicates {
            property_includes: vec![SearchPropertyFilter {
                key: "author".into(),
                value: lower.into(),
            }],
            ..Default::default()
        };
        let mut sql = String::new();
        let mut p = 1usize;
        let binds = append_metadata_sql(&mut sql, &mut p, &meta, "b");
        // value_text bind is verbatim (case-preserving v1 behaviour).
        assert!(matches!(&binds[1], MetaBind::Str(s) if s == lower));
        // ref bind: uppercase form for ULID column convention.
        let expected = lower.to_ascii_uppercase();
        assert!(matches!(&binds[4], MetaBind::NullableStr(Some(s)) if s == &expected));
        let _ = sql;
    }

    #[test]
    fn prop_empty_value_is_key_presence_only() {
        let meta = MetadataPredicates {
            property_includes: vec![SearchPropertyFilter {
                key: "notes".into(),
                value: String::new(),
            }],
            ..Default::default()
        };
        let mut sql = String::new();
        let mut p = 1usize;
        let binds = append_metadata_sql(&mut sql, &mut p, &meta, "b");
        // Key-only EXISTS clause (no value-coercion four-way OR).
        assert!(
            sql.contains("EXISTS (SELECT 1 FROM block_properties bp WHERE bp.block_id = b.id AND bp.key = ?1)"),
            "got SQL: {sql}",
        );
        // Single bind: the key.
        assert_eq!(binds.len(), 1);
        assert!(matches!(&binds[0], MetaBind::Str(s) if s == "notes"));
    }

    #[test]
    fn prop_exclude_emits_not_exists_with_four_column_or() {
        let meta = MetadataPredicates {
            property_excludes: vec![SearchPropertyFilter {
                key: "archived".into(),
                value: "true".into(),
            }],
            ..Default::default()
        };
        let mut sql = String::new();
        let mut p = 1usize;
        let _ = append_metadata_sql(&mut sql, &mut p, &meta, "b");
        assert!(sql.contains("AND NOT EXISTS (SELECT 1 FROM block_properties bp"));
        // Same four-column OR shape as the include path.
        assert!(sql.contains("bp.value_text IS NOT NULL AND bp.value_text = ?2"));
        assert!(sql.contains("bp.value_num  IS NOT NULL AND bp.value_num  = ?3"));
        assert!(sql.contains("bp.value_date IS NOT NULL AND bp.value_date = ?4"));
        assert!(sql.contains("bp.value_ref  IS NOT NULL AND bp.value_ref  = ?5"));
    }

    #[test]
    fn parse_prop_value_rejects_non_ulid_strings() {
        // 25 chars (too short)
        assert!(parse_ulid("01HKQ2RWWWGM34RTGFE9XCRYZ").is_none());
        // 27 chars (too long)
        assert!(parse_ulid("01HKQ2RWWWGM34RTGFE9XCRYZ4X").is_none());
        // 26 chars but contains a non-alphanumeric char (hyphen)
        assert!(parse_ulid("01HKQIRWWWGM34RTGFE9XCRY-4").is_none());
        // 26 chars valid alphanumeric → uppercased. The codebase's
        // existing `normalize_ulid_arg` accepts the strict Crockford
        // set plus I/L/O/U as aliases (matching `crockford_decode_char`),
        // So this helper is intentionally lenient.
        assert_eq!(
            parse_ulid("01hkq2rwwwgm34rtgfe9xcryz4").as_deref(),
            Some("01HKQ2RWWWGM34RTGFE9XCRYZ4"),
        );
        // Lenient — includes 'L' which the strict Crockford alphabet
        // excludes. Matches how Agaric's test fixtures (and
        // `normalize_ulid_arg`) treat ULID-shaped strings.
        assert_eq!(
            parse_ulid("01HQBLMTA00000000000000001").as_deref(),
            Some("01HQBLMTA00000000000000001"),
        );
    }
}
