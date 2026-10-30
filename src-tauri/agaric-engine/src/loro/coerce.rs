//! What a property value becomes under another type (#5841): the conversion a
//! type change applies to each value, and the one the SQL projection applies
//! to a string value under its key's declared type.
//!
//! | from \ to | text, url, select, unknown | number | date | boolean | ref |
//! |---|---|---|---|---|---|
//! | `Str(s)` | `Str(s)` | `s` trimmed, parsed as `f64`, finite | `s` if `YYYY-MM-DD` | `"true"` / `"false"` only | `s` if a ULID, uppercased |
//! | `Num(n)` | its text | itself, if finite | none | none | none |
//! | `Bool(b)` | `"true"` / `"false"` | none | none | itself | none |
//!
//! `Null` is no value, so nothing converts it.

use agaric_core::date_validation::is_valid_iso_date;
use agaric_core::ulid::{BlockId, canonical_ulid};
use agaric_store::op::PropertyValueFields;

use super::engine::PropertyValue;

/// The value `value` becomes under a definition of `to`, or `None` when it
/// does not fit. Pure; a select's option membership is the caller's.
pub fn coerce(value: &PropertyValue, to: &str) -> Option<PropertyValue> {
    use PropertyValue::{Bool, Null, Num, Str};
    match (value, to) {
        (Null, _) => None,
        (Str(s), "number") => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(Num),
        (Str(s), "date") => is_valid_iso_date(s).then(|| value.clone()),
        (Str(s), "boolean") => match s.as_str() {
            "true" => Some(Bool(true)),
            "false" => Some(Bool(false)),
            _ => None,
        },
        (Str(s), "ref") => canonical_ulid(s).ok().map(Str),
        (Str(_), _) => Some(value.clone()),
        (Num(n), "number") => n.is_finite().then_some(Num(*n)),
        (Bool(b), "boolean") => Some(Bool(*b)),
        (Num(_) | Bool(_), "number" | "date" | "boolean" | "ref") => None,
        (Num(_) | Bool(_), _) => value.as_legacy_string().map(Str),
    }
}

/// `value` in the slot a local write under `value_type` puts it in: a string
/// in `value_date` under a date, in `value_ref` under a ref and in
/// `value_text` otherwise; a number or a boolean in its own.
pub fn value_fields_under(value: &PropertyValue, value_type: &str) -> PropertyValueFields {
    let mut fields = PropertyValueFields::default();
    match value {
        PropertyValue::Str(s) => match value_type {
            "date" => fields.value_date = Some(s.clone()),
            "ref" => fields.value_ref = Some(BlockId::from_trusted(s)),
            _ => fields.value_text = Some(s.clone()),
        },
        PropertyValue::Num(n) => fields.value_num = Some(*n),
        PropertyValue::Bool(b) => fields.value_bool = Some(*b),
        PropertyValue::Null => {}
    }
    fields
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_ops::{PropertyDeclaration, check_property_value};
    use PropertyValue::{Bool, Null, Num, Str};
    use proptest::prelude::*;

    const TYPES: [&str; 7] = ["text", "number", "date", "select", "ref", "boolean", "url"];
    const ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    fn s(v: &str) -> PropertyValue {
        Str(v.to_owned())
    }

    /// Every cell of the module's table, by source and target.
    #[test]
    fn the_conversion_table_5841() {
        let cases: &[(PropertyValue, &str, Option<PropertyValue>)] = &[
            // Str → text-like keeps the string, whatever it is.
            (s("abc"), "text", Some(s("abc"))),
            (s("abc"), "url", Some(s("abc"))),
            (s("abc"), "select", Some(s("abc"))),
            (s("abc"), "colour", Some(s("abc"))),
            // Str → number: trimmed, Rust's grammar, finite.
            (s("3"), "number", Some(Num(3.0))),
            (s("042"), "number", Some(Num(42.0))),
            (s(" 4 "), "number", Some(Num(4.0))),
            (s("1e3"), "number", Some(Num(1000.0))),
            (s("-2.5"), "number", Some(Num(-2.5))),
            (s("abc"), "number", None),
            (s("inf"), "number", None),
            (s("NaN"), "number", None),
            (s("1e400"), "number", None),
            (s(""), "number", None),
            // Str → date: strict YYYY-MM-DD, calendar-valid.
            (s("2026-01-05"), "date", Some(s("2026-01-05"))),
            (s("2026-02-30"), "date", None),
            (s("2026-1-5"), "date", None),
            (s(" 2026-01-05"), "date", None),
            (s("soon"), "date", None),
            // Str → boolean: exactly true or false.
            (s("true"), "boolean", Some(Bool(true))),
            (s("false"), "boolean", Some(Bool(false))),
            (s("TRUE"), "boolean", None),
            (s("yes"), "boolean", None),
            (s(" true"), "boolean", None),
            // Str → ref: a ULID's shape, uppercased.
            (s(ULID), "ref", Some(s(ULID))),
            (s(&ULID.to_ascii_lowercase()), "ref", Some(s(ULID))),
            (s("not-a-ulid"), "ref", None),
            // Num.
            (Num(42.0), "text", Some(s("42"))),
            (Num(2.5), "select", Some(s("2.5"))),
            (Num(42.0), "number", Some(Num(42.0))),
            (Num(f64::INFINITY), "number", None),
            (Num(1.0), "boolean", None),
            (Num(20_260_105.0), "date", None),
            (Num(1.0), "ref", None),
            // Bool.
            (Bool(true), "text", Some(s("true"))),
            (Bool(false), "url", Some(s("false"))),
            (Bool(true), "boolean", Some(Bool(true))),
            (Bool(true), "number", None),
            (Bool(true), "date", None),
            (Bool(true), "ref", None),
            // Null is no value.
            (Null, "text", None),
            (Null, "number", None),
        ];
        for (value, to, want) in cases {
            assert_eq!(&coerce(value, to), want, "{value:?} under {to}");
        }
    }

    #[test]
    fn a_value_lands_in_the_slot_its_type_writes_5841() {
        let only = |f: PropertyValueFields| {
            (
                f.value_text,
                f.value_num,
                f.value_date,
                f.value_ref.map(BlockId::into_string),
                f.value_bool,
            )
        };
        assert_eq!(
            only(value_fields_under(&s("2026-01-05"), "date")),
            (None, None, Some("2026-01-05".into()), None, None)
        );
        assert_eq!(
            only(value_fields_under(&s(ULID), "ref")),
            (None, None, None, Some(ULID.into()), None)
        );
        for to in ["text", "select", "url"] {
            assert_eq!(
                only(value_fields_under(&s("a"), to)),
                (Some("a".into()), None, None, None, None),
                "{to}"
            );
        }
        assert_eq!(
            only(value_fields_under(&Num(3.0), "number")),
            (None, Some(3.0), None, None, None)
        );
        assert_eq!(
            only(value_fields_under(&Bool(false), "boolean")),
            (None, None, None, None, Some(false))
        );
        assert_eq!(
            value_fields_under(&Null, "text"),
            PropertyValueFields::default()
        );
    }

    /// Values a block can hold: what the command layer writes, plus the
    /// strings a type change meets (numbers, dates and booleans spelt as text,
    /// ULIDs in either case) and arbitrary ones.
    fn held_value() -> impl Strategy<Value = PropertyValue> {
        prop_oneof![
            any::<f64>()
                .prop_filter("finite", |n| n.is_finite())
                .prop_map(Num),
            any::<bool>().prop_map(Bool),
            "[ -~]{1,12}".prop_map(Str),
            "[+-]?[0-9]{1,6}(\\.[0-9]{0,4})?([eE][+-]?[0-9]{1,3})?".prop_map(Str),
            "20[0-9]{2}-[01][0-9]-[0-3][0-9]".prop_map(Str),
            prop_oneof![Just("true"), Just("false"), Just("yes")].prop_map(s),
            "[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}".prop_map(Str),
        ]
    }

    /// A `set_property` write, one slot set: any string as text, a date of
    /// any year, any number, any boolean, and a block id (a ref names a
    /// block, so it is a ULID), in either case.
    fn written_args() -> impl Strategy<Value = crate::block_ops::TypedPropertyArgs> {
        const DATE: &str = "[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])";
        const BLOCK_ID: &str = "[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}";
        prop_oneof![
            "[ -~]{1,12}".prop_map(|t| (Some(t), None, None, None, None)),
            any::<f64>().prop_map(|n| (None, Some(n), None, None, None)),
            DATE.prop_map(|d| (None, None, Some(d), None, None)),
            BLOCK_ID.prop_map(|r| (None, None, None, Some(r), None)),
            any::<bool>().prop_map(|b| (None, None, None, None, Some(b))),
        ]
    }

    fn value_type() -> impl Strategy<Value = &'static str> {
        prop::sample::select(&TYPES[..])
    }

    proptest! {
        /// A converted value is one its type keeps as it is.
        #[test]
        fn a_converted_value_converts_to_itself(value in held_value(), to in value_type()) {
            if let Some(fit) = coerce(&value, to) {
                prop_assert_eq!(coerce(&fit, to), Some(fit.clone()));
            }
        }

        /// A converted value is of the kind its type holds.
        #[test]
        fn a_converted_value_is_of_its_type_kind(value in held_value(), to in value_type()) {
            let kind = coerce(&value, to).map(|fit| match fit {
                Num(_) => "number",
                Bool(_) => "boolean",
                Str(_) | Null => "string",
            });
            let expected = match to {
                "number" | "boolean" => to,
                _ => "string",
            };
            prop_assert!(kind.is_none_or(|kind| kind == expected), "{:?} under {}", kind, to);
        }

        /// What a type change writes is what the command layer accepts under
        /// the type, so the converted value can be edited and written back.
        #[test]
        fn a_converted_value_is_one_the_type_accepts(value in held_value(), to in value_type()) {
            let blank = matches!(&value, Str(v) if v.trim().is_empty());
            if let (Some(fit), false) = (coerce(&value, to), blank) {
                let f = value_fields_under(&fit, to);
                let args = (
                    f.value_text,
                    f.value_num,
                    f.value_date,
                    f.value_ref.map(BlockId::into_string),
                    f.value_bool,
                );
                let decl = PropertyDeclaration { value_type: to.to_owned(), options: None };
                prop_assert!(
                    check_property_value("k", &args, Some(&decl)).is_ok(),
                    "{:?} under {}", fit, to
                );
            }
        }

        /// What the command layer accepts under a type is a value the type
        /// keeps as it is, so the projection shows every value a user can
        /// write.
        #[test]
        fn a_value_the_type_accepts_converts_to_itself(args in written_args()) {
            let (value_text, value_num, value_date, value_ref, value_bool) = args.clone();
            let value = PropertyValue::from(&PropertyValueFields {
                value_text,
                value_num,
                value_date,
                value_ref: value_ref.map(BlockId::from),
                value_bool,
            });
            for to in TYPES {
                let decl = PropertyDeclaration { value_type: to.to_owned(), options: None };
                if check_property_value("k", &args, Some(&decl)).is_ok() {
                    prop_assert_eq!(coerce(&value, to), Some(value.clone()), "under {}", to);
                }
            }
        }

        /// A number, a boolean or a date taken to text and back is the same
        /// value.
        #[test]
        fn through_text_and_back_is_lossless(
            n in any::<f64>().prop_filter("finite", |n| n.is_finite()),
            b in any::<bool>(),
            date in "20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|1[0-9]|2[0-8])",
        ) {
            for (value, ty) in [(Num(n), "number"), (Bool(b), "boolean"), (Str(date), "date")] {
                let text = coerce(&value, "text").expect("anything is text");
                prop_assert_eq!(coerce(&text, ty), Some(value.clone()), "{:?}", value);
            }
        }
    }
}
