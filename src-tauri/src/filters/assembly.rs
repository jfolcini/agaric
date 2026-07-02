//! #2255 — structured composition of compiled SQL filter fragments.
//!
//! A [`Projection::compile_*`](crate::filters::Projection) call yields a
//! [`WhereClause`] whose `sql` carries bare `?` placeholders in left-to-right
//! bind order. Historically several call sites spliced those fragments into a
//! larger statement by walking the SQL text char-by-char, rewriting each `?`
//! into an explicit `?N` while hand-tracking a running counter
//! (`query::engine::renumber`, `fts::filter_builder`'s `add_projection_clause`,
//! `commands::pages::compile_pages_filters`). That text surgery rested on two
//! invariants that were enforced only by a `debug_assert!` (compiled out in
//! release) and were invisible to fragment authors:
//!
//!   1. every `?` in a fragment is a bind placeholder — never a literal `?`
//!      inside a quoted string;
//!   2. the number of `?` equals `binds.len()`.
//!
//! A future projection that emitted a string literal containing `?`, or whose
//! `?`/bind counts drifted, would MISBIND values in release with no signal.
//!
//! This module replaces the char-scan with a structured representation.
//! [`SqlFragment`] splits the fragment ONCE, at construction, into the literal
//! spans between placeholders. Renumbering is then a single arithmetic pass
//! that interleaves the spans with `?{n}` — placeholder positions are data, not
//! re-derived by re-scanning for `?` at every splice. The span/bind-count
//! invariant is a HARD assertion active in EVERY build profile (the
//! release-active promotion of the former `debug_assert!`), so a malformed
//! fragment fails loudly instead of silently misbinding. A fragment's SQL never
//! interpolates a user string (values, property keys, and glob patterns are all
//! bound `?`), so the invariant can only be violated by a fragment-author bug,
//! never by user input — making the `assert` the correct failure mode.
//!
//! **Byte-for-byte identical output.** Splitting on `?` and re-joining with
//! `?{n}` is the exact inverse of the former char-by-char rewrite for any
//! fragment satisfying invariant (1), so every pinned SQL snapshot is
//! unchanged.

use crate::filters::primitive::{Bind, WhereClause};

/// A compiled boolean SQL fragment with structurally-tracked placeholders.
///
/// The fragment's literal SQL is stored pre-split into the spans that surround
/// its bind placeholders, so the placeholder count is structural data rather
/// than something re-derived by scanning the text. [`render`](Self::render)
/// then numbers the placeholders in a single arithmetic pass.
#[derive(Debug, Clone)]
pub struct SqlFragment {
    /// The literal SQL spans between placeholders. Invariant:
    /// `spans.len() == binds.len() + 1`. The rendered SQL is
    /// `spans[0] ?p0 spans[1] ?p1 … ?p{n-1} spans[n]`.
    spans: Vec<String>,
    /// Positional bind values, one per placeholder, in span order.
    binds: Vec<Bind>,
}

impl SqlFragment {
    /// Build from a bare-`?` SQL string and its ordered binds.
    ///
    /// Splits `sql` on `?`; the resulting span count MUST be exactly
    /// `binds.len() + 1` — i.e. exactly `binds.len()` real `?` placeholders,
    /// none of them a literal inside a string. A mismatch is a fragment-author
    /// bug (user input only ever controls bound VALUES, never the fragment
    /// text), so it is a hard `assert` active in release too — the promotion of
    /// the former `debug_assert!` the placeholder renumberers relied on.
    #[must_use]
    pub fn new(sql: &str, binds: Vec<Bind>) -> Self {
        let spans: Vec<String> = sql.split('?').map(str::to_owned).collect();
        assert_eq!(
            spans.len(),
            binds.len() + 1,
            "SQL fragment placeholder/bind mismatch: {} `?` placeholder(s) but {} bind(s) \
             (a `?` in a string literal, or a `?`/bind count drift, would misbind in release); \
             sql = {sql:?}",
            spans.len() - 1,
            binds.len(),
        );
        Self { spans, binds }
    }

    /// Build from a compiled [`WhereClause`]. The caller MUST have already
    /// rejected `unsupported()` clauses — their sentinel SQL must never reach a
    /// statement.
    #[must_use]
    pub fn from_where_clause(wc: WhereClause) -> Self {
        debug_assert!(
            !wc.is_unsupported(),
            "an unsupported WhereClause must be rejected, not assembled",
        );
        Self::new(&wc.sql, wc.binds)
    }

    /// Number of positional placeholders (equivalently, of binds).
    #[must_use]
    pub fn param_count(&self) -> usize {
        self.binds.len()
    }

    /// The bound values, in placeholder order.
    #[must_use]
    pub fn binds(&self) -> &[Bind] {
        &self.binds
    }

    /// Render the fragment to SQL, numbering its placeholders `?{*next_pos}`,
    /// `?{*next_pos + 1}`, … and advancing `*next_pos` past the last one.
    ///
    /// Byte-for-byte identical to the former char-by-char `?`→`?N` rewrite: the
    /// spans are the exact substrings the old scan copied verbatim, and the
    /// numbering starts at the same slot and increments by one per placeholder.
    #[must_use]
    pub fn render(&self, next_pos: &mut usize) -> String {
        let mut out = String::with_capacity(
            self.spans.iter().map(String::len).sum::<usize>() + self.binds.len() * 3,
        );
        for (i, span) in self.spans.iter().enumerate() {
            out.push_str(span);
            // A placeholder follows every span except the last.
            if i < self.binds.len() {
                out.push('?');
                out.push_str(&next_pos.to_string());
                *next_pos += 1;
            }
        }
        out
    }

    /// Consume the fragment, yielding its binds (call after [`render`](Self::render)
    /// has produced the SQL).
    #[must_use]
    pub fn into_binds(self) -> Vec<Bind> {
        self.binds
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `render` is the exact inverse of splitting on `?`: for every fragment
    /// with no literal `?`, re-numbering reproduces the char-by-char rewrite.
    fn legacy_renumber(sql: &str, next_pos: &mut usize) -> String {
        let mut out = String::new();
        for ch in sql.chars() {
            if ch == '?' {
                out.push('?');
                out.push_str(&next_pos.to_string());
                *next_pos += 1;
            } else {
                out.push(ch);
            }
        }
        out
    }

    fn binds(n: usize) -> Vec<Bind> {
        (0..n)
            .map(|i| Bind::Int(i64::try_from(i).unwrap()))
            .collect()
    }

    #[test]
    fn render_matches_legacy_renumber_across_shapes() {
        let cases = [
            ("", 0usize, 1usize),
            ("1=1", 0, 1),
            ("b.parent_id = ?", 1, 6),
            ("a = ? AND b = ? OR c = ?", 3, 3),
            (
                "EXISTS (SELECT 1 FROM t WHERE k = ? AND v LIKE ? ESCAPE '\\')",
                2,
                42,
            ),
        ];
        for (sql, n, start) in cases {
            let frag = SqlFragment::new(sql, binds(n));
            let mut a = start;
            let got = frag.render(&mut a);
            let mut b = start;
            let want = legacy_renumber(sql, &mut b);
            assert_eq!(got, want, "SQL mismatch for {sql:?}");
            assert_eq!(a, b, "next_pos mismatch for {sql:?}");
            assert_eq!(a, start + n, "advanced by exactly the placeholder count");
        }
    }

    #[test]
    fn empty_fragment_renders_empty() {
        let frag = SqlFragment::new("", Vec::new());
        assert_eq!(frag.param_count(), 0);
        let mut pos = 7;
        assert_eq!(frag.render(&mut pos), "");
        assert_eq!(pos, 7);
    }

    #[test]
    fn single_placeholder() {
        let frag = SqlFragment::new("x = ?", vec![Bind::Text("v".into())]);
        let mut pos = 3;
        assert_eq!(frag.render(&mut pos), "x = ?3");
        assert_eq!(pos, 4);
        assert_eq!(frag.into_binds(), vec![Bind::Text("v".into())]);
    }

    #[test]
    #[should_panic(expected = "placeholder/bind mismatch")]
    fn too_few_binds_hard_errors_in_release() {
        // Two `?` but only one bind — the release-active promotion of the
        // former debug_assert. (A `?` in a string literal produces this shape.)
        let _ = SqlFragment::new("a = ? AND b = ?", vec![Bind::Int(1)]);
    }

    #[test]
    #[should_panic(expected = "placeholder/bind mismatch")]
    fn too_many_binds_hard_errors() {
        let _ = SqlFragment::new("a = ?", vec![Bind::Int(1), Bind::Int(2)]);
    }
}
