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
//!
//! Steps whose sort key is fixture-controlled data (page title, …) set
//! `ordered` and DO compare sequences.

use super::common::pages::list_pages_with_metadata_inner;
use super::common::*;
use super::conformance::seed_label_to_id;
use super::conformance_snapshot::token_key;
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
    RawResult {
        rows: ids_at(v, "items", "id"),
        has_more: v.get("has_more").and_then(Value::as_bool),
        total_count: v.get("total_count").and_then(Value::as_i64),
    }
}

/// Relabel a raw id (or an `a->b` edge token) through the canonical map.
fn relabel_token(token: &str, labels: &BTreeMap<String, String>) -> String {
    if let Some((src, tgt)) = token.split_once("->") {
        return format!(
            "{}->{}",
            labels.get(src).map_or(src, String::as_str),
            labels.get(tgt).map_or(tgt, String::as_str),
        );
    }
    labels
        .get(token)
        .cloned()
        .unwrap_or_else(|| token.to_owned())
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
    for step in steps {
        let name = step["name"].as_str().expect("query step name").to_owned();
        let command = step["command"].as_str().expect("query step command");
        let args = expand_query_args(step.get("args").unwrap_or(&Value::Null));
        let ordered = step
            .get("ordered")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let raw = run_step(pool, command, &args).await;
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
