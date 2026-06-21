//! #1280 — `BacklinkProjection`: routes the backlink resolver's *leaf*
//! filter compilation through the shared [`Projection`] engine
//! (`crate::filters::primitive`).
//!
//! This completes #1320 item 2. The leaves whose SQL is a pure
//! correlated boolean over the outer source-block alias `b`
//! (`PropertyText`/`Num`/`Date`, `PropertyIsSet`/`IsEmpty`, `TodoState`,
//! `Priority`, `DueDate`, `CreatedInRange`, `BlockType`) compile here.
//! The *hybrid* leaves (`Contains`/`HasTag`/`HasTagPrefix`/`SourcePage`)
//! and the boolean combinators (`And`/`Or`/`Not`) stay resolver-side
//! (`backlink::filters::compile_backlink_filter`) because they must
//! pre-resolve an id set rather than correlate per outer row.
//!
//! **Byte-identity contract:** every `compile_*` method emits the EXACT
//! same SQL string + bind order the legacy `compile_backlink_filter` leaf
//! arm emitted (alias `b`, the `bp` property alias, the per-op
//! `IS NOT NULL` guards, the ULID-prefix `Created` range). The resolver
//! (`resolve_filter_with_candidates`) remains the parity oracle. The
//! projection-emitted [`WhereClause`] converts cleanly to the backlink
//! [`CompiledFilter`] via [`From<Bind> for FilterBind`].

use std::collections::HashSet;
use std::sync::LazyLock;

use crate::filters::primitive::{
    Bind, DatePredicate, Projection, PropertyPredicate, PropertyValue, WhereClause,
};
use crate::sql_utils::escape_like;

use super::filters::{CompiledFilter, FilterBind, ms_to_ulid_prefix};

/// #1280 — convert a shared [`Bind`] into the backlink [`FilterBind`].
/// `Text` → `Text`, `Real` → `Num`, `Int` → `Num` (as `f64`). The backlink
/// leaves only ever produce text + numeric binds, so this is total and
/// lossless for every value the routed primitives emit.
impl From<Bind> for FilterBind {
    fn from(b: Bind) -> Self {
        match b {
            Bind::Text(s) => FilterBind::Text(s),
            Bind::Real(n) => FilterBind::Num(n),
            #[allow(clippy::cast_precision_loss)]
            Bind::Int(n) => FilterBind::Num(n as f64),
        }
    }
}

/// #1280 — the backlink surface's allowed primitive keys. The routed
/// leaves' `allowed_key()` tokens (plus the shared property / priority
/// tokens) so the cross-surface consistency test can find them.
pub static BACKLINK_ALLOWED_KEYS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    HashSet::from([
        "has-property",
        "priority",
        "state",
        "block-type",
        "due-date",
        "scheduled",
        "created",
    ])
});

/// #1280 — projection for the correlated backlink leaf fragments.
#[derive(Debug, Clone, Copy, Default)]
pub struct BacklinkProjection;

impl BacklinkProjection {
    /// Convert a projection [`WhereClause`] into the backlink
    /// [`CompiledFilter`] (mapping each [`Bind`] → [`FilterBind`]).
    #[must_use]
    pub fn to_compiled(wc: WhereClause) -> CompiledFilter {
        CompiledFilter {
            sql: wc.sql,
            binds: wc.binds.into_iter().map(FilterBind::from).collect(),
        }
    }
}

/// The SQL operator + whether the value-side `LIKE` form is used, mirroring
/// the backlink `PropertyText`/`PropertyDate` arms.
#[derive(Clone, Copy)]
enum PropCmp {
    /// A direct comparison operator (`=`/`<>`/`<`/`>`/`<=`/`>=`).
    Op(&'static str),
    /// `LIKE ? ESCAPE '\'` with the given pattern wrapper.
    Like { contains: bool },
}

impl Projection for BacklinkProjection {
    fn allowed_keys() -> &'static HashSet<&'static str> {
        &BACKLINK_ALLOWED_KEYS
    }

    fn compile_tag(&self, tag: &str) -> WhereClause {
        // Tag is a hybrid leaf on the backlink surface (pre-resolved id
        // set), never routed here; emit a defined-but-unused fragment that
        // matches the shared shape so `compile` stays total.
        WhereClause::new(
            "b.id IN (SELECT block_id FROM block_tags WHERE tag_id = ?)",
            vec![Bind::Text(tag.to_string())],
        )
    }

    fn compile_path_glob(&self, _pattern: &str, _exclude: bool) -> WhereClause {
        WhereClause::unsupported()
    }

    fn compile_has_property(&self, key: &str, predicate: &PropertyPredicate) -> WhereClause {
        // Byte-identical to the backlink `PropertyText`/`Num`/`Date` +
        // `PropertyIsSet`/`IsEmpty` leaves (the `bp` alias, the
        // `bp.{col} IS NOT NULL` guard, the `<>` for `Ne`).
        match predicate {
            PropertyPredicate::Exists => WhereClause::new(
                "EXISTS (SELECT 1 FROM block_properties bp \
                      WHERE bp.block_id = b.id AND bp.key = ?)",
                vec![Bind::Text(key.to_string())],
            ),
            PropertyPredicate::NotExists => WhereClause::new(
                "NOT EXISTS (SELECT 1 FROM block_properties bp \
                      WHERE bp.block_id = b.id AND bp.key = ?)",
                vec![Bind::Text(key.to_string())],
            ),
            PropertyPredicate::Eq { value } => prop_cmp(key, value, PropCmp::Op("=")),
            PropertyPredicate::Ne { value } => prop_cmp(key, value, PropCmp::Op("<>")),
            PropertyPredicate::Lt { value } => prop_cmp(key, value, PropCmp::Op("<")),
            PropertyPredicate::Gt { value } => prop_cmp(key, value, PropCmp::Op(">")),
            PropertyPredicate::Lte { value } => prop_cmp(key, value, PropCmp::Op("<=")),
            PropertyPredicate::Gte { value } => prop_cmp(key, value, PropCmp::Op(">=")),
            PropertyPredicate::Contains { value } => {
                prop_cmp(key, value, PropCmp::Like { contains: true })
            }
            PropertyPredicate::StartsWith { value } => {
                prop_cmp(key, value, PropCmp::Like { contains: false })
            }
        }
    }

    fn compile_last_edited(
        &self,
        _spec: &crate::filters::primitive::LastEditedSpec,
    ) -> WhereClause {
        WhereClause::unsupported()
    }

    fn compile_space(&self, _space_id: &str) -> WhereClause {
        WhereClause::unsupported()
    }

    fn compile_priority(&self, values: &[String], is_null: bool, exclude: bool) -> WhereClause {
        // The routed backlink `Priority{level}` leaf is exactly
        // `{ values: [level], is_null: false, exclude: false }` → the legacy
        // `b.priority = ?` with one text bind. The multi-value / is_null /
        // exclude generalisations mirror `compile_state` but are not on the
        // byte-identity path the resolver exercises today.
        if values.is_empty() && !is_null {
            // No selection at all matches the resolver's empty-set semantics.
            return WhereClause::new("1=0", Vec::new());
        }
        if !exclude && is_null && values.is_empty() {
            return WhereClause::new("b.priority IS NULL", Vec::new());
        }
        if values.len() == 1 && !is_null && !exclude {
            return WhereClause::new("b.priority = ?", vec![Bind::Text(values[0].clone())]);
        }
        // General multi-value form: `b.priority IN (?, ?, …)` optionally
        // OR-ed with `IS NULL`, optionally negated by `exclude`.
        let placeholders = std::iter::repeat_n("?", values.len())
            .collect::<Vec<_>>()
            .join(", ");
        let mut term = format!("b.priority IN ({placeholders})");
        if is_null {
            term = format!("({term} OR b.priority IS NULL)");
        }
        let sql = if exclude {
            format!("NOT COALESCE(({term}), 0)")
        } else {
            term
        };
        WhereClause::new(sql, values.iter().cloned().map(Bind::Text).collect())
    }

    fn compile_state(&self, values: &[String], is_null: bool, exclude: bool) -> WhereClause {
        // The routed backlink `TodoState{state}` leaf is exactly
        // `{ values: [state], is_null: false, exclude: false }` → the legacy
        // `b.todo_state = ?` with one text bind. The multi-value / is_null /
        // exclude generalisations are #1280 vocabulary the resolver does not
        // yet exercise; they compile but are not on the byte-identity path.
        if values.is_empty() && !is_null {
            // No selection at all matches the resolver's empty-set semantics.
            return WhereClause::new("1=0", Vec::new());
        }
        if !exclude && is_null && values.is_empty() {
            return WhereClause::new("b.todo_state IS NULL", Vec::new());
        }
        if values.len() == 1 && !is_null && !exclude {
            return WhereClause::new("b.todo_state = ?", vec![Bind::Text(values[0].clone())]);
        }
        // General multi-value form: `b.todo_state IN (?, ?, …)` optionally
        // OR-ed with `IS NULL`, optionally negated by `exclude`.
        let placeholders = std::iter::repeat_n("?", values.len())
            .collect::<Vec<_>>()
            .join(", ");
        let mut term = format!("b.todo_state IN ({placeholders})");
        if is_null {
            term = format!("({term} OR b.todo_state IS NULL)");
        }
        let sql = if exclude {
            format!("NOT COALESCE(({term}), 0)")
        } else {
            term
        };
        WhereClause::new(sql, values.iter().cloned().map(Bind::Text).collect())
    }

    fn compile_block_type(&self, values: &[String], exclude: bool) -> WhereClause {
        // Routed backlink `BlockType{block_type}` leaf is
        // `{ values: [block_type], exclude: false }` → byte-identical
        // `b.block_type = ?`.
        if values.is_empty() {
            return WhereClause::new("1=0", Vec::new());
        }
        if values.len() == 1 && !exclude {
            return WhereClause::new("b.block_type = ?", vec![Bind::Text(values[0].clone())]);
        }
        let placeholders = std::iter::repeat_n("?", values.len())
            .collect::<Vec<_>>()
            .join(", ");
        let term = format!("b.block_type IN ({placeholders})");
        let sql = if exclude {
            format!("NOT COALESCE(({term}), 0)")
        } else {
            term
        };
        WhereClause::new(sql, values.iter().cloned().map(Bind::Text).collect())
    }

    fn compile_due_date(&self, predicate: &DatePredicate) -> WhereClause {
        due_or_scheduled(predicate, "due_date")
    }

    fn compile_scheduled(&self, predicate: &DatePredicate) -> WhereClause {
        due_or_scheduled(predicate, "scheduled_date")
    }

    fn compile_created(&self, after: Option<&str>, before: Option<&str>) -> WhereClause {
        // Byte-identical to the backlink `CreatedInRange` leaf: each present
        // bound is parsed to ms → `ms_to_ulid_prefix` → compared against
        // `b.id` (`>= lo`, `< hi`). A malformed-but-present bound is the
        // caller's error; here we treat an unparseable bound as absent
        // (the resolver path validates loudly upstream before routing).
        let after_prefix = after
            .and_then(super::filters::parse_iso_to_ms)
            .map(ms_to_ulid_prefix);
        let before_prefix = before
            .and_then(super::filters::parse_iso_to_ms)
            .map(ms_to_ulid_prefix);

        let mut clauses: Vec<&str> = Vec::new();
        let mut binds: Vec<Bind> = Vec::new();
        if let Some(lo) = after_prefix {
            clauses.push("b.id >= ?");
            binds.push(Bind::Text(lo));
        }
        if let Some(hi) = before_prefix {
            clauses.push("b.id < ?");
            binds.push(Bind::Text(hi));
        }
        let sql = if clauses.is_empty() {
            "1=1".to_string()
        } else {
            format!("({})", clauses.join(" AND "))
        };
        WhereClause::new(sql, binds)
    }
}

/// Byte-identical reproduction of the backlink `DueDate{op,value}` leaf,
/// parameterised by column (`due_date` / `scheduled_date`). The routed
/// `CompareOp` → `DatePredicate` mapping (`Eq→On`, `Lt→Before`,
/// `Lte→OnOrBefore`, `Gt→After`, `Gte→OnOrAfter`) yields the legacy SQL:
/// `Eq` has no guard (`b.due_date = ?`); every other comparison adds the
/// `IS NOT NULL` guard. `IsNull`/`Between` are #1280 vocabulary not on the
/// resolver byte-identity path but compile to the natural forms.
///
/// The column is treated as DATE-exact (the resolver oracle does the same),
/// so `On` is `= ?` — NOT the day-range expansion of
/// [`DatePredicate::to_lexical_sql`].
fn due_or_scheduled(predicate: &DatePredicate, column: &str) -> WhereClause {
    match predicate {
        DatePredicate::On { date } => {
            WhereClause::new(format!("b.{column} = ?"), vec![Bind::Text(date.clone())])
        }
        DatePredicate::Before { date } => WhereClause::new(
            format!("(b.{column} < ? AND b.{column} IS NOT NULL)"),
            vec![Bind::Text(date.clone())],
        ),
        DatePredicate::OnOrBefore { date } => WhereClause::new(
            format!("(b.{column} <= ? AND b.{column} IS NOT NULL)"),
            vec![Bind::Text(date.clone())],
        ),
        DatePredicate::After { date } => WhereClause::new(
            format!("(b.{column} > ? AND b.{column} IS NOT NULL)"),
            vec![Bind::Text(date.clone())],
        ),
        DatePredicate::OnOrAfter { date } => WhereClause::new(
            format!("(b.{column} >= ? AND b.{column} IS NOT NULL)"),
            vec![Bind::Text(date.clone())],
        ),
        DatePredicate::IsNull => WhereClause::new(format!("b.{column} IS NULL"), Vec::new()),
        DatePredicate::Between { from, to } => WhereClause::new(
            format!("(b.{column} IS NOT NULL AND b.{column} BETWEEN ? AND ?)"),
            vec![Bind::Text(from.clone()), Bind::Text(to.clone())],
        ),
    }
}

/// Byte-identical reproduction of the backlink `PropertyText`/`Num`/`Date`
/// leaf body for a single (value-type, comparison) pair. The column is
/// chosen by value type (`value_text`/`value_ref`/`value_num`/`value_date`);
/// `Num` short-circuits a `LIKE` to `1=0` exactly as the resolver returns
/// the empty set.
fn prop_cmp(key: &str, value: &PropertyValue, cmp: PropCmp) -> WhereClause {
    let col = match value {
        PropertyValue::Text { .. } => "value_text",
        PropertyValue::Ref { .. } => "value_ref",
        PropertyValue::Date { .. } => "value_date",
        PropertyValue::Num { .. } => "value_num",
    };
    match cmp {
        PropCmp::Op(op) => {
            let val_bind = match value {
                PropertyValue::Num { value } => Bind::Real(*value),
                PropertyValue::Text { value }
                | PropertyValue::Ref { value }
                | PropertyValue::Date { value } => Bind::Text(value.clone()),
            };
            WhereClause::new(
                format!(
                    "EXISTS (SELECT 1 FROM block_properties bp \
                     WHERE bp.block_id = b.id AND bp.key = ? \
                       AND bp.{col} IS NOT NULL \
                       AND bp.{col} {op} ?)"
                ),
                vec![Bind::Text(key.to_string()), val_bind],
            )
        }
        PropCmp::Like { contains } => {
            // `LIKE` on a numeric value is meaningless → empty set (`1=0`),
            // mirroring the backlink `PropertyNum` Contains/StartsWith arm.
            let raw = match value {
                PropertyValue::Text { value }
                | PropertyValue::Ref { value }
                | PropertyValue::Date { value } => value.clone(),
                PropertyValue::Num { .. } => return WhereClause::new("1=0", Vec::new()),
            };
            let escaped = escape_like(&raw);
            let pattern = if contains {
                format!("%{escaped}%")
            } else {
                format!("{escaped}%")
            };
            WhereClause::new(
                format!(
                    "EXISTS (SELECT 1 FROM block_properties bp \
                     WHERE bp.block_id = b.id AND bp.key = ? \
                       AND bp.{col} IS NOT NULL \
                       AND bp.{col} LIKE ? ESCAPE '\\')"
                ),
                vec![Bind::Text(key.to_string()), Bind::Text(pattern)],
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filters::primitive::FilterPrimitive;

    /// Convenience: route a primitive through the projection and convert to
    /// the backlink `CompiledFilter` for byte-identity assertions.
    fn routed(prim: &FilterPrimitive) -> CompiledFilter {
        BacklinkProjection::to_compiled(BacklinkProjection.compile(prim))
    }

    // ── Byte-identity: each routed leaf reproduces the PRE-REFACTOR
    //    `compile_backlink_filter` literal SQL + bind order EXACTLY. The
    //    expected strings are pasted verbatim from the legacy inline arms.

    #[test]
    fn property_text_eq_byte_identical() {
        let cf = routed(&FilterPrimitive::HasProperty {
            key: "status".into(),
            predicate: PropertyPredicate::Eq {
                value: PropertyValue::Text {
                    value: "done".into(),
                },
            },
        });
        assert_eq!(
            cf.sql,
            "EXISTS (SELECT 1 FROM block_properties bp \
             WHERE bp.block_id = b.id AND bp.key = ? \
               AND bp.value_text IS NOT NULL \
               AND bp.value_text = ?)"
        );
        assert_eq!(
            cf.binds,
            vec![
                FilterBind::Text("status".into()),
                FilterBind::Text("done".into())
            ]
        );
    }

    #[test]
    fn property_text_neq_uses_angle_brackets_byte_identical() {
        let cf = routed(&FilterPrimitive::HasProperty {
            key: "status".into(),
            predicate: PropertyPredicate::Ne {
                value: PropertyValue::Text {
                    value: "done".into(),
                },
            },
        });
        assert_eq!(
            cf.sql,
            "EXISTS (SELECT 1 FROM block_properties bp \
             WHERE bp.block_id = b.id AND bp.key = ? \
               AND bp.value_text IS NOT NULL \
               AND bp.value_text <> ?)"
        );
    }

    #[test]
    fn property_text_contains_byte_identical() {
        let cf = routed(&FilterPrimitive::HasProperty {
            key: "k".into(),
            predicate: PropertyPredicate::Contains {
                value: PropertyValue::Text {
                    value: "ab%c".into(),
                },
            },
        });
        assert_eq!(
            cf.sql,
            "EXISTS (SELECT 1 FROM block_properties bp \
             WHERE bp.block_id = b.id AND bp.key = ? \
               AND bp.value_text IS NOT NULL \
               AND bp.value_text LIKE ? ESCAPE '\\')"
        );
        // `%` is escaped, then wrapped `%…%`.
        assert_eq!(
            cf.binds,
            vec![
                FilterBind::Text("k".into()),
                FilterBind::Text("%ab\\%c%".into())
            ]
        );
    }

    #[test]
    fn property_text_starts_with_byte_identical() {
        let cf = routed(&FilterPrimitive::HasProperty {
            key: "k".into(),
            predicate: PropertyPredicate::StartsWith {
                value: PropertyValue::Text {
                    value: "pre".into(),
                },
            },
        });
        assert_eq!(cf.binds[1], FilterBind::Text("pre%".into()));
    }

    #[test]
    fn property_num_eq_byte_identical_with_real_bind() {
        let cf = routed(&FilterPrimitive::HasProperty {
            key: "count".into(),
            predicate: PropertyPredicate::Eq {
                value: PropertyValue::Num { value: 3.5 },
            },
        });
        assert_eq!(
            cf.sql,
            "EXISTS (SELECT 1 FROM block_properties bp \
             WHERE bp.block_id = b.id AND bp.key = ? \
               AND bp.value_num IS NOT NULL \
               AND bp.value_num = ?)"
        );
        assert_eq!(
            cf.binds,
            vec![FilterBind::Text("count".into()), FilterBind::Num(3.5)]
        );
    }

    #[test]
    fn property_num_contains_is_empty_set() {
        let cf = routed(&FilterPrimitive::HasProperty {
            key: "count".into(),
            predicate: PropertyPredicate::Contains {
                value: PropertyValue::Num { value: 3.0 },
            },
        });
        assert_eq!(cf.sql, "1=0");
        assert!(cf.binds.is_empty());
    }

    #[test]
    fn property_date_lt_byte_identical() {
        let cf = routed(&FilterPrimitive::HasProperty {
            key: "when".into(),
            predicate: PropertyPredicate::Lt {
                value: PropertyValue::Date {
                    value: "2026-01-01".into(),
                },
            },
        });
        assert_eq!(
            cf.sql,
            "EXISTS (SELECT 1 FROM block_properties bp \
             WHERE bp.block_id = b.id AND bp.key = ? \
               AND bp.value_date IS NOT NULL \
               AND bp.value_date < ?)"
        );
    }

    #[test]
    fn property_is_set_and_is_empty_byte_identical() {
        let set = routed(&FilterPrimitive::HasProperty {
            key: "k".into(),
            predicate: PropertyPredicate::Exists,
        });
        assert_eq!(
            set.sql,
            "EXISTS (SELECT 1 FROM block_properties bp \
                      WHERE bp.block_id = b.id AND bp.key = ?)"
        );
        assert_eq!(set.binds, vec![FilterBind::Text("k".into())]);

        let empty = routed(&FilterPrimitive::HasProperty {
            key: "k".into(),
            predicate: PropertyPredicate::NotExists,
        });
        assert_eq!(
            empty.sql,
            "NOT EXISTS (SELECT 1 FROM block_properties bp \
                      WHERE bp.block_id = b.id AND bp.key = ?)"
        );
    }

    #[test]
    fn todo_state_byte_identical() {
        let cf = routed(&FilterPrimitive::State {
            values: vec!["TODO".into()],
            is_null: false,
            exclude: false,
        });
        assert_eq!(cf.sql, "b.todo_state = ?");
        assert_eq!(cf.binds, vec![FilterBind::Text("TODO".into())]);
    }

    #[test]
    fn priority_byte_identical() {
        let cf = routed(&FilterPrimitive::Priority {
            values: vec!["A".into()],
            is_null: false,
            exclude: false,
        });
        assert_eq!(cf.sql, "b.priority = ?");
        assert_eq!(cf.binds, vec![FilterBind::Text("A".into())]);
    }

    #[test]
    fn block_type_byte_identical() {
        let cf = routed(&FilterPrimitive::BlockType {
            values: vec!["task".into()],
            exclude: false,
        });
        assert_eq!(cf.sql, "b.block_type = ?");
        assert_eq!(cf.binds, vec![FilterBind::Text("task".into())]);
    }

    #[test]
    fn due_date_eq_is_exact_no_guard() {
        // `Eq` → `On` → byte-identical exact compare (DATE-exact, NO
        // day-range expansion).
        let cf = routed(&FilterPrimitive::DueDate {
            predicate: DatePredicate::On {
                date: "2026-03-01".into(),
            },
        });
        assert_eq!(cf.sql, "b.due_date = ?");
        assert_eq!(cf.binds, vec![FilterBind::Text("2026-03-01".into())]);
    }

    #[test]
    fn due_date_comparisons_byte_identical() {
        let lt = routed(&FilterPrimitive::DueDate {
            predicate: DatePredicate::Before {
                date: "2026-03-01".into(),
            },
        });
        assert_eq!(lt.sql, "(b.due_date < ? AND b.due_date IS NOT NULL)");

        let lte = routed(&FilterPrimitive::DueDate {
            predicate: DatePredicate::OnOrBefore {
                date: "2026-03-01".into(),
            },
        });
        assert_eq!(lte.sql, "(b.due_date <= ? AND b.due_date IS NOT NULL)");

        let gt = routed(&FilterPrimitive::DueDate {
            predicate: DatePredicate::After {
                date: "2026-03-01".into(),
            },
        });
        assert_eq!(gt.sql, "(b.due_date > ? AND b.due_date IS NOT NULL)");

        let gte = routed(&FilterPrimitive::DueDate {
            predicate: DatePredicate::OnOrAfter {
                date: "2026-03-01".into(),
            },
        });
        assert_eq!(gte.sql, "(b.due_date >= ? AND b.due_date IS NOT NULL)");
    }

    #[test]
    fn scheduled_uses_scheduled_date_column() {
        let cf = routed(&FilterPrimitive::Scheduled {
            predicate: DatePredicate::On {
                date: "2026-03-01".into(),
            },
        });
        assert_eq!(cf.sql, "b.scheduled_date = ?");
    }

    #[test]
    fn created_range_uses_ulid_prefix_byte_identical() {
        // Both bounds present → `(b.id >= ? AND b.id < ?)` with ULID prefixes.
        let cf = routed(&FilterPrimitive::Created {
            after: Some("2026-01-01".into()),
            before: Some("2026-02-01".into()),
        });
        assert_eq!(cf.sql, "(b.id >= ? AND b.id < ?)");
        assert_eq!(cf.binds.len(), 2);
        // The binds are the 10-char ULID prefixes for the two bounds.
        let lo =
            ms_to_ulid_prefix(crate::backlink::filters::parse_iso_to_ms("2026-01-01").unwrap());
        let hi =
            ms_to_ulid_prefix(crate::backlink::filters::parse_iso_to_ms("2026-02-01").unwrap());
        assert_eq!(cf.binds, vec![FilterBind::Text(lo), FilterBind::Text(hi)]);
    }

    #[test]
    fn created_range_no_bounds_is_all() {
        let cf = routed(&FilterPrimitive::Created {
            after: None,
            before: None,
        });
        assert_eq!(cf.sql, "1=1");
        assert!(cf.binds.is_empty());
    }

    #[test]
    fn created_range_only_after() {
        let cf = routed(&FilterPrimitive::Created {
            after: Some("2026-01-01".into()),
            before: None,
        });
        assert_eq!(cf.sql, "(b.id >= ?)");
        assert_eq!(cf.binds.len(), 1);
    }

    #[test]
    fn bind_to_filter_bind_conversion() {
        // #1280 — `From<Bind>` maps Text→Text, Real→Num, Int→Num(as f64).
        assert_eq!(
            FilterBind::from(Bind::Text("x".into())),
            FilterBind::Text("x".into())
        );
        assert_eq!(FilterBind::from(Bind::Real(2.5)), FilterBind::Num(2.5));
        assert_eq!(FilterBind::from(Bind::Int(7)), FilterBind::Num(7.0));
    }

    #[test]
    fn allowed_keys_contains_routed_tokens() {
        let keys = BacklinkProjection::allowed_keys();
        for k in [
            "has-property",
            "priority",
            "state",
            "block-type",
            "due-date",
            "scheduled",
            "created",
        ] {
            assert!(keys.contains(k), "BACKLINK_ALLOWED_KEYS must contain `{k}`");
        }
    }
}
