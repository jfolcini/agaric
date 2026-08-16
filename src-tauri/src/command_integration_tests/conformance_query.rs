//! #3347 — post-op READ-command query steps for the #763 conformance harness
//! (Rust side / source of truth).
//!
//! The #763 harness pins MUTATING behaviour: it replays a fixture's op
//! sequence and diffs the resulting raw table state (`conformance_snapshot`).
//! It never calls a read command, so every `get_` / `list_` / `query_` /
//! `search_` command the UI actually renders from was outside the differential
//! — the mock could answer them however it liked.
//!
//! A fixture may now carry an optional top-level `queries` array. After the op
//! sequence has settled, each step runs ONE read command against the real
//! backend and is projected into a small, representation-stable shape:
//!
//! ```json
//! { "name": "…", "rows": ["B2", "B4"], "has_more": false, "total_count": 2,
//!   "cursor": null, "error": null }
//! ```
//!
//! `error` is the [`AppErrorKind`] wire string when the command REFUSED, and
//! the rest of the projection then reads as an empty result. A refusal is an
//! answer: `get_block` 404s a tombstone, and #3928 is what happens when a step
//! is written so that it cannot see one.
//!
//! The projected results are written back into the fixture's `expected_queries`
//! by the same `CONFORMANCE_UPDATE=1` authoring flow that writes `expected`, and
//! the TS twin (`src/lib/tauri-mock/__tests__/conformance-query.ts`) replays the
//! SAME steps through the tauri-mock and asserts the SAME recorded values. One
//! backend-authored expectation therefore binds both implementations.
//!
//! A row may carry ATTRIBUTES (`B2#page_id=B1#deleted_at=DELETED`) when the
//! ids alone cannot see the command's projection; the grammar and its two
//! comparability rules are documented at "Row tokens" below.
//!
//! ## Pagination: `cursor_from`
//!
//! A step may declare `"cursor_from": "<earlier step name>"`, which feeds that
//! step's own `next_cursor` into this one (at the command's [`cursor_path`]).
//! Each stack paginates through its OWN cursor, and the ROWS of the second page
//! are recorded — per #3821 that is exactly what a keyset-ordering divergence
//! changes. A single-page step pins nothing about the RESUME.
//!
//! It does still pin the cursor's SHAPE. Every step that mints a `next_cursor`
//! records [`cursor_shape`] of it — the schema version plus the keyset
//! structure, with the boundary values erased. That closes #3893: before it,
//! the cursor never entered the recorded projection in any form, so a change to
//! the Rust cursor format could land with the mock silently diverging and every
//! fixture green. The bytes themselves are still NOT recorded, and
//! [`cursor_shape`] documents why that is the stronger choice rather than the
//! weaker one.
//!
//! ## Why `rows` is a list of canonical tokens
//!
//! Op-created blocks get a random ULID on the backend and a mock-local id in the
//! mock, so raw ids are not comparable. `rows` is relabeled through the SAME
//! canonical `B1, B2, …` map the snapshot uses (seed ids in seed order, then
//! created ids in op order), which IS comparable. An id with no canonical label
//! passes through unchanged so a leak is visible rather than silently dropped.
//!
//! ## Why the wire key names are hard-coded per command
//!
//! Each arm below reads its ids out of the SERIALIZED response using the real
//! wire keys (`items` / `rows` / `edges`, `has_more` vs `hasMore`, …), and the TS
//! twin reads the mock's response with the SAME key table. A mock handler that
//! returns the right rows under the wrong envelope key therefore projects to an
//! empty `rows` and fails, instead of being normalised into agreement by a
//! shape-tolerant extractor.
//!
//! ## Ordering — a DELIBERATELY WEAKENED comparison
//!
//! `rows` is canonically SORTED unless the step sets `"ordered": true`, so by
//! default a step compares SETS, not sequences: every ordering divergence is
//! invisible to it. ONE reason remains benign: when the sort key is the raw
//! block id and the fixture creates blocks through ops, the ids genuinely
//! differ between the stacks, so their order is not comparable at all.
//!
//! #3821 used to be a second reason — the mock's `run_advanced_query` sorted
//! `b.id ASC` (and paginated its keyset that way) while the engine's terminal
//! tiebreaker is `b.id DESC` (`resolve_sort` in
//! `agaric-store/src/query/engine.rs`). That was never an incomparability:
//! `query_advanced_filters` queries only SEED blocks, whose ids are
//! byte-identical on both stacks. #3821 is closed and the mock's
//! `resolveSortTerms` now mirrors `resolve_sort`, so #3927 set `"ordered":
//! true` on the DEFAULT-sorted `run_advanced_query` steps and re-authored,
//! exactly as this note predicted. It matters beyond tidiness: those steps are
//! the only evidence for `run_advanced_query`'s DEFAULT sort arm in the branch
//! manifest (`conformance-coverage.test.ts`), and a set comparison is no
//! evidence at all about an ORDERING branch.
//!
//! Scope note (#3893): the closed #3821 only ever covered the DEFAULT keyset.
//! The `advanced_position_page_*` steps added for #3893 carry an EXPLICIT
//! `position` sort, are `"ordered": true`, and pass — including the `B2`
//! before `B1` tie at position 1, which is the appended `b.id DESC`
//! tiebreaker deciding. So a request that names its own sort was never
//! exposed to #3821 in the first place.
//!
//! #3873 used to be a third reason here — `list_tags_for_block` returned
//! `blockTags` INSERTION order on the mock against the backend's `ORDER BY
//! tag_id`. The mock now sorts, so `query_point_reads_tags`'s
//! `tags_two_surviving_in_id_order` step is `"ordered": true` and pins the
//! sequence for real: it applies its two tags in DESCENDING id order, so an
//! implementation that answers in application order fails it. The flip needed
//! no re-authoring, exactly as this note predicted.
//!
//! Steps whose sort key is fixture-controlled data (page title, …) set
//! `ordered` and DO compare sequences.

use super::common::pages::list_pages_with_metadata_inner;
use super::common::*;
use super::conformance::seed_label_to_id;
use super::conformance_snapshot::token_key;
use agaric_core::ulid::BlockId;
use agaric_store::query::{AdvancedQueryRequest, compile_and_run};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Fixture token expanded to the harness space id wherever it appears in a
/// query step's args. Fixtures must not hard-code [`TEST_SPACE_ID`]; the TS twin
/// expands the same token to the same literal.
pub const SPACE_TOKEN: &str = "$SPACE";

/// Expand one fixture-local token: `$SPACE` → the harness space id, `S<n>` → the
/// 26-char expansion of that seed label. Anything else passes through.
fn expand_token(s: &str) -> String {
    if s == SPACE_TOKEN {
        return TEST_SPACE_ID.to_owned();
    }
    let is_seed_label =
        s.len() >= 2 && s.starts_with('S') && s[1..].chars().all(|c| c.is_ascii_digit());
    if is_seed_label {
        return seed_label_to_id(s);
    }
    s.to_owned()
}

/// Recursively expand every string in a query step's args. Applied identically
/// on the TS side, so both stacks receive byte-identical arguments.
pub fn expand_query_args(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(expand_token(s)),
        Value::Array(a) => Value::Array(a.iter().map(expand_query_args).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, val)| (k.clone(), expand_query_args(val)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// One read command's result, before canonical relabeling.
struct RawResult {
    rows: Vec<String>,
    has_more: Option<bool>,
    total_count: Option<i64>,
    /// The envelope's `next_cursor`. Threaded to the next step (`cursor_from`
    /// in [`run_query_steps`]) and, since #3893, projected through
    /// [`cursor_shape`] into the recorded `cursor` field. The raw bytes are
    /// still never recorded — they carry the boundary row's ids and clock
    /// stamps, which are not comparable across the stacks.
    next_cursor: Option<String>,
}

/// Pull `<id_key>` out of each row of an already-located row array.
fn ids_in(rows: &[Value], id_key: &str) -> Vec<String> {
    rows.iter()
        .map(|r| {
            r.get(id_key)
                .and_then(Value::as_str)
                .unwrap_or("<missing-id>")
                .to_owned()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Row tokens (#3826)
// ---------------------------------------------------------------------------
//
// A row token is
//
//     token := head ("#" attr-name "=" attr-value)*
//     head  := <id> | <id> "->" <id> | <opaque key>
//
// `relabel_token` rewrites BOTH sides of an arrow head and every attr VALUE
// through the canonical `Bn` map, so `B1->B3#page_id=B1` reads the same on
// either stack. Attributes exist because an id-only token cannot see a
// projection bug: a command that returns the right rows with the wrong
// `page_id`, the wrong `deleted` flag or the wrong typed value would compare
// equal. Two rules keep an attribute comparable across the stacks:
//
//   * NEVER attach a clock-derived column verbatim. `deleted_at` is an
//     epoch-ms stamp that differs on every run, so it is normalised to the
//     `DELETED` sentinel the #763 snapshot already uses.
//   * NEVER attach content carrying `#` or `->`; the grammar would not survive
//     the round trip. Fixture-authored ASCII words are fine.
//
// The TS twin implements the same grammar in `conformance-query.ts`.

/// The `deleted_at` sentinel — mirrors `conformance_snapshot`'s normalisation
/// of the epoch-ms tombstone stamp.
const DELETED_SENTINEL: &str = "DELETED";

/// Attributes carried by every `BlockRow`-shaped row. `parent_id` / `page_id`
/// are relabeled ids, so a command that serves the right blocks with the wrong
/// tree links (the #1775 class) still reddens; `deleted_at` says whether the
/// command's SQL filters tombstones. MUST match `BLOCK_ATTRS` in the TS twin.
const BLOCK_ATTRS: &[&str] = &["parent_id", "page_id", "position", "deleted_at"];

/// Attributes of a `ResolvedBlock` — the lightweight chip projection.
/// `title` is the RENAMED `content` column and `deleted` the derived tombstone
/// flag: both are projection decisions an id-only token cannot see.
const RESOLVED_ATTRS: &[&str] = &["title", "block_type", "deleted"];

/// The half-open magnitude range in which Rust's `f64` `Display` and the TS
/// twin's `String(n)` provably produce the same characters.
///
/// JS switches to exponent notation at `|v| >= 1e21` and at `0 < |v| < 1e-6`
/// (`String(1e-7) === '1e-7'`), and prints `-0` as `'0'`; Rust's `Display` does
/// neither (`(1e-7_f64).to_string() == "0.0000001"`, `format!("{:.0}", -0.0) ==
/// "-0"`). A `value_num` out there would therefore token DIFFERENTLY on the two
/// runners and redden a fixture that holds no divergence at all — the one way
/// this harness can lie. Zero is comparable, negative zero is not.
const JS_PLAIN_RANGE: std::ops::Range<f64> = 1e-6..1e21;

/// Render one attribute value as a token segment.
///
/// Numbers are printed the way `String(n)` prints them in the TS twin. Rust's
/// `Display` for `f64` already matches inside [`JS_PLAIN_RANGE`] — it prints
/// `3.0` as `3` (the trailing `.0` is `Debug`, not `Display`) and never uses
/// exponent form — so no integral special-case is needed, and an earlier one
/// here was dead code justified by serde_json's rendering, which the
/// `as_f64` hop means never reaches the output. A magnitude the two
/// formatters DO disagree on is REFUSED at authoring time rather than
/// recorded — see [`JS_PLAIN_RANGE`].
///
/// The rendered value is also refused if it contains `#` or `->`, the two
/// sequences the token grammar uses as separators. That failure mode is not a
/// red/green flip — both runners build the identical string — it is token
/// ALIASING: content `a#b` renders `B2#title=a#b#block_type=…`, which a
/// differently-split row can match, so a real projection bug in that column
/// could compare EQUAL. `RESOLVED_ATTRS` carries `title`, i.e. the raw
/// `content` column, and `#` is ordinary text in this app — this is reachable,
/// not theoretical.
fn attr_value(name: &str, v: Option<&Value>) -> String {
    let rendered = match v {
        None | Some(Value::Null) => "null".to_owned(),
        Some(_) if name == "deleted_at" => DELETED_SENTINEL.to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.as_f64().map_or_else(
            || n.to_string(),
            |f| {
                assert!(
                    (f == 0.0 && !f.is_sign_negative()) || JS_PLAIN_RANGE.contains(&f.abs()),
                    "{}query attribute '{name}' holds {f}, whose Rust and JS renderings \
                     differ (exponent form / signed zero), so the two conformance \
                     runners could never agree on its token. Give the fixture a value \
                     in ±[1e-6, 1e21) or exactly 0.",
                    projecting_at()
                );
                f.to_string()
            },
        ),
        Some(other) => other.to_string(),
    };
    assert!(
        !rendered.contains('#') && !rendered.contains("->"),
        "{}query attribute '{name}' renders as {rendered:?}, which contains a token \
         separator ('#' or '->'). Both runners would build the SAME string, so this \
         does not redden — it ALIASES: a differently-split row can match the same \
         token, and a real projection bug in this column would compare equal. Pick \
         fixture content without those sequences.",
        projecting_at()
    );
    rendered
}

/// Refuse a token HEAD carrying a separator, for the same reason [`attr_value`]
/// refuses one in a value.
///
/// [`attr_value`] guards only the ATTRIBUTE side of
/// `head ("#" attr-name "=" attr-value)*`, but the head is concatenated with
/// those segments and aliases across the join just as readily. The property key
/// `a#b` holding `value_text: "x"` renders `a#b#Text=x` — byte-identical to the
/// key `a` carrying a `b#Text=x` segment — so the two compare EQUAL and a
/// projection bug that swaps one for the other is invisible. `->` is the same
/// hazard against the arrow heads of the map projections.
///
/// Reachable, not theoretical: `set_property` takes its key straight from the
/// caller, so property keys are USER-AUTHORED text in which `#` is ordinary.
fn token_head(what: &str, head: &str) -> String {
    assert!(
        !head.contains('#') && !head.contains("->"),
        "{}query {what} {head:?} contains a token separator ('#' or '->'). Both \
         runners would build the SAME string, so this does not redden — it \
         ALIASES: the head runs straight into the '#'-joined attribute segments \
         (and into the '->' of a map pair), so a differently-split token matches \
         it and a real projection bug compares equal. Pick fixture keys without \
         those sequences.",
        projecting_at()
    );
    head.to_owned()
}

/// Build `<row[id_key]>#<attr>=<value>…` for one serialized row.
fn row_token(row: &Value, id_key: &str, attrs: &[&str]) -> String {
    let mut token = token_head(
        "row id",
        row.get(id_key)
            .and_then(Value::as_str)
            .unwrap_or("<missing-id>"),
    );
    for attr in attrs {
        token.push('#');
        token.push_str(attr);
        token.push('=');
        token.push_str(&attr_value(attr, row.get(*attr)));
    }
    token
}

/// Build `<key>#<ValueType>=<value>` for one serialized `PropertyRow`.
///
/// The `(value_type, value)` derivation is the SAME first-non-null-column
/// precedence the #763 snapshot uses (`property_typed_value` in
/// `conformance_snapshot.rs`), so a property read and the snapshot row it comes
/// from disagree only when the command's own projection is wrong. `Bool` keeps
/// SQLite's raw `0` / `1` INTEGER — both stacks store the integer.
fn property_token(row: &Value) -> String {
    let key = token_head(
        "property key",
        row.get("key")
            .and_then(Value::as_str)
            .unwrap_or("<missing-key>"),
    );
    for (column, tag) in [
        ("value_text", "Text"),
        ("value_num", "Num"),
        ("value_date", "Date"),
        ("value_ref", "Ref"),
        ("value_bool", "Bool"),
    ] {
        if row.get(column).is_some_and(|v| !v.is_null()) {
            return format!("{key}#{tag}={}", attr_value(column, row.get(column)));
        }
    }
    format!("{key}#null=null")
}

/// Project a `HashMap<K, Row>` response (`first_child_for_blocks`) into
/// `<map-key>-><row id>` tokens.
fn map_row_tokens(v: &Value, id_key: &str, attrs: &[&str]) -> Vec<String> {
    v.as_object().map_or_else(Vec::new, |map| {
        map.iter()
            .map(|(k, row)| {
                format!(
                    "{}->{}",
                    token_head("map key", k),
                    row_token(row, id_key, attrs)
                )
            })
            .collect()
    })
}

/// Project a `HashMap<K, Vec<Row>>` response (`get_batch_properties`) into
/// `<map-key>-><row token>` tokens.
///
/// A key present with an EMPTY array projects to `<map-key>->(none)`. That is
/// the whole point of the shape: `get_batch_properties_inner` OMITS a block
/// with no properties, and "key absent" vs "key present holding `[]`" is
/// exactly the distinction a reimplementation gets wrong — flattening the map
/// would make the two look identical.
fn map_rows_tokens(v: &Value, token: &dyn Fn(&Value) -> String) -> Vec<String> {
    v.as_object().map_or_else(Vec::new, |map| {
        map.iter()
            .flat_map(|(k, rows)| {
                let head = token_head("map key", k);
                let rows = rows.as_array().cloned().unwrap_or_default();
                if rows.is_empty() {
                    return vec![format!("{head}->(none)")];
                }
                rows.iter()
                    .map(|r| format!("{head}->{}", token(r)))
                    .collect()
            })
            .collect()
    })
}

/// Project `AdvancedQueryResponse.groups` — the GROUPED-mode payload (#3833
/// item 2).
///
/// The two modes are exclusive by construction: `group_by` absent fills `rows`
/// and leaves `groups` empty, `group_by` present fills `groups` and leaves
/// `rows` empty (see [`agaric_store::query::AdvancedQueryResponse`]). The arm
/// therefore CONCATENATES the two projections — exactly one contributes — so
/// flat steps are byte-unchanged and a grouped step stops projecting to `[]`.
/// Until this existed, a grouped step recorded nothing at all: the vacuity
/// guard would have caught the empty projection, but only after the ratchet had
/// already counted `run_advanced_query` as covered, so the command read as
/// exercised in a mode neither runner compared.
///
/// Each bucket contributes
///
///   * `<key>#count=<n>` — the bucket's FULL size, which is the load-bearing
///     number in grouped mode (`members` is a capped preview, and `total_count`
///     counts GROUPS rather than rows), and
///   * one `<key>-><member row>` per preview member, or `<key>->(none)` when
///     the preview is empty — the same `head->row` shape [`map_rows_tokens`]
///     uses, for the same reason: a bucket that serves no members must be
///     visible rather than collapse into its count token.
///
/// …plus one `#agg<i>=<op>/<value>/<count>` segment on the count token per
/// entry of the bucket's own `aggregates`, in request order.
///
/// ## Why per-group `aggregates` IS bound and response-level `aggregates` is not
///
/// This distinction is load-bearing, because the reason first offered for
/// skipping the per-group field — "the mock synthesises it, so a recorded
/// expectation pins the stub" — is equally true of `groups`, which is bound
/// here regardless. Synthesis is not the discriminator. Two things are:
///
///   * **It is a field of the thing this function projects.** `QueryGroup`
///     (`agaric-store/src/query/mod.rs`) has four fields; reading three of them
///     is a projection with a hole in it, and a hole in a projection is
///     invisible in exactly the way #3833 item 2 is about. Response-level
///     `aggregates` is a sibling of `groups`, not a part of it, and belongs to
///     whatever binds the response envelope.
///   * **The divergence is live, not hypothetical.** Per-group aggregates are
///     computed per bucket on the backend and are NOT first-page-gated
///     (`engine.rs`'s `run_grouped` decodes an `a0…aN` cell per bucket and
///     clones it into each `QueryGroup`), while the mock reuses ONE
///     index-derived stub array for both the response-level and the per-group
///     field (`handlers/search.ts`). Binding this does not "pin the stub": it
///     makes the first fixture that requests an aggregate REDDEN, which is the
///     correct outcome for a mock that answers `sum` with `(i + 1) * 10`.
///
/// The values go through [`attr_value`], so the same JS/Rust float-rendering
/// refusal that guards every other numeric attribute guards these too.
fn group_tokens(v: &Value) -> Vec<String> {
    v.get("groups")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |groups| {
            groups
                .iter()
                .flat_map(|g| {
                    let head = token_head(
                        "group key",
                        g.get("key")
                            .and_then(Value::as_str)
                            .unwrap_or("<missing-key>"),
                    );
                    let mut out = vec![format!(
                        "{head}#count={}{}",
                        attr_value("count", g.get("count")),
                        aggregate_segments(g)
                    )];
                    let members = g
                        .get("members")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    if members.is_empty() {
                        out.push(format!("{head}->(none)"));
                    } else {
                        out.extend(
                            members
                                .iter()
                                .map(|m| format!("{head}->{}", row_token(m, "id", &[]))),
                        );
                    }
                    out
                })
                .collect()
        })
}

/// One `#agg<i>=<op>/<value>/<count>` segment per entry of a bucket's
/// `aggregates`, appended to that bucket's count token (#3833 item 2 — see
/// [`group_tokens`] for why this field is bound).
///
/// All three cells are recorded rather than "whichever is non-null", because
/// WHICH one an operator fills is the projection under test:
/// [`agaric_store::query::AggregateResult`] fills `count` for `Count` and
/// `value` for the folds, and a reimplementation that answers a `Sum` in
/// `count` would compare equal to one that answers it in `value` if only the
/// populated cell were recorded. The INDEX is in the segment name because the
/// contract is "same order as the request's `aggregates`", so a reordering must
/// redden. Empty string when the bucket carries none, which is every bucket a
/// fixture authors today.
fn aggregate_segments(g: &Value) -> String {
    let mut out = String::new();
    let aggs = g.get("aggregates").and_then(Value::as_array);
    for (i, a) in aggs.into_iter().flatten().enumerate() {
        out.push_str(&format!(
            "#agg{i}={}/{}/{}",
            attr_value("aggregates[].op", a.get("op")),
            attr_value("aggregates[].value", a.get("value")),
            attr_value("aggregates[].count", a.get("count")),
        ));
    }
    out
}

/// Project a bare `Vec<String>` response (the tag-id readers) — the row IS the
/// token, relabeled like any other id.
fn scalar_tokens(v: &Value) -> Vec<String> {
    v.as_array().map_or_else(Vec::new, |rows| {
        rows.iter()
            .map(|r| r.as_str().unwrap_or("<not-a-string>").to_owned())
            .collect()
    })
}

/// Pull `<rows_key>[].<id_key>` out of a serialized response. A missing key
/// yields an EMPTY list rather than a panic: the point is that a response whose
/// envelope drifted projects to nothing and reddens the diff.
fn ids_at(v: &Value, rows_key: &str, id_key: &str) -> Vec<String> {
    v.get(rows_key)
        .and_then(Value::as_array)
        .map(|rows| ids_in(rows, id_key))
        .unwrap_or_default()
}

/// One step's args, carrying WHO is asking (#3833 item 5).
///
/// Every accessor below fires on exactly one person: the author of a brand-new
/// fixture, who has just mistyped a key or given it the wrong JSON shape. Until
/// this existed those panics named only the arg (`query step is missing
/// required arg 'scope'`) — and since a fixture may hold a dozen steps and the
/// suite holds a dozen fixtures, all run under one `#[tokio::test]`, that
/// message did not say which of ~150 sites produced it. #3429 fixed exactly
/// this class for the op runner, where `read_structural_op_parent` threads
/// `fixture_name` + `command` + `block_id` through for the same reason.
///
/// It is a WRAPPER rather than three extra parameters on purpose. The context
/// is needed at ~50 accessor call sites across 20 match arms; threading it
/// explicitly would have rewritten all 50, while replacing the `&Value` they
/// already take leaves every one of them character-for-character unchanged.
/// The arms read `args.command` instead of a separate parameter for the same
/// reason — the command is part of the identity of the step, not of the call.
struct StepArgs<'a> {
    /// The step's `args` object, already `$SPACE`/`S<n>`-expanded and with any
    /// `cursor_from` cursor injected.
    value: &'a Value,
    /// The fixture's `name` — the file the author is editing.
    fixture: &'a str,
    /// The step's `name` within that fixture.
    step: &'a str,
    /// The read command this step runs.
    command: &'a str,
}

impl StepArgs<'_> {
    fn get(&self, key: &str) -> Option<&Value> {
        self.value.get(key)
    }

    /// The prefix every failure in this module carries. One phrasing, used by
    /// every accessor, so a fixture author greps for their own fixture name.
    fn at(&self) -> String {
        step_context(self.fixture, self.step, self.command)
    }
}

/// THE phrasing of the #3833 item 5 context. One function so the accessor
/// panics (which reach it through [`StepArgs::at`]) and the token-grammar
/// panics (which reach it through [`PROJECTING_STEP`]) cannot drift apart.
fn step_context(fixture: &str, step: &str, command: &str) -> String {
    format!("fixture '{fixture}' query step '{step}' (command '{command}')")
}

tokio::task_local! {
    /// The step whose response is currently being PROJECTED, for the #3833
    /// item 5 panics that fire inside the token grammar rather than in an
    /// accessor (#3980 follow-up).
    ///
    /// [`StepArgs`] gives the accessors their context by REPLACING the `&Value`
    /// they already took, which is why threading it there cost no call-site
    /// churn. The grammar has no such value to replace: [`attr_value`],
    /// [`token_head`] and [`inject_cursor`] are reached from ~40 sites across
    /// [`row_token`], [`property_token`], the two map projections and
    /// [`group_tokens`], and several of those are called from unit tests that
    /// have no fixture at all. A task-local carries it instead — set once per
    /// step by [`run_query_steps`], read only on a failure path.
    ///
    /// These four panics are MORE likely to meet a new fixture's author than a
    /// mistyped arg key is: they trip on seeded property KEYS and VALUES (a `#`
    /// in a page title, a `value_num` of `1e-9`), i.e. on fixture content
    /// rather than on harness plumbing.
    ///
    /// Deliberately a task-local and not a thread-local: `run_step` awaits, and
    /// a multi-thread runtime may resume the task on another thread, which
    /// would silently drop a thread-local set before the await.
    /// `agaric_store::task_locals::ACTOR` is the same shape for the same
    /// reason.
    static PROJECTING_STEP: String;
}

/// [`step_context`] plus its separator, or the EMPTY string when no step is in
/// scope (the grammar's own unit tests, which have no fixture to name).
fn projecting_at() -> String {
    PROJECTING_STEP
        .try_with(|s| format!("{s}: "))
        .unwrap_or_default()
}

fn opt_arg(args: &StepArgs<'_>, key: &str) -> Option<Value> {
    args.get(key).filter(|v| !v.is_null()).cloned()
}

/// [`opt_arg`] plus a typed deserialize, so an optional arg of the wrong SHAPE
/// reports where it came from instead of `.expect("tagFilters")`.
fn opt_arg_as<T: serde::de::DeserializeOwned>(args: &StepArgs<'_>, key: &str) -> Option<T> {
    opt_arg(args, key).map(|v| {
        serde_json::from_value(v)
            .unwrap_or_else(|e| panic!("{}: query arg '{key}': {e}", args.at()))
    })
}

fn arg_or<T: serde::de::DeserializeOwned + Default>(args: &StepArgs<'_>, key: &str) -> T {
    opt_arg(args, key).map_or_else(T::default, |v| {
        serde_json::from_value(v)
            .unwrap_or_else(|e| panic!("{}: query arg '{key}': {e}", args.at()))
    })
}

fn arg_req<T: serde::de::DeserializeOwned>(args: &StepArgs<'_>, key: &str) -> T {
    let raw = args
        .get(key)
        .unwrap_or_else(|| panic!("{}: query step is missing required arg '{key}'", args.at()));
    serde_json::from_value(raw.clone())
        .unwrap_or_else(|e| panic!("{}: query arg '{key}': {e}", args.at()))
}

/// Run ONE read command against the real backend and project its response.
///
/// Adding a command here is the whole cost of putting it under the differential:
/// wire it, then give it a fixture step. A command with no arm panics loudly, so
/// a fixture cannot silently skip the backend leg (a differential that never
/// reaches one stack looks exactly like agreement).
///
/// ## Why this returns `Result` rather than `expect`ing (#3928)
///
/// A read command REFUSING is behaviour, not a harness failure — `get_block`
/// answers `NotFound` for a tombstone, and that refusal is the whole thing its
/// fixture step exists to pin. Every call into production code below therefore
/// propagates with `?` and [`run_query_steps`] records the [`AppErrorKind`] in
/// the projection, so the mock has to refuse the same call with the same kind.
///
/// Only the harness's OWN marshalling still `expect`s: `arg_req` /
/// `serde_json::to_value` failures are fixture or harness bugs with no
/// counterpart on the mock side, and turning those into recorded data would
/// let a mis-typed fixture arg author itself into the expectation.
///
/// The `arg_*` half of that sentence names the FIXTURE it fired on (#3833 item
/// 5, see [`StepArgs`]); the `serde_json::to_value` half deliberately does not,
/// because it takes no fixture input — it serializes an owned, statically typed
/// response struct, so it cannot fail on anything a fixture author wrote and
/// naming their fixture would misdirect them.
async fn run_step(pool: &SqlitePool, args: &StepArgs<'_>) -> Result<RawResult, AppError> {
    Ok(match args.command {
        "run_advanced_query" => {
            let request: AdvancedQueryRequest = arg_req(args, "request");
            let resp = compile_and_run(pool, request).await?;
            let v = serde_json::to_value(&resp).expect("serialize AdvancedQueryResponse");
            RawResult {
                // FLAT rows and GROUPED buckets are mutually exclusive, so this
                // concatenation contributes exactly one of the two (#3833 item
                // 2 — see [`group_tokens`]).
                rows: {
                    let mut rows = ids_at(&v, "rows", "id");
                    rows.extend(group_tokens(&v));
                    rows
                },
                has_more: v.get("hasMore").and_then(Value::as_bool),
                total_count: v.get("totalCount").and_then(Value::as_i64),
                next_cursor: v
                    .get("nextCursor")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            }
        }
        "filtered_blocks_query" => {
            let resp = filtered_blocks_query_inner(
                pool,
                arg_or(args, "propertyFilters"),
                opt_arg_as(args, "tagFilters"),
                opt_arg(args, "blockType").and_then(|v| v.as_str().map(str::to_owned)),
                &arg_req::<SpaceScope>(args, "scope"),
                opt_arg(args, "cursor").and_then(|v| v.as_str().map(str::to_owned)),
                opt_arg(args, "limit").and_then(|v| v.as_i64()),
            )
            .await?;
            page_result(&serde_json::to_value(&resp).expect("serialize PageResponse"))
        }
        "list_pages_with_metadata" => {
            let resp = list_pages_with_metadata_inner(
                pool,
                arg_req(args, "filter"),
                opt_arg(args, "cursor").and_then(|v| v.as_str().map(str::to_owned)),
                opt_arg(args, "limit").and_then(|v| v.as_i64()),
            )
            .await?;
            page_result(&serde_json::to_value(&resp).expect("serialize PageResponse"))
        }
        "search_blocks" => {
            let resp = search_blocks_inner(
                pool,
                arg_req(args, "query"),
                opt_arg(args, "cursor").and_then(|v| v.as_str().map(str::to_owned)),
                opt_arg(args, "limit").and_then(|v| v.as_i64()),
                arg_or(args, "filter"),
                None,
            )
            .await?;
            page_result(&serde_json::to_value(&resp).expect("serialize PageResponse"))
        }
        "list_unfinished_tasks" => {
            let resp = list_unfinished_tasks_inner(
                pool,
                arg_req(args, "beforeDate"),
                arg_or(args, "todoStates"),
                opt_arg(args, "cursor").and_then(|v| v.as_str().map(str::to_owned)),
                opt_arg(args, "limit").and_then(|v| v.as_i64()),
                &arg_req::<SpaceScope>(args, "scope"),
            )
            .await?;
            page_result(&serde_json::to_value(&resp).expect("serialize PageResponse"))
        }
        "list_undated_tasks" => {
            let resp = list_undated_tasks_inner(
                pool,
                opt_arg(args, "cursor").and_then(|v| v.as_str().map(str::to_owned)),
                opt_arg(args, "limit").and_then(|v| v.as_i64()),
                &arg_req::<SpaceScope>(args, "scope"),
            )
            .await?;
            page_result(&serde_json::to_value(&resp).expect("serialize PageResponse"))
        }
        "list_page_links" => {
            let tag_ids: Option<Vec<String>> = opt_arg_as(args, "tagIds");
            let resp = list_page_links_inner(
                pool,
                &arg_req::<SpaceScope>(args, "scope"),
                tag_ids.as_deref(),
            )
            .await?;
            let v = serde_json::to_value(&resp).expect("serialize PageLinksResponse");
            // An edge is a PAIR, so its stable token is `source->target`; the
            // envelope's `truncated` / `total` map onto the same two scalars
            // every other command reports.
            let rows = v
                .get("edges")
                .and_then(Value::as_array)
                .map(|edges| {
                    edges
                        .iter()
                        .map(|e| {
                            format!(
                                "{}->{}",
                                e.get("source_id").and_then(Value::as_str).unwrap_or("?"),
                                e.get("target_id").and_then(Value::as_str).unwrap_or("?"),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            RawResult {
                rows,
                has_more: v.get("truncated").and_then(Value::as_bool),
                total_count: v.get("total").and_then(Value::as_i64),
                next_cursor: None,
            }
        }
        // ── Journal reads (#3347) ──
        //
        // Neither of these touches a clock. `get_journal_page_by_date_inner` is
        // `WHERE block_type = 'page' AND content = ?date AND space_id = ?` and
        // `list_journal_pages_in_range_inner` is the same with `content >= ?`
        // / `content <= ?` — the date is an ARGUMENT, so a seed of date-titled
        // pages binds them exactly. Both return a BARE value (one optional row
        // / a flat `Vec`) with no pagination envelope, so `has_more` and
        // `total_count` are structurally absent and project as `None`.
        "get_journal_page_by_date" => {
            let scope: SpaceScope = arg_req(args, "scope");
            let space_id = scope.require_active()?;
            let row = get_journal_page_by_date_inner(
                pool,
                &arg_req::<String>(args, "date"),
                space_id.as_str(),
            )
            .await?;
            // `Option<BlockRow>`: a hit projects to one token, a miss to none.
            let v = serde_json::to_value(&row).expect("serialize Option<BlockRow>");
            RawResult {
                rows: v
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .into_iter()
                    .collect(),
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "list_journal_pages_in_range" => {
            let scope: SpaceScope = arg_req(args, "scope");
            let space_id = scope.require_active()?;
            let rows = list_journal_pages_in_range_inner(
                pool,
                &arg_req::<String>(args, "startDate"),
                &arg_req::<String>(args, "endDate"),
                space_id.as_str(),
            )
            .await?;
            // Bare `Vec<BlockRow>` — the response IS the row array.
            let v = serde_json::to_value(&rows).expect("serialize Vec<BlockRow>");
            RawResult {
                rows: v.as_array().map(|a| ids_in(a, "id")).unwrap_or_default(),
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        // ── Point reads over blocks / properties / tags (#3826) ──
        //
        // The #763 snapshot already diffs the ROWS these serve. What it does
        // NOT diff is each command's own projection, filtering and pagination
        // of them, which is where a reimplementation drifts — so every step
        // below is aimed at a specific decision the SQL makes: tombstones in
        // or out, missing ids dropped or surfaced, reserved keys column-routed
        // or not, a map key absent or present-but-empty, a page boundary.
        "list_blocks" => {
            let request = args.get("request").cloned().unwrap_or(Value::Null);
            let field = |k: &str| request.get(k).filter(|v| !v.is_null()).cloned();
            let text = |k: &str| field(k).and_then(|v| v.as_str().map(str::to_owned));
            let scope: SpaceScope = arg_req(args, "scope");
            let space_id = scope.require_active()?;
            let range = field("dateRange");
            let range_end = |k: &str| {
                range
                    .as_ref()
                    .and_then(|r| r.get(k))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            let resp = list_blocks_inner(
                pool,
                text("parentId").map(|s| BlockId::from(s.as_str())),
                text("blockType"),
                text("tagId"),
                text("date"),
                range_end("start"),
                range_end("end"),
                text("source"),
                text("cursor"),
                field("limit").and_then(|v| v.as_i64()),
                space_id.as_str().to_owned(),
            )
            .await?;
            page_result_with(
                &serde_json::to_value(&resp).expect("serialize PageResponse"),
                &|row| row_token(row, "id", BLOCK_ATTRS),
            )
        }
        "get_block" => {
            // #3928 — this arm used to call `get_block_inner`, the PERMISSIVE
            // reader, which SERVES a soft-deleted row. The shipped
            // `#[tauri::command] get_block` calls `get_active_block_inner`
            // (`commands/blocks/queries.rs`), whose SQL carries
            // `AND deleted_at IS NULL` and answers `NotFound` instead — the
            // two readers have OPPOSITE behaviour on the one input the step
            // exists to test, so the differential was certifying a function
            // the IPC surface does not call, and the mock had been aligned to
            // the harness rather than to production.
            //
            // `get_block_inner` is deliberately NOT reachable from here now:
            // every public read surface is required to use the active-only
            // twin, so a conformance arm reaching the permissive one can only
            // ever be wrong.
            let row = get_active_block_inner(pool, arg_req::<BlockId>(args, "blockId")).await?;
            let v = serde_json::to_value(&row).expect("serialize BlockRow");
            RawResult {
                rows: vec![row_token(&v, "id", BLOCK_ATTRS)],
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "get_blocks" => {
            let rows = get_blocks_inner(pool, arg_req::<Vec<BlockId>>(args, "ids")).await?;
            let v = serde_json::to_value(&rows).expect("serialize Vec<BlockRow>");
            RawResult {
                rows: v.as_array().map_or_else(Vec::new, |a| {
                    a.iter().map(|r| row_token(r, "id", BLOCK_ATTRS)).collect()
                }),
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "batch_resolve" => {
            let rows = batch_resolve_inner(
                pool,
                arg_req::<Vec<BlockId>>(args, "ids"),
                &arg_req::<SpaceScope>(args, "scope"),
            )
            .await?;
            let v = serde_json::to_value(&rows).expect("serialize Vec<ResolvedBlock>");
            RawResult {
                rows: v.as_array().map_or_else(Vec::new, |a| {
                    a.iter()
                        .map(|r| row_token(r, "id", RESOLVED_ATTRS))
                        .collect()
                }),
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "first_child_for_blocks" => {
            let map = first_child_for_blocks_inner(pool, arg_req::<Vec<BlockId>>(args, "blockIds"))
                .await?;
            let v = serde_json::to_value(&map).expect("serialize HashMap<String, BlockRow>");
            RawResult {
                rows: map_row_tokens(&v, "id", BLOCK_ATTRS),
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "get_properties" => {
            let rows = get_properties_inner(pool, arg_req::<BlockId>(args, "blockId")).await?;
            let v = serde_json::to_value(&rows).expect("serialize Vec<PropertyRow>");
            RawResult {
                rows: v
                    .as_array()
                    .map_or_else(Vec::new, |a| a.iter().map(property_token).collect()),
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "get_property" => {
            let row = get_property_inner(
                pool,
                &arg_req::<BlockId>(args, "blockId"),
                &arg_req::<String>(args, "key"),
            )
            .await?;
            // `Option<PropertyRow>`: a hit projects to one token, a miss to
            // none — the present-vs-absent distinction the step pins.
            let v = serde_json::to_value(&row).expect("serialize Option<PropertyRow>");
            RawResult {
                rows: if v.is_null() {
                    Vec::new()
                } else {
                    vec![property_token(&v)]
                },
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "get_batch_properties" => {
            let map =
                get_batch_properties_inner(pool, arg_req::<Vec<BlockId>>(args, "blockIds")).await?;
            let v =
                serde_json::to_value(&map).expect("serialize HashMap<String, Vec<PropertyRow>>");
            RawResult {
                rows: map_rows_tokens(&v, &property_token),
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "list_tags_for_block" => {
            let rows = list_tags_for_block_inner(pool, arg_req::<BlockId>(args, "blockId")).await?;
            RawResult {
                rows: scalar_tokens(&serde_json::to_value(&rows).expect("serialize Vec<String>")),
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "list_inherited_tags_for_block" => {
            let rows =
                list_inherited_tags_for_block_inner(pool, arg_req::<BlockId>(args, "blockId"))
                    .await?;
            RawResult {
                rows: scalar_tokens(&serde_json::to_value(&rows).expect("serialize Vec<String>")),
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "load_page_subtree" => {
            let scope: SpaceScope = arg_req(args, "scope");
            let space_id = scope.require_active()?;
            let subtree = load_page_subtree_inner(
                pool,
                &arg_req::<String>(args, "rootBlockId"),
                space_id.as_str(),
            )
            .await?;
            let v = serde_json::to_value(&subtree).expect("serialize PageSubtree");
            RawResult {
                rows: v
                    .get("blocks")
                    .and_then(Value::as_array)
                    .map_or_else(Vec::new, |a| {
                        a.iter().map(|r| row_token(r, "id", BLOCK_ATTRS)).collect()
                    }),
                // `truncated` / `total` are the cap signal, mapping onto the
                // same two scalars every other command reports.
                has_more: v.get("truncated").and_then(Value::as_bool),
                total_count: v.get("total").and_then(Value::as_i64),
                next_cursor: None,
            }
        }
        // Adding arm #21? Three things, not one:
        //
        //   1. the arm here, and the matching `WIRE` entry in the TS twin;
        //   2. a fixture step, or the ratchet counts a command nothing runs;
        //   3. the READ-PHASE PURITY GUARD. `run_query_steps` digests the
        //      derived caches before and after the read phase and reddens if
        //      one moved — but that digest is TABLE-SCOPED
        //      (`derived_cache_digest`: `page_link_cache`, `pages_cache`,
        //      `fts_blocks`), so a new reader that lazily backfills some OTHER
        //      table writes invisibly. If the command's reader can write, add
        //      its table there. `reader_delegation_tests` holds the write sweep
        //      that decided today's three, and its arm-count tripwire will
        //      redden the moment this list grows.
        other => panic!(
            "{}: conformance query command '{other}' is not wired in the Rust runner \
             (add an arm in conformance_query.rs and the matching entry in the TS twin)",
            args.at()
        ),
    })
}

/// Project a serialized `PageResponse<T>` (the snake_case envelope shared by
/// every cursor-paginated read command).
fn page_result(v: &Value) -> RawResult {
    page_result_with(v, &|row| row_token(row, "id", &[]))
}

/// [`page_result`] with an explicit per-row token builder, for paginated
/// commands whose rows carry attributes.
fn page_result_with(v: &Value, token: &dyn Fn(&Value) -> String) -> RawResult {
    RawResult {
        rows: v
            .get("items")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().map(token).collect())
            .unwrap_or_default(),
        has_more: v.get("has_more").and_then(Value::as_bool),
        total_count: v.get("total_count").and_then(Value::as_i64),
        next_cursor: v
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

/// Where a command's opaque page cursor lives in its args. Mirrors
/// `CURSOR_PATH` in the TS twin.
///
/// A second page cannot be spelled out in the fixture: the cursor is an opaque
/// keyset blob each stack encodes for itself. A step therefore declares
/// `"cursor_from": "<earlier step name>"` and BOTH runners feed that step's own
/// `next_cursor` back in — so each stack paginates through its own cursor and
/// the recorded comparison is between the ROWS the second page contains, which
/// is what a keyset-ordering divergence changes (#3821).
fn cursor_path(command: &str) -> &'static [&'static str] {
    match command {
        // `list_blocks` and `run_advanced_query` nest every query param under
        // their request DTO. `run_advanced_query` was missing here until #3893
        // added the first fixture that chains it: `AdvancedQueryRequest::cursor`
        // is a field of the DTO (`agaric-store/src/query/mod.rs`), so a
        // top-level `args.cursor` would have been dropped on the floor and the
        // "second page" would silently have been the FIRST page again — a
        // pagination step that proves nothing while looking like it does.
        "list_blocks" | "run_advanced_query" => &["request", "cursor"],
        _ => &["cursor"],
    }
}

// ---------------------------------------------------------------------------
// Cursor shape (#3893)
// ---------------------------------------------------------------------------

/// Decode a `next_cursor` and render its keyset SHAPE, or `None` when the step
/// minted no cursor.
///
/// ## What this pins, and why it is a shape rather than the bytes
///
/// Before #3893 the harness captured `next_cursor` only to thread it into a
/// `cursor_from` step, and never placed any part of it in the recorded
/// projection — so no fixture assertion could see a cursor at all, and a
/// cursor-format change on the Rust side could land with every fixture green.
///
/// The recorded value is deliberately NOT the raw cursor string. A cursor's
/// PAYLOAD is the boundary row's sort tuple: block ids (stack-local for
/// op-created rows), page titles, and — for a `LastEdited` sort — an op-log
/// clock stamp. Recording the bytes would import exactly the values the row
/// token grammar refuses to carry verbatim (see "Row tokens"), and would
/// false-redden on a `COALESCE(position, sentinel)` whose sentinel is
/// `i64::MAX` on one stack and `Number.MAX_SAFE_INTEGER` on the other while
/// both paginate identically.
///
/// What IS comparable is the structure the two encoders agreed on:
///
///   * `v<version>` — the schema version both codecs stamp and check.
///   * for the engine's tuple cursor (`QueryCursor`, `values: [CursorValue]`):
///     the ORDERED list of `#[serde(tag = "t")]` type tags, one per resolved
///     sort term. This is the #3863 class exactly — a mock that encoded only
///     `{id}` where the engine carries the whole tagged tuple differs in
///     arity, and one that mistags a term differs in a tag.
///   * for the pagination cursor (`Cursor`, `agaric-store/src/pagination`):
///     the sorted set of POPULATED slots. Its optional fields are
///     `skip_serializing_if = "Option::is_none"`, so which slots are present
///     IS which keyset the page was minted on.
///
/// The base64 decode is part of the assertion, not a preliminary to it: it is
/// a strict URL-safe unpadded decode, so a switch to the standard alphabet or
/// to padded output on either stack renders `<not-base64url>` and reddens.
/// Deliberately hand-rolled over the JSON rather than routed through
/// `Cursor::decode` / `QueryCursor::decode`: `QueryCursor` is private to
/// `agaric_store::query::engine` and — more to the point — a projection that
/// used each stack's own production codec could not see a change the codec
/// made to itself.
///
/// The concrete boundary VALUES are not abandoned, they are pinned elsewhere
/// and better: a `cursor_from` step compares the ROWS the resumed page holds,
/// which is what a wrong boundary value actually changes.
fn cursor_shape(next_cursor: Option<&str>) -> Value {
    let Some(raw) = next_cursor else {
        return Value::Null;
    };
    Value::String(shape_of_cursor(raw))
}

/// Render one encoded cursor string as its canonical shape. Split out from
/// [`cursor_shape`] so the unit tests below can drive it directly. MUST stay
/// byte-identical to `cursorShape` in the TS twin — with two known, narrow
/// exceptions (#3942 review note 6), neither reachable from a cursor either
/// stack actually MINTS today:
///
///  1. `URL_SAFE_NO_PAD.decode` here rejects non-canonical trailing bits (a
///     final symbol whose leftover bits are not zero, e.g. `"AB"`) as
///     `InvalidLastSymbol` — the base64 crate's `NO_PAD` config sets
///     `decode_allow_trailing_bits: false`. The TS twin decodes through
///     `atob`, which silently discards them instead. This is the SAME
///     divergence `isBase64UrlNoPad`'s doc comment (`@/lib/base64url`)
///     already declines to mirror in every mock cursor decoder, for the same
///     reason: a cursor with such bytes cannot be produced by either
///     encoder, only hand-built, so mirroring it here would make this ONE
///     function stricter than the mock's own production decoders while
///     fixing nothing an encoder could regress into.
///  2. A JSON version literal written with a decimal point (`"version":1.0`)
///     renders `v?` here — `Value::as_u64` returns `None` for a float-typed
///     `serde_json::Number`, decimal point and all, regardless of its
///     numeric value — but `v1` in the TS twin, where `Number.isInteger(1.0)`
///     is `true`: JSON's `1` and `1.0` are indistinguishable once parsed into
///     a JS `number`, so the TS side cannot even observe which one it was
///     handed. Neither `Cursor::encode` nor the TS `encodeBlocksCursor` /
///     `encodeNextCursor` / `encodeCursor` ever emit a decimal version, so no
///     cursor either stack mints reaches this arm; only a hand-built one
///     does.
fn shape_of_cursor(raw: &str) -> String {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    let Ok(bytes) = URL_SAFE_NO_PAD.decode(raw) else {
        return "<not-base64url>".to_owned();
    };
    let Ok(json) = String::from_utf8(bytes) else {
        return "<not-utf8>".to_owned();
    };
    let Ok(v) = serde_json::from_str::<Value>(&json) else {
        return "<not-json>".to_owned();
    };
    let Some(obj) = v.as_object() else {
        return "<not-an-object>".to_owned();
    };
    let version = obj
        .get("version")
        .and_then(Value::as_u64)
        .map_or_else(|| "?".to_owned(), |n| n.to_string());
    // The engine's tuple cursor: an ORDERED list of tagged values.
    if let Some(values) = obj.get("values").and_then(Value::as_array) {
        let tags: Vec<&str> = values
            .iter()
            .map(|e| e.get("t").and_then(Value::as_str).unwrap_or("<untagged>"))
            .collect();
        // Any SIBLING key of `values` is rendered too. Without this the tuple
        // branch reads `version` and `values` and discards the rest of the
        // object, so `QueryCursor` growing a field (a sort fingerprint, a
        // direction flag) would be a cursor-format change with no effect on the
        // recorded shape — invisible on exactly the axis #3893 exists to watch,
        // and asymmetric with the pagination branch below, where a new slot
        // shows up immediately. Empty today, so no fixture value moves.
        let mut extra: Vec<&str> = obj
            .keys()
            .filter(|k| k.as_str() != "version" && k.as_str() != "values")
            .map(String::as_str)
            .collect();
        extra.sort_unstable();
        let suffix = if extra.is_empty() {
            String::new()
        } else {
            format!("+{{{}}}", extra.join(","))
        };
        return format!("v{version}:[{}]{suffix}", tags.join(","));
    }
    // The pagination cursor: a fixed struct whose ABSENT slots are skipped.
    let mut slots: Vec<&str> = obj
        .keys()
        .filter(|k| k.as_str() != "version")
        .map(String::as_str)
        .collect();
    slots.sort_unstable();
    format!("v{version}:{{{}}}", slots.join(","))
}

/// Write `cursor` into `args` at the command's [`cursor_path`], creating the
/// intermediate object if the fixture omitted it.
fn inject_cursor(command: &str, args: &mut Value, cursor: Option<String>) {
    let path = cursor_path(command);
    if !args.is_object() {
        *args = json!({});
    }
    let mut node = args;
    for key in &path[..path.len() - 1] {
        if !node[*key].is_object() {
            node[*key] = json!({});
        }
        // Unreachable as written — the branch above has just made `node[key]`
        // an object. It carries the fixture context anyway (#3833 item 5),
        // because "unreachable" is precisely the kind of claim that decays: it
        // holds only while `cursor_path` returns paths whose intermediate
        // segments are objects, which is a property of a table three hundred
        // lines away.
        node = node.get_mut(*key).unwrap_or_else(|| {
            panic!(
                "{}cursor path segment '{key}' is not an object",
                projecting_at()
            )
        });
    }
    let leaf = path[path.len() - 1];
    node[leaf] = cursor.map_or(Value::Null, Value::String);
}

/// Relabel one raw id (or an `a->b` pair) through the canonical map.
fn relabel_head(head: &str, labels: &BTreeMap<String, String>) -> String {
    if let Some((src, tgt)) = head.split_once("->") {
        return format!(
            "{}->{}",
            labels.get(src).map_or(src, String::as_str),
            labels.get(tgt).map_or(tgt, String::as_str),
        );
    }
    labels.get(head).cloned().unwrap_or_else(|| head.to_owned())
}

/// Relabel a full row token: the head (an id, or an `a->b` pair) and every
/// attribute VALUE, so id-valued attributes like `page_id` read `B1` rather
/// than a stack-local ULID. Attribute NAMES pass through untouched.
fn relabel_token(token: &str, labels: &BTreeMap<String, String>) -> String {
    let mut parts = token.split('#');
    let head = parts.next().unwrap_or(token);
    let mut out = relabel_head(head, labels);
    for attr in parts {
        out.push('#');
        match attr.split_once('=') {
            Some((name, value)) => {
                out.push_str(name);
                out.push('=');
                out.push_str(&relabel_head(value, labels));
            }
            None => out.push_str(attr),
        }
    }
    out
}

/// The `queries[].name` values appearing more than once, each reported ONCE
/// however many times it repeats — parity with the TS twin's
/// `assertUniqueStepNames`, which accumulates into a `Set`.
///
/// A step whose `name` is absent or non-string is skipped rather than
/// counted. Its caller [`assert_unique_step_names`] rejects those steps
/// FIRST, so by the time this runs there are none — see that function for why
/// the rejection lives there and not here (#3980 note 6).
fn duplicate_step_names(steps: &[Value]) -> Vec<&str> {
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut dupes: Vec<&str> = Vec::new();
    for name in steps.iter().filter_map(|s| s["name"].as_str()) {
        if !seen.insert(name) && !dupes.contains(&name) {
            dupes.push(name);
        }
    }
    dupes
}

/// #3833 item 7/12 — every query step must carry a string `name`, and the
/// names must be unique WITHIN a fixture.
///
/// THE canonical statement of this rule; the call site in
/// [`run_query_steps`] points here rather than restating it.
///
/// The coverage test's positional-alignment guard
/// (`conformance-coverage.test.ts`) compares `recorded.name !== step.name` at
/// the SAME index, so two steps sharing a name still align correctly by
/// position — this is not a correctness hole. It is a DIAGNOSTIC one: every
/// message in this module (`misaligned`, `vacuous`, the branch-coverage
/// errors) names the step by its `name`, and a duplicate makes a failure
/// impossible to attribute to the right step.
///
/// Checked once, up front, rather than per-step, so the fixture author sees
/// every offender in one panic rather than only the first.
///
/// The name-PRESENCE half is checked here, ahead of the duplicate scan, so
/// this stays an exact mirror of the TS `assertUniqueStepNames` (#3980 note
/// 6). Before, the two twins disagreed on a nameless step: this side dropped
/// it silently via `filter_map`, while TS read `step.name` unconditionally
/// and reported a duplicate of `[null]`. Neither fixture format validates
/// itself — both stacks parse the fixture JSON into a shape they merely
/// ASSERT (`Value` here, an `as Fixture` cast there) — so an absent `name` is
/// reachable in both, and a mirrored pair may not diverge on it.
fn assert_unique_step_names(fixture_name: &str, steps: &[Value]) {
    let unnamed: Vec<usize> = steps
        .iter()
        .enumerate()
        .filter(|(_, step)| step.get("name").and_then(Value::as_str).is_none())
        .map(|(i, _)| i)
        .collect();
    assert!(
        unnamed.is_empty(),
        "fixture '{fixture_name}' has query step(s) at index {unnamed:?} with no string \
         `name` — every `queries[]` entry must carry one, or the step cannot be named in \
         any diff."
    );

    let dupes = duplicate_step_names(steps);
    assert!(
        dupes.is_empty(),
        "fixture '{fixture_name}' has duplicate query step name(s) {dupes:?} — every \
         `queries[].name` in a fixture must be unique, or a failure cannot be attributed \
         to the right step."
    );
}

/// A content digest of the DERIVED CACHES, for the read-phase purity guard in
/// [`run_query_steps`] (#3833 item 8).
///
/// ## Why these three tables and not all of them
///
/// `page_link_cache` is the only table any WIRED read command can write today.
/// That is the conclusion of the write sweep recorded in
/// [`reader_delegation_tests`] — see `the_write_sweep_is_still_over_twenty_arms`
/// there for the enumeration and for what was ruled out. The one writer is
/// `list_page_links` → `list_page_links_inner_split_with_cap`'s lazy rebuild (a
/// DELETE+INSERT), gated on the cache being empty while `block_links` is not.
///
/// `pages_cache` and `fts_blocks` are digested anyway, and neither is
/// speculative padding: they are the app's other two lazily-rebuildable derived
/// caches (`rebuild_pages_cache`, `rebuild_fts_index`), so they are what arm
/// #21 is most likely to touch. Digesting them costs two more subqueries over
/// tables a conformance fixture holds a handful of rows in, and it means a
/// future read arm that backfills one is CAUGHT rather than discovered by the
/// fixture author whose later step read the rebuilt state.
///
/// A general all-tables digest is still declined: it would need dynamic SQL
/// over `pragma_table_info` to stay schema-agnostic, and it would fold in the
/// tables the OPS legitimately wrote, which this guard has no business
/// asserting on.
///
/// ## On the ordering
///
/// Each subquery is `ORDER BY` its primary key, which makes the digest a
/// function of CONTENT rather than of SQLite's scan order IN PRACTICE — the
/// ordered subquery is satisfied by a PK index scan. It is not a documented
/// guarantee: `group_concat(x, sep)` has no defined aggregation order, and only
/// the 3.44+ `group_concat(x ORDER BY …)` form promises one. The weaker
/// property is enough here because the digest is only ever compared to ITSELF
/// across one read phase: a reordering would be a FALSE RED, never a false
/// green, and the assertion's own message points at the state it captured.
async fn derived_cache_digest(pool: &SqlitePool) -> String {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT \
           coalesce((SELECT group_concat(r, char(10)) FROM ( \
             SELECT coalesce(source_page_id,'') || '|' || coalesce(target_page_id,'') || '|' || coalesce(edge_count,'') \
                    || '|' || coalesce(src_deleted,'') || '|' || coalesce(tgt_deleted,'') || '|' || coalesce(tgt_is_page,'') AS r \
             FROM page_link_cache \
             ORDER BY source_page_id, target_page_id \
           )), '') \
           || char(10) || '-- pages_cache --' || char(10) || \
           coalesce((SELECT group_concat(r, char(10)) FROM ( \
             SELECT coalesce(page_id,'') || '|' || coalesce(title,'') || '|' || coalesce(updated_at,'') \
                    || '|' || coalesce(inbound_link_count,'') || '|' || coalesce(child_block_count,'') AS r \
             FROM pages_cache \
             ORDER BY page_id \
           )), '') \
           || char(10) || '-- fts_blocks --' || char(10) || \
           coalesce((SELECT group_concat(r, char(10)) FROM ( \
             SELECT coalesce(block_id,'') || '|' || coalesce(stripped,'') AS r \
             FROM fts_blocks \
             ORDER BY block_id \
           )), '')",
    )
    .fetch_one(pool)
    .await
    .expect("read derived cache digest")
    .unwrap_or_default()
}

/// Run every query step of a fixture and return the projected `expected_queries`
/// array. Returns `Value::Null` when the fixture declares no `queries`, so
/// fixtures that predate the schema keep an absent key.
pub async fn run_query_steps(
    pool: &SqlitePool,
    fixture: &Value,
    labels: &BTreeMap<String, String>,
) -> Value {
    let Some(steps) = fixture.get("queries").and_then(Value::as_array) else {
        return Value::Null;
    };

    // #3833 item 5 — every failure below names the fixture. `<unnamed>` mirrors
    // the caller's own fallback (`conformance.rs`'s `run_fixture`), so the two
    // never disagree about what an unnamed fixture is called.
    let fixture_name = fixture
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("<unnamed>");

    // #3833 item 7/12 — see [`assert_unique_step_names`] for why this is
    // checked once up front and why a duplicate name is a diagnostic rather
    // than a correctness problem. Stated there ONLY: the rationale used to be
    // duplicated near-verbatim here, which is one copy too many to keep true
    // (#3980 note 5).
    assert_unique_step_names(fixture_name, steps);

    // #3833 item 8 — the read phase must leave the backend exactly as the
    // snapshot found it.
    //
    // `list_page_links` is a read command that can WRITE: it delegates to
    // `list_page_links_inner_split(pool, pool, …)`, which rebuilds
    // `page_link_cache` (DELETE+INSERT) when the cache is empty while
    // `block_links` is not. Neither end of that is removable. The write is
    // production behaviour — a documented redundancy behind migration 0110's
    // backfill — and #3928 is the standing lesson that a harness arm which
    // calls something OTHER than what the shipped command calls certifies a
    // path the IPC surface does not take. Nor is the phase classification
    // wrong: `list_page_links` really is a read.
    //
    // So the write stays and is DETECTED instead. It is inert today (the
    // materializer's per-`ReindexBlockLinks` rollup leaves the cache
    // non-empty, and the one fixture with a `list_page_links` step positions
    // it first), but "inert today" is precisely the shape of every other item
    // in #3833: nothing stopped a later step in the same fixture from reading
    // state the backend had just rebuilt for itself and the mock never
    // produces — a divergence that would present as a mock bug.
    let cache_before = derived_cache_digest(pool).await;

    let mut out: Vec<Value> = Vec::with_capacity(steps.len());
    let mut cursors: BTreeMap<String, Option<String>> = BTreeMap::new();
    for step in steps {
        let name = step["name"]
            .as_str()
            .unwrap_or_else(|| panic!("fixture '{fixture_name}': query step name"))
            .to_owned();
        let command = step["command"]
            .as_str()
            .unwrap_or_else(|| panic!("fixture '{fixture_name}' query step '{name}': no command"));
        // #3833 item 5 — the context the token-grammar panics read. Built once
        // per step and shared with `StepArgs::at` through `step_context`, so
        // the two families of failure carry the identical prefix.
        let at = step_context(fixture_name, &name, command);
        let mut args = expand_query_args(step.get("args").unwrap_or(&Value::Null));
        if let Some(from) = step.get("cursor_from").and_then(Value::as_str) {
            let cursor = cursors.get(from).cloned().unwrap_or_else(|| {
                panic!("fixture '{fixture_name}' query step '{name}' reads `cursor_from` '{from}', which is not an EARLIER step in this fixture")
            });
            PROJECTING_STEP.sync_scope(at.clone(), || inject_cursor(command, &mut args, cursor));
        }
        let ordered = step
            .get("ordered")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // A command that REFUSES has behaved, and the refusal is recorded like
        // any other answer (#3928): `error` carries the `AppErrorKind` wire
        // string and the rest of the projection reads as an empty result, so a
        // mock that serves the row a command 404s — or 404s where the command
        // serves — reddens on the `error` field alone.
        let step_args = StepArgs {
            value: &args,
            fixture: fixture_name,
            step: &name,
            command,
        };
        // Scoped, not just called: every panic raised inside the token grammar
        // during this step's projection names this fixture and this step.
        let (raw, error) = match PROJECTING_STEP
            .scope(at.clone(), run_step(pool, &step_args))
            .await
        {
            Ok(raw) => (raw, Value::Null),
            Err(e) => (
                RawResult {
                    rows: Vec::new(),
                    has_more: None,
                    total_count: None,
                    next_cursor: None,
                },
                serde_json::to_value(e.kind()).expect("serialize AppErrorKind"),
            ),
        };
        // #3946 — a refusal must be DECLARED. `?`-propagation (#3928) is what
        // made an intended refusal expressible, but it also removed the
        // authoring safety net it replaced: before it, a fixture-authoring
        // mistake that made a command fail — an out-of-range `limit`, a bad
        // argument combination, a malformed id — panicked here, loudly. After
        // it, the same mistake is recorded as `"error": "validation"` and
        // baked into `expected_queries` by `CONFORMANCE_UPDATE=1`, where the
        // coverage ratchet then reads it as LIVE evidence that the command was
        // exercised. A step that never reached the command would read exactly
        // like one that did.
        //
        // `expect_error` restores the net without giving up the capability: an
        // intended refusal SAYS so and is recorded; an unintended one fails
        // here, before the update flow can write it down. This is the same
        // "declare the negative" discipline `expect_empty` applies to an empty
        // row set, for the same reason — an empty answer and a failed answer
        // are both indistinguishable from a broken harness unless the author
        // says which they meant. Both keys are inert to the projection: they
        // gate what may be RECORDED, they are not part of the recording.
        //
        // Three arms, because a half-checked pair is how a declaration rots:
        // an undeclared refusal, a declaration that no longer refuses, and a
        // declaration that names a DIFFERENT kind than the one raised.
        let declared: Option<&str> = match step.get("expect_error") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.as_str()),
            Some(other) => panic!(
                "{at}: `expect_error` must be an AppErrorKind wire string (e.g. \"not_found\"), \
                 got {other}"
            ),
        };
        match (declared, error.as_str()) {
            (None, Some(kind)) => panic!(
                "{at}: the command REFUSED with `{kind}`, and the step did not declare it. \
                 A refusal is only evidence when it was intended: an out-of-range `limit`, a \
                 bad argument combination or a malformed id refuses exactly like a pinned \
                 404 does, and recording it would bake the authoring mistake into \
                 `expected_queries` where the coverage ratchet counts it as live coverage of \
                 a command the step never reached. FIX by EITHER correcting the step's args, \
                 OR — if the refusal IS the behaviour being pinned — adding \
                 \"expect_error\": \"{kind}\" to the step plus a \"comment\" saying which \
                 refusal it pins."
            ),
            (Some(kind), None) => panic!(
                "{at}: the step declares \"expect_error\": \"{kind}\" but the command \
                 SUCCEEDED. Both arms or neither: a declaration that no longer refuses is a \
                 stale claim, and leaving it would let the step read as a pinned refusal \
                 while asserting a served answer. FIX by EITHER restoring the input that \
                 makes the command refuse, OR dropping the declaration."
            ),
            (Some(declared), Some(kind)) if declared != kind => panic!(
                "{at}: the step declares \"expect_error\": \"{declared}\" but the command \
                 refused with `{kind}`. The recorded kind is what the mock has to reproduce, \
                 so a declaration naming a different one describes a refusal nobody is \
                 asserting. FIX by EITHER declaring `{kind}`, OR restoring the input that \
                 raises `{declared}`."
            ),
            _ => {}
        }

        cursors.insert(name.clone(), raw.next_cursor.clone());
        let cursor = cursor_shape(raw.next_cursor.as_deref());
        let mut rows: Vec<String> = raw.rows.iter().map(|t| relabel_token(t, labels)).collect();
        if !ordered {
            // Set comparison, not sequence comparison — see "Ordering" in the
            // module docs. The cost is real: every ordering divergence of an
            // unordered step is invisible here, which is why a step that
            // exists to pin a SORT arm must set `"ordered": true`.
            rows.sort_by_key(|t| token_key(t));
        }
        out.push(json!({
            "name": name,
            "rows": rows,
            "has_more": raw.has_more,
            "total_count": raw.total_count,
            "cursor": cursor,
            "error": error,
        }));
    }

    // #3833 item 8 — see the `cache_before` capture above for why these tables
    // and why detection rather than removal.
    assert_eq!(
        cache_before,
        derived_cache_digest(pool).await,
        "fixture '{fixture_name}': the READ phase mutated a derived cache \
         (`page_link_cache` / `pages_cache` / `fts_blocks`). A read step rebuilt \
         backend-only derived state that the mock never produces, so every LATER \
         step in this fixture compared against a backend the snapshot no longer describes. \
         The usual cause is a fixture whose link edges reach `block_links` without the \
         materializer: drive them through an op (`edit_block` with a `[[id]]` token) so \
         the per-`ReindexBlockLinks` rollup fills `page_link_cache` during the OP phase, \
         where both stacks can see it."
    );

    Value::Array(out)
}

#[cfg(test)]
mod reader_delegation_tests {
    /// #3928 — pin that the harness arm and the SHIPPED command reach the same
    /// reader.
    ///
    /// The issue's acceptance criterion is "changing `get_block` to call the
    /// other reader must turn the step RED". A fixture step cannot deliver that
    /// on its own, and it is worth being exact about why rather than claiming
    /// otherwise: every arm of [`run_step`] calls an `*_inner` DIRECTLY, because
    /// a `#[tauri::command]` takes `State<'_, ReadPool>` and there is no way to
    /// construct one in a test. So the differential's real premise is a
    /// SOURCE-LEVEL coupling — "the arm calls what the command calls" — and
    /// until now nothing checked it. That is exactly how #3928 happened: the arm
    /// and the command drifted apart silently, and the mock was then aligned to
    /// the arm.
    ///
    /// This test is that coupling, made falsifiable. It reddens if EITHER side
    /// moves: the command switching back to the permissive reader, or the arm
    /// doing so. `include_str!` source scanning is the established shape for
    /// this class of guard in this crate (see
    /// `pagination_app_tests::block_row_canonical_conformance`).
    ///
    /// Scoped to `get_block` deliberately. A general "every arm calls what its
    /// command calls" checker would need to resolve 20 command→inner
    /// delegations from source; that sweep was done by hand instead, and
    /// `get_block` was the only mismatch — so this pins the one pair that
    /// actually broke, and the one whose two readers have OPPOSITE behaviour on
    /// the same input.
    ///
    /// ## What the hand sweep found, so the denominator is in the repo
    ///
    /// All 20 arms were checked against their `#[tauri::command]`. Nineteen
    /// reach the same function the command does (`list_page_links` reaches
    /// `list_page_links_inner`, whose whole body is
    /// `list_page_links_inner_split(pool, pool, …)` — the documented
    /// single-pool entry point, not a second implementation). `get_block` was
    /// the only FUNCTION mismatch and is fixed above.
    ///
    /// Three ARGUMENT-marshalling divergences remain, and are recorded here
    /// rather than left in a review thread — they are the same failure shape as
    /// #3928 (the harness exercising a path production does not), one layer
    /// down, and none is fixed by this test:
    ///
    ///   1. `list_blocks` hand-picks fields out of `args["request"]` instead of
    ///      deserialising `ListBlocksRequest`, and builds its parent id with
    ///      `BlockId::from(&str)` (ASCII-uppercase only) where the DTO's
    ///      `Deserialize` runs the #1558 Crockford canonicalisation.
    ///   2. `load_page_subtree` types `rootBlockId` as `String`; the command
    ///      takes a `BlockId` and calls `.as_str()`, so the same
    ///      canonicalisation is skipped here too.
    ///   3. `arg_or` DEFAULTS `filter` / `todoStates` when a fixture omits
    ///      them. The real IPC surface makes those required args, so a
    ///      fixture can reach a combination Tauri would have rejected.
    ///      (`scope` used to be in this list too — #3833 item 4 switched
    ///      every `arg_or::<SpaceScope>(args, "scope")` call to `arg_req`,
    ///      since a mistyped `scope` key used to fail OPEN to
    ///      `SpaceScope::default() == Global`, silently WIDENING the query
    ///      instead of failing loudly. Every fixture already passes `scope`
    ///      explicitly, so this cost nothing.)
    ///
    /// Each is a fixture-authoring hazard rather than a live divergence (no
    /// current fixture supplies a non-canonical id or omits a required arg), so
    /// they are scoped out of #3928 rather than silently dropped.
    ///
    /// ## The sweep above answers a DIFFERENT question from the one item 8 asks
    ///
    /// It is a FUNCTION-IDENTITY sweep: does each arm reach the same reader its
    /// command does. It says nothing about whether any of those readers WRITES,
    /// which is the premise the read-phase purity guard in
    /// [`super::derived_cache_digest`] rests on. That second sweep is recorded
    /// separately, on [`the_write_sweep_is_still_over_twenty_arms`], because a
    /// justification that cites the wrong sweep is a proof that is not in the
    /// repo at all.
    const QUERIES_RS: &str = include_str!("../commands/blocks/queries.rs");
    const HARNESS_RS: &str = include_str!("conformance_query.rs");

    /// The number of commands wired into `run_step` when the WRITE sweep below
    /// was taken. A 21st arm reddens
    /// [`the_write_sweep_is_still_over_twenty_arms`], which is the only thing
    /// that makes the sweep's conclusion a claim about the CURRENT code.
    const SWEPT_ARM_COUNT: usize = 20;

    /// #3833 item 8 — the WRITE sweep, recorded where its conclusion is cited.
    ///
    /// [`super::derived_cache_digest`] scopes the read-phase purity guard to
    /// three tables on the strength of "exactly one wired read command can
    /// write". That claim was checked by hand over all
    /// [`SWEPT_ARM_COUNT`] arms, and this is where the result lives:
    ///
    ///   * **The one writer.** `list_page_links` →
    ///     `list_page_links_inner_split_with_cap` (`commands/pages/links.rs`),
    ///     whose lazy-rebuild guard calls
    ///     `agaric_store::cache::rebuild_page_link_cache_split`
    ///     (`agaric-store/src/cache/page_links.rs`) — a DELETE+INSERT over
    ///     `page_link_cache`, gated on the cache being empty while
    ///     `block_links` is not. A documented redundancy behind migration
    ///     0110's backfill.
    ///   * **Ruled out, explicitly, because each is a plausible lazy writer.**
    ///     The FTS rebuild (`rebuild_fts_index`) is a boot/maintenance path,
    ///     not something `search_blocks_inner` triggers; the `pages_cache`
    ///     rebuild is likewise a materializer/boot path, and
    ///     `list_pages_with_metadata_inner` READS the cache without
    ///     backfilling it; `get_journal_page_by_date_inner` looks a journal
    ///     page up and does NOT create one on a miss (the creating path is a
    ///     separate command, and is not wired here); and
    ///     `run_advanced_query`'s compiler builds its grouped/aggregate work in
    ///     ordinary subqueries rather than materialising a TEMP table.
    ///   * **Everything else** is a `SELECT` behind an `*_inner` that takes
    ///     `&SqlitePool` and returns rows.
    ///
    /// This test cannot re-derive that by scanning source — a real answer
    /// needs the call graph under 20 readers. What it CAN do is make the
    /// sweep's denominator falsifiable, so the conclusion cannot quietly come
    /// to describe a set of arms that no longer exists.
    #[test]
    fn the_write_sweep_is_still_over_twenty_arms() {
        let (commands, arms) = wired_commands(HARNESS_RS);
        assert_eq!(
            commands.len(),
            SWEPT_ARM_COUNT,
            "`run_step` now wires {} commands ({commands:?}), not the {SWEPT_ARM_COUNT} the \
             write sweep on this test covered. Re-run the sweep for the new arm: does its \
             `*_inner` (or anything it calls) WRITE? If it can, extend \
             `derived_cache_digest` to the table it writes — the read-phase purity guard \
             is TABLE-SCOPED, and a table it does not digest is a write it cannot see.",
            commands.len()
        );
        // The walk must have reached the CATCH-ALL. Without this, a scanner
        // that stopped early — on a construct it mis-parsed — would report a
        // short list, and "20" would be a coincidence between the arms it
        // managed to read and the arms that were swept.
        //
        // One arm more than commands, because every literal arm names exactly
        // one command today. An OR-PATTERN arm would trip this as well as the
        // count above, which is the right outcome: it is still a new command
        // the sweep has not looked at.
        assert_eq!(
            arms,
            SWEPT_ARM_COUNT + 1,
            "the arm walk crossed {arms} arms but found {} command literals; it should have \
             crossed exactly one MORE arm than commands — the `other =>` catch-all at the end \
             of the dispatch. A mismatch means the walk stopped early (so the count above is \
             not the whole dispatch), or an arm names several commands at once.",
            commands.len()
        );
        let mut sorted = commands.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            commands.len(),
            "`run_step` wires the same command name twice: {commands:?}. The second arm is \
             unreachable, so a fixture step naming it would silently run the FIRST one."
        );
    }

    /// The command names wired into `run_step`'s `match args.command`, and the
    /// number of arms the walk crossed.
    ///
    /// This is a small scanner rather than a line-shape filter because the
    /// filter it replaces (`line.starts_with('"') && line.ends_with("=> {")`)
    /// was defeatable by three arm shapes rustfmt writes without complaint,
    /// each of which would have added a command while leaving the denominator
    /// at 20 — a ratchet whose whole purpose is to be falsifiable, silently
    /// not falsified:
    ///
    ///   * an OR-PATTERN (`"a" | "b" => {`) — one line, two commands;
    ///   * a pattern SPLIT ACROSS LINES, which rustfmt does as soon as the
    ///     alternatives are long enough;
    ///   * an EXPRESSION body (`"a" => foo(args).await?,`) — no brace at all.
    ///
    /// So the walk tracks the dispatch's structure instead: string literals in
    /// PATTERN position are commands, `=>` at pattern level opens an arm, and
    /// an arm ends at the close of its block or at the comma after its
    /// expression. Comments, string bodies, char literals and lifetimes are
    /// consumed so none of their braces or arrows are mistaken for structure.
    ///
    /// A string literal inside a pattern GUARD would be counted as a command
    /// (there is none today). That is the safe direction for a tripwire: it
    /// reddens and asks for a human, rather than passing while under-counting.
    fn wired_commands(src: &str) -> (Vec<String>, usize) {
        const DISPATCH: &str = "match args.command {";
        let body = body_after(src, "fn run_step(", "\n}\n");
        let start = body.find(DISPATCH).unwrap_or_else(|| {
            panic!("{DISPATCH:?} not found inside `run_step` — did the dispatch move or rename?")
        }) + DISPATCH.len();

        let chars: Vec<char> = body[start..].chars().collect();
        let mut commands = Vec::new();
        let mut arms = 0usize;
        let mut depth = 0i32;
        let mut in_pattern = true;
        let mut block_body = false;
        let mut awaiting_body = false;
        let mut i = 0usize;

        while i < chars.len() {
            let c = chars[i];
            // ── Things that are not structure, whatever they contain ──
            if c == '/' && chars.get(i + 1) == Some(&'/') {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if c == '/' && chars.get(i + 1) == Some(&'*') {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i = (i + 2).min(chars.len());
                continue;
            }
            if c == '"' {
                let mut literal = String::new();
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    // An escape consumes the next char, so `\"` does not end
                    // the literal and a `\\` before a quote does not either.
                    if chars[i] == '\\' {
                        i += 2;
                        continue;
                    }
                    literal.push(chars[i]);
                    i += 1;
                }
                i += 1;
                if in_pattern {
                    commands.push(literal);
                }
                continue;
            }
            if c == '\'' {
                // A char literal (`'x'`, `'\n'`) is skipped whole; a LIFETIME
                // (`'_`, `'static`) has no closing quote and is left to fall
                // through as ordinary text.
                let end = if chars.get(i + 1) == Some(&'\\') {
                    chars[i + 2..]
                        .iter()
                        .position(|&d| d == '\'')
                        .map(|p| i + 2 + p)
                } else if chars.get(i + 2) == Some(&'\'') {
                    Some(i + 2)
                } else {
                    None
                };
                i = end.map_or(i + 1, |e| e + 1);
                continue;
            }

            if in_pattern {
                if c == '=' && chars.get(i + 1) == Some(&'>') {
                    arms += 1;
                    in_pattern = false;
                    awaiting_body = true;
                    i += 2;
                    continue;
                }
                match c {
                    '(' | '[' | '{' => depth += 1,
                    ')' | ']' => depth -= 1,
                    // The `}` that closes the whole dispatch.
                    '}' if depth == 0 => break,
                    '}' => depth -= 1,
                    _ => {}
                }
                i += 1;
                continue;
            }

            // ── Inside an arm body ──
            if awaiting_body && !c.is_whitespace() {
                // The first significant character decides how this arm ENDS:
                // a block arm ends when its brace closes, an expression arm at
                // the comma after it.
                block_body = c == '{';
                awaiting_body = false;
            }
            match c {
                '(' | '[' | '{' => depth += 1,
                ')' | ']' | '}' => {
                    if depth == 0 {
                        // An expression arm ran straight into the dispatch's
                        // closing brace (a last arm with no trailing comma).
                        break;
                    }
                    depth -= 1;
                    if depth == 0 && block_body {
                        in_pattern = true;
                    }
                }
                ',' if depth == 0 && !block_body => in_pattern = true,
                _ => {}
            }
            i += 1;
        }
        (commands, arms)
    }

    /// The three shapes the old line-shape filter could not see, in a fixture
    /// built to be counted — because a denominator that only ever runs against
    /// the one source file it guards is a denominator nobody has watched move.
    ///
    /// The legacy filter is recomputed here on the SAME fixture, so the
    /// assertion is not "the new counter returns 7" (which any constant
    /// satisfies) but "the new counter sees five commands the old one did
    /// not".
    #[test]
    fn the_arm_walk_sees_or_patterns_split_patterns_and_expression_bodies() {
        const FIXTURE: &str = r#"
async fn run_step(pool: &SqlitePool, args: &StepArgs<'_>) -> Result<RawResult, AppError> {
    Ok(match args.command {
        // The only shape the old filter could see.
        "plain" => {
            let braces = "=> {";
        }
        // An or-pattern: ONE line, TWO commands.
        "or_a" | "or_b" => {
            let c = '}';
        }
        // rustfmt splits a pattern once the alternatives get long.
        "split_a"
        | "split_b" => {
            let s: &'static str = "x";
        }
        // An expression body: no brace to end with.
        "expr" => expr_only(pool, args).await?,
        other => panic!("{other} is not wired"),
    })
}
"#;
        let legacy = body_after(FIXTURE, "fn run_step(", "\n}\n")
            .lines()
            .filter(|l| {
                let t = l.trim();
                t.starts_with('"') && t.ends_with("=> {")
            })
            .count();
        assert_eq!(
            legacy, 2,
            "the fixture is supposed to be one the OLD filter under-counts; it saw {legacy}"
        );

        let (commands, arms) = wired_commands(FIXTURE);
        assert_eq!(
            commands,
            vec!["plain", "or_a", "or_b", "split_a", "split_b", "expr"],
            "the arm walk missed a shape the denominator has to be able to see"
        );
        // FOUR literal arms — one of which names two commands — plus the
        // catch-all. That commands (6) exceeds arms-minus-the-catch-all (4) is
        // the or-pattern being counted per COMMAND rather than per arm, which
        // is the denominator the sweep is about.
        assert_eq!(
            arms, 5,
            "four literal arms plus the catch-all; got {arms} — the walk stopped early"
        );
    }

    /// The body of `<needle>` up to the first `closer` line after it, where
    /// `closer` is the CLOSING BRACE AT THE CONSTRUCT'S OWN INDENTATION.
    ///
    /// The indentation has to be a parameter rather than always `"\n}\n"`. A
    /// top-level `fn` closes at column 0, but a `match` ARM closes at the arm's
    /// indentation — and taking the first column-0 `}` for an arm walks past
    /// every LATER arm to the end of the enclosing function. That is not a
    /// theoretical objection: `"get_block" => {` to the next column-0 `}` spans
    /// ten arms of [`run_step`], so `arm.contains("get_active_block_inner(")`
    /// would have been satisfiable by any of them. The guard passed only
    /// because `get_active_block_inner(` happens to appear nowhere else in that
    /// span — a coincidence the assertion did not state and would not survive a
    /// future arm reading active blocks.
    fn body_after(src: &str, needle: &str, closer: &str) -> String {
        let start = src
            .find(needle)
            .unwrap_or_else(|| panic!("{needle:?} not found — did it move or get renamed?"));
        let rest = &src[start..];
        let end = rest.find(closer).map_or(rest.len(), |i| i + closer.len());
        rest[..end].to_owned()
    }

    #[test]
    fn get_block_command_delegates_to_the_active_only_reader() {
        let body = body_after(QUERIES_RS, "pub async fn get_block(", "\n}\n");
        assert!(
            body.contains("get_active_block_inner("),
            "the shipped `get_block` no longer calls `get_active_block_inner`. Public \
             read surfaces must never serve a soft-deleted row; if this delegation is \
             changed on purpose, the conformance arm in conformance_query.rs and the \
             `query_point_reads_blocks` fixture step must change with it, or the \
             differential goes back to certifying a reader the command does not use \
             (#3928). Body was:\n{body}"
        );
        assert!(
            !body.contains("get_block_inner("),
            "the shipped `get_block` calls `get_block_inner`, the PERMISSIVE reader \
             that SERVES tombstones. That is the exact regression #3928 filed: the \
             conformance step reads a tombstone and would then be pinning the wrong \
             one of the two readers. Body was:\n{body}"
        );
    }

    #[test]
    fn the_conformance_arm_calls_the_same_reader_the_command_does() {
        // `run_step`'s arms are indented 8 spaces, so the arm ends at the first
        // 8-space `}` — NOT the first column-0 one, which is the end of
        // `run_step` itself, ten arms later.
        let arm = body_after(HARNESS_RS, "\"get_block\" => {", "\n        }\n");
        // A tripwire on this scan's OWN scoping, not on the delegation. NOT
        // load-bearing today (the arm is 24 lines) and said so rather than left
        // to read as verified: it exists because the pre-#3928-review version of
        // this scan silently captured 165 lines, and a text scan that quietly
        // widens is a guard that keeps passing for the wrong reason.
        assert!(
            arm.lines().count() < 40,
            "the `get_block` arm scan captured {} lines, which means the arm-closing \
             brace moved and the scan is now reading LATER arms — an assertion that \
             passes on a neighbouring arm's call is not pinning this one. Captured:\n{arm}",
            arm.lines().count()
        );
        assert!(
            arm.contains("get_active_block_inner("),
            "the `get_block` conformance arm no longer calls the reader the shipped \
             command calls. An arm that reaches a different `*_inner` certifies a \
             function production never runs — and the mock gets aligned to the arm \
             (#3928). Arm was:\n{arm}"
        );
        assert!(
            !arm.contains("get_block_inner("),
            "the `get_block` conformance arm calls `get_block_inner`, the permissive \
             reader. This is #3928 exactly. Arm was:\n{arm}"
        );
    }
}

#[cfg(test)]
mod cursor_shape_tests {
    use super::shape_of_cursor;
    use base64::Engine as _;
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

    fn encode(json: &str) -> String {
        URL_SAFE_NO_PAD.encode(json.as_bytes())
    }

    /// The engine's `QueryCursor` (`agaric-store/src/query/engine.rs`) — the
    /// version plus the ORDERED `#[serde(tag = "t")]` tags of the sort tuple.
    /// #3863 was a mock that carried a 1-element `{id}` payload where the
    /// engine carries this whole tuple; the arity alone separates them.
    #[test]
    fn an_engine_tuple_cursor_renders_version_and_ordered_tags() {
        assert_eq!(
            shape_of_cursor(&encode(
                r#"{"version":1,"values":[{"t":"Int","v":3},{"t":"Text","v":"01ABC"}]}"#
            )),
            "v1:[Int,Text]"
        );
    }

    /// The tuple is ORDERED, so a reordered sort key is a different shape.
    /// A sorted/set rendering here would make the reorder invisible, which is
    /// half of the #3893 failure class.
    #[test]
    fn a_reordered_sort_tuple_is_a_different_shape() {
        assert_ne!(
            shape_of_cursor(&encode(
                r#"{"version":1,"values":[{"t":"Int","v":3},{"t":"Text","v":"a"}]}"#
            )),
            shape_of_cursor(&encode(
                r#"{"version":1,"values":[{"t":"Text","v":"a"},{"t":"Int","v":3}]}"#
            ))
        );
    }

    /// A field added ALONGSIDE `values` is a cursor-format change, and the
    /// tuple branch used to discard every key it did not name — so
    /// `QueryCursor` growing a sort fingerprint or a direction flag would have
    /// left the recorded shape identical. Same-named sibling in the TS twin.
    #[test]
    fn a_sibling_field_added_to_the_tuple_cursor_changes_the_shape() {
        assert_eq!(
            shape_of_cursor(&encode(
                r#"{"version":1,"values":[{"t":"Text","v":"a"}],"desc":true}"#
            )),
            "v1:[Text]+{desc}"
        );
        // The suffix is EMPTY for today's two-key cursor, so no fixture moved
        // when this was added — the guard is free until the format changes.
        assert_eq!(
            shape_of_cursor(&encode(r#"{"version":1,"values":[{"t":"Text","v":"a"}]}"#)),
            "v1:[Text]"
        );
    }

    /// A version bump is the cheapest cursor-format change to make and the
    /// easiest to miss: same tuple, same codec, incompatible cursor.
    #[test]
    fn a_version_bump_changes_the_shape() {
        assert_eq!(
            shape_of_cursor(&encode(r#"{"version":2,"values":[{"t":"Text","v":"a"}]}"#)),
            "v2:[Text]"
        );
    }

    /// The pagination cursor (`agaric-store/src/pagination`) has no `values`
    /// array: its optional slots are `skip_serializing_if = "Option::is_none"`,
    /// so the set of PRESENT keys is the keyset it was minted on. Slots are
    /// sorted because serde field order is a byte-level detail, not a keyset.
    #[test]
    fn a_pagination_cursor_renders_its_populated_slots() {
        assert_eq!(
            shape_of_cursor(&encode(r#"{"id":"01ABC","position":3,"version":1}"#)),
            "v1:{id,position}"
        );
        assert_eq!(
            shape_of_cursor(&encode(r#"{"id":"01ABC","version":1}"#)),
            "v1:{id}"
        );
    }

    /// The two families must never render alike — a tuple cursor and a
    /// pagination cursor are different codecs, and a projection that collapsed
    /// them would let one be swapped for the other.
    #[test]
    fn the_two_cursor_families_do_not_collide() {
        assert_ne!(
            shape_of_cursor(&encode(r#"{"version":1,"values":[{"t":"Text","v":"a"}]}"#)),
            shape_of_cursor(&encode(r#"{"id":"a","version":1}"#))
        );
    }

    /// The base64 decode IS part of the assertion. `URL_SAFE_NO_PAD` is what
    /// both codecs promise; a standard-alphabet or padded encoder (a bare
    /// `btoa`, say) must render as a distinct marker rather than being
    /// tolerated into agreement.
    #[test]
    fn a_standard_alphabet_cursor_is_not_silently_accepted() {
        // Chosen so the standard encoding actually contains a `+` or `/`.
        let payload = r#"{"id":"a?~ÿ>","version":1}"#;
        let standard = STANDARD.encode(payload.as_bytes());
        assert!(
            standard.contains('+') || standard.contains('/') || standard.contains('='),
            "test payload must exercise the alphabet difference; got {standard}"
        );
        assert_eq!(shape_of_cursor(&standard), "<not-base64url>");
    }

    /// Everything after the decode is guarded the same way: a payload that is
    /// not UTF-8 JSON renders a marker instead of panicking the whole suite,
    /// so a codec change reddens ONE step with a readable diff.
    #[test]
    fn a_non_json_payload_renders_a_marker() {
        assert_eq!(shape_of_cursor(&encode("not json at all")), "<not-json>");
        assert_eq!(shape_of_cursor(&encode("[1,2]")), "<not-an-object>");
        assert_eq!(
            shape_of_cursor(&URL_SAFE_NO_PAD.encode([0xff_u8])),
            "<not-utf8>"
        );
    }

    /// A missing version slot is not the same as version 1. `Cursor::decode`
    /// accepts a pre-versioning cursor as v1 for BACKWARD compatibility, but a
    /// freshly-minted cursor that stopped stamping its version is a format
    /// change, and the projection has to be able to say so.
    #[test]
    fn an_unversioned_cursor_is_distinguishable() {
        assert_eq!(shape_of_cursor(&encode(r#"{"id":"a"}"#)), "v?:{id}");
    }
}

#[cfg(test)]
mod attr_value_tests {
    use super::{attr_value, map_rows_tokens, property_token};
    use serde_json::json;

    /// Every rendering here is byte-identical to `String(n)` in the TS twin —
    /// the whole point of the token grammar is that ONE recorded expectation
    /// binds both runners, so a formatting difference is a silent harness lie
    /// rather than a real divergence.
    #[test]
    fn numbers_render_the_way_js_string_renders_them() {
        for (v, expected) in [
            (json!(3), "3"),
            (json!(3.0), "3"),
            (json!(0), "0"),
            (json!(0.5), "0.5"),
            (json!(-1.25), "-1.25"),
            (json!(1e15), "1000000000000000"),
            (json!(1e20), "100000000000000000000"),
            (json!(1e-6), "0.000001"),
        ] {
            assert_eq!(attr_value("value_num", Some(&v)), expected, "for {v}");
        }
    }

    /// `String(1e21) === '1e+21'` but Rust prints the digits out, so the guard
    /// must REFUSE the value instead of recording a token only one stack can
    /// produce.
    #[test]
    #[should_panic(expected = "whose Rust and JS renderings differ")]
    fn a_magnitude_js_prints_in_exponent_form_is_refused() {
        attr_value("value_num", Some(&json!(1e21)));
    }

    /// The other end of the range: `String(1e-7) === '1e-7'`.
    #[test]
    #[should_panic(expected = "whose Rust and JS renderings differ")]
    fn a_magnitude_below_the_js_plain_floor_is_refused() {
        attr_value("value_num", Some(&json!(1e-7)));
    }

    /// A `#` in an attribute value is NOT a red/green flip — both runners build
    /// the same string — it is token ALIASING, so the guard has to refuse it at
    /// authoring time or a projection bug in that column can compare EQUAL.
    /// `RESOLVED_ATTRS` carries `title`, the raw `content` column, and `#` is
    /// ordinary text in this app, so this is reachable rather than theoretical.
    #[test]
    #[should_panic(expected = "contains a token separator")]
    fn a_hash_in_an_attribute_value_is_refused() {
        attr_value("title", Some(&json!("a#b")));
    }

    /// `->` is the other separator: it splits an arrow HEAD, so a value
    /// carrying it can alias against a `parent->child` token.
    #[test]
    #[should_panic(expected = "contains a token separator")]
    fn an_arrow_in_an_attribute_value_is_refused() {
        attr_value("title", Some(&json!("a->b")));
    }

    /// The guard must not be so broad it refuses ordinary text — a lone `-` or
    /// `>` is fine, and refusing them would make the harness unusable for real
    /// content while proving nothing.
    #[test]
    fn ordinary_punctuation_is_not_refused() {
        for v in [json!("a-b"), json!("a > b"), json!("a_b"), json!("plain")] {
            let _ = attr_value("title", Some(&v));
        }
    }

    /// The head is the OTHER half of the grammar, and it was unguarded while
    /// values were guarded. A property key `a#b` with `value_text: "x"` renders
    /// `a#b#Text=x`, which is exactly what the key `a` carrying a `b#Text=x`
    /// segment renders — so the two tokens compare EQUAL and a projection bug
    /// between them is invisible. `set_property` takes the key from the caller,
    /// so this is user-authored text.
    #[test]
    #[should_panic(expected = "contains a token separator")]
    fn a_hash_in_a_property_key_is_refused() {
        let _ = property_token(&json!({ "key": "a#b", "value_text": "x" }));
    }

    /// `->` heads the map projections (`first_child_for_blocks`,
    /// `get_batch_properties`), so a key carrying one splits the pair wrongly.
    #[test]
    #[should_panic(expected = "contains a token separator")]
    fn an_arrow_in_a_map_key_is_refused() {
        let _ = map_rows_tokens(
            &json!({ "a->b": [{ "key": "k", "value_text": "x" }] }),
            &property_token,
        );
    }

    /// The empty-array branch of `map_rows_tokens` builds its own token, so it
    /// needs the guard too — it would otherwise be the one head that escapes.
    #[test]
    #[should_panic(expected = "contains a token separator")]
    fn a_hash_in_an_empty_entry_map_key_is_refused() {
        let _ = map_rows_tokens(&json!({ "a#b": [] }), &property_token);
    }

    /// Ordinary keys must still pass, or the guard is just breakage.
    #[test]
    fn ordinary_keys_are_not_refused() {
        assert_eq!(
            property_token(&json!({ "key": "status", "value_text": "open" })),
            "status#Text=open"
        );
        assert_eq!(
            map_rows_tokens(&json!({ "B2": [] }), &property_token),
            vec!["B2->(none)".to_owned()]
        );
    }

    /// `deleted_at` is normalised BEFORE the number branch, so a tombstone
    /// stamp (an epoch-ms value well outside the plain range in seconds terms,
    /// and a clock value regardless) never reaches the guard.
    #[test]
    fn deleted_at_is_normalised_before_the_numeric_guard() {
        assert_eq!(
            attr_value("deleted_at", Some(&json!(1_760_000_000_000_i64))),
            "DELETED"
        );
        assert_eq!(attr_value("deleted_at", None), "null");
    }
}

/// #3833 items 7/12 — the duplicate-step-name guard's own tests.
///
/// The guard is an assertion over fixture data and no fixture can trip it, so
/// without these its body never executes on any run: the check would be
/// decoration, which is the exact failure class #3833 collects. Both halves
/// are pinned — the predicate, and the fact that [`run_query_steps`] actually
/// calls it before touching the pool. The TS twin's copy of this property
/// lives in `conformance.test.ts`.
#[cfg(test)]
mod step_name_uniqueness_tests {
    use super::{assert_unique_step_names, duplicate_step_names, run_query_steps};
    use serde_json::{Value, json};
    use std::collections::BTreeMap;

    fn steps(names: &[&str]) -> Vec<Value> {
        names.iter().map(|n| json!({ "name": n })).collect()
    }

    #[test]
    fn distinct_names_have_no_duplicates() {
        assert!(duplicate_step_names(&steps(&["a", "b", "c"])).is_empty());
        assert!(duplicate_step_names(&[]).is_empty());
        assert_unique_step_names("fx", &steps(&["a", "b", "c"]));
    }

    /// Three copies of one name report it ONCE — the naive
    /// `filter(|n| !seen.insert(n))` this replaced reported it twice, which
    /// diverged from the TS twin's `Set`-based message for no reason.
    #[test]
    fn a_repeated_name_is_reported_once_and_every_offender_is_reported() {
        assert_eq!(duplicate_step_names(&steps(&["a", "b", "a"])), vec!["a"]);
        assert_eq!(duplicate_step_names(&steps(&["a", "a", "a"])), vec!["a"]);
        assert_eq!(
            duplicate_step_names(&steps(&["a", "b", "a", "b"])),
            vec!["a", "b"]
        );
    }

    #[test]
    #[should_panic(expected = "fixture 'fx' has duplicate query step name(s) [\"dup\"]")]
    fn the_assertion_panics_on_a_duplicate() {
        assert_unique_step_names("fx", &steps(&["dup", "other", "dup"]));
    }

    /// #3980 note 6 — the two twins must AGREE on a step with no usable
    /// `name`, which is reachable in both (neither validates its fixture
    /// parse). Unchecked, this side dropped the step via `filter_map` and
    /// said nothing while the TS side reported a duplicate of `[null]`. TWO
    /// nameless steps, because that is the shape that made TS fabricate one
    /// (a single nameless step collided with nothing); plus a non-string
    /// `name`, the other half of what `as_str()` rejects. The TS half of this
    /// pair runs the same three, in `conformance.test.ts`.
    #[test]
    #[should_panic(
        expected = "fixture 'fx' has query step(s) at index [0, 1, 2] with no string `name`"
    )]
    fn the_assertion_panics_on_a_step_with_no_name() {
        assert_unique_step_names(
            "fx",
            &[
                json!({ "command": "get_page" }),
                json!({ "command": "get_page" }),
                json!({ "name": 7, "command": "get_page" }),
            ],
        );
    }

    /// The CALL SITE, not just the predicate: a guard function that is tested
    /// in isolation and never wired in is a half-covered pair. The panic must
    /// come from `run_query_steps` itself, and BEFORE it issues any query —
    /// the pool here is a bare in-memory database with no schema at all, so
    /// anything reaching a step would fail differently.
    #[tokio::test]
    #[should_panic(expected = "duplicate query step name(s) [\"dup\"]")]
    async fn run_query_steps_rejects_a_duplicate_before_touching_the_pool() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("in-memory pool");
        let fixture = json!({
            "queries": [
                { "name": "dup", "command": "list_page_links", "args": {} },
                { "name": "dup", "command": "list_page_links", "args": {} },
            ]
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }
}

/// #3833 item 2 — the GROUPED projection.
///
/// [`group_tokens`] is a pure function over the serialized response, so its
/// grammar is pinned here; the CALL SITE — the concatenation inside the
/// `run_advanced_query` arm — is pinned by
/// `grouped_and_flat_projection_tests::a_grouped_request_records_its_buckets`,
/// because a projector nothing calls is the same decoration this issue is
/// about.
#[cfg(test)]
mod group_token_tests {
    use super::group_tokens;
    use serde_json::json;

    /// The FLAT response. `groups` is absent from neither stack's wire form
    /// (it serializes as `[]`), and both readings must contribute nothing so
    /// every existing flat step projects byte-identically to before.
    #[test]
    fn a_flat_response_contributes_no_group_tokens() {
        assert!(group_tokens(&json!({ "rows": [{ "id": "B1" }], "groups": [] })).is_empty());
        assert!(group_tokens(&json!({ "rows": [{ "id": "B1" }] })).is_empty());
    }

    #[test]
    fn a_bucket_projects_its_count_and_one_token_per_preview_member() {
        assert_eq!(
            group_tokens(&json!({
                "rows": [],
                "groups": [{
                    "key": "DONE",
                    "count": 2,
                    "members": [{ "id": "B1" }, { "id": "B4" }],
                }],
            })),
            vec!["DONE#count=2", "DONE->B1", "DONE->B4"]
        );
    }

    /// A bucket whose preview is EMPTY must stay visible. The mock's grouped
    /// path currently synthesises a single bucket with no members at all, so
    /// this is the token that makes that stub show up in a diff instead of
    /// collapsing into a bare count.
    #[test]
    fn a_bucket_with_no_preview_members_projects_none() {
        assert_eq!(
            group_tokens(&json!({
                "groups": [{ "key": "none", "count": 7, "members": [] }],
            })),
            vec!["none#count=7", "none->(none)"]
        );
    }

    /// Every bucket contributes, and the buckets keep the order the engine
    /// paged them in (a step may then set `"ordered": true` to pin it).
    #[test]
    fn every_bucket_contributes() {
        assert_eq!(
            group_tokens(&json!({
                "groups": [
                    { "key": "page", "count": 1, "members": [{ "id": "B1" }] },
                    { "key": "content", "count": 1, "members": [{ "id": "B2" }] },
                ],
            })),
            vec!["page#count=1", "page->B1", "content#count=1", "content->B2"]
        );
    }

    /// #3833 item 2 (review) — `QueryGroup`'s FOURTH field. All three cells of
    /// each result are recorded, so an operator that answers in the wrong cell
    /// is visible rather than normalised away.
    #[test]
    fn a_bucket_projects_its_per_group_aggregates() {
        assert_eq!(
            group_tokens(&json!({
                "groups": [{
                    "key": "DONE",
                    "count": 2,
                    "members": [],
                    "aggregates": [
                        { "op": "count", "value": null, "count": 2 },
                        { "op": "sum", "value": 7.5, "count": null },
                    ],
                }],
            })),
            vec![
                "DONE#count=2#agg0=count/null/2#agg1=sum/7.5/null",
                "DONE->(none)"
            ]
        );
    }

    /// The contract is "in the SAME order as the request's `aggregates`", so a
    /// reordering is a different projection. Indexing the segment name is what
    /// buys that; a set of `#count=`/`#sum=` segments would not.
    #[test]
    fn reordered_aggregates_are_a_different_projection() {
        let a = group_tokens(&json!({ "groups": [{ "key": "k", "count": 1, "members": [],
            "aggregates": [{ "op": "count", "count": 1 }, { "op": "sum", "value": 2.0 }] }] }));
        let b = group_tokens(&json!({ "groups": [{ "key": "k", "count": 1, "members": [],
            "aggregates": [{ "op": "sum", "value": 2.0 }, { "op": "count", "count": 1 }] }] }));
        assert_ne!(a, b);
    }

    /// A bucket missing the `key` the projector reads records the SAME
    /// `<missing-key>` sentinel `property_token` uses, so the coverage test's
    /// sentinel-leak guard (#3833 items 9/10) already covers this projection
    /// rather than needing a sentinel of its own.
    #[test]
    fn a_bucket_with_no_key_records_the_shared_sentinel() {
        assert_eq!(
            group_tokens(&json!({ "groups": [{ "count": 1, "members": [] }] })),
            vec!["<missing-key>#count=1", "<missing-key>->(none)"]
        );
    }
}

/// #3833 items 2, 5 and 8 — the three properties that need a real backend
/// under them: the grouped arm's call site, the fixture-naming of an accessor
/// failure, and the read-phase purity guard.
#[cfg(test)]
mod query_runner_context_tests {
    use super::super::common::{TEST_SPACE_ID, assign_all_to_test_space, insert_block, test_pool};
    use super::{derived_cache_digest, run_query_steps};
    use serde_json::json;
    use std::collections::BTreeMap;

    const PAGE: &str = "00000000000000000000000P01";
    const CHILD: &str = "00000000000000000000000C01";
    const PAGE2: &str = "00000000000000000000000P02";

    /// One page with one text child, both in the harness space.
    async fn seeded_pool() -> (sqlx::SqlitePool, tempfile::TempDir) {
        let (pool, dir) = test_pool().await;
        insert_block(&pool, PAGE, "page", "Page One", None, Some(0)).await;
        insert_block(&pool, CHILD, "content", "A child", Some(PAGE), Some(1)).await;
        assign_all_to_test_space(&pool).await;
        (pool, dir)
    }

    /// #3833 item 2, the CALL SITE. Before the grouped projection was bound,
    /// this step recorded `rows: []` — non-comparable, and the ratchet counted
    /// `run_advanced_query` as covered anyway.
    #[tokio::test]
    async fn a_grouped_request_records_its_buckets() {
        let (pool, _dir) = seeded_pool().await;
        let fixture = json!({
            "name": "grouped_demo",
            "queries": [{
                "name": "grouped_by_block_type",
                "command": "run_advanced_query",
                "ordered": true,
                "args": { "request": {
                    "spaceId": TEST_SPACE_ID,
                    "limit": 100,
                    "groupBy": { "key": { "type": "BlockType" } },
                }},
            }],
        });
        let out = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
        let rows = out[0]["rows"].as_array().expect("rows array").clone();
        let rows: Vec<&str> = rows.iter().filter_map(serde_json::Value::as_str).collect();

        // The two seeded blocks bucket by `block_type`, one each. Asserting the
        // COUNT tokens (rather than the whole vector) keeps this about the
        // projection being bound, not about the engine's bucket order.
        assert!(
            rows.contains(&"page#count=1") && rows.contains(&"content#count=1"),
            "grouped response projected {rows:?}, which carries no bucket counts — the \
             GROUPED arm is unbound again"
        );
        assert!(
            rows.iter().any(|t| *t == format!("page->{PAGE}"))
                && rows.iter().any(|t| *t == format!("content->{CHILD}")),
            "grouped response projected {rows:?}, which carries no preview members"
        );
    }

    /// #3833 item 5. `list_page_links` requires `scope`; the message must name
    /// the fixture and the step, because the suite runs every fixture under one
    /// `#[tokio::test]` and the arg name alone identifies ~150 sites.
    #[tokio::test]
    #[should_panic(
        expected = "fixture 'accessor_demo' query step 'links_without_a_scope' (command \
                    'list_page_links'): query step is missing required arg 'scope'"
    )]
    async fn a_missing_required_arg_names_the_fixture_and_the_step() {
        let (pool, _dir) = seeded_pool().await;
        let fixture = json!({
            "name": "accessor_demo",
            "queries": [
                { "name": "links_without_a_scope", "command": "list_page_links", "args": {} },
            ],
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }

    /// #3833 item 5, the other accessor failure: an arg that is PRESENT but of
    /// the wrong shape.
    #[tokio::test]
    #[should_panic(
        expected = "fixture 'accessor_demo' query step 'scope_of_the_wrong_shape' (command \
                    'list_page_links'): query arg 'scope'"
    )]
    async fn a_malformed_arg_names_the_fixture_and_the_step() {
        let (pool, _dir) = seeded_pool().await;
        let fixture = json!({
            "name": "accessor_demo",
            "queries": [{
                "name": "scope_of_the_wrong_shape",
                "command": "list_page_links",
                "args": { "scope": "global" },
            }],
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }

    // ── #3946: a refusal is only recorded when it was DECLARED ──────────────
    //
    // These five drive `run_query_steps` itself rather than a helper, because
    // the thing under test is what the RUNNER agrees to write down. All five
    // arms are otherwise untestable from the fixture set: every shipped fixture
    // is green by construction, so the panics below never fire in the suite and
    // would rot unnoticed.

    /// An id that exists nowhere, so `get_block` answers `NotFound`.
    const MISSING: &str = "00000000000000000000000ZZZ";

    /// The hole #3946 names: `run_step` propagates production errors, so an
    /// authoring mistake (a bad id here; an out-of-range `limit` or a wrong
    /// argument combination just as easily) is a recordable answer. Undeclared,
    /// it must not become one.
    #[tokio::test]
    #[should_panic(
        expected = "fixture 'refusal_demo' query step 'block_that_is_not_there' (command \
                    'get_block'): the command REFUSED with `not_found`, and the step did not \
                    declare it"
    )]
    async fn an_undeclared_refusal_is_rejected_rather_than_recorded() {
        let (pool, _dir) = seeded_pool().await;
        let fixture = json!({
            "name": "refusal_demo",
            "queries": [
                { "name": "block_that_is_not_there", "command": "get_block",
                  "args": { "blockId": MISSING } },
            ],
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }

    /// The other half: DECLARED, the same refusal is the recording — the #3928
    /// capability is not what #3946 takes away.
    #[tokio::test]
    async fn a_declared_refusal_is_recorded() {
        let (pool, _dir) = seeded_pool().await;
        let fixture = json!({
            "name": "refusal_demo",
            "queries": [
                { "name": "block_that_is_not_there", "command": "get_block",
                  "expect_error": "not_found", "args": { "blockId": MISSING } },
            ],
        });
        let out = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
        assert_eq!(out[0]["error"], json!("not_found"));
        assert_eq!(out[0]["rows"], json!([]));
    }

    /// Both arms or neither: a declaration whose command now SUCCEEDS is a
    /// stale claim, and leaving it would let a served answer read as a pinned
    /// refusal.
    #[tokio::test]
    #[should_panic(
        expected = "fixture 'refusal_demo' query step 'block_that_is_there' (command \
                    'get_block'): the step declares \"expect_error\": \"not_found\" but the \
                    command SUCCEEDED"
    )]
    async fn a_declaration_that_no_longer_refuses_is_rejected() {
        let (pool, _dir) = seeded_pool().await;
        let fixture = json!({
            "name": "refusal_demo",
            "queries": [
                { "name": "block_that_is_there", "command": "get_block",
                  "expect_error": "not_found", "args": { "blockId": CHILD } },
            ],
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }

    /// A declaration naming a DIFFERENT kind than the one raised describes a
    /// refusal nobody is asserting — the recorded kind is what the mock has to
    /// reproduce.
    #[tokio::test]
    #[should_panic(
        expected = "fixture 'refusal_demo' query step 'block_that_is_not_there' (command \
                    'get_block'): the step declares \"expect_error\": \"validation\" but the \
                    command refused with `not_found`"
    )]
    async fn a_declaration_naming_the_wrong_kind_is_rejected() {
        let (pool, _dir) = seeded_pool().await;
        let fixture = json!({
            "name": "refusal_demo",
            "queries": [
                { "name": "block_that_is_not_there", "command": "get_block",
                  "expect_error": "validation", "args": { "blockId": MISSING } },
            ],
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }

    /// `expect_error: true` would read as "declared" to a bare `as_str()` and
    /// then silently fail to match any kind, so the shape is checked rather
    /// than coerced — a mis-typed declaration must not degrade into no
    /// declaration at all.
    #[tokio::test]
    #[should_panic(
        expected = "fixture 'refusal_demo' query step 'block_that_is_not_there' (command \
                    'get_block'): `expect_error` must be an AppErrorKind wire string"
    )]
    async fn a_non_string_declaration_is_rejected() {
        let (pool, _dir) = seeded_pool().await;
        let fixture = json!({
            "name": "refusal_demo",
            "queries": [
                { "name": "block_that_is_not_there", "command": "get_block",
                  "expect_error": true, "args": { "blockId": MISSING } },
            ],
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }

    /// Insert one `block_properties` row directly, so a test can seed the
    /// fixture CONTENT the token grammar refuses. No op-log entry: these tests
    /// are about the projection, not about a write path.
    async fn insert_property(
        pool: &sqlx::SqlitePool,
        block_id: &str,
        key: &str,
        value_text: Option<&str>,
        value_num: Option<f64>,
    ) {
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text, value_num) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(block_id)
        .bind(key)
        .bind(value_text)
        .bind(value_num)
        .execute(pool)
        .await
        .expect("seed a block_properties row");
    }

    /// #3833 item 5 — the panics inside the TOKEN GRAMMAR name the fixture too,
    /// not only the arg accessors.
    ///
    /// These three are the ones a NEW fixture is likeliest to meet, because
    /// they trip on seeded content rather than on harness plumbing: a `#` in a
    /// page title, a `#` in a property key, a `value_num` outside the range the
    /// two runners render identically. None of them can reach [`StepArgs`] —
    /// they fire beneath `row_token` / `property_token`, which take a
    /// serialized response row — so the context arrives through the
    /// [`super::PROJECTING_STEP`] task-local instead.
    #[tokio::test]
    #[should_panic(
        expected = "fixture 'grammar_demo' query step 'resolve_the_page' (command \
                    'batch_resolve'): query attribute 'title' renders as"
    )]
    async fn a_separator_in_a_seeded_title_names_the_fixture_and_the_step() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, PAGE, "page", "Sharp # title", None, Some(0)).await;
        assign_all_to_test_space(&pool).await;
        let fixture = json!({
            "name": "grammar_demo",
            "queries": [{
                "name": "resolve_the_page",
                "command": "batch_resolve",
                "args": { "ids": [PAGE], "scope": { "kind": "active", "space_id": TEST_SPACE_ID } },
            }],
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }

    /// The HEAD half of the same hazard: a property KEY is user-authored text
    /// (`set_property` takes it straight from the caller), so `#` in one is
    /// reachable rather than theoretical.
    #[tokio::test]
    #[should_panic(
        expected = "fixture 'grammar_demo' query step 'read_the_properties' (command \
                    'get_properties'): query property key \"a#b\""
    )]
    async fn a_separator_in_a_seeded_property_key_names_the_fixture_and_the_step() {
        let (pool, _dir) = seeded_pool().await;
        insert_property(&pool, PAGE, "a#b", Some("x"), None).await;
        let fixture = json!({
            "name": "grammar_demo",
            "queries": [{
                "name": "read_the_properties",
                "command": "get_properties",
                "args": { "blockId": PAGE },
            }],
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }

    /// The float-rendering refusal ([`super::JS_PLAIN_RANGE`]): `1e-9` prints
    /// as `0.000000001` in Rust and `1e-9` in JS, so recording it would redden
    /// a fixture holding no divergence at all.
    #[tokio::test]
    #[should_panic(
        expected = "fixture 'grammar_demo' query step 'read_the_properties' (command \
                    'get_properties'): query attribute 'value_num' holds"
    )]
    async fn an_unrenderable_number_names_the_fixture_and_the_step() {
        let (pool, _dir) = seeded_pool().await;
        insert_property(&pool, PAGE, "tiny", None, Some(1e-9)).await;
        let fixture = json!({
            "name": "grammar_demo",
            "queries": [{
                "name": "read_the_properties",
                "command": "get_properties",
                "args": { "blockId": PAGE },
            }],
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }

    /// #3833 item 5 — the unwired-command panic is the FIRST thing a fixture
    /// author extending the harness meets, so it names them too.
    #[tokio::test]
    #[should_panic(
        expected = "fixture 'accessor_demo' query step 'unwired' (command 'get_page'): \
                    conformance query command 'get_page' is not wired"
    )]
    async fn an_unwired_command_names_the_fixture_and_the_step() {
        let (pool, _dir) = seeded_pool().await;
        let fixture = json!({
            "name": "accessor_demo",
            "queries": [{ "name": "unwired", "command": "get_page", "args": {} }],
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }

    /// #3833 item 8 — the read phase writing is DETECTED.
    ///
    /// This reproduces the exact state `list_page_links_inner_split_with_cap`'s
    /// lazy-rebuild branch is gated on: `block_links` populated OUTSIDE the
    /// materializer (a direct INSERT, which is what the branch's own comment
    /// names as its trigger) while `page_link_cache` is still empty. The read
    /// step then rebuilds the cache, and the guard reddens instead of letting
    /// a later step in the same fixture read the rebuilt state.
    #[tokio::test]
    #[should_panic(expected = "fixture 'writing_reader': the READ phase mutated a derived cache")]
    async fn a_read_step_that_rebuilds_the_link_cache_is_caught() {
        let (pool, _dir) = seeded_pool().await;
        insert_block(&pool, PAGE2, "page", "Page Two", None, Some(2)).await;
        assign_all_to_test_space(&pool).await;
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(CHILD)
            .bind(PAGE2)
            .execute(&pool)
            .await
            .expect("seed a block_links edge outside the materializer");

        let fixture = json!({
            "name": "writing_reader",
            "queries": [{
                "name": "page_links_global",
                "command": "list_page_links",
                "args": { "scope": { "kind": "global" } },
            }],
        });
        let _ = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
    }

    /// The purity guard is exactly as wide as [`derived_cache_digest`], and two
    /// of its three tables have no wired read command that writes them — so if
    /// either subquery were silently empty (a renamed column, a table that no
    /// longer exists, a `coalesce` swallowing an error) nothing else in the
    /// suite would notice and the widening would be decoration. This pins that
    /// each of the three actually contributes.
    #[tokio::test]
    async fn every_digested_table_contributes_to_the_digest() {
        let (pool, _dir) = seeded_pool().await;
        insert_block(&pool, PAGE2, "page", "Page Two", None, Some(2)).await;
        let base = derived_cache_digest(&pool).await;

        sqlx::query(
            "INSERT INTO page_link_cache (source_page_id, target_page_id, edge_count) \
             VALUES (?, ?, 1)",
        )
        .bind(PAGE)
        .bind(PAGE2)
        .execute(&pool)
        .await
        .expect("seed a page_link_cache row");
        let with_links = derived_cache_digest(&pool).await;
        assert_ne!(
            base, with_links,
            "a `page_link_cache` row did not change the digest"
        );

        sqlx::query(
            "INSERT INTO pages_cache (page_id, title, updated_at) VALUES (?, 'Page Two', 1)",
        )
        .bind(PAGE2)
        .execute(&pool)
        .await
        .expect("seed a pages_cache row");
        let with_pages = derived_cache_digest(&pool).await;
        assert_ne!(
            with_links, with_pages,
            "a `pages_cache` row did not change the digest"
        );

        sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, 'page two')")
            .bind(PAGE2)
            .execute(&pool)
            .await
            .expect("seed an fts_blocks row");
        assert_ne!(
            with_pages,
            derived_cache_digest(&pool).await,
            "an `fts_blocks` row did not change the digest"
        );
    }

    /// The PAIR of the test above: the same step over a fixture whose link
    /// state came from the materializer leaves the cache alone, so the guard
    /// is not simply "any fixture with a `list_page_links` step fails".
    #[tokio::test]
    async fn a_read_step_that_does_not_rebuild_passes_the_guard() {
        let (pool, _dir) = seeded_pool().await;
        let fixture = json!({
            "name": "clean_reader",
            "queries": [{
                "name": "page_links_global",
                "command": "list_page_links",
                "args": { "scope": { "kind": "global" } },
            }],
        });
        let out = run_query_steps(&pool, &fixture, &BTreeMap::new()).await;
        assert_eq!(out[0]["name"], json!("page_links_global"));
    }
}
