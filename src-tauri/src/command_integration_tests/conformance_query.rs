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
//! { "name": "…", "rows": ["B2", "B4"], "has_more": false, "total_count": 2 }
//! ```
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
//! The cursor itself is never recorded — it is an opaque per-stack keyset blob,
//! so comparing encodings would prove nothing — but the ROWS of the second page
//! are, and per #3821 that is exactly what a keyset-ordering divergence
//! changes. A single-page step pins nothing about pagination.
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
//! invisible to it. Two distinct reasons, and only the first is benign:
//!
//! 1. When the sort key is the raw block id and the fixture creates blocks
//!    through ops, the ids genuinely differ between the stacks, so their order
//!    is not comparable at all.
//! 2. #3821 — the mock's `run_advanced_query` sorts `b.id ASC` (and paginates
//!    its keyset that way) while the engine's terminal tiebreaker is `b.id
//!    DESC` (`resolve_sort` in `agaric-store/src/query/engine.rs`). This is a
//!    LIVE mock bug, not an incomparability: `query_advanced_filters` queries
//!    only SEED blocks, whose ids are byte-identical on both stacks, so its
//!    order IS comparable — the unordered compare is what stops the fixture
//!    reddening on a real divergence. When #3821 lands, set `"ordered": true`
//!    on the three `run_advanced_query` steps and re-author; the fixture is
//!    already shaped to pin the order.
//! 3. #3873 — `list_tags_for_block` sorts `ORDER BY tag_id` on the backend and
//!    returns `blockTags` INSERTION order on the mock. Same shape as (2):
//!    `query_point_reads_tags`'s `tags_two_surviving_in_id_order` step applies
//!    its two tags in descending id order precisely so the sequences differ,
//!    and flipping it to `"ordered": true` after #3873 lands makes it a real
//!    order pin without touching the fixture's data.
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
    /// The envelope's `next_cursor`, kept OUT of the recorded projection: it is
    /// an opaque per-stack blob (the backend base64s a versioned JSON keyset,
    /// the mock encodes its own), so recording it would compare two encodings
    /// rather than two result sets. It is threaded to the next step instead —
    /// see `cursor_from` in [`run_query_steps`].
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

/// Render one attribute value as a token segment.
///
/// Numbers are printed the way `String(n)` prints them in the TS twin: an
/// integral float loses its `.0` (serde_json renders `f64` 3.0 as `3.0`, JS
/// renders it `3`), so a `value_num` property compares equal on both stacks.
fn attr_value(name: &str, v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "null".to_owned(),
        Some(_) if name == "deleted_at" => DELETED_SENTINEL.to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.as_f64().map_or_else(
            || n.to_string(),
            |f| {
                // `{:.0}` rather than a cast to i64: the value is already
                // integral (`fract() == 0.0`) so nothing is rounded, and it
                // keeps the formatting total instead of relying on a bound.
                if f.fract() == 0.0 && f.abs() < 1e15 {
                    format!("{f:.0}")
                } else {
                    f.to_string()
                }
            },
        ),
        Some(other) => other.to_string(),
    }
}

/// Build `<row[id_key]>#<attr>=<value>…` for one serialized row.
fn row_token(row: &Value, id_key: &str, attrs: &[&str]) -> String {
    let mut token = row
        .get(id_key)
        .and_then(Value::as_str)
        .unwrap_or("<missing-id>")
        .to_owned();
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
    let key = row
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or("<missing-key>");
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
            .map(|(k, row)| format!("{k}->{}", row_token(row, id_key, attrs)))
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
                let rows = rows.as_array().cloned().unwrap_or_default();
                if rows.is_empty() {
                    return vec![format!("{k}->(none)")];
                }
                rows.iter().map(|r| format!("{k}->{}", token(r))).collect()
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
async fn run_step(pool: &SqlitePool, command: &str, args: &Value) -> RawResult {
    match command {
        "run_advanced_query" => {
            let request: AdvancedQueryRequest = arg_req(args, "request");
            let resp = compile_and_run(pool, request)
                .await
                .expect("run_advanced_query");
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
                &arg_or::<SpaceScope>(args, "scope"),
                opt_arg(args, "cursor").and_then(|v| v.as_str().map(str::to_owned)),
                opt_arg(args, "limit").and_then(|v| v.as_i64()),
            )
            .await
            .expect("filtered_blocks_query");
            page_result(&serde_json::to_value(&resp).expect("serialize PageResponse"))
        }
        "list_pages_with_metadata" => {
            let resp = list_pages_with_metadata_inner(
                pool,
                arg_req(args, "filter"),
                opt_arg(args, "cursor").and_then(|v| v.as_str().map(str::to_owned)),
                opt_arg(args, "limit").and_then(|v| v.as_i64()),
            )
            .await
            .expect("list_pages_with_metadata");
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
            .await
            .expect("search_blocks");
            page_result(&serde_json::to_value(&resp).expect("serialize PageResponse"))
        }
        "list_unfinished_tasks" => {
            let resp = list_unfinished_tasks_inner(
                pool,
                arg_req(args, "beforeDate"),
                arg_or(args, "todoStates"),
                opt_arg(args, "cursor").and_then(|v| v.as_str().map(str::to_owned)),
                opt_arg(args, "limit").and_then(|v| v.as_i64()),
                &arg_or::<SpaceScope>(args, "scope"),
            )
            .await
            .expect("list_unfinished_tasks");
            page_result(&serde_json::to_value(&resp).expect("serialize PageResponse"))
        }
        "list_undated_tasks" => {
            let resp = list_undated_tasks_inner(
                pool,
                opt_arg(args, "cursor").and_then(|v| v.as_str().map(str::to_owned)),
                opt_arg(args, "limit").and_then(|v| v.as_i64()),
                &arg_or::<SpaceScope>(args, "scope"),
            )
            .await
            .expect("list_undated_tasks");
            page_result(&serde_json::to_value(&resp).expect("serialize PageResponse"))
        }
        "list_page_links" => {
            let tag_ids: Option<Vec<String>> =
                opt_arg(args, "tagIds").map(|v| serde_json::from_value(v).expect("tagIds"));
            let resp = list_page_links_inner(
                pool,
                &arg_or::<SpaceScope>(args, "scope"),
                tag_ids.as_deref(),
            )
            .await
            .expect("list_page_links");
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
            let space_id = scope
                .require_active()
                .expect("get_journal_page_by_date requires an active scope");
            let row = get_journal_page_by_date_inner(
                pool,
                &arg_req::<String>(args, "date"),
                space_id.as_str(),
            )
            .await
            .expect("get_journal_page_by_date");
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
            let space_id = scope
                .require_active()
                .expect("list_journal_pages_in_range requires an active scope");
            let rows = list_journal_pages_in_range_inner(
                pool,
                &arg_req::<String>(args, "startDate"),
                &arg_req::<String>(args, "endDate"),
                space_id.as_str(),
            )
            .await
            .expect("list_journal_pages_in_range");
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
            let space_id = scope
                .require_active()
                .expect("list_blocks requires an active scope");
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
            .await
            .expect("list_blocks");
            page_result_with(
                &serde_json::to_value(&resp).expect("serialize PageResponse"),
                &|row| row_token(row, "id", BLOCK_ATTRS),
            )
        }
        "get_block" => {
            // `get_block_inner` is the PERMISSIVE reader: it serves a
            // soft-deleted row rather than 404ing on it (the `deleted_at IS
            // NULL` twin is `get_active_block_inner`). A step reading a
            // tombstone is what pins which of the two the command uses.
            let row = get_block_inner(pool, arg_req::<BlockId>(args, "blockId"))
                .await
                .expect("get_block");
            let v = serde_json::to_value(&row).expect("serialize BlockRow");
            RawResult {
                rows: vec![row_token(&v, "id", BLOCK_ATTRS)],
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "get_blocks" => {
            let rows = get_blocks_inner(pool, arg_req::<Vec<BlockId>>(args, "ids"))
                .await
                .expect("get_blocks");
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
                &arg_or::<SpaceScope>(args, "scope"),
            )
            .await
            .expect("batch_resolve");
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
                .await
                .expect("first_child_for_blocks");
            let v = serde_json::to_value(&map).expect("serialize HashMap<String, BlockRow>");
            RawResult {
                rows: map_row_tokens(&v, "id", BLOCK_ATTRS),
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "get_properties" => {
            let rows = get_properties_inner(pool, arg_req::<BlockId>(args, "blockId"))
                .await
                .expect("get_properties");
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
            .await
            .expect("get_property");
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
            let map = get_batch_properties_inner(pool, arg_req::<Vec<BlockId>>(args, "blockIds"))
                .await
                .expect("get_batch_properties");
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
            let rows = list_tags_for_block_inner(pool, arg_req::<BlockId>(args, "blockId"))
                .await
                .expect("list_tags_for_block");
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
                    .await
                    .expect("list_inherited_tags_for_block");
            RawResult {
                rows: scalar_tokens(&serde_json::to_value(&rows).expect("serialize Vec<String>")),
                has_more: None,
                total_count: None,
                next_cursor: None,
            }
        }
        "load_page_subtree" => {
            let scope: SpaceScope = arg_req(args, "scope");
            let space_id = scope
                .require_active()
                .expect("load_page_subtree requires an active scope");
            let subtree = load_page_subtree_inner(
                pool,
                &arg_req::<String>(args, "rootBlockId"),
                space_id.as_str(),
            )
            .await
            .expect("load_page_subtree");
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
    }
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
        // `list_blocks` nests every query param under the `request` DTO.
        "list_blocks" => &["request", "cursor"],
        _ => &["cursor"],
    }
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

        let raw = run_step(pool, command, &args).await;
        cursors.insert(name.clone(), raw.next_cursor.clone());
        let mut rows: Vec<String> = raw.rows.iter().map(|t| relabel_token(t, labels)).collect();
        if !ordered {
            // Set comparison, not sequence comparison — see "Ordering" in the
            // module docs. Known cost today: #3821 (mock `run_advanced_query`
            // orders `b.id ASC`, engine `b.id DESC`) is invisible here.
            rows.sort_by_key(|t| token_key(t));
        }
        out.push(json!({
            "name": name,
            "rows": rows,
            "has_more": raw.has_more,
            "total_count": raw.total_count,
        }));
    }
    Value::Array(out)
}
