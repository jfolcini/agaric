use super::*;
use crate::commands::tests::common::TEST_SPACE_ID;
use crate::commands::{create_block_inner, create_space_inner};
use crate::db::init_pool;
use crate::materializer::Materializer;
use agaric_store::space::{SpaceId, SpaceScope};
use agaric_store::task_locals::Actor;
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

/// Create a single space and return its ULID. Used by the
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
    // `init_pool` returns a single combined pool, so reuse it
    // for both the reader and writer slots in this fixture. The
    // production wiring uses split `init_pools` semantics; the
    // dedicated `tests_m82` block below exercises that path.
    let tools = ReadOnlyTools::new(pool.clone(), pool, mat.clone(), DEV.to_string());
    (tools, mat, dir)
}

async fn settle(mat: &Materializer) {
    mat.flush_background().await.unwrap();
}

/// A search over [`TEST_SPACE_ID`] with no other predicate.
fn test_space_search_filter() -> crate::commands::SearchFilter {
    serde_json::from_value(json!({
        "scope": SearchScope::Spaces(vec![SpaceId::from_trusted(TEST_SPACE_ID)]),
    }))
    .unwrap()
}

// -------------------------------------------------------------------
// list_tools — snapshot of the wire contract
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tools_advertises_the_ro_tools() {
    let (tools, _mat, _dir) = mk_tools().await;
    let descs = tools.list_tools();
    let names: Vec<&str> = descs.iter().map(|d| d.name.as_str()).collect();
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
            "get_page_markdown",
            "page_history",
            "block_history",
            "get_journal",
            "list_journal",
            "list_trash",
            "resolve",
            "query",
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
// (d) PARTIAL — schema/struct equivalence
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
// The asserts below cover `list_pages` (one required field, two
// optional) and `get_block` (two required fields, no optional). When
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
    assert_eq!(schema["required"], json!(["space_id"]));
    let missing: Result<ListPagesArgs, _> = serde_json::from_value(json!({}));
    assert!(
        missing.is_err(),
        "ListPagesArgs must reject an object without space_id",
    );

    // Build a concrete payload using every property the schema
    // advertises. If the struct lacks one of these fields, this
    // would parse but lose data; if the struct has additional
    // fields, those would be required and missing from the payload.
    let mut payload = serde_json::Map::new();
    for &name in &prop_names {
        // Pick a value-shape that matches the schema's declared type.
        let ty = props[name]["type"].as_str().expect("each prop has a type");
        let value = match (ty, props[name].get("enum")) {
            ("string", Some(variants)) => variants[0].clone(),
            ("string", None) => json!("placeholder"),
            ("integer", _) => json!(1),
            ("array", _) => json!([]),
            (other, _) => panic!("list_pages schema grew an unexpected type: {other}"),
        };
        payload.insert(name.to_string(), value);
    }
    let parsed: ListPagesArgs = serde_json::from_value(Value::Object(payload))
        .expect("ListPagesArgs accepts every property the schema advertises");
    assert_eq!(parsed.space_id, "placeholder");
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
        vec!["block_id", "space_id"],
        "get_block schema requires exactly the `block_id` and `space_id` fields",
    );

    // A payload that omits a required field must fail deserialization
    // (the struct fields are non-optional).
    for partial in [json!({"block_id": "abc"}), json!({"space_id": "s"})] {
        let missing: Result<GetBlockArgs, _> = serde_json::from_value(partial.clone());
        assert!(
            missing.is_err(),
            "GetBlockArgs must reject {partial} — required field missing",
        );
    }

    // A payload with both required fields deserializes cleanly.
    let parsed: GetBlockArgs = serde_json::from_value(json!({"block_id": "abc", "space_id": "s"}))
        .expect("GetBlockArgs accepts a payload with block_id and space_id");
    assert_eq!(parsed.block_id, "abc");
    assert_eq!(parsed.space_id, "s");

    // A payload with an unknown property must be rejected by
    // `deny_unknown_fields` — pinning the schema/struct contract
    // even when the schema's `additionalProperties: false` is the
    // wire contract.
    let stray: Result<GetBlockArgs, _> =
        serde_json::from_value(json!({"block_id": "abc", "space_id": "s", "extra": 1}));
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
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let result = tools
        .call_tool(
            "list_pages",
            json!({"space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
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
        .call_tool(
            "list_pages",
            json!({"space_id": TEST_SPACE_ID, "bogus": 1}),
            &test_ctx(),
        )
        .await
        .expect_err("must reject unknown field");
    assert!(
        matches!(err, AppError::Validation { .. }),
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
    // Bootstrap so the page lands in Personal via the back-fill sweep.
    crate::spaces::bootstrap_spaces_for_test(&tools.pool, DEV)
        .await
        .unwrap();

    let result = tools
        .call_tool(
            "get_page",
            json!({"page_id": page.id.clone(), "space_id": crate::spaces::SPACE_PERSONAL_ULID}),
            &test_ctx(),
        )
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
            json!({"page_id": BlockId::new().into_string(), "space_id": TEST_SPACE_ID}),
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
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let err = tools
        .call_tool(
            "get_page",
            json!({"page_id": content.id, "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect_err("non-page block must error");
    assert!(
        matches!(err, AppError::Validation { .. }),
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
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

/// #2956 (`space_id`) and #3301 (`parent_id`, `tag_ids`) — a malformed or
/// truncated id must be REJECTED at the boundary via the strict
/// `from_string` gate (an `AppError::Ulid`, like every sibling tool:
/// `list_backlinks`, `list_property_defs`, `create_page`), NOT coerced
/// through `from_trusted` or waved past by `normalize_ulid_arg` into an id
/// that matches nothing. Before these fixes each returned `Ok` with an empty
/// `items` array, so an agent that mangled an id would wrongly conclude the
/// vault held nothing — a false negative, not a true miss. The seeded block
/// and the closing control call are what make that distinction provable, and
/// they serve all three ids, which is why the cases share one test.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_malformed_ids_error_rather_than_empty() {
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
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    // Truncated / non-ULID id: must error at construction, not match nothing.
    let err = tools
        .call_tool(
            "search",
            json!({"query": "needle", "space_id": "NOT-A-VALID-ULID"}),
            &test_ctx(),
        )
        .await
        .expect_err("a malformed space_id must be rejected, not return empty results");
    assert!(
        matches!(err, AppError::Ulid(_)),
        "malformed space_id must surface as AppError::Ulid (strict from_string gate, \
         same as sibling tools), got {err:?}"
    );

    // Empty id: `normalize_ulid_arg` leaves it empty, so `from_string("")`
    // must reject it too rather than producing an empty `Active` scope.
    let err = tools
        .call_tool(
            "search",
            json!({"query": "needle", "space_id": ""}),
            &test_ctx(),
        )
        .await
        .expect_err("an empty space_id must be rejected, not return empty results");
    assert!(
        matches!(err, AppError::Ulid(_)),
        "empty space_id must surface as AppError::Ulid, got {err:?}"
    );

    // #3301 — `parent_id`: only `normalize_ulid_arg`-ed before the fix, so a
    // non-ULID bound a string that matched nothing. Since #5397 it names a
    // page, and no page has that name.
    let err = tools
        .call_tool(
            "search",
            json!({
                "query": "needle",
                "space_id": TEST_SPACE_ID,
                "parent_id": "NOT-A-VALID-ULID",
            }),
            &test_ctx(),
        )
        .await
        .expect_err("a malformed parent_id must be rejected, not return empty results");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "malformed parent_id must surface as Validation, got {err:?}"
    );

    // #3301 — `tag_ids`: a truncated (25-char) tag ULID, the realistic
    // copy/paste slip. An agent would conclude no block carries that tag.
    let err = tools
        .call_tool(
            "search",
            json!({
                "query": "needle",
                "space_id": TEST_SPACE_ID,
                "tag_ids": ["01ARZ3NDEKTSV4RRFFQ69G5FA"],
            }),
            &test_ctx(),
        )
        .await
        .expect_err("a malformed tag_ids entry must be rejected, not return empty results");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "malformed tag_ids entry must surface as Validation, got {err:?}"
    );

    // Control: the SAME query under the VALID space still returns the hit —
    // proving the rejections above were about the bad id, not an empty vault.
    let ok = tools
        .call_tool(
            "search",
            json!({"query": "needle", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect("valid space_id must still return the seeded match");
    assert_eq!(
        ok["items"].as_array().expect("items").len(),
        1,
        "the vault is non-empty for a valid space_id"
    );
}

// -------------------------------------------------------------------
// Explicit `limit` validation (rejects out-of-range values
// instead of silently clamping). Six tools advertise a min/max in
// their input schema; cover them parametrically.
// -------------------------------------------------------------------

/// Parametric expectations for every tool that gates `limit`
/// against an advertised `[1, cap]` range. `base_args` carries the
/// rest of each tool's required fields; the test merges a
/// `"limit"` field in.
fn limit_validation_cases() -> Vec<(&'static str, i64, Value)> {
    vec![
        (
            TOOL_LIST_PAGES,
            LIST_RESULT_CAP,
            json!({"space_id": TEST_SPACE_ID}),
        ),
        // page_id need not exist — `validate_limit` runs before
        // the inner lookup, so out-of-range cases fire before any
        // NotFound is possible.
        (
            TOOL_GET_PAGE,
            LIST_RESULT_CAP,
            json!({"page_id": "ANY", "space_id": TEST_SPACE_ID}),
        ),
        (
            TOOL_SEARCH,
            SEARCH_RESULT_CAP,
            json!({"query": "needle", "space_id": TEST_SPACE_ID}),
        ),
        (
            TOOL_LIST_BACKLINKS,
            LIST_RESULT_CAP,
            json!({"block_id": "ANY", "space_id": TEST_SPACE_ID}),
        ),
        (
            TOOL_LIST_TAGS,
            LIST_RESULT_CAP,
            json!({"space_id": TEST_SPACE_ID}),
        ),
        (
            TOOL_GET_AGENDA,
            AGENDA_RESULT_CAP,
            json!({"start_date": "2025-01-01", "end_date": "2025-01-02", "space_id": TEST_SPACE_ID}),
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
                Err(AppError::Validation { message: msg, .. }) => {
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
        // Boundary value must NOT trip the validation. The
        // inner handler may still legitimately surface another
        // error (e.g. NotFound when `page_id`/`block_id` is a
        // placeholder, or a different Validation for an invalid
        // ULID) — only the message pattern is the regression
        // signal here.
        if let Err(AppError::Validation { message: msg, .. }) = &result {
            assert!(
                !msg.contains("limit must be in"),
                "{tool}: limit={cap} (boundary) tripped  validation: {msg}",
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
        test_space_search_filter(),
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
// MCP `search` tool: `filter` arg threads through to
// `SearchFilter`. The structured-filter shape mirrors the Tauri
// command surface; the inline `tag:` / `state:` / `prop:` syntax is
// NOT parsed at the MCP boundary (agents pass structured args).
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_filter_omitted_preserves_pre_pend65_behavior() {
    // No `filter` arg = the wide query (every match across content)
    // Exactly as before.
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
    // Fields exposed through MCP: `excluded_state_filter`
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
    // Property_filters + four-column matching ride
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
        matches!(err, AppError::Validation { .. }),
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
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let result = tools
        .call_tool(
            "get_block",
            json!({"block_id": blk.id.clone(), "space_id": TEST_SPACE_ID}),
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
            json!({"block_id": "NONEXISTENT_ID", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect_err("unknown block must error");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

/// Lowercase ULIDs supplied by the agent at the MCP boundary
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
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    // Agaric returns uppercase ULIDs; the agent supplies the
    // *lowercase* form to exercise the boundary normalisation.
    let lower = blk.id.as_str().to_lowercase();
    assert_ne!(
        lower, blk.id,
        "test setup: block id must not already be all-lowercase"
    );

    let result = tools
        .call_tool(
            "get_block",
            json!({"block_id": lower, "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect("lowercase ULID must be accepted at the MCP boundary");
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
            json!({"block_id": target.id, "space_id": TEST_SPACE_ID}),
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

/// #3301 — `list_backlinks` waved `block_id` through `normalize_ulid_arg`,
/// and `list_backlinks_grouped_inner` rejects only an EMPTY id, so a
/// malformed one bound a string that matched nothing and came back as an
/// empty grouped response: an agent reads "this block has no backlinks"
/// and does not retry. `BlockId::from_string` rejects it instead. The
/// lowercase arm is the other half of the pair — that constructor must
/// still uppercase, or the fix would trade a false negative for a
/// regression on the case the boundary normalisation existed to serve.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_backlinks_malformed_block_id_errors_rather_than_empty() {
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

    for bad in ["NOT-A-VALID-ULID", "01ARZ3NDEKTSV4RRFFQ69G5FA", ""] {
        let err = tools
            .call_tool(
                "list_backlinks",
                json!({"block_id": bad, "space_id": TEST_SPACE_ID}),
                &test_ctx(),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::Ulid(_)),
            "block_id {bad:?} must surface as AppError::Ulid, got {err:?}"
        );
    }

    // Lowercase still resolves: `canonical_ulid` compares against the
    // uppercased input, so dropping `normalize_ulid_arg` here changed
    // nothing for the case an agent actually mangles.
    let lower = target.id.as_str().to_lowercase();
    assert_ne!(lower, target.id.as_str(), "test setup: id has letters");
    let via_lower = tools
        .call_tool(
            "list_backlinks",
            json!({"block_id": lower, "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect("a lowercase ULID must still be accepted");
    let via_upper = tools
        .call_tool(
            "list_backlinks",
            json!({"block_id": target.id, "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect("the canonical id must be accepted");
    assert_eq!(
        via_lower, via_upper,
        "lowercase must resolve to the same block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_backlinks_missing_block_id_validation() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "list_backlinks",
            json!({"space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect_err("missing block_id");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

async fn mk_tag(pool: &SqlitePool, mat: &Materializer, space: &str, name: &str) -> String {
    crate::commands::create_block_inner_with_space(
        pool,
        DEV,
        mat,
        "tag".into(),
        name.into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(space)),
        None,
    )
    .await
    .unwrap()
    .id
    .into_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_lists_only_the_given_space() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "Work").await;
    let other = mk_space(&tools.pool, "Home").await;
    let mut expected = vec![
        mk_tag(&tools.pool, &mat, &space, "work").await,
        mk_tag(&tools.pool, &mat, &space, "urgent").await,
    ];
    expected.sort();
    mk_tag(&tools.pool, &mat, &other, "garden").await;
    settle(&mat).await;

    let result = tools
        .call_tool("list_tags", json!({ "space_id": space }), &test_ctx())
        .await
        .expect("happy path");
    let ids: Vec<&str> = result["items"]
        .as_array()
        .expect("tag items array")
        .iter()
        .map(|row| row["tag_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, expected);
    assert!(result["next_cursor"].is_null(), "got {result:?}");
    assert_eq!(result["has_more"], json!(false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_requires_space_id() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool("list_tags", json!({}), &test_ctx())
        .await
        .expect_err("space_id is required");
    assert!(
        matches!(&err, AppError::Validation { message, .. } if message.contains("missing field `space_id`")),
        "got {err:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_rejects_unknown_field() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "list_tags",
            json!({"space_id": TEST_SPACE_ID, "prefix": "w"}),
            &test_ctx(),
        )
        .await
        .expect_err("prefix is not a valid arg for list_tags");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_property_defs_happy_path() {
    // A fresh DB ships built-in property definitions seeded by
    // migrations. The exact wire shape is snapshot-locked by
    // `tool_response_list_property_defs.snap`; this test just pins
    // (a) a stable subset of must-be-present keys (the four reserved
    // keys named in AGENTS.md "Architectural Stability — properties
    // system", which any future migration must preserve), and
    // (b) cross-checks the response count against the live
    // `property_definitions` table so adding/removing seeded defs
    // does not silently desync this assertion from reality.
    let (tools, _mat, _dir) = mk_tools().await;
    // Under the default page limit (`MAX_PAGE_SIZE = 200`) all
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
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_agenda_happy_path() {
    let (tools, _mat, _dir) = mk_tools().await;
    let result = tools
        .call_tool(
            "get_agenda",
            json!({"start_date": "2025-01-01", "end_date": "2025-01-31", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    // `get_agenda` now returns a `PageResponse` shape rather
    // than a flat array. The empty DB has zero entries, so `items`
    // is the empty array and `has_more` is false.
    let items = result["items"].as_array().expect("agenda items array");
    assert_eq!(items.len(), 0, "empty DB has zero agenda entries");
    assert_eq!(result["has_more"], false);
    assert!(result["next_cursor"].is_null());
}

/// #5393 — `get_agenda` returns dated blocks as well as projected repeats.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_agenda_returns_dated_and_projected_rows() {
    let (tools, _mat, _dir) = mk_tools().await;
    // Raw inserts keep the projected cache empty, so the on-the-fly
    // projector answers from the base dates alone.
    crate::commands::tests::common::ensure_test_space(&tools.pool).await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, todo_state, due_date, scheduled_date, space_id) VALUES
         ('GA_ONEOFF', 'content', 'one-off', 'TODO', '2025-01-10', NULL, ?1),
         ('GA_WEEKLY', 'content', 'weekly', 'TODO', '2025-01-20', NULL, ?1),
         ('GA_SCHED', 'content', 'scheduled', NULL, NULL, '2025-01-15', ?1)",
    )
    .bind(TEST_SPACE_ID)
    .execute(&tools.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES ('GA_WEEKLY', 'repeat', 'weekly')",
    )
    .execute(&tools.pool)
    .await
    .unwrap();

    let result = tools
        .call_tool(
            "get_agenda",
            json!({"start_date": "2025-01-01", "end_date": "2025-01-31", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    let rows: Vec<(String, String, String, bool)> = result["items"]
        .as_array()
        .expect("agenda items array")
        .iter()
        .map(|e| {
            (
                e["date"].as_str().unwrap().to_string(),
                e["block"]["id"].as_str().unwrap().to_string(),
                e["source"].as_str().unwrap().to_string(),
                e["projected"].as_bool().unwrap(),
            )
        })
        .collect();
    let row =
        |d: &str, id: &str, s: &str, p: bool| (d.to_string(), id.to_string(), s.to_string(), p);
    assert_eq!(
        rows,
        vec![
            row("2025-01-10", "GA_ONEOFF", "due_date", false),
            row("2025-01-15", "GA_SCHED", "scheduled_date", false),
            row("2025-01-20", "GA_WEEKLY", "due_date", false),
            row("2025-01-27", "GA_WEEKLY", "due_date", true),
        ]
    );
    assert_eq!(result["has_more"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_agenda_invalid_date_returns_validation() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "get_agenda",
            json!({"start_date": "not-a-date", "end_date": "2025-01-31", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect_err("invalid date");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

/// The `list_backlinks` / `get_agenda` error for an omitted `space_id`:
/// a validation error that names the field.
fn assert_missing_space_id(err: &AppError) {
    match err {
        AppError::Validation { message, .. } => assert!(
            message.contains("`space_id`"),
            "the error must name `space_id`, got {message:?}"
        ),
        other => panic!("expected AppError::Validation, got {other:?}"),
    }
}

/// Seed one block row; `parent` doubles as the owning page.
async fn insert_spaced_block(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    parent: Option<&str>,
    space_id: &str,
    due_date: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id, position, space_id, due_date) \
         VALUES (?1, ?2, ?1, ?3, COALESCE(?3, ?1), 1, ?4, ?5)",
    )
    .bind(id)
    .bind(block_type)
    .bind(parent)
    .bind(space_id)
    .bind(due_date)
    .execute(pool)
    .await
    .unwrap();
}

/// #5415 — `list_backlinks` takes a required `space_id`: without it the call
/// is refused rather than answered across every space, and with it only the
/// named space's sources come back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_backlinks_requires_space_id_and_returns_only_that_space() {
    use crate::commands::tests::common::{TEST_SPACE_B_ID, ensure_test_space, ensure_test_space_b};

    let (tools, _mat, _dir) = mk_tools().await;
    ensure_test_space(&tools.pool).await;
    ensure_test_space_b(&tools.pool).await;
    let target = BlockId::new().to_string();
    insert_spaced_block(&tools.pool, &target, "page", None, TEST_SPACE_ID, None).await;
    let mut source_in = Vec::new();
    for space in [TEST_SPACE_ID, TEST_SPACE_B_ID] {
        let page = BlockId::new().to_string();
        let source = BlockId::new().to_string();
        insert_spaced_block(&tools.pool, &page, "page", None, space, None).await;
        insert_spaced_block(&tools.pool, &source, "content", Some(&page), space, None).await;
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&source)
            .bind(&target)
            .execute(&tools.pool)
            .await
            .unwrap();
        source_in.push((space, source));
    }

    let err = tools
        .call_tool("list_backlinks", json!({"block_id": target}), &test_ctx())
        .await
        .expect_err("an omitted space_id must be refused");
    assert_missing_space_id(&err);

    for (space, source) in source_in {
        let result = tools
            .call_tool(
                "list_backlinks",
                json!({"block_id": target, "space_id": space}),
                &test_ctx(),
            )
            .await
            .expect("a scoped call must succeed");
        let ids: Vec<&str> = result["groups"]
            .as_array()
            .expect("groups array")
            .iter()
            .flat_map(|g| g["blocks"].as_array().expect("blocks array"))
            .map(|b| b["id"].as_str().expect("block id"))
            .collect();
        assert_eq!(
            ids,
            vec![source.as_str()],
            "space {space} must see only its own source"
        );
    }
}

/// #5415 — `get_agenda` takes a required `space_id`: without it the call is
/// refused rather than answered across every space, and with it only the
/// named space's dated blocks come back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_agenda_requires_space_id_and_returns_only_that_space() {
    use crate::commands::tests::common::{TEST_SPACE_B_ID, ensure_test_space, ensure_test_space_b};

    let (tools, _mat, _dir) = mk_tools().await;
    ensure_test_space(&tools.pool).await;
    ensure_test_space_b(&tools.pool).await;
    let mut task_in = Vec::new();
    for space in [TEST_SPACE_ID, TEST_SPACE_B_ID] {
        let task = BlockId::new().to_string();
        insert_spaced_block(
            &tools.pool,
            &task,
            "content",
            None,
            space,
            Some("2025-01-10"),
        )
        .await;
        task_in.push((space, task));
    }
    let range = json!({"start_date": "2025-01-01", "end_date": "2025-01-31"});

    let err = tools
        .call_tool("get_agenda", range.clone(), &test_ctx())
        .await
        .expect_err("an omitted space_id must be refused");
    assert_missing_space_id(&err);

    for (space, task) in task_in {
        let mut args = range.clone();
        args["space_id"] = json!(space);
        let result = tools
            .call_tool("get_agenda", args, &test_ctx())
            .await
            .expect("a scoped call must succeed");
        let ids: Vec<&str> = result["items"]
            .as_array()
            .expect("agenda items array")
            .iter()
            .map(|e| e["block"]["id"].as_str().expect("block id"))
            .collect();
        assert_eq!(
            ids,
            vec![task.as_str()],
            "space {space} must see only its own task"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn journal_for_date_happy_path_creates_page() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "Personal").await;
    // #2719: the create carve-out is bounded to today ± 12 months, so use
    // today's date (trivially in-window) rather than a hardcoded literal
    // that drifts out of the window as the wall clock advances.
    let date = chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let result = tools
        .call_tool(
            "journal_for_date",
            json!({"date": date.clone(), "space_id": space}),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    assert_eq!(result["block_type"], "page");
    assert_eq!(result["content"], date.as_str());
    // Second call must return the same page id (idempotent).
    let first_id = result["id"].as_str().expect("id present").to_string();
    settle(&mat).await;
    let again = tools
        .call_tool(
            "journal_for_date",
            json!({"date": date.clone(), "space_id": space}),
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

/// #5314 — a page `journal_for_date` creates must reach open views, as every
/// RW tool's write does; a plain lookup emits nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn journal_for_date_emits_blocks_changed_only_when_it_creates_5314() {
    let (tools, mat, _dir) = mk_tools().await;
    let emitter = Arc::new(crate::mcp::view_notify::RecordingViewChangeEmitter::new());
    let tools = tools.with_view_emitter(emitter.clone());
    let space = mk_space(&tools.pool, "Personal").await;
    let date = chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let args = json!({"date": date, "space_id": space});

    let created = tools
        .call_tool("journal_for_date", args.clone(), &test_ctx())
        .await
        .expect("create");
    settle(&mat).await;
    tools
        .call_tool("journal_for_date", args, &test_ctx())
        .await
        .expect("lookup");

    let page_id = created["id"].as_str().expect("id present").to_string();
    assert_eq!(emitter.blocks_changed(), vec![vec![page_id]]);
}

/// The `journal_for_date` tool lives in the read-only
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
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
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
    // #2719: use an in-window date (today) so the create carve-out fires.
    let date = chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let journal = tools
        .call_tool(
            "journal_for_date",
            json!({"date": date, "space_id": space_id}),
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
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
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

/// #694 / sibling of `get_block_accepts_lowercase_ulid_l121`:
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

    // #2719: use an in-window date (today) so the create carve-out fires.
    let date = chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let result = tools
        .call_tool(
            "journal_for_date",
            json!({"date": date.clone(), "space_id": lower}),
            &test_ctx(),
        )
        .await
        .expect("lowercase space ULID must be accepted at the MCP boundary (#694)");
    assert_eq!(result["block_type"], "page");
    assert_eq!(result["content"], date.as_str());

    // Idempotency must hold across casings: the canonical-case call
    // resolves to the same page the lowercase call created.
    settle(&mat).await;
    let again = tools
        .call_tool(
            "journal_for_date",
            json!({"date": date.clone(), "space_id": space}),
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
    let tag_ids: Vec<String> = (0..=SEARCH_FILTER_TERMS_CAP)
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
        AppError::Validation { message: msg, .. } => {
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

/// #699: filter vectors count against the same combined
/// budget — two half-budget vectors together overflow it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_rejects_oversized_combined_filter_vectors_699() {
    let (tools, _mat, _dir) = mk_tools().await;
    let half: Vec<String> = (0..=(SEARCH_FILTER_TERMS_CAP / 2))
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
        matches!(err, AppError::Validation { message: ref msg, .. } if msg.contains("too many filter terms")),
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
// #1607 — per-term and aggregate byte caps on search terms
//
// The #699 count cap bounds how *many* terms arrive but not how *large*
// each is. These cover the byte-size guard that rejects multi-megabyte
// term strings before they reach glob / regex / SQL.
// -------------------------------------------------------------------

/// #1607: a single `query` string larger than `SEARCH_TERM_BYTES_CAP`
/// is rejected at the boundary with an actionable Validation error
/// naming the offending dimension.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_rejects_oversized_query_string_1607() {
    let (tools, _mat, _dir) = mk_tools().await;
    let huge = "a".repeat(SEARCH_TERM_BYTES_CAP + 1);
    let err = tools
        .call_tool(
            "search",
            json!({"query": huge, "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect_err("an over-byte-cap query must be rejected");
    match err {
        AppError::Validation { message: msg, .. } => {
            assert!(msg.contains("query"), "message names the dimension: {msg}");
            assert!(
                msg.contains(&SEARCH_TERM_BYTES_CAP.to_string()),
                "message names the per-term cap: {msg}"
            );
        }
        other => panic!("expected Validation, got {other:?}"),
    }
}

/// #1607: an oversized page glob is rejected (the glob vectors flow
/// straight into glob matching, so they need the same per-term guard).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_rejects_oversized_page_glob_1607() {
    let (tools, _mat, _dir) = mk_tools().await;
    let huge = "g".repeat(SEARCH_TERM_BYTES_CAP + 1);
    let err = tools
        .call_tool(
            "search",
            json!({
                "query": "x",
                "space_id": TEST_SPACE_ID,
                "filter": { "include_page_globs": [huge] },
            }),
            &test_ctx(),
        )
        .await
        .expect_err("an over-byte-cap page glob must be rejected");
    assert!(
        matches!(err, AppError::Validation { message: ref msg, .. } if msg.contains("include_page_globs")),
        "got {err:?}",
    );
}

/// #1607: an oversized property-filter value is rejected (property
/// values are matched against `block_properties.value_text`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_rejects_oversized_property_value_1607() {
    let (tools, _mat, _dir) = mk_tools().await;
    let huge = "v".repeat(SEARCH_TERM_BYTES_CAP + 1);
    let err = tools
        .call_tool(
            "search",
            json!({
                "query": "x",
                "space_id": TEST_SPACE_ID,
                "filter": { "property_filters": [{ "key": "status", "value": huge }] },
            }),
            &test_ctx(),
        )
        .await
        .expect_err("an over-byte-cap property value must be rejected");
    assert!(
        matches!(err, AppError::Validation { message: ref msg, .. } if msg.contains("property_filters value")),
        "got {err:?}",
    );
}

/// #1607 (review): the state/priority/block-type filter strings are NOT
/// enum-validated — `prepare_metadata_with_today` binds them verbatim
/// into the `IN (…)` predicate — so a single multi-MB `state_filter`
/// entry (one term, under the #699 count cap) must still trip the
/// per-term byte guard.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_rejects_oversized_state_filter_1607() {
    let (tools, _mat, _dir) = mk_tools().await;
    let huge = "s".repeat(SEARCH_TERM_BYTES_CAP + 1);
    let err = tools
        .call_tool(
            "search",
            json!({
                "query": "x",
                "space_id": TEST_SPACE_ID,
                "filter": { "state_filter": [huge] },
            }),
            &test_ctx(),
        )
        .await
        .expect_err("an over-byte-cap state_filter entry must be rejected");
    assert!(
        matches!(err, AppError::Validation { message: ref msg, .. } if msg.contains("state/priority")),
        "got {err:?}",
    );
}

/// #1607 (review): the `block_type_filter` string flows straight into
/// the FTS query as a bound `&str`; bound it by bytes too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_rejects_oversized_block_type_filter_1607() {
    let (tools, _mat, _dir) = mk_tools().await;
    let huge = "b".repeat(SEARCH_TERM_BYTES_CAP + 1);
    let err = tools
        .call_tool(
            "search",
            json!({
                "query": "x",
                "space_id": TEST_SPACE_ID,
                "filter": { "block_type_filter": huge },
            }),
            &test_ctx(),
        )
        .await
        .expect_err("an over-byte-cap block_type_filter must be rejected");
    assert!(
        matches!(err, AppError::Validation { message: ref msg, .. } if msg.contains("block_type_filter")),
        "got {err:?}",
    );
}

/// #1607: many individually-in-cap strings whose combined size exceeds
/// `SEARCH_TERM_TOTAL_BYTES_CAP` are rejected by the aggregate guard,
/// even though no single string trips the per-term cap.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_rejects_aggregate_byte_overflow_1607() {
    let (tools, _mat, _dir) = mk_tools().await;
    // Each glob is well under the per-term cap, but together they exceed
    // the aggregate cap.
    let chunk = SEARCH_TERM_BYTES_CAP / 4;
    let count = SEARCH_TERM_TOTAL_BYTES_CAP / chunk + 2;
    let globs: Vec<String> = (0..count).map(|_| "g".repeat(chunk)).collect();
    assert!(
        count <= SEARCH_FILTER_TERMS_CAP,
        "test must stay under the #699 count cap to exercise the byte cap",
    );
    let err = tools
        .call_tool(
            "search",
            json!({
                "query": "x",
                "space_id": TEST_SPACE_ID,
                "filter": { "include_page_globs": globs },
            }),
            &test_ctx(),
        )
        .await
        .expect_err("combined term bytes over the aggregate cap must be rejected");
    match err {
        AppError::Validation { message: msg, .. } => {
            assert!(
                msg.contains("combined search-term length"),
                "message names the aggregate violation: {msg}"
            );
            assert!(
                msg.contains(&SEARCH_TERM_TOTAL_BYTES_CAP.to_string()),
                "message names the aggregate cap: {msg}"
            );
        }
        other => panic!("expected Validation, got {other:?}"),
    }
}

/// #1607 boundary sanity: terms comfortably under both byte caps still
/// run — the byte guard must not reject legitimate calls.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_accepts_in_byte_budget_terms_1607() {
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

    // Modest free-text terms well under both byte caps must pass the
    // #1607 guard and execute the query. We assert only that the call
    // succeeds and returns a well-formed result — the globs / property
    // filter legitimately narrow the hit set, so the exact item count is
    // not what this test pins down.
    let result = tools
        .call_tool(
            "search",
            json!({
                "query": "needle",
                "space_id": TEST_SPACE_ID,
                "filter": {
                    "include_page_globs": ["*.md", "notes/**"],
                    "property_filters": [{ "key": "status", "value": "open" }],
                },
            }),
            &test_ctx(),
        )
        .await
        .expect("modest in-byte-budget terms must not trip the #1607 cap");
    assert!(
        result["items"].is_array(),
        "search must return a well-formed items array: {result}"
    );
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
    // PageResponse object with an `items` array. Confirms the
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
            Some(i64::from(i) + 1),
        )
        .await
        .unwrap();
    }
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let page1 = tools
        .call_tool(
            "list_pages",
            json!({"limit": 2, "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
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
            json!({"limit": 2, "cursor": cursor, "space_id": TEST_SPACE_ID}),
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

    // Previous test asserted page1/page2 didn't overlap but never
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
            json!({"limit": 2, "cursor": cursor2, "space_id": TEST_SPACE_ID}),
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
// Wire-level cursor pagination for list_tags / list_property_defs
// -------------------------------------------------------------------
//
// `list_tags` and `list_property_defs` both moved from a flat
// top-level array to the canonical `PageResponse { items, next_cursor,
// Has_more }` envelope. The two tests below exercise that
// directly through `tools.call_tool(...)` so a future regression on
// either side of the JSON boundary surfaces as a wire-shape failure.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_paginates_m85() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    // Seed 6 tag blocks; with limit=4 the first page must overflow and
    // the wire response must expose `items` + `next_cursor` + `has_more`.
    for i in 0..6 {
        mk_tag(&tools.pool, &mat, &space, &format!("tag-m85-{i}")).await;
    }
    settle(&mat).await;

    let resp = tools
        .call_tool(
            "list_tags",
            json!({"limit": 4, "space_id": space}),
            &test_ctx(),
        )
        .await
        .expect("list_tags wire call must succeed");
    // Wire shape — PageResponse JSON envelope.
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
        "has_more must be true when more rows remain past the cap",
    );
    assert!(
        resp["next_cursor"].is_string(),
        "next_cursor must be present when has_more is true, got {resp:?}",
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
        "has_more must be true when more rows remain past the cap",
    );
    assert!(
        resp["next_cursor"].is_string(),
        "next_cursor must be present when has_more is true, got {resp:?}",
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
            // Assign every seeded block to the test space
            // So the -required `space_id` filter returns them.
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
                test_space_search_filter(),
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
                let b = tools
                    .call_tool("list_pages", json!({"space_id": TEST_SPACE_ID}), &ctx)
                    .await;
                let d = tools
                    .call_tool(
                        "get_agenda",
                        json!({
                            "start_date": "2025-01-01",
                            "end_date": "2025-01-02",
                            "space_id": TEST_SPACE_ID,
                        }),
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
        "all {CLIENTS} × {ITERS} × {TOOLS_PER_ITER} calls must succeed",
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
// Happy + error path per *new* *_inner helper
// -------------------------------------------------------------------

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
    // Phase 7 — `get_page_inner` enforces space membership.
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
    // Must be a valid ULID shape so the BlockId::from_string gate
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
    let space = mk_space(&pool, "S").await;
    mk_tag(&pool, &mat, &space, "alpha").await;
    mk_tag(&pool, &mat, &space, "beta").await;
    settle(&mat).await;

    // Paginated; under default limit both tags are on page 1.
    let page = list_tags_inner(&pool, &space, None, Some(100))
        .await
        .unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(!page.has_more);
    assert!(page.next_cursor.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inner_list_tags_empty_db() {
    let (pool, _dir) = test_pool().await;
    let page = list_tags_inner(&pool, TEST_SPACE_ID, None, Some(100))
        .await
        .unwrap();
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
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;
    let result = tools
        .call_tool(
            "list_pages",
            json!({"space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_list_pages", result, {
        ".items[].id" => "[ULID]",
        ".items[].page_id" => "[ULID]",
        ".items[].last_modified_at" => "[TIMESTAMP]",
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
    // Bootstrap so the page lands in Personal via the back-fill sweep.
    crate::spaces::bootstrap_spaces_for_test(&tools.pool, DEV)
        .await
        .unwrap();
    let result = tools
        .call_tool(
            "get_page",
            json!({"page_id": page.id, "space_id": crate::spaces::SPACE_PERSONAL_ULID}),
            &test_ctx(),
        )
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
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;
    let result = tools
        .call_tool(
            "get_block",
            json!({"block_id": blk.id, "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
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
            json!({"block_id": target.id, "space_id": TEST_SPACE_ID}),
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
    let space = mk_space(&tools.pool, "S").await;
    mk_tag(&tools.pool, &mat, &space, "snap-tag").await;
    settle(&mat).await;
    let result = tools
        .call_tool("list_tags", json!({ "space_id": space }), &test_ctx())
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
    // `[]`, which never exercises the populated `AgendaRangeEntry`
    // wire shape (`block` / `date` / `source` / `projected`) — letting a
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
    crate::commands::tests::common::ensure_test_space(&tools.pool).await;
    crate::commands::tests::common::assign_to_space(&tools.pool, task.id.as_str(), TEST_SPACE_ID)
        .await;

    let result = tools
        .call_tool(
            "get_agenda",
            json!({"start_date": "2099-01-04", "end_date": "2099-01-04", "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_get_agenda", result, {
        // Response is now `PageResponse { items, next_cursor, has_more }`
        ".items[].block.id" => "[ULID]",
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_journal_for_date_response_shape() {
    let (tools, _mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "Personal").await;
    // #2719: the create carve-out is bounded to today ± 12 months, so drive
    // the snapshot with today's date and redact the (now wall-clock-derived)
    // `content` so the pinned wire shape stays stable across runs.
    let date = chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();
    let result = tools
        .call_tool(
            "journal_for_date",
            json!({"date": date, "space_id": space}),
            &test_ctx(),
        )
        .await
        .unwrap();
    insta::assert_yaml_snapshot!("tool_response_journal_for_date", result, {
        ".id" => "[ULID]",
        ".page_id" => "[ULID]",
        ".content" => "[DATE]",
    });
}

/// Slice 3: RO tools must NOT populate `LAST_APPEND` — they
/// don't append ops, so the dispatch layer should drain an empty
/// list and emit an `ActivityEntry` with `op_ref = None` and
/// `additional_op_refs = []`. Drive `list_pages` inside an
/// explicit scope and assert the drained list is empty on exit.
///
/// Storage is a `Vec`, so the assertion shifts from
/// `is_none()` to `is_empty()`. Multi-op RW tools are covered in
/// `mcp::server::tests::handle_tools_call_multi_op_tool_*`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_pages_does_not_populate_last_append() {
    use agaric_store::task_locals::{LAST_APPEND, take_appends};
    use std::cell::RefCell;

    let (tools, _mat, _dir) = mk_tools().await;

    let captured = LAST_APPEND
        .scope(RefCell::new(Vec::new()), async {
            tools
                .call_tool(
                    "list_pages",
                    json!({"space_id": TEST_SPACE_ID}),
                    &test_ctx(),
                )
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

// -------------------------------------------------------------------
// #5377 — `get_block` / `get_page` carry properties, tags and aliases
// -------------------------------------------------------------------

/// A page marked `template:: true`, with an alias and a tag, shows all three
/// on `get_block` and on `get_page`'s `page`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_and_get_page_return_properties_tags_and_aliases_5377() {
    let (tools, mat, _dir) = mk_tools().await;
    let page = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "Daily".into(),
        None,
        Some(0),
    )
    .await
    .unwrap();
    let tag = create_block_inner(
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
    settle(&mat).await;
    crate::spaces::bootstrap_spaces_for_test(&tools.pool, DEV)
        .await
        .unwrap();
    crate::commands::set_property_inner(
        &tools.pool,
        DEV,
        &mat,
        page.id.as_str().into(),
        "template".into(),
        Some("true".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    crate::commands::set_page_aliases_inner(
        &tools.pool,
        DEV,
        &mat,
        page.id.as_str(),
        vec!["Day".into()],
    )
    .await
    .unwrap();
    crate::commands::add_tag_inner(&tools.pool, DEV, &mat, page.id.clone(), tag.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let block = tools
        .call_tool(
            "get_block",
            json!({"block_id": page.id.clone(), "space_id": crate::spaces::SPACE_PERSONAL_ULID}),
            &test_ctx(),
        )
        .await
        .unwrap();
    let read = tools
        .call_tool(
            "get_page",
            json!({"page_id": page.id.clone(), "space_id": crate::spaces::SPACE_PERSONAL_ULID}),
            &test_ctx(),
        )
        .await
        .unwrap();
    for got in [&block, &read["page"]] {
        assert_eq!(got["id"], page.id.as_str());
        assert_eq!(
            got["properties"],
            json!([{
                "key": "template",
                "value_text": "true",
                "value_num": null,
                "value_date": null,
                "value_ref": null,
                "value_bool": null,
            }]),
            "got {got}"
        );
        assert_eq!(got["tags"], json!([tag.id.as_str()]), "got {got}");
        assert_eq!(got["aliases"], json!(["Day"]), "got {got}");
    }
}

/// None of them reads as empty arrays; a block that is not a page has no
/// `aliases` at all.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_without_properties_tags_or_aliases_returns_empty_arrays_5377() {
    let (tools, mat, _dir) = mk_tools().await;
    let page = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "Bare".into(),
        None,
        Some(0),
    )
    .await
    .unwrap();
    let content = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "c".into(),
        Some(page.id.clone()),
        Some(0),
    )
    .await
    .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let page_row = tools
        .call_tool(
            "get_block",
            json!({"block_id": page.id, "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .unwrap();
    assert_eq!(page_row["properties"], json!([]), "got {page_row}");
    assert_eq!(page_row["tags"], json!([]), "got {page_row}");
    assert_eq!(page_row["aliases"], json!([]), "got {page_row}");

    let content_row = tools
        .call_tool(
            "get_block",
            json!({"block_id": content.id, "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .unwrap();
    assert_eq!(content_row["properties"], json!([]), "got {content_row}");
    assert_eq!(content_row["tags"], json!([]), "got {content_row}");
    assert!(content_row.get("aliases").is_none(), "got {content_row}");
}

// -------------------------------------------------------------------
// #5375 — `get_page_markdown`
// -------------------------------------------------------------------

/// The page as an agent reads it: the title, the front matter, a link as the
/// linked page's title, and the block's `^ID`. The id is accepted in lower
/// case and echoed canonical, and the activity summary has the id prefix and
/// the line count, never the text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_markdown_happy_path_5375() {
    let (tools, mat, _dir) = mk_tools().await;
    let other = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "Other".into(),
        None,
        Some(0),
    )
    .await
    .unwrap();
    let page = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "Plan".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let child = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        format!("see [[{}]]", other.id.as_str()),
        Some(page.id.clone()),
        Some(0),
    )
    .await
    .unwrap();
    crate::commands::set_page_aliases_inner(
        &tools.pool,
        DEV,
        &mat,
        page.id.as_str(),
        vec!["Plan B".into()],
    )
    .await
    .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let args = json!({"page_id": page.id.as_str().to_lowercase(), "space_id": TEST_SPACE_ID});
    let result = tools
        .call_tool("get_page_markdown", args.clone(), &test_ctx())
        .await
        .expect("happy path");
    assert_eq!(result["page_id"], page.id.as_str());
    assert_eq!(
        result["markdown"],
        format!(
            "# Plan\n\n---\naliases: [Plan B]\n---\n\n- see [[Other]] ^{}\n",
            child.id.as_str()
        )
    );
    assert_eq!(
        crate::mcp::summarise::summarise("get_page_markdown", &args, &result),
        format!("get_page_markdown — {} (7 lines)", &page.id.as_str()[..8])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_markdown_unknown_page_is_not_found_5375() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool(
            "get_page_markdown",
            json!({"page_id": BlockId::new().into_string(), "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect_err("an unknown page must error");
    assert!(
        matches!(err, AppError::NotFound(_)),
        "an unknown page must surface as AppError::NotFound (→ -32001), got {err:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_markdown_on_a_content_block_is_validation_5375() {
    let (tools, mat, _dir) = mk_tools().await;
    let page = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "P".into(),
        None,
        Some(0),
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
        Some(0),
    )
    .await
    .unwrap();
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let err = tools
        .call_tool(
            "get_page_markdown",
            json!({"page_id": content.id, "space_id": TEST_SPACE_ID}),
            &test_ctx(),
        )
        .await
        .expect_err("a content block is not a page");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "a non-page must surface as AppError::Validation (→ -32602), got {err:?}",
    );
}

// -------------------------------------------------------------------
// page_history / block_history (#5400)
// -------------------------------------------------------------------

async fn mk_page_in(tools: &ReadOnlyTools, mat: &Materializer, space: &str) -> String {
    crate::commands::create_block_inner_with_space(
        &tools.pool,
        DEV,
        mat,
        "page".into(),
        "History page".into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(space)),
        None,
    )
    .await
    .unwrap()
    .id
    .into_string()
}

async fn mk_child(tools: &ReadOnlyTools, mat: &Materializer, parent: &str, text: &str) -> String {
    create_block_inner(
        &tools.pool,
        DEV,
        mat,
        "content".into(),
        text.into(),
        Some(BlockId::from_trusted(parent)),
        None,
    )
    .await
    .unwrap()
    .id
    .into_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_history_pages_across_a_cursor_with_agent_and_user_ops_5400() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let page = mk_page_in(&tools, &mat, &space).await;
    let user_block = mk_child(&tools, &mat, &page, "user text").await;
    let agent_block = agaric_store::task_locals::ACTOR
        .scope(test_ctx(), mk_child(&tools, &mat, &page, "agent text"))
        .await;
    settle(&mat).await;
    let mut expected: Vec<(String, i64)> = sqlx::query_as(
        "SELECT device_id, seq FROM op_log WHERE block_id IN (?, ?, ?) ORDER BY seq",
    )
    .bind(&page)
    .bind(&user_block)
    .bind(&agent_block)
    .fetch_all(&tools.pool)
    .await
    .unwrap();
    assert!(
        expected.len() > 2,
        "the page must span more than one history page"
    );

    let mut seen: Vec<(String, i64)> = Vec::new();
    let mut origins: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut args = json!({ "page_id": page, "space_id": space, "limit": 2 });
        if let Some(c) = &cursor {
            args["cursor"] = json!(c);
        }
        let resp = tools
            .call_tool("page_history", args, &test_ctx())
            .await
            .unwrap();
        for row in resp["items"].as_array().unwrap() {
            seen.push((
                row["device_id"].as_str().unwrap().into(),
                row["seq"].as_i64().unwrap(),
            ));
            origins.push(row["origin"].as_str().unwrap().into());
            if row["block_id"] == json!(agent_block) && row["op_type"] == "create_block" {
                assert_eq!(row["after"], "agent text");
            }
        }
        if resp["has_more"] != json!(true) {
            break;
        }
        cursor = resp["next_cursor"].as_str().map(str::to_owned);
    }
    seen.sort_by_key(|(_, seq)| *seq);
    expected.sort_by_key(|(_, seq)| *seq);
    assert_eq!(
        seen, expected,
        "every op exactly once across the cursor boundary"
    );
    assert!(origins.iter().any(|o| o == "user"), "got {origins:?}");
    assert!(
        origins.iter().any(|o| o == "agent:test-agent"),
        "got {origins:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_history_refuses_a_page_in_another_space_5400() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let other = mk_space(&tools.pool, "Other").await;
    let page = mk_page_in(&tools, &mat, &space).await;
    let err = tools
        .call_tool(
            "page_history",
            json!({ "page_id": page, "space_id": other }),
            &test_ctx(),
        )
        .await
        .expect_err("a page in another space must be refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

/// `__all__` is the history reader's whole-vault sentinel.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_history_refuses_the_all_pages_sentinel_5400() {
    let (tools, _mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let err = tools
        .call_tool(
            "page_history",
            json!({ "page_id": "__all__", "space_id": space }),
            &test_ctx(),
        )
        .await
        .expect_err("the sentinel must be refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn block_history_shows_before_and_a_clipped_after_5400() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let page = mk_page_in(&tools, &mat, &space).await;
    let block = mk_child(&tools, &mat, &page, "first").await;
    let long = "日本".repeat(60);
    crate::commands::edit_block_inner(&tools.pool, DEV, &mat, block.clone().into(), long.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let resp = tools
        .call_tool(
            "block_history",
            json!({ "block_id": block, "space_id": space }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let items = resp["items"].as_array().unwrap();
    let edit = &items[0];
    assert_eq!(edit["op_type"], "edit_block");
    assert_eq!(edit["origin"], "user");
    assert_eq!(edit["before"], "first");
    let after: String = long.chars().take(HISTORY_TEXT_CAP).chain(['…']).collect();
    assert_eq!(edit["after"], after.as_str());
    assert_eq!(items.last().unwrap()["op_type"], "create_block");
}

/// The batched lookup must answer what the per-row `find_prior_text` it
/// replaced answers, for every edit row on the page.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_prior_texts_match_find_prior_text_per_row() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let page = mk_page_in(&tools, &mat, &space).await;
    let a = mk_child(&tools, &mat, &page, "a0").await;
    let b = mk_child(&tools, &mat, &page, "b0").await;
    for (block, text) in [(&a, "a1"), (&b, "b1"), (&a, "a2"), (&b, "b2"), (&a, "a3")] {
        crate::commands::edit_block_inner(
            &tools.pool,
            DEV,
            &mat,
            block.clone().into(),
            text.into(),
        )
        .await
        .unwrap();
    }
    settle(&mat).await;
    let scope = SpaceScope::Active(SpaceId::from_trusted(&space));
    let resp = list_page_history_inner(&tools.pool, page, None, &scope, None, Some(100))
        .await
        .unwrap();
    let payloads: Vec<Value> = resp
        .items
        .iter()
        .map(|e| serde_json::from_str(&e.payload).unwrap())
        .collect();

    let batched = prior_texts(&tools.pool, &resp.items, &payloads)
        .await
        .unwrap();

    let mut oracle = HashMap::new();
    for (entry, payload) in resp.items.iter().zip(&payloads) {
        if entry.op_type != "edit_block" {
            continue;
        }
        let prior = agaric_engine::reverse::find_prior_text(
            &tools.pool,
            payload_block_id(payload).unwrap(),
            entry.created_at,
            entry.seq,
            &entry.device_id,
        )
        .await
        .unwrap()
        .unwrap();
        oracle.insert((entry.device_id.clone(), entry.seq), prior);
    }
    assert_eq!(oracle.len(), 5);
    assert_eq!(batched, oracle);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn block_history_refuses_a_block_in_another_space_5400() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let other = mk_space(&tools.pool, "Other").await;
    let page = mk_page_in(&tools, &mat, &space).await;
    let block = mk_child(&tools, &mat, &page, "text").await;
    let err = tools
        .call_tool(
            "block_history",
            json!({ "block_id": block, "space_id": other }),
            &test_ctx(),
        )
        .await
        .expect_err("a block in another space must be refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

// -------------------------------------------------------------------
// get_journal / list_journal (#5396)
// -------------------------------------------------------------------

fn day(s: &str) -> chrono::NaiveDate {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

/// The journal page for `date` in `space` with `blocks` children.
async fn mk_day(
    tools: &ReadOnlyTools,
    mat: &Materializer,
    space: &str,
    date: &str,
    blocks: usize,
) -> BlockId {
    let page = journal_for_date_inner(&tools.pool, DEV, mat, day(date), space)
        .await
        .unwrap()
        .id;
    for i in 0..blocks {
        create_block_inner(
            &tools.pool,
            DEV,
            mat,
            "content".into(),
            format!("note {i}"),
            Some(page.clone()),
            None,
        )
        .await
        .unwrap();
    }
    page
}

async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// A day reads as `get_page_markdown` renders it, `today` and `yesterday`
/// resolve against the date the handler is given, and a missing day is an
/// empty result that writes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_journal_reads_a_day_and_never_creates_one_5396() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let page = mk_day(&tools, &mat, &space, "2026-03-01", 1).await;
    settle(&mat).await;
    let markdown = get_page_for_agent_inner(&tools.pool, page.as_str())
        .await
        .unwrap();
    assert!(markdown.contains("- note 0 ^"), "got {markdown:?}");

    for (date, today) in [(None, "2026-03-01"), (Some("yesterday"), "2026-03-02")] {
        let mut args = json!({ "space_id": space.to_lowercase() });
        if let Some(date) = date {
            args["date"] = json!(date);
        }
        let result = handle_get_journal(&tools.pool, args, day(today))
            .await
            .unwrap();
        assert_eq!(
            result,
            json!({ "date": "2026-03-01", "page_id": page.as_str(), "markdown": markdown }),
            "{date:?} read from {today}"
        );
    }

    let before = op_count(&tools.pool).await;
    let result = handle_get_journal(
        &tools.pool,
        json!({ "space_id": space, "date": "2026-03-02" }),
        day("2026-03-01"),
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        json!({ "date": "2026-03-02", "page_id": null, "markdown": "" })
    );
    settle(&mat).await;
    assert_eq!(
        op_count(&tools.pool).await,
        before,
        "a missing day writes nothing"
    );
    assert!(
        get_journal_page_by_date_inner(&tools.pool, "2026-03-02", &space)
            .await
            .unwrap()
            .is_none()
    );

    let err = tools
        .call_tool(
            "get_journal",
            json!({ "space_id": space, "date": "2026-02-30" }),
            &test_ctx(),
        )
        .await
        .expect_err("a bad date is refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    let err = tools
        .call_tool("get_journal", json!({ "space_id": "nope" }), &test_ctx())
        .await
        .expect_err("a malformed space is refused");
    assert!(matches!(err, AppError::Ulid(_)), "got {err:?}");
}

/// Paged two at a time, every day in the range comes back once, in order,
/// with its block count; a day outside the range or the space never does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_journal_pages_every_day_once_across_cursors_5396() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let other = mk_space(&tools.pool, "Other").await;
    for (date, blocks) in [
        ("2026-03-03", 2),
        ("2026-03-01", 0),
        ("2026-03-04", 1),
        ("2026-03-02", 3),
        ("2026-03-05", 1),
        ("2026-02-28", 1),
    ] {
        mk_day(&tools, &mat, &space, date, blocks).await;
    }
    mk_day(&tools, &mat, &other, "2026-03-02", 1).await;
    settle(&mat).await;

    let mut days = Vec::new();
    let mut cursor: Option<String> = None;
    let mut calls = 0;
    loop {
        let mut args =
            json!({ "space_id": space, "from": "2026-03-01", "to": "2026-03-05", "limit": 2 });
        if let Some(c) = &cursor {
            args["cursor"] = json!(c);
        }
        let resp = tools
            .call_tool("list_journal", args, &test_ctx())
            .await
            .unwrap();
        calls += 1;
        for item in resp["items"].as_array().unwrap() {
            days.push((
                item["date"].as_str().unwrap().to_owned(),
                item["block_count"].as_i64().unwrap(),
            ));
        }
        match resp["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_owned()),
            None => break,
        }
    }
    let want: Vec<(String, i64)> = [
        ("2026-03-01", 0),
        ("2026-03-02", 3),
        ("2026-03-03", 2),
        ("2026-03-04", 1),
        ("2026-03-05", 1),
    ]
    .into_iter()
    .map(|(d, n)| (d.to_owned(), n))
    .collect();
    assert_eq!(days, want);
    assert_eq!(calls, 3);

    for args in [
        json!({ "space_id": space, "from": "2026-03-05", "to": "2026-03-01" }),
        json!({ "space_id": space, "from": "2026-03-01", "to": "2026-03-05", "limit": 101 }),
        json!({ "space_id": space, "from": "March", "to": "2026-03-05" }),
    ] {
        let err = tools
            .call_tool("list_journal", args.clone(), &test_ctx())
            .await
            .expect_err("refused");
        assert!(
            matches!(err, AppError::Validation { .. }),
            "{args}: {err:?}"
        );
    }
}

// -------------------------------------------------------------------
// list_trash (#5399)
// -------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_trash_pages_one_space_across_a_cursor_5399() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let other = mk_space(&tools.pool, "Other").await;
    let page = mk_page_in(&tools, &mat, &space).await;
    let other_page = mk_page_in(&tools, &mat, &other).await;
    let parent = mk_child(&tools, &mat, &page, "parent").await;
    mk_child(&tools, &mat, &parent, "deleted with its parent").await;
    let mut roots = vec![parent];
    for text in ["a", "b"] {
        roots.push(mk_child(&tools, &mat, &page, text).await);
    }
    let foreign = mk_child(&tools, &mat, &other_page, "other space").await;
    for id in roots.iter().chain([&foreign]) {
        crate::commands::delete_block_inner(&tools.pool, DEV, &mat, BlockId::from_trusted(id))
            .await
            .unwrap();
    }
    settle(&mat).await;

    let first = tools
        .call_tool(
            "list_trash",
            json!({ "space_id": space, "limit": 2 }),
            &test_ctx(),
        )
        .await
        .unwrap();
    assert_eq!(first["has_more"], json!(true));
    let second = tools
        .call_tool(
            "list_trash",
            json!({ "space_id": space, "limit": 2, "cursor": first["next_cursor"] }),
            &test_ctx(),
        )
        .await
        .unwrap();
    assert_eq!(second["has_more"], json!(false));
    let rows: Vec<&Value> = [&first, &second]
        .iter()
        .flat_map(|page| page["items"].as_array().unwrap())
        .collect();
    assert!(
        rows.iter().all(|row| row["deleted_at"].is_i64()),
        "restore_block needs it"
    );
    let mut seen: Vec<String> = rows
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    seen.sort();
    roots.sort();
    assert_eq!(seen, roots, "each deletion root of the space exactly once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_trash_refuses_a_space_id_that_is_not_a_ulid_5399() {
    let (tools, _mat, _dir) = mk_tools().await;
    let err = tools
        .call_tool("list_trash", json!({ "space_id": "__all__" }), &test_ctx())
        .await
        .expect_err("the space must be named");
    assert!(matches!(err, AppError::Ulid(_)), "got {err:?}");
}

// -------------------------------------------------------------------
// Names in place of ids (#5397)
// -------------------------------------------------------------------

async fn mk_named(
    tools: &ReadOnlyTools,
    mat: &Materializer,
    space: &str,
    block_type: &str,
    name: &str,
) -> String {
    crate::commands::create_block_inner_with_space(
        &tools.pool,
        DEV,
        mat,
        block_type.into(),
        name.into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(space)),
        None,
    )
    .await
    .unwrap()
    .id
    .into_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_matches_a_title_in_any_case_an_alias_and_a_tag_5397() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let other = mk_space(&tools.pool, "Other").await;
    let page = mk_named(&tools, &mat, &space, "page", "Project X").await;
    mk_named(&tools, &mat, &other, "page", "Elsewhere").await;
    crate::commands::set_page_aliases_inner(&tools.pool, DEV, &mat, &page, vec!["px".into()])
        .await
        .unwrap();
    let tag = mk_named(&tools, &mat, &space, "tag", "work").await;
    settle(&mat).await;

    let result = tools
        .call_tool(
            "resolve",
            json!({
                "names": ["Project X", "project x", " PX ", " Work ", "Elsewhere", "nothing"],
                "space_id": space,
            }),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    let page_ids: Vec<&Value> = result
        .as_array()
        .unwrap()
        .iter()
        .map(|a| &a["page_id"])
        .collect();
    assert_eq!(
        page_ids,
        [
            &json!(page),
            &json!(page),
            &json!(page),
            &Value::Null,
            &Value::Null,
            &Value::Null
        ],
        "exact title, another case and an alias name the page; another space's page is not \
         matched; got {result}"
    );
    let tag_ids: Vec<&Value> = result
        .as_array()
        .unwrap()
        .iter()
        .map(|a| &a["tag_id"])
        .collect();
    assert_eq!(
        tag_ids,
        [
            &Value::Null,
            &Value::Null,
            &Value::Null,
            &json!(tag),
            &Value::Null,
            &Value::Null
        ],
        "got {result}"
    );
    assert_eq!(result[3]["name"], " Work ", "each answer echoes its name");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_lists_the_pages_a_name_ties_between_5397() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let a = mk_named(&tools, &mat, &space, "page", "Dup").await;
    let b = mk_named(&tools, &mat, &space, "page", "DUP").await;
    settle(&mat).await;

    let result = tools
        .call_tool(
            "resolve",
            json!({ "names": ["dup", "Dup"], "space_id": space }),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    assert_eq!(
        result,
        json!([
            {
                "name": "dup",
                "page_id": null,
                "page_candidates": [{ "id": a, "title": "Dup" }, { "id": b, "title": "DUP" }],
                "tag_id": null,
            },
            { "name": "Dup", "page_id": a, "tag_id": null },
        ]),
        "a case tie lists both; the exact title wins it",
    );

    let err = tools
        .call_tool(
            "resolve",
            json!({ "names": ["dup"], "space_id": "__all__" }),
            &test_ctx(),
        )
        .await
        .expect_err("the space must be named");
    assert!(matches!(err, AppError::Ulid(_)), "got {err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_takes_a_parent_page_and_tags_by_name_5397() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let page = mk_named(&tools, &mat, &space, "page", "Inbox").await;
    let tag = mk_named(&tools, &mat, &space, "tag", "work").await;
    let hit = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "needle tagged".into(),
        Some(BlockId::from_trusted(&page)),
        None,
    )
    .await
    .unwrap();
    crate::commands::add_tag_inner(
        &tools.pool,
        DEV,
        &mat,
        hit.id.clone(),
        BlockId::from_trusted(&tag),
    )
    .await
    .unwrap();
    create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "content".into(),
        "needle untagged".into(),
        Some(BlockId::from_trusted(&page)),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let result = tools
        .call_tool(
            "search",
            json!({
                "query": "needle",
                "space_id": space,
                "parent_id": "inbox",
                "tag_ids": ["WORK"],
            }),
            &test_ctx(),
        )
        .await
        .expect("happy path");
    let ids: Vec<&str> = result["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [hit.id.as_str()]);

    let err = tools
        .call_tool(
            "search",
            json!({ "query": "needle", "space_id": space, "tag_ids": ["nope"] }),
            &test_ctx(),
        )
        .await
        .expect_err("an unknown tag name must be refused");
    let message = err.to_string();
    assert!(
        matches!(err, AppError::Validation { .. }) && message.contains("`tag_ids` 'nope'"),
        "got {message}"
    );
}

// -------------------------------------------------------------------
// #5415 — `list_pages`, `get_page`, `get_page_markdown`, `get_block`
// read one space
// -------------------------------------------------------------------

/// The reads that took no space now refuse a call without one, naming the
/// field.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_without_space_id_are_refused_5415() {
    let (tools, _mat, _dir) = mk_tools().await;
    let id = BlockId::new().into_string();
    for (tool, args) in [
        (TOOL_LIST_PAGES, json!({})),
        (TOOL_GET_PAGE, json!({ "page_id": id })),
        (TOOL_GET_PAGE_MARKDOWN, json!({ "page_id": id })),
        (TOOL_GET_BLOCK, json!({ "block_id": id })),
    ] {
        let err = tools
            .call_tool(tool, args, &test_ctx())
            .await
            .expect_err("a call without space_id must be refused");
        let message = err.to_string();
        assert!(
            matches!(err, AppError::Validation { .. })
                && message.contains("missing field `space_id`"),
            "{tool}: got {message}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_pages_lists_only_the_pages_of_its_space_5415() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let other = mk_space(&tools.pool, "Other").await;
    let page = mk_page_in(&tools, &mat, &space).await;
    let other_page = mk_page_in(&tools, &mat, &other).await;
    settle(&mat).await;

    for (space, expected) in [(&space, &page), (&other, &other_page)] {
        let resp = tools
            .call_tool("list_pages", json!({ "space_id": space }), &test_ctx())
            .await
            .unwrap();
        let ids: Vec<&str> = resp["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, [expected.as_str()], "pages of space {space}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_refuses_a_page_in_another_space_5415() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let other = mk_space(&tools.pool, "Other").await;
    let page = mk_page_in(&tools, &mat, &space).await;
    settle(&mat).await;

    let read = tools
        .call_tool(
            "get_page",
            json!({ "page_id": page, "space_id": space }),
            &test_ctx(),
        )
        .await
        .expect("a page in the named space is read");
    assert_eq!(read["page"]["id"], page.as_str());

    let err = tools
        .call_tool(
            "get_page",
            json!({ "page_id": page, "space_id": other }),
            &test_ctx(),
        )
        .await
        .expect_err("a page in another space must be refused");
    let message = err.to_string();
    assert!(
        matches!(err, AppError::Validation { .. })
            && message.contains(&format!("not in current space '{other}'")),
        "got {message}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_markdown_refuses_a_page_in_another_space_5415() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let other = mk_space(&tools.pool, "Other").await;
    let page = mk_page_in(&tools, &mat, &space).await;
    settle(&mat).await;

    let read = tools
        .call_tool(
            "get_page_markdown",
            json!({ "page_id": page, "space_id": space }),
            &test_ctx(),
        )
        .await
        .expect("a page in the named space is read");
    assert_eq!(read["page_id"], page.as_str());

    let err = tools
        .call_tool(
            "get_page_markdown",
            json!({ "page_id": page, "space_id": other }),
            &test_ctx(),
        )
        .await
        .expect_err("a page in another space must be refused");
    let message = err.to_string();
    assert!(
        matches!(err, AppError::Validation { .. })
            && message.contains(&format!("belongs to space '{space}'")),
        "got {message}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_block_refuses_a_block_in_another_space_5415() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let other = mk_space(&tools.pool, "Other").await;
    let page = mk_page_in(&tools, &mat, &space).await;
    let block = mk_child(&tools, &mat, &page, "text").await;
    settle(&mat).await;

    let read = tools
        .call_tool(
            "get_block",
            json!({ "block_id": block, "space_id": space }),
            &test_ctx(),
        )
        .await
        .expect("a block in the named space is read");
    assert_eq!(read["id"], block.as_str());

    let err = tools
        .call_tool(
            "get_block",
            json!({ "block_id": block, "space_id": other }),
            &test_ctx(),
        )
        .await
        .expect_err("a block in another space must be refused");
    let message = err.to_string();
    assert!(
        matches!(err, AppError::Validation { .. })
            && message.contains(&format!("belongs to space '{space}'")),
        "got {message}"
    );
}

// -------------------------------------------------------------------
// query (#5398)
// -------------------------------------------------------------------

/// A block created in 2016 (its ULID's time) with no op, so it was last
/// edited then: commands stamp every block they write with now.
const OLD_BLOCK: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/// The vault the `query` tests ask their questions of. Another space holds an
/// open block with estimate 9 due 2026-10-12, so each answer also shows it
/// stays out.
struct QueryVault {
    tools: ReadOnlyTools,
    _mat: Materializer,
    _dir: TempDir,
    space: String,
    alpha: String,
    beta: String,
    target: String,
    tag: String,
    /// Links the target page, open, estimate 5, owner `me`, due 2026-10-12.
    /// On `alpha`, which carries `tag`.
    a1: String,
    /// Open, estimate 2, due 2026-10-25. On `alpha`.
    a2: String,
    /// Links the target page, done, due 2026-10-15. On `beta`.
    b1: String,
    /// Open, estimate 4. On `beta`.
    b2: String,
}

async fn mk_titled_page(
    tools: &ReadOnlyTools,
    mat: &Materializer,
    space: &str,
    title: &str,
) -> String {
    crate::commands::create_block_inner_with_space(
        &tools.pool,
        DEV,
        mat,
        "page".into(),
        title.into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(space)),
        None,
    )
    .await
    .unwrap()
    .id
    .into_string()
}

async fn mk_task(
    tools: &ReadOnlyTools,
    mat: &Materializer,
    page: &str,
    content: &str,
    state: &str,
    estimate: Option<f64>,
    due: Option<&str>,
) -> String {
    let id = mk_child(tools, mat, page, content).await;
    crate::commands::set_todo_state_inner(
        &tools.pool,
        DEV,
        mat,
        id.as_str().into(),
        Some(state.into()),
    )
    .await
    .unwrap();
    if let Some(estimate) = estimate {
        crate::commands::set_property_inner(
            &tools.pool,
            DEV,
            mat,
            id.as_str().into(),
            "estimate".into(),
            None,
            Some(estimate),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    }
    if let Some(due) = due {
        crate::commands::set_due_date_inner(
            &tools.pool,
            DEV,
            mat,
            id.as_str().into(),
            Some(due.into()),
        )
        .await
        .unwrap();
    }
    id
}

async fn mk_query_vault() -> QueryVault {
    let (tools, mat, dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let other = mk_space(&tools.pool, "Other").await;
    let alpha = mk_titled_page(&tools, &mat, &space, "Alpha").await;
    let beta = mk_titled_page(&tools, &mat, &space, "Beta").await;
    let target = mk_titled_page(&tools, &mat, &space, "Target").await;
    let tag = mk_tag(&tools.pool, &mat, &space, "project").await;
    crate::commands::add_tag_inner(
        &tools.pool,
        DEV,
        &mat,
        BlockId::from_trusted(&alpha),
        BlockId::from_trusted(&tag),
    )
    .await
    .unwrap();
    let link = format!("see [[{target}]]");
    let a1 = mk_task(
        &tools,
        &mat,
        &alpha,
        &link,
        "TODO",
        Some(5.0),
        Some("2026-10-12"),
    )
    .await;
    crate::commands::set_property_inner(
        &tools.pool,
        DEV,
        &mat,
        a1.as_str().into(),
        "owner".into(),
        Some("me".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let a2 = mk_task(
        &tools,
        &mat,
        &alpha,
        "plain",
        "TODO",
        Some(2.0),
        Some("2026-10-25"),
    )
    .await;
    let b1 = mk_task(&tools, &mat, &beta, &link, "DONE", None, Some("2026-10-15")).await;
    let b2 = mk_task(&tools, &mat, &beta, "sized", "TODO", Some(4.0), None).await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
         VALUES (?, 'content', 'old note', ?, 9, ?, ?)",
    )
    .bind(OLD_BLOCK)
    .bind(&alpha)
    .bind(&alpha)
    .bind(&space)
    .execute(&tools.pool)
    .await
    .unwrap();
    let elsewhere = mk_titled_page(&tools, &mat, &other, "Elsewhere").await;
    mk_task(
        &tools,
        &mat,
        &elsewhere,
        "elsewhere",
        "TODO",
        Some(9.0),
        Some("2026-10-12"),
    )
    .await;
    settle(&mat).await;
    QueryVault {
        tools,
        _mat: mat,
        _dir: dir,
        space,
        alpha,
        beta,
        target,
        tag,
        a1,
        a2,
        b1,
        b2,
    }
}

fn leaf(primitive: Value) -> Value {
    let mut leaf = json!({ "type": "Leaf" });
    leaf["primitive"] = primitive;
    leaf
}

fn and(children: Vec<Value>) -> Value {
    json!({ "type": "And", "children": Value::Array(children) })
}

impl QueryVault {
    async fn query(&self, mut args: Value) -> Result<Value, AppError> {
        args["space_id"] = json!(self.space);
        self.tools.call_tool("query", args, &test_ctx()).await
    }

    async fn ids(&self, filter: Value) -> Vec<String> {
        let result = self.query(json!({ "where": filter })).await.unwrap();
        let mut ids: Vec<String> = result["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_owned())
            .collect();
        ids.sort();
        ids
    }
}

fn sorted(ids: &[&String]) -> Vec<String> {
    let mut ids: Vec<String> = ids.iter().map(|id| (*id).clone()).collect();
    ids.sort();
    ids
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_what_was_edited_since_a_date_5398() {
    let v = mk_query_vault().await;
    let ids = v
        .ids(and(vec![
            leaf(json!({ "type": "BlockType", "values": ["content"], "exclude": false })),
            leaf(json!({ "type": "LastEdited", "spec": { "type": "Range", "start": "2020-01-01", "end": "2999-12-31" } })),
        ]))
        .await;
    assert_eq!(
        ids,
        sorted(&[&v.a1, &v.a2, &v.b1, &v.b2]),
        "not the 2016 block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_a_numeric_property_above_a_bound_5398() {
    let v = mk_query_vault().await;
    let result = v
        .query(json!({ "where": leaf(json!({
            "type": "HasProperty",
            "key": "estimate",
            "predicate": { "type": "Gt", "value": { "type": "Num", "value": 3 } },
        })), "sort": [{ "source": { "type": "Column", "name": "created" } }] }))
        .await
        .unwrap();
    let rows = result["rows"].as_array().unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![v.a1.as_str(), v.b2.as_str()]);
    assert_eq!(rows[0]["page_title"], json!("Alpha"));
    assert_eq!(rows[1]["page_title"], json!("Beta"));
    let properties = rows[0]["properties"].as_array().unwrap();
    assert_eq!(
        properties.len(),
        1,
        "only the property `where` reads: {properties:?}"
    );
    assert_eq!(properties[0]["key"], json!("estimate"));
    assert_eq!(properties[0]["value_num"], json!(5.0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_due_between_two_dates_5398() {
    let v = mk_query_vault().await;
    let ids = v
        .ids(leaf(json!({
            "type": "DueDate",
            "predicate": { "type": "Between", "from": "2026-10-10", "to": "2026-10-20" },
        })))
        .await;
    assert_eq!(ids, sorted(&[&v.a1, &v.b1]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_blocks_linking_a_page_on_pages_with_a_tag_5398() {
    let v = mk_query_vault().await;
    let result = v
        .query(json!({ "where": and(vec![
            leaf(json!({ "type": "LinksTo", "target": v.target })),
            leaf(json!({ "type": "HasParentMatching", "matcher": leaf(json!({ "type": "Tag", "tag": v.tag })) })),
        ]) }))
        .await
        .unwrap();
    let rows = result["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["id"], json!(v.a1));
    assert_eq!(rows[0]["page_id"], json!(v.alpha));
    assert_eq!(rows[0]["page_title"], json!("Alpha"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_counts_open_todos_per_page_5398() {
    let v = mk_query_vault().await;
    let result = v
        .query(json!({
            "where": leaf(json!({ "type": "State", "values": ["TODO"] })),
            "group_by": { "type": "Page" },
            "aggregate": [{ "op": "count" }],
        }))
        .await
        .unwrap();
    assert_eq!(result["rows"], json!([]));
    assert_eq!(result["aggregates"][0]["count"], json!(3), "{result}");
    let mut groups: Vec<Value> = result["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| json!([g["key"], g["title"], g["count"]]))
        .collect();
    groups.sort_by_key(|g| g[0].as_str().unwrap().to_owned());
    let mut expected = vec![json!([v.alpha, "Alpha", 2]), json!([v.beta, "Beta", 1])];
    expected.sort_by_key(|g| g[0].as_str().unwrap().to_owned());
    assert_eq!(groups, expected);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_pages_one_space_across_a_cursor_5398() {
    let v = mk_query_vault().await;
    let content = leaf(json!({ "type": "BlockType", "values": ["content"], "exclude": false }));
    let first = v
        .query(json!({ "where": content, "limit": 3 }))
        .await
        .unwrap();
    assert_eq!(first["has_more"], json!(true));
    assert_eq!(first["total_count"], json!(5));
    let second = v
        .query(json!({ "where": content, "limit": 3, "cursor": first["next_cursor"] }))
        .await
        .unwrap();
    assert_eq!(second["has_more"], json!(false));
    let mut ids: Vec<String> = [&first, &second]
        .iter()
        .flat_map(|page| page["rows"].as_array().unwrap())
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    let old = OLD_BLOCK.to_owned();
    assert_eq!(
        ids,
        sorted(&[&v.a1, &v.a2, &v.b1, &v.b2, &old]),
        "each of the space's blocks once"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_names_an_unknown_predicate_5398() {
    let v = mk_query_vault().await;
    let err = v
        .query(json!({ "where": leaf(json!({ "type": "Estimate", "above": 3 })) }))
        .await
        .expect_err("no such predicate");
    assert!(
        matches!(&err, AppError::Validation { .. }) && err.to_string().contains("`Estimate`"),
        "{err:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_rejects_a_bad_date_range_5398() {
    let v = mk_query_vault().await;
    let due = |from: &str, to: &str| json!({ "type": "DueDate", "predicate": { "type": "Between", "from": from, "to": to } });
    for primitive in [
        due("2026-10-20", "2026-10-10"),
        due("2026-10-1", "2026-10-20"),
        json!({ "type": "Created", "after": "last week" }),
    ] {
        let err = v
            .query(json!({ "where": leaf(primitive.clone()) }))
            .await
            .expect_err("a range that cannot match as written");
        assert!(
            matches!(err, AppError::Validation { .. }),
            "{primitive}: {err:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_rejects_a_limit_out_of_range_5398() {
    let v = mk_query_vault().await;
    let err = v
        .query(json!({ "where": and(vec![]), "limit": LIST_RESULT_CAP + 1 }))
        .await
        .expect_err("rejected, not clamped");
    assert!(matches!(err, AppError::Validation { .. }), "{err:?}");
}

// -------------------------------------------------------------------
// #5402 — byte caps: a large read stops early and continues from a cursor
// -------------------------------------------------------------------

/// More content than one response carries, alone.
const OVER_CAP: usize = RESPONSE_BYTES_CAP + 1;
/// Two of these fit one response, with room for each block's ids.
const HALF_CAP: usize = RESPONSE_BYTES_CAP / 2 - 64;

/// A page titled `title` whose children hold `sizes` bytes of content each,
/// in order. Returns the page id and the child ids.
async fn mk_page_of_sizes(
    tools: &ReadOnlyTools,
    mat: &Materializer,
    title: &str,
    sizes: &[usize],
) -> (String, Vec<String>) {
    let page = create_block_inner(
        &tools.pool,
        DEV,
        mat,
        "page".into(),
        title.into(),
        None,
        None,
    )
    .await
    .unwrap();
    let mut children = Vec::new();
    for size in sizes {
        let child = create_block_inner(
            &tools.pool,
            DEV,
            mat,
            "content".into(),
            "x".repeat(*size),
            Some(page.id.clone()),
            None,
        )
        .await
        .unwrap();
        children.push(child.id.into_string());
    }
    (page.id.into_string(), children)
}

/// Each response of `tool` from the first, following `next_cursor` while
/// `has_more`; `args` without the cursor.
async fn read_all(tools: &ReadOnlyTools, tool: &str, args: &Value) -> Vec<Value> {
    let mut responses: Vec<Value> = Vec::new();
    for _ in 0..4 {
        let mut args = args.clone();
        if let Some(last) = responses.last() {
            if last["has_more"] != json!(true) {
                return responses;
            }
            args["cursor"] = last["next_cursor"].clone();
        }
        responses.push(tools.call_tool(tool, args, &test_ctx()).await.unwrap());
    }
    panic!("{tool} did not finish in 4 responses: {responses:?}");
}

/// A child larger than the cap comes back alone; the two after it share the
/// next response; every child comes back once, in order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_stops_at_the_byte_cap_and_continues_5402() {
    let (tools, mat, _dir) = mk_tools().await;
    let (page, children) =
        mk_page_of_sizes(&tools, &mat, "Big", &[OVER_CAP, HALF_CAP, HALF_CAP]).await;
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let responses = read_all(
        &tools,
        "get_page",
        &json!({"page_id": page, "space_id": TEST_SPACE_ID}),
    )
    .await;
    let pages: Vec<(Vec<String>, Value)> = responses
        .iter()
        .map(|r| {
            let ids: Vec<String> = r["children"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["id"].as_str().unwrap().to_owned())
                .collect();
            (ids, r["truncated"].clone())
        })
        .collect();
    assert_eq!(
        pages,
        vec![
            (vec![children[0].clone()], json!(true)),
            (vec![children[1].clone(), children[2].clone()], json!(false)),
        ]
    );
}

/// Whole groups up to the cap, the group cursor resuming after the last one
/// kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_backlinks_stops_at_the_byte_cap_and_continues_5402() {
    let (tools, mat, _dir) = mk_tools().await;
    let target = create_block_inner(
        &tools.pool,
        DEV,
        &mat,
        "page".into(),
        "Target".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let link = format!("[[{}]] ", target.id.as_str());
    let mut sources = Vec::new();
    for (title, size) in [("A", OVER_CAP), ("B", HALF_CAP), ("C", HALF_CAP)] {
        let page = create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "page".into(),
            title.into(),
            None,
            None,
        )
        .await
        .unwrap();
        create_block_inner(
            &tools.pool,
            DEV,
            &mat,
            "content".into(),
            format!("{link}{}", "x".repeat(size)),
            Some(page.id.clone()),
            None,
        )
        .await
        .unwrap();
        sources.push(page.id.into_string());
    }
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;

    let responses = read_all(
        &tools,
        "list_backlinks",
        &json!({"block_id": target.id, "space_id": TEST_SPACE_ID}),
    )
    .await;
    let pages: Vec<(Vec<String>, Value)> = responses
        .iter()
        .map(|r| {
            let ids: Vec<String> = r["groups"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| g["page_id"].as_str().unwrap().to_owned())
                .collect();
            (ids, r["truncated"].clone())
        })
        .collect();
    assert_eq!(
        pages,
        vec![
            (vec![sources[0].clone()], json!(true)),
            (vec![sources[1].clone(), sources[2].clone()], json!(false)),
        ]
    );
}

/// Read in turn, the stretches are the whole page; the first carries the
/// title with its block; a cursor whose block left the page is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_markdown_stops_at_the_byte_cap_and_continues_5402() {
    let (tools, mat, _dir) = mk_tools().await;
    let (page, children) =
        mk_page_of_sizes(&tools, &mat, "Big", &[OVER_CAP, HALF_CAP, HALF_CAP]).await;
    settle(&mat).await;
    crate::commands::tests::common::assign_all_to_test_space(&tools.pool).await;
    let whole = get_page_for_agent_inner(&tools.pool, &page).await.unwrap();

    let args = json!({"page_id": page, "space_id": TEST_SPACE_ID});
    let first = tools
        .call_tool("get_page_markdown", args.clone(), &test_ctx())
        .await
        .unwrap();
    let mut rest_args = args.clone();
    rest_args["cursor"] = first["next_cursor"].clone();
    let rest = tools
        .call_tool("get_page_markdown", rest_args, &test_ctx())
        .await
        .unwrap();
    assert_eq!(
        [&first["truncated"], &first["next_cursor"]],
        [&json!(true), &json!(children[1])]
    );
    assert_eq!(
        [&rest["truncated"], &rest["next_cursor"]],
        [&json!(false), &Value::Null]
    );
    let first_md = first["markdown"].as_str().unwrap();
    assert!(first_md.starts_with("# Big\n"), "got {first_md:.40}");
    assert_eq!(
        format!("{first_md}{}", rest["markdown"].as_str().unwrap()),
        whole
    );

    let mut gone = args;
    gone["cursor"] = json!(BlockId::new().into_string());
    let err = tools
        .call_tool("get_page_markdown", gone, &test_ctx())
        .await
        .expect_err("a cursor naming no block of the page is refused");
    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
}

// -------------------------------------------------------------------
// #5398 / #5401 — search fixes, compact rows, list_pages on the metadata
// backend
// -------------------------------------------------------------------

/// The bytes an agent receives for a fixed page and search: the JSON text
/// `rmcp_adapter` sends. Ids and cursors have fixed lengths, so only a field
/// added to or left out of a row moves these.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_and_search_response_bytes_5401() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let page = mk_named(&tools, &mat, &space, "page", "Project Alpha").await;
    for text in [
        "findme in the first note",
        "findme in the second note",
        "unrelated",
    ] {
        mk_child(&tools, &mat, &page, text).await;
    }
    settle(&mat).await;

    let page_resp = tools
        .call_tool(
            TOOL_GET_PAGE,
            json!({ "page_id": page, "space_id": space }),
            &test_ctx(),
        )
        .await
        .unwrap();
    let search_resp = tools
        .call_tool(
            TOOL_SEARCH,
            json!({ "query": "findme", "space_id": space }),
            &test_ctx(),
        )
        .await
        .unwrap();
    assert_eq!(
        (page_resp.to_string().len(), search_resp.to_string().len()),
        (801, 604),
        "get_page: {page_resp}\nsearch: {search_resp}"
    );
}

async fn tag_block(tools: &ReadOnlyTools, mat: &Materializer, block: &str, tag: &str) {
    crate::commands::add_tag_inner(
        &tools.pool,
        DEV,
        mat,
        BlockId::from_trusted(block),
        BlockId::from_trusted(tag),
    )
    .await
    .unwrap();
}

fn row_ids(result: &Value) -> Vec<String> {
    let mut ids: Vec<String> = result["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}

/// A tag reaches a block attached, written inline, or inherited from its
/// page, on the text path and the empty-query path alike, also across a
/// cursor; every row names its page. The app's search, which cannot set the
/// mode, still matches attached tags only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_tag_matches_attached_inline_and_inherited_tags_5398() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let tag = mk_named(&tools, &mat, &space, "tag", "work").await;
    let tagged = mk_named(&tools, &mat, &space, "page", "Tagged").await;
    let inherits = mk_child(&tools, &mat, &tagged, "needle inherits").await;
    tag_block(&tools, &mat, &tagged, &tag).await;
    let plain = mk_named(&tools, &mat, &space, "page", "Plain").await;
    let inline = mk_child(&tools, &mat, &plain, &format!("needle inline #[{tag}]")).await;
    let attached = mk_child(&tools, &mat, &plain, "needle attached").await;
    tag_block(&tools, &mat, &attached, &tag).await;
    mk_child(&tools, &mat, &plain, "needle untagged").await;
    settle(&mat).await;

    let ctx = test_ctx();
    let search = |query: &str| {
        tools.call_tool(
            TOOL_SEARCH,
            json!({ "query": query, "space_id": space, "tag_ids": [tag] }),
            &ctx,
        )
    };
    let hits = search("needle").await.unwrap();
    let mut expected = vec![inherits.clone(), inline.clone(), attached.clone()];
    expected.sort();
    assert_eq!(row_ids(&hits), expected);
    for row in hits["items"].as_array().unwrap() {
        let page = if row["id"] == inherits.as_str() {
            "Tagged"
        } else {
            "Plain"
        };
        assert_eq!(row["page_title"], page, "{row}");
    }
    expected.push(tagged.clone());
    expected.sort();
    assert_eq!(row_ids(&search("").await.unwrap()), expected);

    // One row per response, so each path's tag binds must line up with its
    // cursor binds for every block to come back exactly once.
    let text_hits: Vec<String> = expected
        .iter()
        .filter(|id| **id != tagged)
        .cloned()
        .collect();
    for (query, want) in [("needle", text_hits), ("", expected.clone())] {
        let mut ids = Vec::new();
        let mut args = json!({ "query": query, "space_id": space, "tag_ids": [tag], "limit": 1 });
        loop {
            let resp = tools
                .call_tool(TOOL_SEARCH, args.clone(), &ctx)
                .await
                .unwrap();
            ids.extend(row_ids(&resp));
            match resp["next_cursor"].as_str() {
                Some(cursor) if resp["has_more"] == true => args["cursor"] = json!(cursor),
                _ => break,
            }
        }
        ids.sort();
        assert_eq!(ids, want, "query {query:?}");
    }

    let app_filter: crate::commands::SearchFilter = serde_json::from_value(json!({
        "scope": SearchScope::Spaces(vec![SpaceId::from_trusted(&space)]),
        "tagIds": [tag],
        "tagsMatchInlineAndInherited": true,
    }))
    .unwrap();
    let app = search_blocks_inner(&tools.pool, "needle".into(), None, None, app_filter, None)
        .await
        .unwrap();
    let app_ids: Vec<&str> = app.items.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(app_ids, [attached.as_str()]);
}

/// `filter.last_edited` narrows a search to the blocks edited in the window.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_last_edited_narrows_results_5398() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let page = mk_named(&tools, &mat, &space, "page", "Inbox").await;
    let fresh = mk_child(&tools, &mat, &page, "fresh note").await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
         VALUES (?, 'content', 'old note', ?, 9, ?, ?)",
    )
    .bind(OLD_BLOCK)
    .bind(&page)
    .bind(&page)
    .bind(&space)
    .execute(&tools.pool)
    .await
    .unwrap();
    settle(&mat).await;
    agaric_store::fts::rebuild_fts_index(&tools.pool)
        .await
        .unwrap();

    let (tools, space) = (&tools, &space);
    let search = |filter: Value| async move {
        let args = json!({ "query": "note", "space_id": space, "filter": filter });
        row_ids(
            &tools
                .call_tool(TOOL_SEARCH, args, &test_ctx())
                .await
                .unwrap(),
        )
    };
    let mut both = vec![fresh.clone(), OLD_BLOCK.to_owned()];
    both.sort();
    assert_eq!(search(json!({})).await, both);
    let recent =
        json!({ "last_edited": { "type": "Range", "start": "2020-01-01", "end": "2999-12-31" } });
    assert_eq!(search(recent).await, [fresh]);
    let old = json!({ "last_edited": { "type": "OlderThan", "days": 365 } });
    assert_eq!(search(old).await, [OLD_BLOCK]);
}

/// `match_offsets` comes back only when asked for.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_match_offsets_only_when_asked_5401() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let page = mk_named(&tools, &mat, &space, "page", "Notes").await;
    mk_child(&tools, &mat, &page, "find the needle").await;
    settle(&mat).await;

    for (asked, expected) in [
        (false, None),
        (true, Some(json!([{ "start": 9, "end": 15 }]))),
    ] {
        let result = tools
            .call_tool(
                TOOL_SEARCH,
                json!({
                    "query": "needle",
                    "space_id": space,
                    "filter": { "whole_word": true },
                    "include_match_offsets": asked,
                }),
                &test_ctx(),
            )
            .await
            .unwrap();
        let row = &result["items"][0];
        assert_eq!(row.get("match_offsets"), expected.as_ref(), "{row}");
    }
}

/// `list_pages` sorts and filters as the Pages view does, and its cursor
/// carries both across a page boundary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_pages_sorts_and_filters_across_a_cursor_5401() {
    let (tools, mat, _dir) = mk_tools().await;
    let space = mk_space(&tools.pool, "S").await;
    let tag = mk_named(&tools, &mat, &space, "tag", "work").await;
    let mut pages = HashMap::new();
    for (title, children, tagged) in [
        ("echo", 3, true),
        ("alpha", 0, false),
        ("Delta", 1, true),
        ("bravo", 2, true),
        ("Charlie", 0, false),
    ] {
        let page = mk_named(&tools, &mat, &space, "page", title).await;
        for i in 0..children {
            mk_child(&tools, &mat, &page, &format!("block {i}")).await;
        }
        if tagged {
            tag_block(&tools, &mat, &page, &tag).await;
        }
        pages.insert(page, title);
    }
    settle(&mat).await;

    let (tools, space, pages) = (&tools, &space, &pages);
    let list = |mut args: Value| async move {
        let mut all = Vec::new();
        args["space_id"] = json!(space);
        loop {
            let resp = tools
                .call_tool(TOOL_LIST_PAGES, args.clone(), &test_ctx())
                .await
                .unwrap();
            let titles: Vec<&str> = resp["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| pages[row["id"].as_str().unwrap()])
                .collect();
            all.push(titles);
            match resp["next_cursor"].as_str() {
                Some(cursor) if resp["has_more"] == true => args["cursor"] = json!(cursor),
                _ => return all,
            }
        }
    };
    assert_eq!(
        list(json!({ "limit": 2 })).await,
        [
            vec!["alpha", "bravo"],
            vec!["Charlie", "Delta"],
            vec!["echo"]
        ]
    );
    assert_eq!(
        list(json!({
            "sort": "most-content",
            "filters": [{ "type": "Tag", "tag": tag }],
            "limit": 2,
        }))
        .await,
        [vec!["echo", "bravo"], vec!["Delta"]]
    );
    assert_eq!(
        list(json!({ "filters": [{ "type": "Stub" }], "limit": 1 })).await,
        [vec!["alpha"], vec!["Charlie"]]
    );

    let first = tools
        .call_tool(
            TOOL_LIST_PAGES,
            json!({ "space_id": space, "limit": 1 }),
            &test_ctx(),
        )
        .await
        .unwrap();
    for args in [
        json!({ "space_id": space, "sort": "most-linked", "cursor": first["next_cursor"] }),
        json!({ "space_id": space, "filters": [{ "type": "State", "values": ["TODO"] }] }),
    ] {
        let err = tools
            .call_tool(TOOL_LIST_PAGES, args.clone(), &test_ctx())
            .await
            .expect_err("refused");
        assert!(
            matches!(err, AppError::Validation { .. }),
            "{args}: {err:?}"
        );
    }
}
