//! #1280 Phase 0 — composable boolean filter expressions.
//!
//! [`FilterExpr`] is the boolean tree over [`FilterPrimitive`] leaves that the
//! advanced query mode (#1280) composes — `And` / `Or` / `Not` combinators with
//! primitive leaves. It is the cross-surface twin of the backlink resolver's
//! existing `BacklinkFilter` boolean tree (`crate::backlink::filters`): the
//! `compile_expr` default on [`Projection`] lifts the SAME 3-valued
//! `NOT COALESCE((…), 0)` complement logic `compile_backlink_filter` uses, so a
//! `Not` over a NULL-yielding leaf (e.g. a `LEFT JOIN` miss) is the documented
//! set complement rather than SQL's three-valued `NOT NULL = NULL`.
//!
//! **Additive / lossless.** A flat `Vec<FilterPrimitive>` (the existing
//! chip-row shape) is exactly `FilterExpr::And { children: [Leaf, Leaf, …] }`,
//! so every current surface keeps its semantics; the tree only ADDS the ability
//! to nest `Or` / `Not`. No existing query path changes in this phase — this
//! lands as a purely additive module, mirroring how `FilterPrimitive` itself
//! shipped (Phase 1).
//!
//! **Empty-combinator identities** (matching the backlink resolver):
//! - empty `And` is the identity TRUE (`1=1`) — vacuously satisfied;
//! - empty `Or` is the identity FALSE (`1=0`) — no disjunct can match.
//!
//! **Unsupported propagation.** A leaf a projection does not support compiles to
//! [`WhereClause::unsupported`]; any unsupported descendant makes the whole
//! expression unsupported, so a caller's allow-list gate rejects the query as a
//! unit instead of silently emitting a `1=0 /* UNSUPPORTED */` conjunct.

use super::primitive::{Bind, FilterPrimitive, Projection, WhereClause};
use agaric_core::error::AppError;

/// A boolean tree over [`FilterPrimitive`] leaves.
///
/// Struct variants (not newtype/tuple variants) for the same reason
/// [`FilterPrimitive`] uses them: serde's internally-tagged representation
/// (`#[serde(tag = "type")]`) does not support newtype variants wrapping a
/// non-struct, and named fields give the TS union self-describing shapes
/// (`{ type: "Not", child }`).
// NOTE: `Eq` is intentionally NOT derived — `FilterPrimitive` no longer
// implements `Eq` (its `HasProperty` predicate carries an `f64` `Num` value,
// #1280). `PartialEq` is sufficient for every use site.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum FilterExpr {
    /// A single primitive leaf.
    Leaf { primitive: FilterPrimitive },
    /// Conjunction — every child must match. Empty = TRUE (`1=1`).
    And { children: Vec<FilterExpr> },
    /// Disjunction — at least one child must match. Empty = FALSE (`1=0`).
    Or { children: Vec<FilterExpr> },
    /// Set complement of the child (3-valued `NOT COALESCE((…), 0)`).
    Not { child: Box<FilterExpr> },
}

impl FilterExpr {
    /// Wrap a single primitive as a leaf.
    pub fn leaf(primitive: FilterPrimitive) -> Self {
        FilterExpr::Leaf { primitive }
    }

    /// Build the canonical `And` tree from a flat primitive list — the lossless
    /// lift of the existing `Vec<FilterPrimitive>` chip-row shape.
    pub fn all(primitives: impl IntoIterator<Item = FilterPrimitive>) -> Self {
        FilterExpr::And {
            children: primitives.into_iter().map(FilterExpr::leaf).collect(),
        }
    }

    /// Maximum boolean-tree nesting depth accepted from any caller (#1396).
    ///
    /// Mirrors the backlink resolver's `compile_backlink_filter` bound
    /// (`backlink/filters.rs`: `depth > 50`) so the two boolean-tree compilers
    /// reject pathological nesting identically.
    pub const MAX_DEPTH: usize = 50;

    /// Reject a `FilterExpr` whose nesting exceeds [`FilterExpr::MAX_DEPTH`]
    /// (#1396). Callers that build a tree from UNTRUSTED input — a future IPC
    /// command deserialising an advanced query — MUST call this before
    /// [`CompileExpr::compile_expr`], exactly as the allow-list gate must reject
    /// unsupported leaves before compiling. `compile_expr` recurses UNBOUNDED
    /// and is an infallible pure SQL builder, so depth validation is a separate,
    /// caller-invoked gate (the same shape the resolver uses: its entry point
    /// threads `depth` and rejects before recursing deeper).
    ///
    /// The walk checks the bound at the TOP of each frame, BEFORE recursing into
    /// children, so it bounds its OWN recursion to `MAX_DEPTH + 1` frames and
    /// therefore cannot itself overflow the stack on a pathologically deep tree.
    pub fn validate_depth(&self) -> Result<(), AppError> {
        self.check_depth(0)
    }

    fn check_depth(&self, depth: usize) -> Result<(), AppError> {
        if depth > Self::MAX_DEPTH {
            return Err(AppError::validation(format!(
                "Filter nesting depth exceeds {}",
                Self::MAX_DEPTH
            )));
        }
        match self {
            // #1455 — a `has-parent-matching` leaf carries a NESTED FilterExpr
            // (the parent matcher). It must count toward depth so a chain of
            // `has-parent-matching` whose matchers nest each other cannot run
            // the compile recursion away. The boxed matcher is one frame deeper
            // than this leaf, mirroring the `Not { child }` arm.
            FilterExpr::Leaf {
                primitive: FilterPrimitive::HasParentMatching { matcher },
            } => matcher.check_depth(depth + 1),
            FilterExpr::Leaf { .. } => Ok(()),
            FilterExpr::And { children } | FilterExpr::Or { children } => {
                for child in children {
                    child.check_depth(depth + 1)?;
                }
                Ok(())
            }
            FilterExpr::Not { child } => child.check_depth(depth + 1),
        }
    }
}

impl<P: Projection> CompileExpr for P {}

/// `compile_expr` is an extension on every [`Projection`]: it recurses the
/// [`FilterExpr`] tree, compiling each leaf via the projection's own
/// `compile` and combining the fragments with SQL boolean operators. Kept as a
/// separate sealed-by-blanket-impl trait (rather than a `Projection` method) so
/// the core trait stays object-safe-ish and surface impls need only the
/// `compile_*` leaf methods.
pub trait CompileExpr: Projection + Sized {
    /// Compile a boolean [`FilterExpr`] tree into one [`WhereClause`].
    ///
    /// Returns [`WhereClause::unsupported`] if ANY leaf is unsupported by this
    /// projection — the expression is rejected as a unit, never partially
    /// emitted.
    ///
    /// This recurses UNBOUNDED. Callers building a tree from untrusted input
    /// MUST call [`FilterExpr::validate_depth`] first (#1396) — it bounds the
    /// nesting to [`FilterExpr::MAX_DEPTH`] so this recursion cannot overflow
    /// the stack.
    fn compile_expr(&self, expr: &FilterExpr) -> WhereClause {
        match expr {
            FilterExpr::Leaf { primitive } => self.compile(primitive),
            // AND conjuncts are cost-ordered (cheapest first) so index-backed
            // clauses gate the row set before full-scan ones run — the tree
            // twin of the flat cost-order the Pages path applies in
            // `compile_pages_filters`. OR is NOT reordered (see below).
            FilterExpr::And { children } => self.combine(children, " AND ", "1=1", true),
            FilterExpr::Or { children } => self.combine(children, " OR ", "1=0", false),
            FilterExpr::Not { child } => {
                let c = self.compile_expr(child);
                if c.is_unsupported() {
                    return WhereClause::unsupported();
                }
                // 3-valued complement, lifted verbatim from
                // `compile_backlink_filter`'s `Not` arm: COALESCE folds a NULL
                // (LEFT-JOIN miss / unknown) to 0 BEFORE negating, so `Not`
                // is the set complement over non-deleted rows rather than SQL's
                // `NOT NULL = NULL` (which would silently drop the row).
                WhereClause::new(format!("NOT COALESCE(({}), 0)", c.sql), c.binds)
            }
        }
    }

    /// Compile + AND/OR-join the children, parenthesising each fragment.
    /// Empty list yields the supplied identity (`1=1` for AND, `1=0` for OR).
    /// Propagates `unsupported` if any child is unsupported.
    ///
    /// When `cost_order` is set (the AND path only, #2201), the children are
    /// STABLE-sorted by [`child_cost`] ascending — cheapest first — BEFORE
    /// compiling, so index-backed conjuncts narrow the row set before
    /// full-scan ones run, exactly as the Pages path sorts its flat primitive
    /// vec (`compile_pages_filters`). This is a **behaviour-preserving**
    /// optimisation: AND is commutative and its join is a set-intersection, so
    /// REORDERING the conjuncts can never change the result set — only the
    /// evaluation order/speed (even a suboptimal order stays correct). Each
    /// child's compiled fragment carries its OWN binds and we move the
    /// (fragment, binds) pair as a unit, so the positional `?` placeholders
    /// stay matched to their binds. OR is a union whose disjuncts are NOT a
    /// gate for one another, so it is left in declaration order (`cost_order =
    /// false`); NOT wraps a single child and has nothing to reorder.
    fn combine(
        &self,
        children: &[FilterExpr],
        joiner: &str,
        identity: &str,
        cost_order: bool,
    ) -> WhereClause {
        if children.is_empty() {
            return WhereClause::new(identity.to_string(), Vec::new());
        }
        let mut ordered: Vec<&FilterExpr> = children.iter().collect();
        if cost_order {
            // STABLE sort: equal-cost children keep declaration order, so the
            // compiled output stays deterministic for a given input tree.
            ordered.sort_by_key(|c| child_cost(c));
        }
        let mut sql = String::new();
        let mut binds: Vec<Bind> = Vec::new();
        for (i, child) in ordered.iter().enumerate() {
            let c = self.compile_expr(child);
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
}

/// Conservative cost estimate for ordering AND conjuncts cheapest-first
/// (#2201). Because `combine` works over a [`FilterExpr`] TREE — not the flat
/// `Vec<FilterPrimitive>` the Pages path sorts — a composite child needs an
/// AGGREGATE estimate, not just a leaf `cost_hint`:
///
/// - **Leaf** → its [`FilterPrimitive::cost_hint`] (the same 0..=3 SQL-plan
///   scale the Pages path sorts on; lower = cheaper).
/// - **`And`** → the MIN child cost. An intersection can gate on its cheapest
///   conjunct, so an `And` is at least as cheap to start as its cheapest
///   child.
/// - **`Or`** → the MAX child cost. A union must evaluate every disjunct to
///   decide membership, so it is only as cheap as its most expensive branch —
///   the conservative choice (never UNDER-estimates a composite's cost).
/// - **`Not`** → the child's cost. Negation wraps the child in
///   `NOT COALESCE(…)` and does not change which index/scan runs.
///
/// Empty `And`/`Or` compile to the constant identities `1=1` / `1=0`, which
/// are free — cost 0.
///
/// This is only a HEURISTIC for ordering; correctness never depends on it
/// (reordering AND is result-preserving regardless), so a rough estimate is
/// fine. It recurses over the same tree shape as `compile_expr`, so the
/// caller's [`FilterExpr::validate_depth`] gate bounds this recursion too.
fn child_cost(expr: &FilterExpr) -> u8 {
    match expr {
        FilterExpr::Leaf { primitive } => primitive.cost_hint(),
        FilterExpr::And { children } => children.iter().map(child_cost).min().unwrap_or(0),
        FilterExpr::Or { children } => children.iter().map(child_cost).max().unwrap_or(0),
        FilterExpr::Not { child } => child_cost(child),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filters::primitive::{PropertyPredicate, SearchProjection};

    fn tag(t: &str) -> FilterExpr {
        FilterExpr::leaf(FilterPrimitive::Tag { tag: t.to_string() })
    }

    /// A flat `And` of leaves compiles to the parenthesised AND-join, with binds
    /// in left-to-right order — the lossless lift of the chip-row `Vec`.
    #[test]
    fn and_of_leaves_joins_with_and() {
        let expr = FilterExpr::And {
            children: vec![tag("A"), tag("B")],
        };
        let wc = SearchProjection.compile_expr(&expr);
        assert!(!wc.is_unsupported());
        let a = SearchProjection.compile(&FilterPrimitive::Tag { tag: "A".into() });
        let b = SearchProjection.compile(&FilterPrimitive::Tag { tag: "B".into() });
        assert_eq!(wc.sql, format!("({}) AND ({})", a.sql, b.sql));
        let mut want = a.binds.clone();
        want.extend(b.binds.clone());
        assert_eq!(wc.binds, want);
    }

    /// `Or` joins with OR; the disjuncts are parenthesised so operator
    /// precedence cannot bleed across siblings.
    #[test]
    fn or_of_leaves_joins_with_or() {
        let expr = FilterExpr::Or {
            children: vec![tag("A"), tag("B")],
        };
        let wc = SearchProjection.compile_expr(&expr);
        let a = SearchProjection.compile(&FilterPrimitive::Tag { tag: "A".into() });
        let b = SearchProjection.compile(&FilterPrimitive::Tag { tag: "B".into() });
        assert_eq!(wc.sql, format!("({}) OR ({})", a.sql, b.sql));
    }

    /// `Not` wraps in the 3-valued `NOT COALESCE((…), 0)` complement.
    #[test]
    fn not_wraps_in_three_valued_complement() {
        let inner = tag("A");
        let wc = SearchProjection.compile_expr(&FilterExpr::Not {
            child: Box::new(inner),
        });
        let a = SearchProjection.compile(&FilterPrimitive::Tag { tag: "A".into() });
        assert_eq!(wc.sql, format!("NOT COALESCE(({}), 0)", a.sql));
        assert_eq!(wc.binds, a.binds);
    }

    /// Empty `And` is the identity TRUE; empty `Or` is the identity FALSE.
    #[test]
    fn empty_combinators_are_identities() {
        let and = SearchProjection.compile_expr(&FilterExpr::And { children: vec![] });
        assert_eq!(and.sql, "1=1");
        assert!(and.binds.is_empty());
        let or = SearchProjection.compile_expr(&FilterExpr::Or { children: vec![] });
        assert_eq!(or.sql, "1=0");
        assert!(or.binds.is_empty());
    }

    /// Nested `And { Or, Not }` recurses and parenthesises at each level so the
    /// boolean structure is preserved in SQL.
    #[test]
    fn nested_tree_recurses_and_parenthesises() {
        // A AND (B OR NOT C)
        let expr = FilterExpr::And {
            children: vec![
                tag("A"),
                FilterExpr::Or {
                    children: vec![
                        tag("B"),
                        FilterExpr::Not {
                            child: Box::new(tag("C")),
                        },
                    ],
                },
            ],
        };
        let wc = SearchProjection.compile_expr(&expr);
        let a = SearchProjection.compile(&FilterPrimitive::Tag { tag: "A".into() });
        let b = SearchProjection.compile(&FilterPrimitive::Tag { tag: "B".into() });
        let c = SearchProjection.compile(&FilterPrimitive::Tag { tag: "C".into() });
        let expected = format!(
            "({}) AND (({}) OR (NOT COALESCE(({}), 0)))",
            a.sql, b.sql, c.sql
        );
        assert_eq!(wc.sql, expected);
        // Binds preserved in depth-first left-to-right order: A, B, C.
        let mut want = a.binds.clone();
        want.extend(b.binds.clone());
        want.extend(c.binds.clone());
        assert_eq!(wc.binds, want);
    }

    /// An unsupported leaf anywhere makes the whole expression unsupported —
    /// the caller's allow-list gate rejects it as a unit. `Stub` is Pages-only,
    /// so `SearchProjection` reports it unsupported.
    #[test]
    fn unsupported_leaf_poisons_the_whole_expression() {
        let expr = FilterExpr::And {
            children: vec![tag("A"), FilterExpr::leaf(FilterPrimitive::Stub)],
        };
        assert!(SearchProjection.compile_expr(&expr).is_unsupported());
        // Also through Or and Not.
        let or = FilterExpr::Or {
            children: vec![FilterExpr::leaf(FilterPrimitive::Stub)],
        };
        assert!(SearchProjection.compile_expr(&or).is_unsupported());
        let not = FilterExpr::Not {
            child: Box::new(FilterExpr::leaf(FilterPrimitive::Stub)),
        };
        assert!(SearchProjection.compile_expr(&not).is_unsupported());
    }

    /// `FilterExpr::all` lifts a flat primitive list to the canonical `And`.
    #[test]
    fn all_builds_canonical_and() {
        let expr = FilterExpr::all([
            FilterPrimitive::Tag { tag: "A".into() },
            FilterPrimitive::HasProperty {
                key: "status".into(),
                predicate: PropertyPredicate::Exists,
            },
        ]);
        match expr {
            FilterExpr::And { children } => {
                assert_eq!(children.len(), 2);
                assert!(matches!(children[0], FilterExpr::Leaf { .. }));
            }
            _ => panic!("FilterExpr::all must build an And"),
        }
    }

    // ── #1396 — recursion-depth guard ──────────────────────────────────

    /// Wrap a leaf in `n` `Not` layers, so the innermost leaf sits at frame
    /// depth `n` under `check_depth`.
    fn nest_not(n: usize) -> FilterExpr {
        let mut e = tag("A");
        for _ in 0..n {
            e = FilterExpr::Not { child: Box::new(e) };
        }
        e
    }

    /// A tree whose deepest frame is exactly `MAX_DEPTH` is accepted.
    #[test]
    fn validate_depth_accepts_up_to_max() {
        assert!(nest_not(FilterExpr::MAX_DEPTH).validate_depth().is_ok());
    }

    /// One level beyond `MAX_DEPTH` is rejected with a typed `Validation` error.
    #[test]
    fn validate_depth_rejects_beyond_max() {
        let err = nest_not(FilterExpr::MAX_DEPTH + 1)
            .validate_depth()
            .unwrap_err();
        match err {
            AppError::Validation { message: msg, .. } => {
                assert!(msg.contains("exceeds 50"), "unexpected message: {msg}");
            }
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    /// Over-deep nesting via `And`/`Or` (not just `Not`) is also rejected — the
    /// guard counts nesting on every combinator.
    #[test]
    fn validate_depth_rejects_deep_and_chain() {
        let mut e = tag("A");
        for _ in 0..=FilterExpr::MAX_DEPTH {
            e = FilterExpr::And { children: vec![e] };
        }
        assert!(e.validate_depth().is_err());
    }

    /// Depth counts NESTING, not breadth: a very WIDE but shallow tree (1000
    /// sibling leaves under one `And`) is accepted — only nesting can overflow
    /// the `compile_expr` recursion.
    #[test]
    fn validate_depth_accepts_wide_shallow_tree() {
        let wide = FilterExpr::And {
            children: (0..1000).map(|_| tag("A")).collect(),
        };
        assert!(wide.validate_depth().is_ok());
        // And a realistic shallow branching tree: A AND (B OR NOT C).
        let expr = FilterExpr::And {
            children: vec![
                tag("A"),
                FilterExpr::Or {
                    children: vec![
                        tag("B"),
                        FilterExpr::Not {
                            child: Box::new(tag("C")),
                        },
                    ],
                },
            ],
        };
        assert!(expr.validate_depth().is_ok());
        // A bare leaf is the shallowest valid tree.
        assert!(tag("A").validate_depth().is_ok());
    }

    // ── #2201 — cost-ordering the AND children ─────────────────────────

    /// A `PathGlob` leaf — `cost_hint == 2`, an expensive full-scan clause,
    /// used opposite the cheap index-backed `tag` (`cost_hint == 0`).
    fn glob(p: &str) -> FilterExpr {
        FilterExpr::leaf(FilterPrimitive::PathGlob {
            pattern: p.to_string(),
            exclude: false,
        })
    }

    /// `child_cost` maps a leaf to its `cost_hint` and aggregates composites:
    /// `And` = MIN child, `Or` = MAX child, `Not` = child, empty = 0.
    #[test]
    fn child_cost_aggregates_the_tree() {
        // Leaf → its own cost_hint.
        assert_eq!(child_cost(&tag("A")), 0);
        assert_eq!(child_cost(&glob("x")), 2);
        // And → MIN (an intersection can gate on its cheapest conjunct).
        assert_eq!(
            child_cost(&FilterExpr::And {
                children: vec![glob("x"), tag("A")],
            }),
            0
        );
        // Or → MAX (a union must evaluate its most expensive disjunct).
        assert_eq!(
            child_cost(&FilterExpr::Or {
                children: vec![glob("x"), tag("A")],
            }),
            2
        );
        // Not → the child's cost (negation does not change the scan).
        assert_eq!(
            child_cost(&FilterExpr::Not {
                child: Box::new(glob("x"))
            }),
            2
        );
        // Empty combinators compile to constant identities — cost 0.
        assert_eq!(child_cost(&FilterExpr::And { children: vec![] }), 0);
        assert_eq!(child_cost(&FilterExpr::Or { children: vec![] }), 0);
    }

    /// ORDERING: a cheap conjunct is emitted before an expensive one
    /// regardless of declaration order — the compiled AND places `tag`
    /// (cost 0) ahead of `PathGlob` (cost 2).
    #[test]
    fn and_cost_orders_cheap_conjunct_first() {
        let cheap = SearchProjection.compile(&FilterPrimitive::Tag { tag: "A".into() });
        let dear = SearchProjection.compile(&FilterPrimitive::PathGlob {
            pattern: "x".into(),
            exclude: false,
        });
        // Declaration order is EXPENSIVE-then-CHEAP; the cost-order must flip
        // it to CHEAP-then-EXPENSIVE.
        let wc = SearchProjection.compile_expr(&FilterExpr::And {
            children: vec![glob("x"), tag("A")],
        });
        assert_eq!(wc.sql, format!("({}) AND ({})", cheap.sql, dear.sql));
        // Binds move WITH their fragment: cheap leaf's binds come first.
        let mut want = cheap.binds.clone();
        want.extend(dear.binds.clone());
        assert_eq!(wc.binds, want);
    }

    /// RESULT-EQUIVALENCE: AND is commutative, so the SAME children in DIFFERENT
    /// declaration orders compile to the IDENTICAL WhereClause (SQL + binds) —
    /// hence the exact same query, hence the same result set. Reordering is
    /// behaviour-preserving.
    #[test]
    fn and_is_order_independent() {
        let forward = SearchProjection.compile_expr(&FilterExpr::And {
            children: vec![tag("A"), glob("x")],
        });
        let reversed = SearchProjection.compile_expr(&FilterExpr::And {
            children: vec![glob("x"), tag("A")],
        });
        assert_eq!(forward.sql, reversed.sql);
        assert_eq!(forward.binds, reversed.binds);
    }

    /// STABILITY: equal-cost conjuncts keep their declaration order (the sort
    /// is stable), so output stays deterministic and does not reorder by
    /// content. Two same-cost `tag` leaves stay in the order given.
    #[test]
    fn and_stable_sort_preserves_equal_cost_order() {
        let a = SearchProjection.compile(&FilterPrimitive::Tag { tag: "A".into() });
        let b = SearchProjection.compile(&FilterPrimitive::Tag { tag: "B".into() });
        let ab = SearchProjection.compile_expr(&FilterExpr::And {
            children: vec![tag("A"), tag("B")],
        });
        assert_eq!(ab.sql, format!("({}) AND ({})", a.sql, b.sql));
        let ba = SearchProjection.compile_expr(&FilterExpr::And {
            children: vec![tag("B"), tag("A")],
        });
        assert_eq!(ba.sql, format!("({}) AND ({})", b.sql, a.sql));
    }

    /// A COMPOSITE child is ordered by its aggregate estimate: an `Or` of two
    /// expensive globs (aggregate MAX = 2) is emitted AFTER a cheap `tag`
    /// (cost 0), even though the `Or` is declared first.
    #[test]
    fn and_orders_composite_child_by_aggregate_cost() {
        let wc = SearchProjection.compile_expr(&FilterExpr::And {
            children: vec![
                FilterExpr::Or {
                    children: vec![glob("x"), glob("y")],
                },
                tag("A"),
            ],
        });
        let tag_sql = SearchProjection
            .compile(&FilterPrimitive::Tag { tag: "A".into() })
            .sql;
        let or_sql = {
            let x = SearchProjection
                .compile(&FilterPrimitive::PathGlob {
                    pattern: "x".into(),
                    exclude: false,
                })
                .sql;
            let y = SearchProjection
                .compile(&FilterPrimitive::PathGlob {
                    pattern: "y".into(),
                    exclude: false,
                })
                .sql;
            format!("({x}) OR ({y})")
        };
        assert_eq!(wc.sql, format!("({tag_sql}) AND ({or_sql})"));
    }

    /// OR is NOT reordered: cost-ordering is an AND-only gating optimisation.
    /// An `Or` of expensive-then-cheap stays in declaration order.
    #[test]
    fn or_is_not_cost_ordered() {
        let wc = SearchProjection.compile_expr(&FilterExpr::Or {
            children: vec![glob("x"), tag("A")],
        });
        let dear = SearchProjection
            .compile(&FilterPrimitive::PathGlob {
                pattern: "x".into(),
                exclude: false,
            })
            .sql;
        let cheap = SearchProjection
            .compile(&FilterPrimitive::Tag { tag: "A".into() })
            .sql;
        assert_eq!(wc.sql, format!("({dear}) OR ({cheap})"));
    }
}
