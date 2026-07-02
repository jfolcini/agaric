//! #1280 — [`QueryProjection`]: the advanced-query surface's
//! [`Projection`] impl.
//!
//! The advanced query runs over `FROM blocks b` (the `b` alias), exactly
//! like [`PagesProjection`]. Every shared + metadata leaf therefore
//! DELEGATES to `PagesProjection`'s compiler so the SQL is byte-shape-
//! identical to the Pages surface (mirroring how
//! [`crate::filters::SearchProjection`] delegates
//! `compile_has_property` / `compile_last_edited` / `compile_space`).
//!
//! What the advanced query supports:
//!
//! * **Shared:** `tag`, `path`, `has-property` (incl. typed Num/Date and the
//!   ordered/`Contains`/`StartsWith` predicates), `last-edited`, `space`,
//!   `priority`.
//! * **Metadata (#1280):** `state`, `block-type`, `due-date`, `scheduled`,
//!   `created`.
//!
//! What it does NOT support (kept as the trait default `unsupported()`):
//!
//! * **Pages-only physical leaves** — `orphan`, `stub`,
//!   `has-no-inbound-links`. These read a `pc.*` (`pages_cache`) alias that
//!   the advanced-query `FROM blocks b` does not join, AND they are
//!   page-grain predicates that don't generalise to arbitrary block rows.
//! * **Search-only leaves** — `regex`, `case-sensitive`, `whole-word`,
//!   `snippet`. Those belong to the full-text fast-follow.

use std::collections::HashSet;

use crate::filters::primitive::{Bind, DatePredicate, FilterPrimitive};
use crate::filters::{
    FilterExpr, LastEditedSpec, PagesProjection, Projection, PropertyPredicate, WhereClause,
};

/// The advanced-query projection. Compiles every shared + #1280-metadata
/// leaf by delegating to [`PagesProjection`] (both compile on the `b`
/// alias). Pages-only physical leaves and Search-only leaves fall through to
/// the trait's `unsupported()` default.
#[derive(Debug, Clone, Copy, Default)]
pub struct QueryProjection;

/// The keys an advanced query accepts: the shared vocabulary plus the #1280
/// metadata leaves. Deliberately EXCLUDES the Pages-only surface-physical
/// leaves (`orphan` / `stub` / `has-no-inbound-links`) and the Search-only
/// leaves — both groups compile to `unsupported()` on this surface, and the
/// engine's allow-list gate rejects them before compilation with a typed
/// validation error.
pub static QUERY_ALLOWED_KEYS: std::sync::LazyLock<HashSet<&'static str>> =
    std::sync::LazyLock::new(|| {
        HashSet::from([
            // Shared.
            "tag",
            "path",
            "has-property",
            "last-edited",
            "space",
            "priority",
            // #1280 metadata.
            "state",
            "block-type",
            "due-date",
            "scheduled",
            "created",
            // #1455 relational / multi-hop predicates.
            "links-to",
            "linked-from",
            "has-parent-matching",
            // Direct-children structural leaf — the legacy backlinks reroute
            // target (`b.parent_id = ?`).
            "child-of",
        ])
    });

impl Projection for QueryProjection {
    fn allowed_keys() -> &'static HashSet<&'static str> {
        &QUERY_ALLOWED_KEYS
    }

    // ── Shared leaves — delegate to PagesProjection (same `b` alias). ──
    fn compile_tag(&self, tag: &str) -> WhereClause {
        PagesProjection.compile_tag(tag)
    }
    fn compile_tag_or_ref(&self, tag: &str) -> WhereClause {
        PagesProjection.compile_tag_or_ref(tag)
    }
    fn compile_child_of(&self, parent: &str) -> WhereClause {
        PagesProjection.compile_child_of(parent)
    }
    fn compile_path_glob(&self, pattern: &str, exclude: bool) -> WhereClause {
        PagesProjection.compile_path_glob(pattern, exclude)
    }
    fn compile_has_property(&self, key: &str, predicate: &PropertyPredicate) -> WhereClause {
        PagesProjection.compile_has_property(key, predicate)
    }
    fn compile_last_edited(&self, spec: &LastEditedSpec) -> WhereClause {
        PagesProjection.compile_last_edited(spec)
    }
    fn compile_space(&self, space_id: &str) -> WhereClause {
        PagesProjection.compile_space(space_id)
    }
    fn compile_priority(&self, values: &[String], is_null: bool, exclude: bool) -> WhereClause {
        PagesProjection.compile_priority(values, is_null, exclude)
    }

    // ── #1280 metadata leaves — delegate to PagesProjection. ──
    fn compile_state(&self, values: &[String], is_null: bool, exclude: bool) -> WhereClause {
        PagesProjection.compile_state(values, is_null, exclude)
    }
    fn compile_block_type(&self, values: &[String], exclude: bool) -> WhereClause {
        PagesProjection.compile_block_type(values, exclude)
    }
    fn compile_due_date(&self, predicate: &DatePredicate) -> WhereClause {
        PagesProjection.compile_due_date(predicate)
    }
    fn compile_scheduled(&self, predicate: &DatePredicate) -> WhereClause {
        PagesProjection.compile_scheduled(predicate)
    }
    fn compile_created(&self, after: Option<&str>, before: Option<&str>) -> WhereClause {
        PagesProjection.compile_created(after, before)
    }

    // ── #1455 relational / multi-hop predicates ───────────────────────
    //
    // Bind ordering: every fragment below appends its `Bind` values in the
    // SAME left-to-right order the `?` placeholders appear in its SQL. The
    // engine's structured assembler ([`SqlFragment`](crate::filters::SqlFragment))
    // numbers the placeholders `?1, ?2, …` in textual (bind) order in one
    // arithmetic pass, so as long as each fragment keeps that
    // invariant the engine's positional binding lines up exactly — no
    // `?N`-index collision between the outer query and these subqueries.
    fn compile_links_to(&self, target: &str) -> WhereClause {
        // Outbound: this block authored a link whose target is `target`.
        // Concrete-id form (the FilterExpr-target form is a #1455 follow-up).
        WhereClause::new(
            "EXISTS (SELECT 1 FROM block_links l \
             WHERE l.source_id = b.id AND l.target_id = ?)",
            vec![Bind::Text(target.to_string())],
        )
    }
    fn compile_linked_from(&self, source: &str) -> WhereClause {
        // Inbound: some block `source` authored a link whose target is this
        // block. Inverse of `links-to`; concrete-id form.
        WhereClause::new(
            "EXISTS (SELECT 1 FROM block_links l \
             WHERE l.target_id = b.id AND l.source_id = ?)",
            vec![Bind::Text(source.to_string())],
        )
    }
    fn compile_has_parent_matching(&self, matcher: &FilterExpr) -> WhereClause {
        // #1455 — `EXISTS (SELECT 1 FROM blocks p1 WHERE p1.id = b.parent_id
        // AND (<matcher compiled against the parent row>))`.
        //
        // The matcher's leaves are authored against the outer `b` alias
        // (every `Projection::compile_*` hard-codes `b.`), so we retarget
        // them onto the parent alias. Nested `has-parent-matching` is handled
        // by `compile_parent_matching` (below) with a per-LEVEL alias
        // (`p1`, `p2`, …) so an inner parent-row never shadows an outer one
        // (`p2.id = p1.parent_id`). Depth-1 is the first parent level.
        compile_parent_matching(matcher, 1)
    }

    // Pages-only physical leaves (orphan / stub / has-no-inbound-links) and
    // Search-only leaves keep the trait's `unsupported()` default — the
    // advanced-query `FROM blocks b` does not join `pages_cache`, and those
    // primitives are page-grain / full-text concerns. The engine's
    // allow-list gate rejects their keys before they reach `compile`.
}

/// #1455 — compile the `has-parent-matching` EXISTS subquery at nesting
/// `level` (1 = the immediate parent). Returns the `EXISTS (…)` fragment that
/// tests whether the row referenced by the OUTER alias's `parent_id` matches
/// `matcher`. The caller (`compile_has_parent_matching`) supplies the outer
/// alias `b` and `level = 1`; the recursion supplies `p{level}` for deeper
/// levels — each level gets a DISTINCT `p{level}` alias so an inner parent
/// row never shadows an outer one (the `?N` / alias-collision hazard the
/// issue flags).
fn compile_parent_matching(matcher: &FilterExpr, level: usize) -> WhereClause {
    let outer = if level == 1 {
        "b".to_string()
    } else {
        format!("p{}", level - 1)
    };
    let parent = format!("p{level}");
    let inner = compile_expr_on_alias(matcher, &parent, level);
    if inner.is_unsupported() {
        return WhereClause::unsupported();
    }
    // The only join term is `{parent}.id = {outer}.parent_id` — no bind. The
    // matcher's binds are the ONLY binds, appended in `inner`'s emission
    // order; the assembler assigns their `?N` slots in that same textual order.
    WhereClause::new(
        format!(
            "EXISTS (SELECT 1 FROM blocks {parent} \
             WHERE {parent}.id = {outer}.parent_id AND ({}))",
            inner.sql
        ),
        inner.binds,
    )
}

/// Compile a [`FilterExpr`] so every leaf references `alias.` instead of the
/// canonical `b.`. Mirrors [`CompileExpr::compile_expr`](crate::filters::CompileExpr::compile_expr)'s AND/OR/NOT folding
/// (including the 3-valued `NOT COALESCE((…), 0)` complement) but retargets
/// the row alias and, for a nested `has-parent-matching` leaf, descends via
/// [`compile_parent_matching`] at `level + 1`.
fn compile_expr_on_alias(expr: &FilterExpr, alias: &str, level: usize) -> WhereClause {
    match expr {
        FilterExpr::Leaf {
            primitive: FilterPrimitive::HasParentMatching { matcher },
        } => compile_parent_matching(matcher, level + 1),
        FilterExpr::Leaf { primitive } => {
            let c = QueryProjection.compile(primitive);
            if c.is_unsupported() {
                return WhereClause::unsupported();
            }
            WhereClause::new(retarget_alias(&c.sql, alias), c.binds)
        }
        FilterExpr::And { children } => combine_on_alias(children, alias, level, " AND ", "1=1"),
        FilterExpr::Or { children } => combine_on_alias(children, alias, level, " OR ", "1=0"),
        FilterExpr::Not { child } => {
            let c = compile_expr_on_alias(child, alias, level);
            if c.is_unsupported() {
                return WhereClause::unsupported();
            }
            WhereClause::new(format!("NOT COALESCE(({}), 0)", c.sql), c.binds)
        }
    }
}

/// AND/OR-join children, each compiled on `alias` (mirrors
/// `CompileExpr::combine`). Empty list yields the supplied identity.
fn combine_on_alias(
    children: &[FilterExpr],
    alias: &str,
    level: usize,
    joiner: &str,
    identity: &str,
) -> WhereClause {
    if children.is_empty() {
        return WhereClause::new(identity.to_string(), Vec::new());
    }
    let mut sql = String::new();
    let mut binds: Vec<Bind> = Vec::new();
    for (i, child) in children.iter().enumerate() {
        let c = compile_expr_on_alias(child, alias, level);
        if c.is_unsupported() {
            return WhereClause::unsupported();
        }
        if i > 0 {
            sql.push_str(joiner);
        }
        sql.push('(');
        sql.push_str(&c.sql);
        sql.push(')');
        binds.extend(c.binds);
    }
    WhereClause::new(sql, binds)
}

/// Rewrite every whole-word `b.` column reference in `sql` to `{alias}.`.
/// Only a `b` token at a word boundary (start-of-string or a preceding
/// non-identifier char) followed by `.` is rewritten, so substrings like
/// `block_id`, `bl.`, `tab.` or `bm25` are NEVER touched. Placeholders (`?`)
/// and binds are unaffected — alias retargeting is a pure text rewrite of the
/// row reference, independent of bind ordering.
fn retarget_alias(sql: &str, alias: &str) -> String {
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        // Match a `b.` token where `b` is at a word boundary.
        let prev_is_ident = i > 0 && {
            let p = bytes[i - 1] as char;
            p.is_ascii_alphanumeric() || p == '_'
        };
        if c == 'b' && !prev_is_ident && i + 1 < bytes.len() && bytes[i + 1] as char == '.' {
            out.push_str(alias);
            out.push('.');
            i += 2;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

// #2255 — assembly equivalence: the structured `SqlFragment` path must render
// a multi-fragment advanced-query filter to BYTE-IDENTICAL SQL as the former
// char-by-char `?`→`?N` renumber. The golden string below was captured from
// `origin/main`'s renumber over the exact same tree.
#[cfg(test)]
mod assembly_equivalence {
    use super::*;
    use crate::filters::primitive::PropertyValue;
    use crate::filters::{CompileExpr, SqlFragment};

    fn leaf(p: FilterPrimitive) -> FilterExpr {
        FilterExpr::leaf(p)
    }

    /// Byte-for-byte golden of `origin/main`'s renumber over the tree below,
    /// starting at `?3` (the advanced-query filter's first free slot with no
    /// full-text term: `?1` = space_id, filter binds start at `?2`… here the
    /// harness starts numbering at 3 to mirror the full-text layout).
    const GOLDEN_NUM: &str = "(b.id IN (SELECT block_id FROM block_tags WHERE tag_id = ?3)) AND (EXISTS (SELECT 1 FROM block_properties WHERE block_id = b.id AND key = ?4 AND value_num IS NOT NULL AND value_num > ?5)) AND (((b.todo_state IN (?6))) OR (NOT COALESCE((b.block_type IN (?7)), 0))) AND (COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), 0) >= (CAST(strftime('%s', 'now', ?8) AS INTEGER) * 1000)) AND (EXISTS (SELECT 1 FROM block_links l WHERE l.source_id = b.id AND l.target_id = ?9)) AND (EXISTS (SELECT 1 FROM blocks p1 WHERE p1.id = b.parent_id AND ((p1.id IN (SELECT block_id FROM block_tags WHERE tag_id = ?10)) AND (EXISTS (SELECT 1 FROM blocks p2 WHERE p2.id = p1.parent_id AND ((p2.todo_state IS NULL OR p2.todo_state NOT IN (?11))))))))";

    #[test]
    fn structured_assembly_is_byte_identical_to_legacy_renumber() {
        let expr = FilterExpr::And {
            children: vec![
                leaf(FilterPrimitive::Tag { tag: "TAGX".into() }),
                leaf(FilterPrimitive::HasProperty {
                    key: "score".into(),
                    predicate: PropertyPredicate::Gt {
                        value: PropertyValue::Num { value: 2.0 },
                    },
                }),
                FilterExpr::Or {
                    children: vec![
                        leaf(FilterPrimitive::State {
                            values: vec!["TODO".into()],
                            is_null: false,
                            exclude: false,
                        }),
                        FilterExpr::Not {
                            child: Box::new(leaf(FilterPrimitive::BlockType {
                                values: vec!["page".into()],
                                exclude: false,
                            })),
                        },
                    ],
                },
                leaf(FilterPrimitive::LastEdited {
                    spec: LastEditedSpec::Rolling { days: 7 },
                }),
                leaf(FilterPrimitive::LinksTo {
                    target: "BLK1".into(),
                }),
                leaf(FilterPrimitive::HasParentMatching {
                    matcher: Box::new(FilterExpr::And {
                        children: vec![
                            leaf(FilterPrimitive::Tag { tag: "PTAG".into() }),
                            leaf(FilterPrimitive::HasParentMatching {
                                matcher: Box::new(leaf(FilterPrimitive::State {
                                    values: vec!["DONE".into()],
                                    is_null: false,
                                    exclude: true,
                                })),
                            }),
                        ],
                    }),
                }),
            ],
        };
        let wc = QueryProjection.compile_expr(&expr);
        assert!(!wc.is_unsupported());
        let bind_count = wc.binds.len();
        // The production assembly path (#2255): structured fragment, arithmetic
        // renumber in one pass.
        let fragment = SqlFragment::from_where_clause(wc);
        let mut next = 3usize;
        let rendered = fragment.render(&mut next);
        assert_eq!(
            rendered, GOLDEN_NUM,
            "renumbered SQL must be byte-identical"
        );
        assert_eq!(bind_count, 9, "bind count unchanged");
        assert_eq!(fragment.param_count(), 9, "fragment param count == binds");
        assert_eq!(next, 12, "next free slot after 9 placeholders from ?3");
    }
}
