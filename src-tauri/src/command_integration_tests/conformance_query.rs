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
                    "query attribute '{name}' holds {f}, whose Rust and JS renderings \
                     differ (exponent form / signed zero), so the two conformance \
                     runners could never agree on its token. Give the fixture a value \
                     in ±[1e-6, 1e21) or exactly 0."
                );
                f.to_string()
            },
        ),
        Some(other) => other.to_string(),
    };
    assert!(
        !rendered.contains('#') && !rendered.contains("->"),
        "query attribute '{name}' renders as {rendered:?}, which contains a token \
         separator ('#' or '->'). Both runners would build the SAME string, so this \
         does not redden — it ALIASES: a differently-split row can match the same \
         token, and a real projection bug in this column would compare equal. Pick \
         fixture content without those sequences."
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
        "query {what} {head:?} contains a token separator ('#' or '->'). Both \
         runners would build the SAME string, so this does not redden — it \
         ALIASES: the head runs straight into the '#'-joined attribute segments \
         (and into the '->' of a map pair), so a differently-split token matches \
         it and a real projection bug compares equal. Pick fixture keys without \
         those sequences."
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

fn opt_arg(args: &Value, key: &str) -> Option<Value> {
    args.get(key).filter(|v| !v.is_null()).cloned()
}

fn arg_or<T: serde::de::DeserializeOwned + Default>(args: &Value, key: &str) -> T {
    opt_arg(args, key).map_or_else(T::default, |v| {
        serde_json::from_value(v).unwrap_or_else(|e| panic!("query arg '{key}': {e}"))
    })
}

fn arg_req<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> T {
    let raw = args
        .get(key)
        .unwrap_or_else(|| panic!("query step is missing required arg '{key}'"));
    serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("query arg '{key}': {e}"))
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
async fn run_step(pool: &SqlitePool, command: &str, args: &Value) -> Result<RawResult, AppError> {
    Ok(match command {
        "run_advanced_query" => {
            let request: AdvancedQueryRequest = arg_req(args, "request");
            let resp = compile_and_run(pool, request).await?;
            let v = serde_json::to_value(&resp).expect("serialize AdvancedQueryResponse");
            RawResult {
                rows: ids_at(&v, "rows", "id"),
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
                opt_arg(args, "tagFilters").map(|v| serde_json::from_value(v).expect("tagFilters")),
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
            let tag_ids: Option<Vec<String>> =
                opt_arg(args, "tagIds").map(|v| serde_json::from_value(v).expect("tagIds"));
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
        other => panic!(
            "conformance query command '{other}' is not wired in the Rust runner \
             (add an arm in conformance_query.rs and the matching entry in the TS twin)"
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
        node = node.get_mut(*key).expect("cursor path segment");
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
/// `assertUniqueStepNames`, which accumulates into a `Set`. (A step whose
/// `name` is absent or non-string is skipped here; it panics with a clearer
/// message at the point the step is actually run.)
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

/// #3833 item 7/12 — step names must be unique WITHIN a fixture.
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
/// every duplicate in one panic rather than only the first.
fn assert_unique_step_names(steps: &[Value]) {
    let dupes = duplicate_step_names(steps);
    assert!(
        dupes.is_empty(),
        "fixture has duplicate query step name(s) {dupes:?} — every `queries[].name` in a \
         fixture must be unique, or a failure cannot be attributed to the right step."
    );
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

    // #3833 item 7/12 — step names must be unique WITHIN a fixture. The
    // coverage test's positional-alignment guard (`conformance-coverage.
    // test.ts`) compares `recorded.name !== step.name` at the SAME index, so
    // two steps sharing a name still align correctly by position — this is
    // not a correctness hole. It is a DIAGNOSTIC one: every message in this
    // module (`misaligned`, `vacuous`, the branch-coverage errors) names the
    // step by its `name`, and a duplicate makes a failure impossible to
    // attribute to the right step. Checked once, up front, rather than
    // per-step, so the fixture author sees every duplicate in one panic
    // rather than only the first.
    assert_unique_step_names(steps);

    let mut out: Vec<Value> = Vec::with_capacity(steps.len());
    let mut cursors: BTreeMap<String, Option<String>> = BTreeMap::new();
    for step in steps {
        let name = step["name"].as_str().expect("query step name").to_owned();
        let command = step["command"].as_str().expect("query step command");
        let mut args = expand_query_args(step.get("args").unwrap_or(&Value::Null));
        if let Some(from) = step.get("cursor_from").and_then(Value::as_str) {
            let cursor = cursors.get(from).cloned().unwrap_or_else(|| {
                panic!("query step '{name}' reads `cursor_from` '{from}', which is not an EARLIER step in this fixture")
            });
            inject_cursor(command, &mut args, cursor);
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
        let (raw, error) = match run_step(pool, command, &args).await {
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
    const QUERIES_RS: &str = include_str!("../commands/blocks/queries.rs");
    const HARNESS_RS: &str = include_str!("conformance_query.rs");

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
        assert_unique_step_names(&steps(&["a", "b", "c"]));
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
    #[should_panic(expected = "duplicate query step name(s) [\"dup\"]")]
    fn the_assertion_panics_on_a_duplicate() {
        assert_unique_step_names(&steps(&["dup", "other", "dup"]));
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
