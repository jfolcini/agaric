use super::*;
use crate::commands::tests::common::TEST_SPACE_ID;
use crate::commands::{create_block_inner, create_space_inner};
use crate::db::init_pool;
use crate::materializer::Materializer;
use crate::mcp::actor::Actor;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

const DEV: &str = "test-mcp-dev";

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// FEAT-3p5: create a single space and return its ULID. Used by the
/// journal_for_date MCP tests so the per-space lookup has a valid
/// space to scope under.
async fn mk_space(pool: &SqlitePool, name: &str) -> String {
    let materializer = Materializer::new(pool.clone());
    create_space_inner(pool, DEV, &materializer, name.into(), None)
        .await
        .expect("create_space must succeed")
        .into_string()
}

fn test_ctx() -> ActorContext {
    ActorContext {
        actor: Actor::Agent {
            name: "test-agent".to_string(),
        },
        request_id: "req-test".to_string(),
    }
}

async fn mk_tools() -> (ReadOnlyTools, Materializer, TempDir) {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // M-82: `init_pool` returns a single combined pool, so reuse it
    // for both the reader and writer slots in this fixture. The
    // production wiring uses split `init_pools` semantics; the
    // dedicated `tests_m82` block below exercises that path.
    let tools = ReadOnlyTools::new(pool.clone(), pool, mat.clone(), DEV.to_string());
    (tools, mat, dir)
}

async fn settle(mat: &Materializer) {
    mat.flush_background().await.unwrap();
}

// -------------------------------------------------------------------
// list_tools — snapshot of the 10-tool wire contract
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tools_advertises_ten_tools() {
    let (tools, _mat, _dir) = mk_tools().await;
    let descs = tools.list_tools();
    let names: Vec<&str> = descs.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(
        names.len(),
        10,
        "ReadOnlyTools exposes exactly ten tools (v1 nine + #633 list_spaces)"
    );
    assert_eq!(
        names,
        vec![
            "list_pages",
            "get_page",
            "search",
            "get_block",
            "list_backlinks",
            "list_tags",
            "list_property_defs",
            "get_agenda",
            "journal_for_date",
            "list_spaces",
        ],
        "tool order is part of the wire contract — do not re-order (new tools append)",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_tool_descriptions() {
    // Snapshot the full list_tools() response — any accidental change
    // to names / descriptions / input schemas will break CI.
    let (tools, _mat, _dir) = mk_tools().await;
    let descs = tools.list_tools();
    // Use `to_value` so camelCase `inputSchema` is visible in the snap.
    let wire: Value = serde_json::to_value(&descs).unwrap();
    insta::assert_yaml_snapshot!("tool_descriptions", wire);
}

// -------------------------------------------------------------------
// MAINT-150 (d) PARTIAL — schema/struct equivalence
//
// The full fix would derive `JsonSchema` via `schemars` on each
// `*Args` struct so the tool description's `inputSchema` is
// auto-generated, eliminating drift. That is a meaningful design
// change requiring user approval (extra dependency + a re-derive on
// every `*Args` struct), so it is DEFERRED.
//
// As a partial / starting point, the following tests pin the link
// between the hand-authored `json!` schema and the typed `*Args`
// struct for two representative tools (one trivial, one with
// multiple optional fields). Drift between schema and struct will
// fail one of these asserts:
//
//   - The struct must successfully `serde_json::from_value` a
//     payload built from the schema's `required` list.
//   - Every property advertised in the schema's `properties` must
//     deserialise into the struct without an `unknown_fields`
//     rejection (the structs use `deny_unknown_fields`).
//
// The asserts below cover `list_pages` (no required fields, two
// optional) and `get_block` (one required field, no optional). When
// schemars lands these can be removed in favour of the
// auto-generated schema.
// -------------------------------------------------------------------
#[test]
fn list_pages_schema_matches_args_struct() {
    let desc = tool_desc_list_pages();
    let schema = &desc.input_schema;
    let props = schema
        .get("properties")
        .and_then(|p| p.as_object())
        .expect("inputSchema has properties object");
    let prop_names: Vec<&str> = props.keys().map(String::as_str).collect();

    // Every property advertised in the schema must round-trip
    // through `ListPagesArgs` without `deny_unknown_fields` firing.
    // The schema has no required fields — an empty object must
    // deserialize cleanly (no required-field rejection).
    let empty: ListPagesArgs = serde_json::from_value(json!({}))
        .expect("ListPagesArgs accepts an empty object (all fields optional)");
    let _ = empty;

    // Build a concrete payload using every property the schema
    // advertises. If the struct lacks one of these fields, this
    // would parse but lose data; if the struct has additional
    // fields, those would be required (currently they are all
    // `Option<T>` with `#[serde(default)]`, so this stays valid).
    let mut payload = serde_json::Map::new();
    for &name in &prop_names {
        // Pick a value-shape that matches the schema's declared
        // type. Both fields here are typed (`string` and
        // `integer`); extending the test would need a small type
        // mapper.
        let ty = props[name]["type"].as_str().expect("each prop has a type");
        let value = match ty {
            "string" => json!("placeholder"),
            "integer" => json!(1),
            other => panic!("list_pages schema grew an unexpected type: {other}"),
        };
        payload.insert(name.to_string(), value);
    }
    let parsed: ListPagesArgs = serde_json::from_value(Value::Object(payload))
        .expect("ListPagesArgs accepts every property the schema advertises");
    assert_eq!(parsed.cursor.as_deref(), Some("placeholder"));
    assert_eq!(parsed.limit, Some(1));

    // The schema must not advertise `additionalProperties: true`
    // (struct uses `deny_unknown_fields`) — pin that here so a
    // future schema edit cannot silently drift.
    assert_eq!(
        schema.get("additionalProperties"),
        Some(&Value::Bool(false)),
        "list_pages schema must mirror `deny_unknown_fields` with additionalProperties: false",
    );
}

#[test]
fn get_block_schema_matches_args_struct() {
    let desc = tool_desc_get_block();
    let schema = &desc.input_schema;
    let required: Vec<&str> = schema
        .get("required")
        .and_then(|r| r.as_array())
        .expect("get_block inputSchema declares required[]")
        .iter()
        .map(|v| v.as_str().expect("required entries are strings"))
        .collect();
    assert_eq!(
        required,
        vec!["block_id"],
        "get_block schema requires exactly the `block_id` field",
    );

    // A payload that omits `block_id` must fail deserialization
    // (the struct field is non-optional).
    let missing: Result<GetBlockArgs, _> = serde_json::from_value(json!({}));
    assert!(
        missing.is_err(),
        "GetBlockArgs must reject an empty object — required field missing",
    );

    // A payload that includes `block_id` deserializes cleanly.
    let parsed: GetBlockArgs = serde_json::from_value(json!({"block_id": "abc"}))
        .expect("GetBlockArgs accepts a payload with block_id");
    assert_eq!(parsed.block_id, "abc");

    // A payload with an unknown property must be rejected by
    // `deny_unknown_fields` — pinning the schema/struct contract
    // even when the schema's `additionalProperties: false` is the
    // wire contract.
    let stray: Result<GetBlockArgs, _> =
        serde_json::from_value(json!({"block_id": "abc", "extra": 1}));
    assert!(
        stray.is_err(),
        "GetBlockArgs must reject unknown fields (deny_unknown_fields)",
    );
    assert_eq!(
        schema.get("additionalProperties"),
        Some(&Value::Bool(false)),
        "get_block schema must mirror `deny_unknown_fields` with additionalProperties: false",
    );
}

// -------------------------------------------------------------------
// Happy + error path per tool (9 × 2 = 18 tests)
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_pages_happy_path_returns_pages_only() {
    let (tools, mat, _dir) = mk_tools().await;
    // Create 3 pages + 1 non-page block — list_pages must ignore the
    // non-page block.
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "P1".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "P2".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "P3".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "x".into(),
        None,
        Some(4),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool("list_pages", json!({}), &test_ctx())
        .await
        .expect("happy path");
    let items = result["items"].as_array().expect("items array");
    assert_eq!(items.len(), 3, "list_pages returns exactly the three pages");
    for item in items {
        assert_eq!(item["block_type"], "page");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_pages_rejects_unknown_field() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool("list_pages", json!({"bogus": 1}), &test_ctx())
        .await
        .expect_err("must reject unknown field");
    assert!(
        matches!(err, AppError::Validation(_)),
        "unknown-field must surface as AppError::Validation (→ -32602), got {err:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_happy_path_returns_subtree() {
    let (tools, mat, _dir) = mk_tools().await;
    let page = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "P".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let child1 = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "c1".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    let _grandchild = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "g1".into(),
        Some(child1.id),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    // FEAT-3 Phase 7 — MCP `handle_get_page` looks up the page's own
    // `space` property and threads it through `get_page_inner`. Run
    // bootstrap so the page lands in Personal via the back-fill sweep.
    crate::spaces::bootstrap_spaces_for_test(&tools.pool, DEV)
        .await
        .unwrap();

    let result = tools
        .call_tool("get_page", json!({"page_id": page.id.clone()}), &test_ctx())
        .await
        .expect("happy path");
    assert_eq!(result["page"]["id"], page.id.as_str());
    let children = result["children"].as_array().expect("children array");
    assert_eq!(
        children.len(),
        2,
        "get_page returns full subtree (child + grandchild), not just direct children",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_not_found_returns_not_found() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "get_page",
            json!({"page_id": "NONEXISTENT_ULID_01HZ"}),
            &test_ctx(),
        )
        .await
        .expect_err("unknown page must error");
    assert!(
        matches!(err, AppError::NotFound(_)),
        "missing page must surface as AppError::NotFound (→ -32001), got {err:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_on_non_page_block_validation_error() {
    let (tools, mat, _dir) = mk_tools().await;
    let page = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "P".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let content = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "c".into(),
        Some(page.id),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let err = tools
        .call_tool("get_page", json!({"page_id": content.id}), &test_ctx())
        .await
        .expect_err("non-page block must error");
    assert!(
        matches!(err, AppError::Validation(_)),
        "non-page must surface as Validation (→ -32602), got {err:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_happy_path_returns_matches() {
    let (tools, mat, _dir) = mk_tools().await;
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "needle in the haystack".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "just hay".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let result = tools
        .call_tool(
            "search",
            json!({"query": "needle", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    let items = result["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "exactly one hit for 'needle'");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_missing_query_returns_validation() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool("search", json!({"space_id": TEST_SPACE_ID}), &test_ctx())
        .await
        .expect_err("missing query must fail");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

// -------------------------------------------------------------------
// L-119: explicit `limit` validation (rejects out-of-range values
// instead of silently clamping). Six tools advertise a min/max in
// their input schema; cover them parametrically.
// -------------------------------------------------------------------

/// Parametric expectations for every tool that gates `limit`
/// against an advertised `[1, cap]` range. `base_args` carries the
/// rest of each tool's required fields; the test merges a
/// `"limit"` field in.
fn limit_validation_cases() -> Vec<(&'static str, i64, Value)> {
    vec![
        (TOOL_LIST_PAGES, LIST_RESULT_CAP, json!({})),
        // page_id need not exist — `validate_limit` runs before
        // the inner lookup, so out-of-range cases fire before any
        // NotFound is possible.
        (TOOL_GET_PAGE, LIST_RESULT_CAP, json!({"page_id": "ANY"})),
        (
            TOOL_SEARCH,
            SEARCH_RESULT_CAP,
            json!({"query": "needle", "space_id": TEST_SPACE_ID}),
        ),
        (
            TOOL_LIST_BACKLINKS,
            LIST_RESULT_CAP,
            json!({"block_id": "ANY"}),
        ),
        (TOOL_LIST_TAGS, LIST_RESULT_CAP, json!({})),
        (
            TOOL_GET_AGENDA,
            AGENDA_RESULT_CAP,
            json!({"start_date": "2025-01-01", "end_date": "2025-01-02"}),
        ),
    ]
}

fn args_with_limit(base: &Value, limit: i64) -> Value {
    let mut obj = base.as_object().expect("base_args is an object").clone();
    obj.insert("limit".into(), json!(limit));
    Value::Object(obj)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn limit_validation_rejects_zero_and_above_cap() {
    let (tools, _mat, _dir) = mk_tools().await;
    for (tool, cap, base_args) in limit_validation_cases() {
        for bad in [0i64, cap + 1] {
            let args = args_with_limit(&base_args, bad);
            let result = tools.call_tool(tool, args, &test_ctx()).await;
            match result {
                Err(AppError::Validation(msg)) => {
                    assert!(
                        msg.contains(tool),
                        "{tool}: error message must name the tool — got {msg:?}",
                    );
                    assert!(
                        msg.contains(&cap.to_string()),
                        "{tool}: error message must name the cap {cap} — got {msg:?}",
                    );
                    assert!(
                        msg.contains(&bad.to_string()),
                        "{tool}: error message must echo the offending value {bad} — got {msg:?}",
                    );
                }
                other => panic!(
                    "{tool}: limit={bad} (cap={cap}) must return AppError::Validation, got {other:?}",
                ),
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn limit_validation_accepts_boundary() {
    let (tools, _mat, _dir) = mk_tools().await;
    for (tool, cap, base_args) in limit_validation_cases() {
        let args = args_with_limit(&base_args, cap);
        let result = tools.call_tool(tool, args, &test_ctx()).await;
        // Boundary value must NOT trip the L-119 validation. The
        // inner handler may still legitimately surface another
        // error (e.g. NotFound when `page_id`/`block_id` is a
        // placeholder, or a different Validation for an invalid
        // ULID) — only the L-119 message pattern is the regression
        // signal here.
        if let Err(AppError::Validation(msg)) = &result {
            assert!(
                !msg.contains("limit must be in"),
                "{tool}: limit={cap} (boundary) tripped L-119 validation: {msg}",
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_truncates_long_content() {
    let (tools, mat, _dir) = mk_tools().await;
    let long: String = "needle ".to_string() + &"x".repeat(2000);
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        long,
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let result = tools
        .call_tool(
            "search",
            json!({"query": "needle", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    let items = result["items"].as_array().expect("items");
    assert_eq!(items.len(), 1);
    let content = items[0]["content"].as_str().unwrap_or("");
    assert!(
        content.chars().count() <= SEARCH_SNIPPET_CAP,
        "content must be truncated to {} chars, got {}",
        SEARCH_SNIPPET_CAP,
        content.chars().count(),
    );
}

/// P4 (#346) — the MCP `search` path truncates `content` at the DB
/// (`search_blocks_inner(.., Some(SEARCH_SNIPPET_CAP))`), while the FE/IPC
/// path (`search_blocks_inner(.., None)`) returns the FULL block content.
/// This pins the path-dependent contract: the same block yields a
/// `SEARCH_SNIPPET_CAP`-codepoint snippet via the tool but its complete
/// body via the cursor command.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_snippet_len_truncates_mcp_but_not_fe_path() {
    use crate::commands::queries::search_blocks_inner;

    let (tools, mat, _dir) = mk_tools().await;
    // Body well past the cap so truncation is observable; the literal
    // "needle" anchors the FTS match at the very start.
    let full_len = SEARCH_SNIPPET_CAP + 1500;
    let body: String = "needle ".to_string() + &"x".repeat(full_len);
    let body_chars = body.chars().count();
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        body,
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    // MCP path — Some(SEARCH_SNIPPET_CAP): content truncated at the DB.
    let mcp = tools
        .call_tool(
            "search",
            json!({"query": "needle", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect("MCP search happy path");
    let mcp_items = mcp["items"].as_array().expect("items");
    assert_eq!(mcp_items.len(), 1, "exactly one block matches");
    let mcp_content = mcp_items[0]["content"].as_str().unwrap_or("");
    assert_eq!(
        mcp_content.chars().count(),
        SEARCH_SNIPPET_CAP,
        "MCP path must truncate content to exactly SEARCH_SNIPPET_CAP codepoints",
    );

    // FE/IPC path — None: full content returned, byte-identical.
    let fe = search_blocks_inner(
        &tools.pool,
        "needle".into(),
        None,
        Some(SEARCH_RESULT_CAP),
        crate::commands::SearchFilter {
            space_id: Some(TEST_SPACE_ID.into()),
            ..Default::default()
        },
        None,
    )
    .await
    .expect("FE search happy path");
    assert_eq!(fe.items.len(), 1, "exactly one block matches");
    let fe_content = fe.items[0].content.as_deref().unwrap_or("");
    assert_eq!(
        fe_content.chars().count(),
        body_chars,
        "FE path (snippet_len = None) must return the FULL block content untruncated",
    );
    assert!(
        fe_content.chars().count() > SEARCH_SNIPPET_CAP,
        "sanity: full content must exceed the MCP cap so the two paths differ",
    );
}

/// Truncation on multibyte (emoji) content — a byte-based truncation bug
/// would split a 4-byte codepoint and produce invalid UTF-8 or an incorrect
/// char count.  This test builds a body that is entirely 4-byte emoji so the
/// char count and byte count diverge maximally, then verifies that the MCP
/// `search` path:
///   1. returns at most SEARCH_SNIPPET_CAP chars (not silently over-counted),
///   2. does not truncate to the empty string, and
///   3. returns valid UTF-8 (no split codepoints).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_truncates_multibyte_content_safely() {
    let (tools, mat, _dir) = mk_tools().await;

    // "needle" at the front so FTS matches, then a wall of 4-byte emoji that
    // pushes the body well past SEARCH_SNIPPET_CAP chars.
    let emoji_body: String = "needle ".to_string() + &"🔥".repeat(SEARCH_SNIPPET_CAP + 100);

    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        emoji_body,
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let result = tools
        .call_tool(
            "search",
            json!({"query": "needle", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect("happy path for multibyte truncation test");

    let items = result["items"].as_array().expect("items array");
    assert_eq!(items.len(), 1, "exactly one block should match");

    let content = items[0]["content"].as_str().unwrap_or("");

    // 1. Char count must be bounded.
    assert!(
        content.chars().count() <= SEARCH_SNIPPET_CAP,
        "multibyte content must be truncated to at most {} chars, got {}",
        SEARCH_SNIPPET_CAP,
        content.chars().count(),
    );

    // 2. Must not be over-truncated to nothing.
    assert!(
        !content.is_empty(),
        "truncation must not produce an empty snippet",
    );

    // 3. Must be valid UTF-8 (no split codepoints).
    assert!(
        std::str::from_utf8(content.as_bytes()).is_ok(),
        "truncated multibyte content must be valid UTF-8",
    );
}

// -------------------------------------------------------------------
// PEND-65 — MCP `search` tool: `filter` arg threads through to
// `SearchFilter`. The structured-filter shape mirrors the Tauri
// command surface; the inline `tag:` / `state:` / `prop:` syntax is
// NOT parsed at the MCP boundary (agents pass structured args).
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_filter_omitted_preserves_pre_pend65_behavior() {
    // No `filter` arg = the wide query (every match across content)
    // exactly as before PEND-65.
    let (tools, mat, _dir) = mk_tools().await;
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "needle one".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "needle two".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let result = tools
        .call_tool(
            "search",
            json!({"query": "needle", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    let items = result["items"].as_array().expect("items");
    assert_eq!(items.len(), 2, "both blocks match without filter");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_filter_state_narrows_results() {
    let (tools, mat, _dir) = mk_tools().await;
    let b1 = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "needle TODO row".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let _b2 = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "needle done row".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    // Promote b1 to todo_state = 'TODO' so the state_filter narrows
    // to it. `create_block_inner` does not take state/priority, so a
    // direct UPDATE is the simplest fixture path here (no
    // user-visible API exposed for this in v1).
    sqlx::query("UPDATE blocks SET todo_state = 'TODO' WHERE id = ?")
        .bind(b1.id.as_str())
        .execute(&tools.pool)
        .await
        .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let result = tools
        .call_tool(
            "search",
            json!({
                "query": "needle",
                "space_id": TEST_SPACE_ID,
                "filter": { "state_filter": ["TODO"] },
            }),
            &test_ctx(),
        )
        .await
        .expect("filter must narrow not error");
    let items = result["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "only the TODO block survives");
    assert_eq!(items[0]["id"].as_str().unwrap(), b1.id.as_str());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_filter_excluded_state_includes_no_state_rows() {
    // PEND-63 fields exposed through MCP: `excluded_state_filter`
    // with NULL-inclusive inversion.
    let (tools, mat, _dir) = mk_tools().await;
    let b_done = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "needle done row".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let _b_nostate = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "needle nostate row".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE blocks SET todo_state = 'DONE' WHERE id = ?")
        .bind(b_done.id.as_str())
        .execute(&tools.pool)
        .await
        .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let result = tools
        .call_tool(
            "search",
            json!({
                "query": "needle",
                "space_id": TEST_SPACE_ID,
                "filter": { "excluded_state_filter": ["DONE"] },
            }),
            &test_ctx(),
        )
        .await
        .expect("excluded_state must narrow");
    let items = result["items"].as_array().expect("items");
    let ids: Vec<&str> = items.iter().map(|i| i["id"].as_str().unwrap()).collect();
    assert!(!ids.contains(&b_done.id.as_str()), "DONE excluded");
    assert_eq!(ids.len(), 1, "only the no-state block survives");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_filter_property_filters_threaded_through() {
    // PEND-53 property_filters + PEND-64 four-column matching ride
    // through the MCP wire. Numeric value matches `value_num`.
    let (tools, mat, _dir) = mk_tools().await;
    let b1 = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "needle priority row".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_properties (block_id, key, value_num) VALUES (?, 'score', 1.0)")
        .bind(b1.id.as_str())
        .execute(&tools.pool)
        .await
        .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let result = tools
        .call_tool(
            "search",
            json!({
                "query": "needle",
                "space_id": TEST_SPACE_ID,
                "filter": {
                    "property_filters": [{ "key": "score", "value": "1" }],
                },
            }),
            &test_ctx(),
        )
        .await
        .expect("property filter must narrow");
    let items = result["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "value_num=1.0 matched by prop:score=1");
    assert_eq!(items[0]["id"].as_str().unwrap(), b1.id.as_str());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_filter_unknown_field_rejected() {
    // `deny_unknown_fields` on `SearchFilterArgs` keeps the MCP
    // boundary strict — a typo in an agent's call surfaces as a
    // validation error, not a silent no-op.
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "search",
            json!({
                "query": "anything",
                "space_id": TEST_SPACE_ID,
                "filter": { "not_a_real_filter": true },
            }),
            &test_ctx(),
        )
        .await
        .expect_err("unknown filter field must fail validation");
    assert!(
        matches!(err, AppError::Validation(_)),
        "got {err:?} — expected AppError::Validation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_happy_path() {
    let (tools, mat, _dir) = mk_tools().await;
    let blk = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "hello".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "get_block",
            json!({"block_id": blk.id.clone()}),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["id"], blk.id.as_str());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_not_found_error() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "get_block",
            json!({"block_id": "NONEXISTENT_ID"}),
            &test_ctx(),
        )
        .await
        .expect_err("unknown block must error");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

/// L-121: lowercase ULIDs supplied by the agent at the MCP boundary
/// must be uppercased by `normalize_ulid_arg` before the lookup hits
/// SQLite (whose default `=` is case-sensitive). Without the
/// normalisation, this test would surface as `NotFound`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_accepts_lowercase_ulid_l121() {
    let (tools, mat, _dir) = mk_tools().await;
    let blk = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "hello-lower".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Agaric returns uppercase ULIDs; the agent supplies the
    // *lowercase* form to exercise the L-121 boundary normalisation.
    let lower = blk.id.as_str().to_lowercase();
    assert_ne!(
        lower, blk.id,
        "test setup: block id must not already be all-lowercase"
    );

    let result = tools
        .call_tool("get_block", json!({"block_id": lower}), &test_ctx())
        .await
        .expect("lowercase ULID must be accepted at the MCP boundary (L-121)");
    assert_eq!(
        result["id"],
        blk.id.as_str(),
        "response must contain the canonical uppercase id, not the input"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_backlinks_happy_path() {
    let (tools, mat, _dir) = mk_tools().await;
    let target = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // No sources yet → empty grouped response, not an error.
    let result = tools
        .call_tool(
            "list_backlinks",
            json!({"block_id": target.id}),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    // `list_backlinks_grouped_inner` returns a GroupedBacklinkResponse
    // shaped `{ groups: [], next_cursor, has_more, total_count, ... }`.
    // Assert the full envelope contract, not just "it's an object" — a
    // handler that returned `{}` or a raw array would pass a bare
    // `is_object()` check but break every downstream consumer.
    assert!(result.is_object(), "response is a JSON object");
    let groups = result
        .get("groups")
        .and_then(|v| v.as_array())
        .expect("response.groups[] array");
    assert!(groups.is_empty(), "no sources seeded → groups empty");
    assert!(
        result.get("next_cursor").is_some(),
        "response.next_cursor field present (nullable)",
    );
    assert_eq!(
        result.get("has_more").and_then(serde_json::Value::as_bool),
        Some(false),
        "no results → has_more must be false",
    );
    assert_eq!(
        result
            .get("total_count")
            .and_then(serde_json::Value::as_u64),
        Some(0),
        "no results → total_count must be 0",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_backlinks_missing_block_id_validation() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool("list_backlinks", json!({}), &test_ctx())
        .await
        .expect_err("missing block_id");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

/// PEND-18 Phase 2 parity test: the post-migration handler builds
/// [`SpaceScope::Global`] from the JSON-side `space_id: null` (or omitted).
/// Asserts that calling the MCP `list_backlinks` tool with that input
/// returns the same `GroupedBacklinkResponse` envelope as a direct call to
/// the migrated [`list_backlinks_grouped_inner`] passing
/// [`SpaceScope::Global`] explicitly. Pre-migration the handler passed
/// `None` for the `Option<String>` parameter; post-migration it passes
/// `&SpaceScope::Global`. Both encode "no space filter" — this test
/// pins behavioural parity across the migration boundary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_backlinks_global_scope_parity() {
    use crate::commands::list_backlinks_grouped_inner;
    use crate::space::SpaceScope;

    let (tools, mat, _dir) = mk_tools().await;
    let target = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Path A: through the MCP handler with `space_id: null` — the
    // handler builds `SpaceScope::Global` internally.
    let via_handler = tools
        .call_tool(
            "list_backlinks",
            json!({"block_id": target.id, "space_id": null}),
            &test_ctx(),
        )
        .await
        .expect("handler call must succeed");

    // Path B: direct call to the migrated `_inner` with the same scope.
    let via_inner = list_backlinks_grouped_inner(
        &tools.pool,
        target.id.clone(),
        None,
        None,
        None,
        None,
        &SpaceScope::Global,
    )
    .await
    .expect("inner call must succeed");
    let via_inner_json = serde_json::to_value(&via_inner).expect("inner serialises");

    assert_eq!(
        via_handler, via_inner_json,
        "handler `space_id: null` must produce the same envelope as a direct \
         `&SpaceScope::Global` call to `list_backlinks_grouped_inner`"
    );

    // Path C: omitted `space_id` defaults to `None` → `SpaceScope::Global`
    // by the same handler match. Re-checks the parity for the "field absent"
    // wire shape.
    let via_handler_omitted = tools
        .call_tool(
            "list_backlinks",
            json!({"block_id": target.id}),
            &test_ctx(),
        )
        .await
        .expect("handler call must succeed (space_id omitted)");
    assert_eq!(
        via_handler_omitted, via_inner_json,
        "handler with omitted `space_id` must match `&SpaceScope::Global` parity"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_happy_path() {
    let (tools, mat, _dir) = mk_tools().await;
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "tag".into(),
        "work".into(),
        None,
        None,
    )
    .await
    .unwrap();
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "tag".into(),
        "home".into(),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool("list_tags", json!({}), &test_ctx())
        .await
        .expect("happy path");
    // M-85: response is a `PageResponse { items, next_cursor, has_more }`
    // rather than a flat array.
    let arr = result["items"].as_array().expect("tag items array");
    assert_eq!(arr.len(), 2, "two tags returned");
    assert!(
        result["next_cursor"].is_null(),
        "two-tag fixture under default limit must not paginate (got {result:?})",
    );
    assert_eq!(
        result["has_more"],
        json!(false),
        "two-tag fixture under default limit must report has_more=false",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_rejects_unknown_field() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool("list_tags", json!({"prefix": "w"}), &test_ctx())
        .await
        .expect_err("prefix is not a valid arg for list_tags");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_property_defs_happy_path() {
    // L-115: a fresh DB ships built-in property definitions seeded by
    // migrations. The exact wire shape is snapshot-locked by
    // `tool_response_list_property_defs.snap`; this test just pins
    // (a) a stable subset of must-be-present keys (the four reserved
    // keys named in AGENTS.md "Architectural Stability — properties
    // system", which any future migration must preserve), and
    // (b) cross-checks the response count against the live
    // `property_definitions` table so adding/removing seeded defs
    // does not silently desync this assertion from reality.
    let (tools, _mat, _dir) = mk_tools().await;
    // M-85: under the default page limit (`MAX_PAGE_SIZE = 200`) all
    // seeded definitions fit on a single page, so we still see them
    // all. The response is now a `PageResponse { items, next_cursor,
    // has_more }` rather than a flat array.
    let result = tools
        .call_tool("list_property_defs", json!({}), &test_ctx())
        .await
        .expect("happy path");
    let arr = result["items"].as_array().expect("defs items array");

    // (a) Stable subset — these four are the reserved-column keys
    //     enumerated by `op::is_reserved_property_key` and must
    //     ship in every Agaric build (they back columns on the
    //     `blocks` table directly).
    let actual_keys: std::collections::HashSet<&str> = arr
        .iter()
        .map(|v| v["key"].as_str().expect("each def has a 'key' string"))
        .collect();
    for required in ["todo_state", "priority", "due_date", "scheduled_date"] {
        assert!(
            actual_keys.contains(required),
            "required reserved-property key {required:?} missing from list_property_defs; \
             got {actual_keys:?}",
        );
    }

    // (b) Cross-check against the live DB so this test detects
    //     drift in either direction (added or removed migrations)
    //     without requiring a hand-edited count constant.
    let live_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM property_definitions")
        .fetch_one(&tools.pool)
        .await
        .expect("count property_definitions");
    assert_eq!(
        i64::try_from(arr.len()).expect("test response length fits i64"),
        live_count,
        "list_property_defs response count must match live property_definitions row count",
    );
    // Seeded defaults fit under the default limit — no second page.
    assert!(
        result["next_cursor"].is_null(),
        "seeded defaults fit under the default limit; expected no next_cursor (got {result:?})",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_property_defs_rejects_unknown_field() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool("list_property_defs", json!({"key": "x"}), &test_ctx())
        .await
        .expect_err("any arg is an error");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_agenda_happy_path() {
    let (tools, _mat, _dir) = mk_tools().await;
    let result = tools
        .call_tool(
            "get_agenda",
            json!({"start_date": "2025-01-01", "end_date": "2025-01-31"}),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    // M-25: `get_agenda` now returns a `PageResponse` shape rather
    // than a flat array. The empty DB has zero entries, so `items`
    // is the empty array and `has_more` is false.
    let items = result["items"].as_array().expect("agenda items array");
    assert_eq!(items.len(), 0, "empty DB has zero agenda entries");
    assert_eq!(result["has_more"], false);
    assert!(result["next_cursor"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_agenda_invalid_date_returns_validation() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "get_agenda",
            json!({"start_date": "not-a-date", "end_date": "2025-01-31"}),
            &test_ctx(),
        )
        .await
        .expect_err("invalid date");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn journal_for_date_happy_path_creates_page() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "Personal").await;
    let result = tools
        .call_tool(
            "journal_for_date",
            json!({"date": "2025-06-15", "space_id": space}),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["block_type"], "page");
    assert_eq!(result["content"], "2025-06-15");
    // Second call must return the same page id (idempotent).
    let first_id = result["id"].as_str().expect("id present").to_string();
    settle(&mat).await;
    let again = tools
        .call_tool(
            "journal_for_date",
            json!({"date": "2025-06-15", "space_id": space}),
            &test_ctx(),
        )
        .await
        .expect("second call");
    assert_eq!(
        again["id"].as_str(),
        Some(first_id.as_str()),
        "journal_for_date is idempotent",
    );
}

/// PEND-26 N4 — the `journal_for_date` tool lives in the read-only
/// group but emits a `CreateBlock` op on first read-of-the-day. Pin
/// the wire-visible description so it leads with that side-effect
/// and names the op type, so MCP agents skimming descriptions for
/// rollback / transactional purposes do not classify it as a pure
/// read.
#[test]
fn journal_for_date_description_advertises_create_side_effect() {
    let desc = tool_desc_journal_for_date();
    let text = &desc.description;
    assert!(
        text.starts_with("Creates the page"),
        "description must lead with the create side-effect, got {text:?}",
    );
    assert!(
        text.contains("CreateBlock"),
        "description must name the op type so agents recognise the write, got {text:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn journal_for_date_invalid_date_validation() {
    let (tools, _mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "Personal").await;
    let err = tools
        .call_tool(
            "journal_for_date",
            json!({"date": "2025-13-99", "space_id": space}),
            &test_ctx(),
        )
        .await
        .expect_err("invalid date");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

// -------------------------------------------------------------------
// #633 — list_spaces
// -------------------------------------------------------------------

/// #633 happy path: the seeded Personal + Work spaces surface as
/// `{ id, name, is_default }` rows, alphabetical by name, with
/// `is_default` marking exactly the Personal space.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_spaces_happy_path_returns_spaces_with_default_flag() {
    let (tools, _mat, _dir) = mk_tools().await;
    // Seed the two canonical spaces (Personal carries the reserved
    // SPACE_PERSONAL_ULID, which is what `is_default` keys on).
    crate::spaces::bootstrap_spaces_for_test(&tools.pool, DEV)
        .await
        .unwrap();

    let result = tools
        .call_tool("list_spaces", json!({}), &test_ctx())
        .await
        .expect("happy path");
    let rows = result.as_array().expect("list_spaces returns a JSON array");
    assert_eq!(rows.len(), 2, "bootstrap seeds exactly two spaces");

    let names: Vec<&str> = rows
        .iter()
        .map(|r| r["name"].as_str().expect("name string"))
        .collect();
    assert_eq!(names, vec!["Personal", "Work"], "alphabetical by name");

    let personal = &rows[0];
    assert_eq!(
        personal["id"].as_str(),
        Some(crate::spaces::SPACE_PERSONAL_ULID),
        "Personal carries the reserved seeded ULID",
    );
    assert_eq!(
        personal["is_default"],
        json!(true),
        "Personal is the default space",
    );
    assert_eq!(
        rows[1]["is_default"],
        json!(false),
        "non-Personal spaces are not default",
    );

    // The discovery loop the issue describes: a space id returned by
    // list_spaces must be directly usable as the `space_id` argument
    // of a space-requiring tool.
    let space_id = personal["id"].as_str().unwrap().to_string();
    let journal = tools
        .call_tool(
            "journal_for_date",
            json!({"date": "2025-03-03", "space_id": space_id}),
            &test_ctx(),
        )
        .await
        .expect("a list_spaces id must satisfy a space_id-requiring tool");
    assert_eq!(journal["block_type"], "page");
}

/// #633 error path: strict boundary — unknown fields are rejected with
/// a Validation error (→ -32602), same as every other tool.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_spaces_rejects_unknown_field() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool("list_spaces", json!({"bogus": 1}), &test_ctx())
        .await
        .expect_err("must reject unknown field");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

/// #633: a soft-deleted space block keeps its registry row (0089
/// semantics) but must NOT surface from list_spaces — liveness is the
/// standard `blocks.deleted_at IS NULL` predicate.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_spaces_excludes_soft_deleted_space() {
    let (tools, mat, _dir) = mk_tools().await;
    let keep = mk_space(&tools.pool, "Keep").await;
    let doomed = mk_space(&tools.pool, "Doomed").await;
    settle(&mat).await;
    // Soft-delete the space's block row directly (the user-facing
    // delete flow soft-deletes the empty space block the same way).
    sqlx::query("UPDATE blocks SET deleted_at = 1 WHERE id = ?")
        .bind(&doomed)
        .execute(&tools.pool)
        .await
        .unwrap();

    let result = tools
        .call_tool("list_spaces", json!({}), &test_ctx())
        .await
        .expect("happy path");
    let rows = result.as_array().expect("array");
    let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().expect("id")).collect();
    assert!(ids.contains(&keep.as_str()), "live space surfaces");
    assert!(
        !ids.contains(&doomed.as_str()),
        "soft-deleted space must not surface from list_spaces",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_list_spaces_response_shape() {
    let (tools, _mat, _dir) = mk_tools().await;
    crate::spaces::bootstrap_spaces_for_test(&tools.pool, DEV)
        .await
        .unwrap();
    let result = tools
        .call_tool("list_spaces", json!({}), &test_ctx())
        .await
        .unwrap();
    // The seeded ULIDs are reserved constants (stable across runs), so
    // no redaction is needed — the snapshot pins the full wire shape.
    insta::assert_yaml_snapshot!("tool_response_list_spaces", result);
}

// -------------------------------------------------------------------
// #694 — journal_for_date normalises space_id at the boundary
// -------------------------------------------------------------------

/// #694 / L-121 sibling of `get_block_accepts_lowercase_ulid_l121`:
/// `journal_for_date` was the only handler that skipped
/// `normalize_ulid_arg` on `space_id`, so a lowercase space ULID
/// surfaced as a spurious "space not found".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn journal_for_date_accepts_lowercase_space_id_694() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "Personal").await;
    settle(&mat).await;

    let lower = space.to_lowercase();
    assert_ne!(lower, space, "fixture space ULID must not be all-lowercase");

    let result = tools
        .call_tool(
            "journal_for_date",
            json!({"date": "2025-06-15", "space_id": lower}),
            &test_ctx(),
        )
        .await
        .expect("lowercase space ULID must be accepted at the MCP boundary (#694)");
    assert_eq!(result["block_type"], "page");
    assert_eq!(result["content"], "2025-06-15");

    // Idempotency must hold across casings: the canonical-case call
    // resolves to the same page the lowercase call created.
    settle(&mat).await;
    let again = tools
        .call_tool(
            "journal_for_date",
            json!({"date": "2025-06-15", "space_id": space}),
            &test_ctx(),
        )
        .await
        .expect("canonical-case call succeeds");
    assert_eq!(
        again["id"], result["id"],
        "lowercase and canonical space ids must resolve to the same journal page",
    );
}

// -------------------------------------------------------------------
// #699 — search filter-term budget
// -------------------------------------------------------------------

/// #699: a `tag_ids` list larger than the SQLite bind-parameter limit
/// (`MAX_SQL_PARAMS` = SEARCH_FILTER_TERMS_CAP) is rejected at the
/// boundary with an actionable Validation error instead of surfacing
/// as an opaque internal error from the doomed SQL statement.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_rejects_oversized_tag_ids_vector_699() {
    let (tools, _mat, _dir) = mk_tools().await;
    let tag_ids: Vec<String> = (0..SEARCH_FILTER_TERMS_CAP + 1)
        .map(|i| format!("TAG{i}"))
        .collect();
    let err = tools
        .call_tool(
            "search",
            json!({"query": "x", "space_id": TEST_SPACE_ID, "tag_ids": tag_ids}),
            &test_ctx(),
        )
        .await
        .expect_err("oversized tag_ids must be rejected");
    match err {
        AppError::Validation(msg) => {
            assert!(
                msg.contains("too many filter terms"),
                "message names the violation: {msg}"
            );
            assert!(
                msg.contains(&SEARCH_FILTER_TERMS_CAP.to_string()),
                "message names the cap: {msg}"
            );
        }
        other => panic!("expected Validation, got {other:?}"),
    }
}

/// #699: PEND-65 filter vectors count against the same combined
/// budget — two half-budget vectors together overflow it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_rejects_oversized_combined_filter_vectors_699() {
    let (tools, _mat, _dir) = mk_tools().await;
    let half: Vec<String> = (0..(SEARCH_FILTER_TERMS_CAP / 2 + 1))
        .map(|i| format!("S{i}"))
        .collect();
    let err = tools
        .call_tool(
            "search",
            json!({
                "query": "x",
                "space_id": TEST_SPACE_ID,
                "filter": {
                    "state_filter": half,
                    "excluded_state_filter": half,
                },
            }),
            &test_ctx(),
        )
        .await
        .expect_err("combined filter vectors over the budget must be rejected");
    assert!(
        matches!(err, AppError::Validation(ref msg) if msg.contains("too many filter terms")),
        "got {err:?}",
    );
}

/// #699 boundary sanity: a modest in-budget filter set still runs (the
/// cap must not reject legitimate calls).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_accepts_in_budget_filter_vectors_699() {
    let (tools, mat, _dir) = mk_tools().await;
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "needle row".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let result = tools
        .call_tool(
            "search",
            json!({
                "query": "needle",
                "space_id": TEST_SPACE_ID,
                "filter": { "excluded_state_filter": ["DONE", "CANCELLED"] },
            }),
            &test_ctx(),
        )
        .await
        .expect("in-budget filters must not trip the #699 cap");
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
}

// -------------------------------------------------------------------
// Unknown tool name → NotFound (→ -32001)
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_tool_returns_not_found() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool("this_tool_does_not_exist", json!({}), &test_ctx())
        .await
        .expect_err("unknown tool");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

// -------------------------------------------------------------------
// Actor scoping — ACTOR task-local must reflect ctx inside call_tool
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn call_tool_scopes_actor_even_when_outer_scope_absent() {
    // Direct invocation (no server wrapper) — the registry must scope
    // ACTOR itself so downstream `current_actor()` reads the agent.
    let (tools, _mat, _dir) = mk_tools().await;
    let ctx = ActorContext {
        actor: Actor::Agent {
            name: "scoped-agent".to_string(),
        },
        request_id: "req-scoped".to_string(),
    };
    // Inject a check inside the pool-free handler path by calling
    // list_property_defs (no DB side effects needed for the check,
    // but ACTOR.scope runs in the same task).
    let result = tools.call_tool("list_property_defs", json!({}), &ctx).await;
    let Ok(resp) = result else {
        panic!("list_property_defs must succeed inside scoped call, got {result:?}");
    };
    // Sanity-check the response shape: list_property_defs returns a JSON
    // PageResponse object (M-85) with an `items` array. Confirms the
    // scoped call actually ran the handler (not just returned a default
    // value).
    assert!(
        resp["items"].is_array(),
        "list_property_defs response should expose an `items` array, got {resp:?}",
    );
}

// -------------------------------------------------------------------
// Cursor pagination roundtrip
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_pages_cursor_pagination_roundtrip() {
    let (tools, mat, _dir) = mk_tools().await;
    // Insert 5 pages; page with limit=2 → page1 (2), page2 (2), page3 (1).
    for i in 0..5 {
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            format!("P{i}"),
            None,
            Some(i as i64 + 1),
        )
        .await
        .unwrap();
    }
    settle(&mat).await;

    let page1 = tools
        .call_tool("list_pages", json!({"limit": 2}), &test_ctx())
        .await
        .unwrap();
    let items1 = page1["items"].as_array().unwrap();
    assert_eq!(items1.len(), 2);
    assert_eq!(page1["has_more"], true);
    let cursor = page1["next_cursor"].as_str().expect("cursor").to_string();
    let ids1: Vec<&str> = items1.iter().map(|i| i["id"].as_str().unwrap()).collect();

    let page2 = tools
        .call_tool(
            "list_pages",
            json!({"limit": 2, "cursor": cursor}),
            &test_ctx(),
        )
        .await
        .unwrap();
    let items2 = page2["items"].as_array().unwrap();
    assert_eq!(items2.len(), 2);
    let ids2: Vec<&str> = items2.iter().map(|i| i["id"].as_str().unwrap()).collect();
    for id in &ids2 {
        assert!(
            !ids1.contains(id),
            "page2 must not repeat page1 items; found overlap on {id}",
        );
    }

    // TEST-31: previous test asserted page1/page2 didn't overlap but never
    // walked to the end of pagination — a bug that DROPPED an item between
    // pages would still pass. Page through to page3 (the 5th item, with
    // `has_more = false`) and assert the union covers the full input set.
    assert_eq!(
        page2["has_more"], true,
        "page2 must still flag more pages — 5 items total, 4 seen so far"
    );
    let cursor2 = page2["next_cursor"]
        .as_str()
        .expect("page2 cursor")
        .to_string();

    let page3 = tools
        .call_tool(
            "list_pages",
            json!({"limit": 2, "cursor": cursor2}),
            &test_ctx(),
        )
        .await
        .unwrap();
    let items3 = page3["items"].as_array().unwrap();
    assert_eq!(
        items3.len(),
        1,
        "page3 must contain the final item (5 total / page-size 2)"
    );
    assert_eq!(page3["has_more"], false, "page3 must NOT flag more pages");
    let ids3: Vec<&str> = items3.iter().map(|i| i["id"].as_str().unwrap()).collect();
    for id in &ids3 {
        assert!(
            !ids1.contains(id) && !ids2.contains(id),
            "page3 must not repeat page1 or page2 items; found overlap on {id}",
        );
    }

    // The full union must equal the original input set: 5 distinct pages.
    let total = ids1.len() + ids2.len() + ids3.len();
    assert_eq!(
        total, 5,
        "pagination union must equal original input count of 5; got {total} \
         (a missing item between pages would silently slip through the per-page no-overlap check)",
    );
}

// -------------------------------------------------------------------
// M-85 — wire-level cursor pagination for list_tags / list_property_defs
// -------------------------------------------------------------------
//
// `list_tags` and `list_property_defs` both moved from a flat
// top-level array to the canonical `PageResponse { items, next_cursor,
// has_more }` envelope (M-85). The two tests below exercise that
// directly through `tools.call_tool(...)` so a future regression on
// either side of the JSON boundary surfaces as a wire-shape failure.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_paginates_m85() {
    let (tools, mat, _dir) = mk_tools().await;
    // Seed 6 tag blocks; with limit=4 the first page must overflow and
    // the wire response must expose `items` + `next_cursor` + `has_more`.
    for i in 0..6 {
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "tag".into(),
            format!("tag-m85-{i}"),
            None,
            None,
        )
        .await
        .unwrap();
    }
    settle(&mat).await;

    let resp = tools
        .call_tool("list_tags", json!({"limit": 4}), &test_ctx())
        .await
        .expect("list_tags wire call must succeed");
    // Wire shape — PageResponse JSON envelope (M-85).
    let items = resp["items"].as_array().expect("response.items[]");
    assert_eq!(
        items.len(),
        4,
        "first page must contain exactly the requested 4 entries (got {})",
        items.len(),
    );
    assert_eq!(
        resp["has_more"],
        json!(true),
        "has_more must be true when more rows remain past the cap (M-85)",
    );
    assert!(
        resp["next_cursor"].is_string(),
        "next_cursor must be present when has_more is true (M-85), got {resp:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_property_defs_paginates_m85() {
    let (tools, _mat, _dir) = mk_tools().await;
    // Use the migration-seeded defaults (~19 rows) — with limit=4 the
    // first page must overflow.
    let resp = tools
        .call_tool("list_property_defs", json!({"limit": 4}), &test_ctx())
        .await
        .expect("list_property_defs wire call must succeed");
    let items = resp["items"].as_array().expect("response.items[]");
    assert_eq!(
        items.len(),
        4,
        "first page must contain exactly the requested 4 entries (got {})",
        items.len(),
    );
    assert_eq!(
        resp["has_more"],
        json!(true),
        "has_more must be true when more rows remain past the cap (M-85)",
    );
    assert!(
        resp["next_cursor"].is_string(),
        "next_cursor must be present when has_more is true (M-85), got {resp:?}",
    );

    // Threading the cursor back must yield a non-empty second page
    // disjoint from the first (no duplicates, monotonic on key).
    let cursor = resp["next_cursor"].as_str().unwrap().to_string();
    let resp2 = tools
        .call_tool(
            "list_property_defs",
            json!({"limit": 4, "cursor": cursor}),
            &test_ctx(),
        )
        .await
        .expect("second-page wire call must succeed");
    let items2 = resp2["items"].as_array().expect("response.items[]");
    assert!(
        !items2.is_empty(),
        "second page must not be empty when has_more was true",
    );
    let keys1: std::collections::HashSet<&str> =
        items.iter().map(|d| d["key"].as_str().unwrap()).collect();
    for d in items2 {
        let k = d["key"].as_str().unwrap();
        assert!(
            !keys1.contains(k),
            "page2 must not repeat page1 items; found overlap on key {k}",
        );
    }
}

// -------------------------------------------------------------------
// Proptest — search tool matches search_blocks_inner directly
// -------------------------------------------------------------------

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig {
        cases: 32,
        .. proptest::prelude::ProptestConfig::default()
    })]

    #[test]
    fn proptest_search_tool_matches_search_blocks_inner(
        query in "[a-zA-Z]{1,32}",
    ) {
        // fast-check style: run each case in a fresh tokio runtime +
        // fresh DB so state does not leak between iterations.
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            let (tools, mat, _dir) = mk_tools().await;
            // Insert a handful of blocks with the query string plus
            // noise. `create_block_inner` trips FTS indexing.
            create_block_inner(
                &tools.pool, DEV, &mat, "content".into(),
                format!("exact {query} match"), None, Some(1),
            ).await.unwrap();
            create_block_inner(
                &tools.pool, DEV, &mat, "content".into(),
                format!("also {query} here"), None, Some(2),
            ).await.unwrap();
            create_block_inner(
                &tools.pool, DEV, &mat, "content".into(),
                "no match".into(), None, Some(3),
            ).await.unwrap();
            settle(&mat).await;
            // FEAT-3p4 — assign every seeded block to the test space
            // so the FEAT-3p4-required `space_id` filter returns them.
            crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

            let via_tool = tools
                .call_tool(
                    "search",
                    json!({
                        "query": query,
                        "limit": 50,
                        "space_id": TEST_SPACE_ID,
                    }),
                    &test_ctx(),
                )
                .await
                .unwrap();
            let via_inner = search_blocks_inner(
                &tools.pool,
                query.clone(),
                None,
                Some(SEARCH_RESULT_CAP),
                crate::commands::SearchFilter {
                    space_id: Some(TEST_SPACE_ID.into()),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();

            let tool_ids: Vec<String> = via_tool["items"].as_array().unwrap().iter()
                .map(|i| i["id"].as_str().unwrap().to_string()).collect();
            let inner_ids: Vec<String> = via_inner.items.iter().map(|b| b.id.as_str().into()).collect();
            assert_eq!(
                tool_ids, inner_ids,
                "MCP `search` tool must return the same ids in the same order \
                 as `search_blocks_inner` with equivalent caps",
            );
        });
    }
}

// -------------------------------------------------------------------
// Concurrent-client stress — 8 parallel clients × 3 tools × N iters
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_clients_exact_success_count() {
    let (tools, mat, _dir) = mk_tools().await;
    // Seed some data so the tools have something to return.
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "SeedPage".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "hello world".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let tools = Arc::new(tools);
    const CLIENTS: usize = 8;
    const ITERS: usize = 10;
    const TOOLS_PER_ITER: usize = 3;

    let mut handles = Vec::new();
    for c in 0..CLIENTS {
        let tools = tools.clone();
        handles.push(tokio::spawn(async move {
            let mut ok = 0usize;
            // Hold onto one sample list_pages response per task so the
            // outer scope can shape-check at least one of the N calls
            // beyond just `is_ok()`.
            let mut last_list_pages: Value = Value::Null;
            for _ in 0..ITERS {
                let ctx = ActorContext {
                    actor: Actor::Agent {
                        name: format!("stress-{c}"),
                    },
                    request_id: format!("{c}-{ok}"),
                };
                let a = tools
                    .call_tool(
                        "search",
                        json!({"query": "hello", "space_id": TEST_SPACE_ID}),
                        &ctx,
                    )
                    .await;
                let b = tools.call_tool("list_pages", json!({}), &ctx).await;
                let d = tools
                    .call_tool(
                        "get_agenda",
                        json!({"start_date": "2025-01-01", "end_date": "2025-01-02"}),
                        &ctx,
                    )
                    .await;
                if let Ok(ref v) = b {
                    last_list_pages = v.clone();
                }
                for r in [a, b, d] {
                    // All three tools (`search`, `list_pages`,
                    // `get_agenda`) return a `PageResponse`-shaped
                    // envelope `{ items, next_cursor, has_more }`. A
                    // bare `is_ok()` would miss a handler that
                    // returned the wrong JSON shape under contention
                    // (e.g., a `Null`, raw array, or an object
                    // missing pagination fields) — assert the
                    // contract on every call, not just the sample.
                    let v = r.as_ref().expect("stress call failed");
                    assert!(
                        v.get("items").and_then(|x| x.as_array()).is_some(),
                        "response.items[] array present, got {v:?}",
                    );
                    assert!(
                        v.get("has_more")
                            .and_then(serde_json::Value::as_bool)
                            .is_some(),
                        "response.has_more bool present, got {v:?}",
                    );
                    assert!(
                        v.get("next_cursor").is_some(),
                        "response.next_cursor field present (nullable), got {v:?}",
                    );
                    ok += 1;
                }
            }
            (ok, last_list_pages)
        }));
    }

    let mut total = 0usize;
    let mut samples: Vec<Value> = Vec::new();
    for h in handles {
        let (ok, sample) = h.await.expect("task joined");
        total += ok;
        samples.push(sample);
    }
    assert_eq!(
        total,
        CLIENTS * ITERS * TOOLS_PER_ITER,
        "all {} × {} × {} calls must succeed",
        CLIENTS,
        ITERS,
        TOOLS_PER_ITER,
    );

    // Shape check: at least one of the sampled list_pages responses
    // must be a JSON object exposing the paginated `items` field.
    // Catches handlers that succeed but return wrong-typed JSON under
    // contention (e.g., Null, raw array).
    let sample = samples
        .iter()
        .find(|v| !v.is_null())
        .expect("at least one stress task should have captured a list_pages response");
    assert!(
        sample.get("items").is_some(),
        "list_pages stress response should expose `items` field, got {sample:?}",
    );
}

// -------------------------------------------------------------------
// Happy + error path per *new* *_inner helper (4 × 2 = 8 tests)
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inner_list_pages_returns_only_pages() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    create_block_inner(&pool, DEV, &mat, "page".into(), "P1".into(), None, Some(1))
        .await
        .unwrap();
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "c1".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let resp = list_pages_inner(&pool, None, Some(10)).await.unwrap();
    assert_eq!(resp.items.len(), 1);
    assert_eq!(resp.items[0].block_type, "page");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inner_list_pages_rejects_bogus_cursor() {
    let (pool, _dir) = test_pool().await;
    let err = list_pages_inner(&pool, Some("not-a-real-cursor".to_string()), Some(10))
        .await
        .expect_err("invalid cursor");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inner_get_page_composes_root_and_subtree() {
    use crate::commands::get_page_inner;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = create_block_inner(&pool, DEV, &mat, "page".into(), "P".into(), None, Some(1))
        .await
        .unwrap();
    let _c = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "c".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    // FEAT-3 Phase 7 — `get_page_inner` enforces space membership.
    // Bootstrap seeds Personal + Work and back-fills any pages missing a
    // `space` property into Personal, which is exactly what we want.
    crate::spaces::bootstrap_spaces_for_test(&pool, DEV)
        .await
        .unwrap();

    let resp = get_page_inner(
        &pool,
        page.id.clone().as_str(),
        crate::spaces::SPACE_PERSONAL_ULID,
        None,
        Some(10),
    )
    .await
    .unwrap();
    assert_eq!(resp.page.id, page.id);
    assert_eq!(resp.children.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inner_get_page_unknown_id_not_found() {
    use crate::commands::get_page_inner;

    let (pool, _dir) = test_pool().await;
    // Even with no bootstrap, `get_page_inner` resolves NotFound first
    // (via `get_block_inner`) before reaching the space-membership
    // check, so the error category is unchanged for unknown IDs.
    // L-136: must be a valid ULID shape so the BlockId::from_string gate
    // passes — the test intent is to verify NotFound, not Ulid validation.
    let err = get_page_inner(
        &pool,
        "01N0PE0000000000000000N0PE",
        crate::spaces::SPACE_PERSONAL_ULID,
        None,
        Some(10),
    )
    .await
    .expect_err("unknown id");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inner_list_tags_returns_seeded_tags() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    create_block_inner(&pool, DEV, &mat, "tag".into(), "alpha".into(), None, None)
        .await
        .unwrap();
    create_block_inner(&pool, DEV, &mat, "tag".into(), "beta".into(), None, None)
        .await
        .unwrap();
    settle(&mat).await;

    // M-85: paginated; under default limit both tags are on page 1.
    let page = list_tags_inner(&pool, None, Some(100)).await.unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(!page.has_more);
    assert!(page.next_cursor.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inner_list_tags_empty_db() {
    let (pool, _dir) = test_pool().await;
    let page = list_tags_inner(&pool, None, Some(100)).await.unwrap();
    assert_eq!(page.items.len(), 0);
    assert!(!page.has_more);
    assert!(page.next_cursor.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inner_journal_for_date_idempotent() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let space = mk_space(&pool, "Personal").await;
    let date = chrono::NaiveDate::from_ymd_opt(2025, 7, 20).unwrap();
    let first = journal_for_date_inner(&pool, DEV, &mat, date, &space)
        .await
        .unwrap();
    settle(&mat).await;
    let again = journal_for_date_inner(&pool, DEV, &mat, date, &space)
        .await
        .unwrap();
    assert_eq!(
        first.id, again.id,
        "journal_for_date_inner must return the same id for the same date",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inner_journal_for_date_agrees_with_navigate_journal() {
    // Extraction-preservation check: the new helper and the pre-existing
    // `navigate_journal_inner` must return identical results for the
    // same date so the refactor does not drift the behaviour.
    use crate::commands::navigate_journal_inner;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let space = mk_space(&pool, "Personal").await;
    let date = chrono::NaiveDate::from_ymd_opt(2025, 8, 10).unwrap();
    let via_navigate = navigate_journal_inner(
        &pool,
        DEV,
        &mat,
        date.format("%Y-%m-%d").to_string(),
        &space,
    )
    .await
    .unwrap();
    settle(&mat).await;
    let via_typed = journal_for_date_inner(&pool, DEV, &mat, date, &space)
        .await
        .unwrap();
    assert_eq!(
        via_navigate.id, via_typed.id,
        "typed and string variants must agree on the same date",
    );
}

// -------------------------------------------------------------------
// Snapshot per-tool output shape (9 snapshots)
//
// Each snapshot redacts ULIDs / timestamps / cursors — the shape of
// the response is what is locked in, not the data. Any accidental
// change to a tool's JSON envelope breaks CI.
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_list_pages_response_shape() {
    let (tools, mat, _dir) = mk_tools().await;
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "Alpha".into(),
        None,
        // #400: 0-based slot 0 ⇒ first page ⇒ dense `position` 1.
        Some(0),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let result = tools
        .call_tool("list_pages", json!({}), &test_ctx())
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_list_pages", result, {
        ".items[].id" => "[ULID]",
        ".items[].page_id" => "[ULID]",
        ".next_cursor" => "[CURSOR]",
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_get_page_response_shape() {
    let (tools, mat, _dir) = mk_tools().await;
    let page = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "Root".into(),
        None,
        // #400: 0-based slot 0 ⇒ first root page ⇒ dense `position` 1.
        Some(0),
    )
    .await
    .unwrap();
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(page.id.clone()),
        // #400: 0-based slot 0 ⇒ sole first child ⇒ dense `position` 1.
        Some(0),
    )
    .await
    .unwrap();
    settle(&mat).await;
    // FEAT-3 Phase 7 — bootstrap so the page lands in Personal via the
    // back-fill sweep; otherwise `handle_get_page` rejects pages with
    // no `space` property.
    crate::spaces::bootstrap_spaces_for_test(&tools.pool, DEV)
        .await
        .unwrap();
    let result = tools
        .call_tool("get_page", json!({"page_id": page.id}), &test_ctx())
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_get_page", result, {
        ".page.id" => "[ULID]",
        ".page.page_id" => "[ULID]",
        ".children[].id" => "[ULID]",
        ".children[].parent_id" => "[ULID]",
        ".children[].page_id" => "[ULID]",
        ".next_cursor" => "[CURSOR]",
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_search_response_shape() {
    let (tools, mat, _dir) = mk_tools().await;
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "findme please".into(),
        None,
        // #400: 0-based slot 0 ⇒ sole first child ⇒ dense `position` 1.
        Some(0),
    )
    .await
    .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;
    let result = tools
        .call_tool(
            "search",
            json!({"query": "findme", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_search", result, {
        ".items[].id" => "[ULID]",
        ".items[].page_id" => "[ULID]",
        ".next_cursor" => "[CURSOR]",
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_get_block_response_shape() {
    let (tools, mat, _dir) = mk_tools().await;
    let blk = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "text".into(),
        None,
        // #400: `index` is now a 0-based sibling slot; slot 0 ⇒ sole first
        // child ⇒ dense 1-based `position` 1.
        Some(0),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let result = tools
        .call_tool("get_block", json!({"block_id": blk.id}), &test_ctx())
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_get_block", result, {
        ".id" => "[ULID]",
        ".page_id" => "[ULID]",
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_list_backlinks_response_shape() {
    let (tools, mat, _dir) = mk_tools().await;
    let target = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let result = tools
        .call_tool(
            "list_backlinks",
            json!({"block_id": target.id}),
            &test_ctx(),
        )
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_list_backlinks", result, {
        ".next_cursor" => "[CURSOR]",
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_list_tags_response_shape() {
    let (tools, mat, _dir) = mk_tools().await;
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "tag".into(),
        "snap-tag".into(),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    let result = tools
        .call_tool("list_tags", json!({}), &test_ctx())
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_list_tags", result, {
        ".items[].tag_id" => "[ULID]",
        ".items[].updated_at" => "[TIMESTAMP]",
        ".next_cursor" => "[CURSOR]",
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_list_property_defs_response_shape() {
    let (tools, _mat, _dir) = mk_tools().await;
    let result = tools
        .call_tool("list_property_defs", json!({}), &test_ctx())
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_list_property_defs", result, {
        ".items[].created_at" => "[TIMESTAMP]",
        ".next_cursor" => "[CURSOR]",
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_get_agenda_response_shape() {
    let (tools, mat, _dir) = mk_tools().await;

    // I-MCP-6: seed a single repeating block so the projection has at
    // least one entry to surface. With an empty DB the response is
    // `[]`, which never exercises the populated `ProjectedAgendaEntry`
    // wire shape (`block` / `projected_date` / `source`) — letting a
    // future field rename slip through silently.
    let task = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "recurring".into(),
        None,
        // #400: 0-based slot 0 ⇒ sole first child ⇒ dense `position` 1.
        Some(0),
    )
    .await
    .unwrap();
    crate::commands::set_due_date_inner(
        &tools.pool,
        DEV,
        &mat,
        task.id.as_str().into(),
        Some("2099-01-03".into()),
    )
    .await
    .unwrap();
    crate::commands::set_property_inner(
        &tools.pool,
        DEV,
        &mat,
        task.id.as_str().into(),
        "repeat".into(),
        Some("daily".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    // Force the on-the-fly fallback so the projected_date is purely a
    // function of (due_date, repeat_rule, requested range) rather than
    // the wall-clock date the test was run (the cache rebuild anchors
    // its horizon to `chrono::Local::now`).
    sqlx::query("DELETE FROM projected_agenda_cache")
        .execute(&tools.pool)
        .await
        .unwrap();

    let result = tools
        .call_tool(
            "get_agenda",
            json!({"start_date": "2099-01-04", "end_date": "2099-01-04"}),
            &test_ctx(),
        )
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_get_agenda", result, {
        // M-25: response is now `PageResponse { items, next_cursor, has_more }`
        ".items[].block.id" => "[ULID]",
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_journal_for_date_response_shape() {
    let (tools, _mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "Personal").await;
    let result = tools
        .call_tool(
            "journal_for_date",
            json!({"date": "2025-09-09", "space_id": space}),
            &test_ctx(),
        )
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_journal_for_date", result, {
        ".id" => "[ULID]",
        ".page_id" => "[ULID]",
    });
}

/// FEAT-4h slice 3: RO tools must NOT populate `LAST_APPEND` — they
/// don't append ops, so the dispatch layer should drain an empty
/// list and emit an `ActivityEntry` with `op_ref = None` and
/// `additional_op_refs = []`. Drive `list_pages` inside an
/// explicit scope and assert the drained list is empty on exit.
///
/// L-114: storage is a `Vec`, so the assertion shifts from
/// `is_none()` to `is_empty()`. Multi-op RW tools are covered in
/// `mcp::server::tests::handle_tools_call_multi_op_tool_*`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_pages_does_not_populate_last_append() {
    use crate::task_locals::{LAST_APPEND, take_appends};
    use std::cell::RefCell;

    let (tools, _mat, _dir) = mk_tools().await;

    let captured = LAST_APPEND
        .scope(RefCell::new(Vec::new()), async {
            tools
                .call_tool("list_pages", json!({}), &test_ctx())
                .await
                .expect("list_pages ok");
            take_appends()
        })
        .await;

    assert!(
        captured.is_empty(),
        "RO tool `list_pages` must not populate LAST_APPEND; got {captured:?}",
    );
}
