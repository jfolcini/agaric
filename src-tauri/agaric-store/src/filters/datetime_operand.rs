//! The operand of a property filter on a key a space declares `datetime`
//! (#6758), read as the user wrote it into what the stored instants
//! (`YYYY-MM-DDTHH:MMZ` in `value_date`) compare with.
//!
//! A full datetime is the instant it names. A day alone is a [`LocalDay`],
//! which each row reads by its own form: a stored instant against the
//! device's local day, any other value against the day as written.
//!
//! The compilers are pure and know no definition, so the surfaces that hold a
//! pool run [`read_datetime_operands`] on the filter before compiling it: one
//! lookup of the keys the filter names.

use std::collections::HashSet;

use agaric_core::date_validation::{is_valid_iso_date, local_day_bounds, read_datetime};
use agaric_core::error::AppError;
use sqlx::SqlitePool;

use super::expr::FilterExpr;
use super::primitive::{FilterPrimitive, PropertyPredicate, PropertyValue};

/// A day operand (#6758, #6906): the day as written, and the bounds of the
/// device's local day in the stored form, `[from, until)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalDay {
    pub day: String,
    pub from: String,
    pub until: String,
}

impl LocalDay {
    /// `day` in `tz`, or `None` when it is no `YYYY-MM-DD` calendar day.
    pub fn read<Tz: chrono::TimeZone>(day: &str, tz: &Tz) -> Option<Self> {
        let (from, until) = local_day_bounds(day, tz)?;
        Some(Self {
            day: day.to_owned(),
            from,
            until,
        })
    }

    /// `held {op}` this day, read per row: a stored instant (a 17-character
    /// `YYYY-MM-DDTHH:MMZ`) against the local day, `=` within it, `<>` / `!=`
    /// not within it, `>` at or after its end, `>=` at or after its start,
    /// `<` before its start and `<=` before its end; any other value against
    /// the day as written. `bind` takes each operand in the order its
    /// placeholder appears and returns the placeholder.
    pub fn test<'s, F>(&'s self, held: &str, op: &str, bind: &mut F) -> String
    where
        F: FnMut(&'s str) -> String + ?Sized,
    {
        let within = match op {
            "=" => {
                let from = bind(&self.from);
                format!("{held} >= {from} AND {held} < {}", bind(&self.until))
            }
            "<>" | "!=" => {
                let from = bind(&self.from);
                format!("({held} < {from} OR {held} >= {})", bind(&self.until))
            }
            ">" => format!("{held} >= {}", bind(&self.until)),
            ">=" => format!("{held} >= {}", bind(&self.from)),
            "<" => format!("{held} < {}", bind(&self.from)),
            _ => format!("{held} < {}", bind(&self.until)),
        };
        let day = bind(&self.day);
        format!("CASE WHEN length({held}) = 17 THEN {within} ELSE {held} {op} {day} END")
    }
}

/// `predicate` on a `datetime` key with its operand read in `tz`, or `None`
/// when it compares with no date or datetime and stays as it is.
pub fn datetime_predicate<Tz: chrono::TimeZone>(
    predicate: &PropertyPredicate,
    tz: &Tz,
) -> Option<PropertyPredicate> {
    use PropertyPredicate::{Eq, Gt, Gte, Lt, Lte, Ne};
    let (Eq { value } | Ne { value } | Gt { value } | Gte { value } | Lt { value } | Lte { value }) =
        predicate
    else {
        return None;
    };
    let (PropertyValue::Text { value: operand } | PropertyValue::Date { value: operand }) = value
    else {
        return None;
    };
    let value = if is_valid_iso_date(operand) {
        PropertyValue::DatetimeDay(LocalDay::read(operand, tz)?)
    } else {
        PropertyValue::Date {
            value: read_datetime(operand, tz)?.canonical,
        }
    };
    Some(match predicate {
        Eq { .. } => Eq { value },
        Ne { .. } => Ne { value },
        Gt { .. } => Gt { value },
        Gte { .. } => Gte { value },
        Lt { .. } => Lt { value },
        _ => Lte { value },
    })
}

/// Read the operand of every `HasProperty` leaf of `expr` on one of `keys`.
pub fn read_operands<Tz: chrono::TimeZone>(expr: &mut FilterExpr, keys: &HashSet<String>, tz: &Tz) {
    match expr {
        FilterExpr::Leaf { primitive } => read_primitive(primitive, keys, tz),
        FilterExpr::And { children } | FilterExpr::Or { children } => {
            for child in children {
                read_operands(child, keys, tz);
            }
        }
        FilterExpr::Not { child } => read_operands(child, keys, tz),
    }
}

fn read_primitive<Tz: chrono::TimeZone>(
    primitive: &mut FilterPrimitive,
    keys: &HashSet<String>,
    tz: &Tz,
) {
    match primitive {
        FilterPrimitive::HasProperty { key, predicate } if keys.contains(key.as_str()) => {
            if let Some(read) = datetime_predicate(predicate, tz) {
                *predicate = read;
            }
        }
        FilterPrimitive::HasParentMatching { matcher } => read_operands(matcher, keys, tz),
        _ => {}
    }
}

/// The keys `expr`'s `HasProperty` leaves name, added to `keys`.
pub fn property_keys(expr: &FilterExpr, keys: &mut Vec<String>) {
    match expr {
        FilterExpr::Leaf { primitive } => primitive_keys(primitive, keys),
        FilterExpr::And { children } | FilterExpr::Or { children } => {
            for child in children {
                property_keys(child, keys);
            }
        }
        FilterExpr::Not { child } => property_keys(child, keys),
    }
}

fn primitive_keys(primitive: &FilterPrimitive, keys: &mut Vec<String>) {
    match primitive {
        FilterPrimitive::HasProperty { key, .. } => keys.push(key.clone()),
        FilterPrimitive::HasParentMatching { matcher } => property_keys(matcher, keys),
        _ => {}
    }
}

/// Those of `keys` that one of `spaces` (`None`: any space) declares
/// `datetime`. No query when `keys` is empty.
pub async fn datetime_keys(
    pool: &SqlitePool,
    spaces: Option<&[String]>,
    keys: &[String],
) -> Result<HashSet<String>, AppError> {
    if keys.is_empty() {
        return Ok(HashSet::new());
    }
    let keys = serde_json::to_string(keys)?;
    let spaces = spaces.map(serde_json::to_string).transpose()?;
    Ok(sqlx::query_scalar!(
        r#"SELECT DISTINCT key AS "key!: String" FROM property_definitions
           WHERE value_type = 'datetime'
             AND key IN (SELECT value FROM json_each(?1))
             AND (?2 IS NULL OR space_id IN (SELECT value FROM json_each(?2)))"#,
        keys,
        spaces,
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect())
}

/// [`read_operands`] of `expr` for the keys `spaces` declare `datetime`, a
/// time with no zone being the device's local time.
pub async fn read_datetime_operands(
    pool: &SqlitePool,
    spaces: Option<&[String]>,
    expr: &mut FilterExpr,
) -> Result<(), AppError> {
    let mut named = Vec::new();
    property_keys(expr, &mut named);
    let keys = datetime_keys(pool, spaces, &named).await?;
    if !keys.is_empty() {
        read_operands(expr, &keys, &chrono::Local);
    }
    Ok(())
}

/// [`read_datetime_operands`] of the primitives a surface AND-joins, as the
/// Pages view does.
pub async fn read_datetime_operands_of(
    pool: &SqlitePool,
    spaces: Option<&[String]>,
    primitives: &mut [FilterPrimitive],
) -> Result<(), AppError> {
    let mut named = Vec::new();
    for primitive in primitives.iter() {
        primitive_keys(primitive, &mut named);
    }
    let keys = datetime_keys(pool, spaces, &named).await?;
    for primitive in primitives {
        read_primitive(primitive, &keys, &chrono::Local);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filters::CompileExpr;
    use crate::filters::primitive::Bind;
    use crate::query::projection::QueryProjection;
    use PropertyPredicate::{Contains, Eq, Exists, Gt, Gte, Lt, Lte, Ne, StartsWith};
    use chrono::FixedOffset;

    const SPACE: &str = "01SPACE00000000000000000A";
    const OTHER_SPACE: &str = "01SPACE00000000000000000B";

    fn new_york() -> FixedOffset {
        FixedOffset::west_opt(5 * 3600).unwrap()
    }

    fn date(value: &str) -> PropertyValue {
        PropertyValue::Date {
            value: value.to_owned(),
        }
    }

    fn text(value: &str) -> PropertyValue {
        PropertyValue::Text {
            value: value.to_owned(),
        }
    }

    fn day() -> PropertyValue {
        PropertyValue::DatetimeDay(LocalDay {
            day: "2026-11-14".to_owned(),
            from: "2026-11-14T05:00Z".to_owned(),
            until: "2026-11-15T05:00Z".to_owned(),
        })
    }

    /// A day is itself with the local day's bounds in UTC, under every
    /// comparison.
    #[test]
    fn a_day_operand_is_the_local_day() {
        let read = |predicate: PropertyPredicate| datetime_predicate(&predicate, &new_york());
        for operand in [date("2026-11-14"), text("2026-11-14")] {
            let value = || operand.clone();
            assert_eq!(read(Eq { value: value() }), Some(Eq { value: day() }));
            assert_eq!(read(Ne { value: value() }), Some(Ne { value: day() }));
            assert_eq!(read(Gt { value: value() }), Some(Gt { value: day() }));
            assert_eq!(read(Gte { value: value() }), Some(Gte { value: day() }));
            assert_eq!(read(Lt { value: value() }), Some(Lt { value: day() }));
            assert_eq!(read(Lte { value: value() }), Some(Lte { value: day() }));
        }
    }

    /// A full datetime, in any form the reader takes, is compared as stored.
    #[test]
    fn a_datetime_operand_is_its_stored_form() {
        let read = |predicate: PropertyPredicate| datetime_predicate(&predicate, &new_york());
        let stored = || date("2026-11-14T14:30Z");
        assert_eq!(
            read(Eq {
                value: text("2026-11-14T09:30")
            }),
            Some(Eq { value: stored() })
        );
        assert_eq!(
            read(Ne {
                value: date("2026-11-14 09:30:59")
            }),
            Some(Ne { value: stored() })
        );
        assert_eq!(
            read(Gt {
                value: text("2026-11-14T15:30+01:00")
            }),
            Some(Gt { value: stored() })
        );
        assert_eq!(
            read(Lte {
                value: text("2026-11-14T14:30Z")
            }),
            Some(Lte { value: stored() })
        );
    }

    #[test]
    fn any_other_predicate_stays_as_it_is() {
        for predicate in [
            Exists,
            Eq {
                value: text("soon"),
            },
            Eq {
                value: PropertyValue::Num { value: 2026.0 },
            },
            Contains {
                value: text("2026-11-14"),
            },
            StartsWith {
                value: date("2026-11-14"),
            },
            Eq {
                value: date("2026-02-30"),
            },
        ] {
            assert_eq!(
                datetime_predicate(&predicate, &new_york()),
                None,
                "{predicate:?}"
            );
        }
    }

    fn leaf(key: &str, predicate: PropertyPredicate) -> FilterExpr {
        FilterExpr::leaf(FilterPrimitive::HasProperty {
            key: key.to_owned(),
            predicate,
        })
    }

    /// Only the named keys' leaves are read, wherever they are in the tree.
    #[test]
    fn read_operands_reads_the_datetime_keys_leaves_only() {
        let on = |value: PropertyValue| Eq { value };
        let tree = |starts: PropertyValue, due: PropertyValue| FilterExpr::And {
            children: vec![
                FilterExpr::Not {
                    child: Box::new(leaf("starts", on(starts.clone()))),
                },
                FilterExpr::Or {
                    children: vec![leaf("due", on(due)), leaf("starts", on(starts.clone()))],
                },
                FilterExpr::leaf(FilterPrimitive::HasParentMatching {
                    matcher: Box::new(leaf("starts", on(starts))),
                }),
            ],
        };
        let mut expr = tree(date("2026-11-14"), date("2026-11-14"));
        let mut named = Vec::new();
        property_keys(&expr, &mut named);
        assert_eq!(named, ["starts", "due", "starts", "starts"]);

        read_operands(
            &mut expr,
            &HashSet::from(["starts".to_owned()]),
            &new_york(),
        );
        assert_eq!(expr, tree(day(), date("2026-11-14")));
    }

    async fn seed(pool: &SqlitePool) {
        for (space, key, value_type) in [
            (SPACE, "starts", "datetime"),
            (SPACE, "due", "date"),
            (OTHER_SPACE, "ends", "datetime"),
        ] {
            sqlx::query(
                "INSERT INTO property_definitions (space_id, key, value_type, created_at) \
                 VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
            )
            .bind(space)
            .bind(key)
            .bind(value_type)
            .execute(pool)
            .await
            .unwrap();
        }
        // New York's 14 November runs from 05:00Z to 05:00Z the next day.
        for (id, column, value) in [
            ("B1", "value_date", "2026-11-14T04:59Z"),
            ("B2", "value_date", "2026-11-14T05:00Z"),
            ("B3", "value_date", "2026-11-14T14:30Z"),
            ("B4", "value_date", "2026-11-15T04:59Z"),
            ("B5", "value_date", "2026-11-15T05:00Z"),
            (
                "B6",
                "value_list",
                r#"["2026-11-13T12:00Z","2026-11-16T12:00Z"]"#,
            ),
            (
                "B7",
                "value_list",
                r#"["2026-11-13T12:00Z","2026-11-14T14:30Z"]"#,
            ),
            ("B8", "value_text", "2026-11-14"),
            // A day, the next and a list of a day, as a `date` key holds them.
            ("BA", "value_date", "2026-11-14"),
            ("BB", "value_date", "2026-11-15"),
            ("BC", "value_list", r#"["2026-11-14"]"#),
        ] {
            sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', '')")
                .bind(id)
                .execute(pool)
                .await
                .unwrap();
            // dynamic-sql: the column is one of this table's three literals
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "INSERT INTO block_properties (block_id, key, {column}) VALUES (?, 'starts', ?)"
            )))
            .bind(id)
            .bind(value)
            .execute(pool)
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('B9', 'content', '')")
            .execute(pool)
            .await
            .unwrap();
    }

    /// The blocks `predicate` on `starts` selects, read in New York.
    async fn matched(pool: &SqlitePool, predicate: PropertyPredicate) -> String {
        let mut expr = leaf("starts", predicate);
        read_operands(
            &mut expr,
            &HashSet::from(["starts".to_owned()]),
            &new_york(),
        );
        let clause = QueryProjection.compile_expr(&expr);
        let sql = format!(
            "SELECT b.id FROM blocks b WHERE {} ORDER BY b.id",
            clause.sql
        );
        // dynamic-sql: the compiled filter under test
        let mut query = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql));
        for bind in &clause.binds {
            query = match bind {
                Bind::Text(text) => query.bind(text.clone()),
                other => panic!("a datetime filter binds text only, got {other:?}"),
            };
        }
        query.fetch_all(pool).await.unwrap().join(" ")
    }

    /// Each comparison against stored instants on either side of both local
    /// midnights, single and in lists, against days as a `date` key holds
    /// them (#6906), and a block without the key.
    #[tokio::test]
    async fn a_day_operand_selects_the_local_days_instants() {
        let (pool, _dir) = crate::test_support::test_pool().await;
        seed(&pool).await;
        let day = || date("2026-11-14");
        assert_eq!(
            matched(&pool, Eq { value: day() }).await,
            "B2 B3 B4 B7 BA BC"
        );
        assert_eq!(
            matched(&pool, Ne { value: day() }).await,
            "B1 B5 B6 B8 B9 BB"
        );
        assert_eq!(matched(&pool, Gt { value: day() }).await, "B5 B6 BB");
        assert_eq!(
            matched(&pool, Gte { value: day() }).await,
            "B2 B3 B4 B5 B6 B7 BA BB BC"
        );
        assert_eq!(matched(&pool, Lt { value: day() }).await, "B1 B6 B7");
        assert_eq!(
            matched(&pool, Lte { value: day() }).await,
            "B1 B2 B3 B4 B6 B7 BA BC"
        );
        assert_eq!(
            matched(
                &pool,
                Eq {
                    value: text("2026-11-14T09:30")
                }
            )
            .await,
            "B3 B7"
        );
        assert_eq!(
            matched(
                &pool,
                Gt {
                    value: text("2026-11-14T09:30-05:00")
                }
            )
            .await,
            "B4 B5 B6 BB"
        );
    }

    #[tokio::test]
    async fn datetime_keys_are_the_named_keys_the_spaces_declare_datetime() {
        let (pool, _dir) = crate::test_support::test_pool().await;
        seed(&pool).await;
        let keys = |spaces: Option<&[&str]>, named: &[&str]| {
            let spaces = spaces.map(|s| s.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
            let named: Vec<String> = named.iter().map(|k| (*k).to_owned()).collect();
            let pool = pool.clone();
            async move {
                let mut found: Vec<String> = datetime_keys(&pool, spaces.as_deref(), &named)
                    .await
                    .unwrap()
                    .into_iter()
                    .collect();
                found.sort();
                found.join(" ")
            }
        };
        let all = ["starts", "due", "ends", "absent"];
        assert_eq!(keys(Some(&[SPACE]), &all).await, "starts");
        assert_eq!(keys(Some(&[OTHER_SPACE]), &all).await, "ends");
        assert_eq!(keys(Some(&[SPACE, OTHER_SPACE]), &all).await, "ends starts");
        assert_eq!(keys(None, &all).await, "ends starts");
        assert_eq!(keys(None, &["due", "ends"]).await, "ends");
        assert_eq!(keys(None, &[]).await, "");
    }

    /// The wiring: an expression's operands are read for the space's keys.
    #[tokio::test]
    async fn read_datetime_operands_reads_what_the_space_declares() {
        let (pool, _dir) = crate::test_support::test_pool().await;
        seed(&pool).await;
        let on = |key: &str| {
            leaf(
                key,
                Eq {
                    value: text("2026-11-14T15:30+01:00"),
                },
            )
        };
        let mut expr = FilterExpr::And {
            children: vec![on("starts"), on("ends"), on("due")],
        };
        read_datetime_operands(&pool, Some(&[SPACE.to_owned()]), &mut expr)
            .await
            .unwrap();
        assert_eq!(
            expr,
            FilterExpr::And {
                children: vec![
                    leaf(
                        "starts",
                        Eq {
                            value: date("2026-11-14T14:30Z")
                        }
                    ),
                    on("ends"),
                    on("due"),
                ],
            }
        );
    }
}
