//! #763 — mock-vs-backend conformance harness (Rust side / source of truth).
//!
//! The Rust backend is the SOURCE OF TRUTH for the expected resulting state of
//! every shared fixture in `conformance/fixtures/*.json`. This module:
//!
//!   1. Loads each fixture (seed state + op sequence).
//!   2. Inserts the seed blocks/properties/tags with their LITERAL expanded
//!      ids, scoped to one test space.
//!   3. Dispatches every op through the real `*_inner` command layer,
//!      `settle()`-ing the materializer after each so derived caches
//!      (`block_links`) are populated.
//!   4. Reads the full DB state and builds a *normalized snapshot* with
//!      canonical id relabeling (see `snapshot.rs` — shared with the TS side).
//!   5. Asserts the snapshot equals the fixture's `expected`.
//!
//! UPDATE mode: run with `CONFORMANCE_UPDATE=1` to WRITE the backend-derived
//! `expected` back into each fixture JSON. This is how the source-of-truth
//! expected is authored; never hand-write `expected`.
//!
//! ## Engine path (#891 — production parity)
//!
//! Production installs the Loro engine unconditionally at boot
//! (`crate::loro::shared::init()` in `app.setup`), so every op runs the
//! `apply_*_via_loro` ENGINE path — which reprojects dense 1-based sibling
//! positions via `projection::reproject_dense_positions`. This runner therefore
//! `install_for_test()`s the engine and SEEDS each fixture's seed blocks into
//! the per-space Loro tree (mirroring the raw-SQL seed insert) so ops resolve
//! their space and route through the engine, not the SQL-only fallback. Without
//! this, `shared::get()` is `None` and every op silently took the SQL-only
//! fallback whose provisional `index+1` positions DIFFER from production —
//! which produced the spurious `position_reproject_drift` (#763).
//!
//! The TS runner (`src/lib/tauri-mock/__tests__/conformance.test.ts`) builds
//! the SAME normalized snapshot from the tauri-mock and asserts it matches the
//! backend-authored `expected`. Behavioral drift between the 3.5k-line mock and
//! the real backend then fails CI.

use super::common::*;
use crate::op::{
    CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    SetPropertyPayload,
};
use crate::ulid::BlockId;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;

use super::conformance_snapshot::{Snapshot, build_snapshot_with_order};

// ---------------------------------------------------------------------------
// Fixture model
// ---------------------------------------------------------------------------

/// Expand a stable seed label (`S1`, `S2`, …) to its 26-char block id. The
/// expansion is `label` right-justified in 26 `'0'` chars — a valid
/// `[0-9A-Z]{26}` ULID shape so `[[id]]` link tokens and FK refs work. The
/// SAME expansion is implemented in the TS runner (`seedIdToBlockId`).
pub fn seed_label_to_id(label: &str) -> String {
    if label.len() >= 26 {
        return label.to_owned();
    }
    let pad = 26 - label.len();
    format!("{}{}", "0".repeat(pad), label)
}

/// List the fixture files, sorted by name for deterministic test order.
fn fixture_paths() -> Vec<PathBuf> {
    // CARGO_MANIFEST_DIR == <repo>/src-tauri; fixtures live at <repo>/conformance.
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("conformance")
        .join("fixtures");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read conformance dir {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    paths.sort();
    paths
}

// ---------------------------------------------------------------------------
// Seed + op application against the real backend
// ---------------------------------------------------------------------------

/// Insert a seed block with its literal expanded id, bypassing the command
/// layer (mirrors the mock's `seedBlocks` direct-store insert).
async fn insert_seed_block(pool: &SqlitePool, b: &Value) {
    let label = b["id"].as_str().expect("seed block id");
    let id = seed_label_to_id(label);
    let block_type = b["block_type"].as_str().expect("seed block_type");
    let content = b["content"].as_str();
    let parent_id = b["parent_id"].as_str().map(seed_label_to_id);
    let position = b["position"].as_i64();
    insert_block(
        pool,
        &id,
        block_type,
        content.unwrap_or(""),
        parent_id.as_deref(),
        position,
    )
    .await;
}

/// Seed one block into the per-space Loro ENGINE tree (#891), mirroring the
/// raw-SQL `insert_seed_block` so the engine and SQL stay in lockstep BEFORE any
/// op runs. Production never seeds blocks out-of-band (every block is born from
/// a `CreateBlock` op → engine), but the conformance seed is a synthetic
/// pre-existing state, so we replay it straight into the engine here — NOT
/// through the op-log (that would inflate `op_log_digest` and the create-order
/// relabel). The fixture seed arrays are page-first (parents precede children),
/// so a single forward pass satisfies the engine's parent-before-child
/// requirement.
fn seed_block_into_engine(state: &crate::loro::shared::LoroState, b: &Value) {
    let label = b["id"].as_str().expect("seed block id");
    let id = seed_label_to_id(label);
    let block_type = b["block_type"].as_str().expect("seed block_type");
    let content = b["content"].as_str().unwrap_or("");
    let parent_id = b["parent_id"].as_str().map(seed_label_to_id);
    let position = b["position"].as_i64().unwrap_or(0);
    let space = SpaceId::from_trusted(TEST_SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEV)
        .expect("for_space (seed)");
    guard
        .engine_mut()
        .apply_create_block(&id, block_type, content, parent_id.as_deref(), position)
        .expect("seed apply_create_block into engine");
    drop(guard);
}

/// Dispatch one fixture op through the production ENGINE path (#891).
///
/// The op is appended to the op-log (`append_local_op`) and applied via the
/// materializer's `dispatch_op` — the FOREGROUND `ApplyOp` task, which runs
/// `apply_op_tx` → `apply_*_via_loro` (the engine apply + dense-rank
/// reprojection) plus the matching background cache fan-out (block_links, FTS,
/// derived caches). This is the SAME pipeline production runs for op-log replay
/// and inbound sync — the path that reprojects dense 1-based sibling positions.
///
/// NOTE on path choice (the #891 fix): the previous runner used the LOCAL
/// `*_inner` command layer (`create_block_inner` etc.). That path writes SQL
/// inline with a PROVISIONAL `index+1` position and only enqueues background
/// cache rebuilds — it never runs `apply_op_tx`, so it never reprojects. With
/// no engine installed it was identical to the `apply_*_sql_only` fallback,
/// which is why the fixtures encoded fallback (gapped) positions. Routing
/// through `dispatch_op` exercises the engine path the mock mirrors.
///
/// Reserved column-backed keys (`set_todo_state` / `set_priority` /
/// `set_due_date` / `set_scheduled_date`) map to a `SetProperty` op with the
/// reserved key — exactly what the `*_inner` commands emit and what
/// `project_set_property_to_sql` writes to the dedicated `blocks` column.
async fn apply_op(pool: &SqlitePool, mat: &Materializer, op: &Value) {
    let command = op["command"].as_str().expect("op command");
    let args = &op["args"];
    let arg = |k: &str| args.get(k);
    let arg_str = |k: &str| arg(k).and_then(Value::as_str).map(str::to_owned);
    let arg_label_id = |k: &str| arg(k).and_then(Value::as_str).map(seed_label_to_id);
    let label_block_id = |k: &str| BlockId::from(arg_label_id(k).expect("blockId").as_str());
    // Build a SetProperty payload for a reserved column-backed key. The value
    // goes in the typed field the projection reads for that key
    // (`project_set_property_to_sql`): todo_state/priority → `value_text`;
    // due_date/scheduled_date → `value_date`. This mirrors how the `*_inner`
    // commands (`set_todo_state_inner` vs `set_due_date_inner`) populate the op.
    let reserved = |key: &str, value: Option<String>, is_date: bool| {
        let (value_text, value_date) = if is_date {
            (None, value)
        } else {
            (value, None)
        };
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: label_block_id("blockId"),
            key: key.to_owned(),
            value_text,
            value_num: None,
            value_date,
            value_ref: None,
            value_bool: None,
        })
    };

    let payload = match command {
        "create_block" => OpPayload::CreateBlock(CreateBlockPayload {
            // Created blocks get a fresh ULID (the canonical relabel reads
            // create order from the op-log's `block_id` sidecar, so the random
            // id is fine — it is relabeled to B2, B3, … exactly as on the mock).
            block_id: BlockId::new(),
            block_type: arg_str("blockType").expect("create_block.blockType"),
            parent_id: arg_label_id("parentId").map(|s| BlockId::from(s.as_str())),
            position: None,
            index: arg("index").and_then(Value::as_i64),
            content: arg_str("content").unwrap_or_default(),
        }),
        "edit_block" => OpPayload::EditBlock(EditBlockPayload {
            block_id: label_block_id("blockId"),
            to_text: arg_str("toText").unwrap_or_default(),
            prev_edit: None,
        }),
        "move_block" => {
            let new_index = arg("newIndex").and_then(Value::as_i64).expect("newIndex");
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: label_block_id("blockId"),
                new_parent_id: arg_label_id("newParentId").map(|s| BlockId::from(s.as_str())),
                // #400 ops route on `new_index`; `new_position` mirrors it as a
                // non-authoritative breadcrumb (see MoveBlockPayload docs).
                new_position: new_index,
                new_index: Some(new_index),
            })
        }
        "delete_block" => OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: label_block_id("blockId"),
        }),
        "set_property" => {
            let key = arg_str("key").expect("set_property.key");
            let v = arg("value").cloned().unwrap_or(Value::Null);
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: label_block_id("blockId"),
                key,
                value_text: v
                    .get("value_text")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                value_num: v.get("value_num").and_then(Value::as_f64),
                value_date: v
                    .get("value_date")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                // value_ref is a block id — expand it through the seed-label map.
                value_ref: v
                    .get("value_ref")
                    .and_then(Value::as_str)
                    .map(|s| BlockId::from(seed_label_to_id(s).as_str())),
                value_bool: v.get("value_bool").and_then(Value::as_bool),
            })
        }
        "set_todo_state" => reserved("todo_state", arg_str("state"), false),
        "set_priority" => reserved("priority", arg_str("level"), false),
        "set_due_date" => reserved("due_date", arg_str("date"), true),
        "set_scheduled_date" => reserved("scheduled_date", arg_str("date"), true),
        other => panic!("conformance op '{other}' is not wired in the Rust runner"),
    };

    let record = crate::op_log::append_local_op(pool, DEV, payload)
        .await
        .expect("append_local_op");
    // `dispatch_op` runs the foreground ApplyOp (engine apply + reproject),
    // flushes the foreground queue, then enqueues the background fan-out;
    // `settle` (flush_background) drains block_links / FTS / cache rebuilds.
    mat.dispatch_op(&record).await.expect("dispatch_op");
    settle(mat).await;
}

// ---------------------------------------------------------------------------
// Raw DB read → RawState (pre-relabel). Shared snapshot builder relabels it.
// ---------------------------------------------------------------------------

/// Read the full materialized state into the relabel-agnostic intermediate
/// shape the shared snapshot builder consumes.
async fn read_raw_state(pool: &SqlitePool) -> super::conformance_snapshot::RawState {
    use super::conformance_snapshot::{RawBlock, RawLink, RawOp, RawProperty, RawState, RawTag};

    // Blocks — every row (incl. tombstoned) except the synthetic test space.
    let block_rows = sqlx::query_as::<
        _,
        (
            String,         // id
            String,         // block_type
            Option<String>, // content
            Option<String>, // parent_id
            Option<i64>,    // position
            Option<i64>,    // deleted_at (epoch-ms)
            Option<String>, // todo_state
            Option<String>, // priority
            Option<String>, // due_date
            Option<String>, // scheduled_date
            Option<String>, // page_id
        ),
    >(
        "SELECT id, block_type, content, parent_id, position, deleted_at, \
                todo_state, priority, due_date, scheduled_date, page_id \
         FROM blocks WHERE id <> ? ORDER BY id",
    )
    .bind(TEST_SPACE_ID)
    .fetch_all(pool)
    .await
    .unwrap();
    let blocks = block_rows
        .into_iter()
        .map(|r| RawBlock {
            id: r.0,
            block_type: r.1,
            content: r.2,
            parent_id: r.3,
            position: r.4,
            deleted: r.5.is_some(),
            todo_state: r.6,
            priority: r.7,
            due_date: r.8,
            scheduled_date: r.9,
            page_id: r.10,
        })
        .collect();

    // Properties — block_properties rows. Exclude auto-derived timestamp keys
    // (created_at/completed_at) — they carry today's date and the mock does
    // not model them; they are intentionally outside the conformance surface.
    let prop_rows = sqlx::query_as::<
        _,
        (
            String,         // block_id
            String,         // key
            Option<String>, // value_text
            Option<f64>,    // value_num
            Option<String>, // value_date
            Option<String>, // value_ref
            Option<i64>,    // value_bool
        ),
    >(
        "SELECT block_id, key, value_text, value_num, value_date, value_ref, value_bool \
         FROM block_properties \
         WHERE key NOT IN ('created_at', 'completed_at')",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let properties = prop_rows
        .into_iter()
        .map(|r| RawProperty {
            block_id: r.0,
            key: r.1,
            value_text: r.2,
            value_num: r.3,
            value_date: r.4,
            value_ref: r.5,
            value_bool: r.6.map(|n| n != 0),
        })
        .collect();

    // Block tags.
    let tag_rows = sqlx::query_as::<_, (String, String)>("SELECT block_id, tag_id FROM block_tags")
        .fetch_all(pool)
        .await
        .unwrap();
    let block_tags = tag_rows
        .into_iter()
        .map(|r| RawTag {
            block_id: r.0,
            tag_id: r.1,
        })
        .collect();

    // Page links — the migration-0070 surface. Derive `source_page_id` by
    // joining each `block_links` edge to its source block's `page_id`. This is
    // the projection the mock reimplements in `deriveLinkEdges` / `pageLinkStats`.
    let link_rows = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT bl.source_id, bl.target_id, src.page_id \
         FROM block_links bl \
         JOIN blocks src ON src.id = bl.source_id",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let page_links = link_rows
        .into_iter()
        .map(|r| RawLink {
            source_id: r.0,
            target_id: r.1,
            source_page_id: r.2,
        })
        .collect();

    // Op log digest — ordered by seq, with reserved-key set_property ops
    // canonicalized to their `set_<key>` logical name (so the mock's
    // dedicated op_types line up) and auto-timestamp ops dropped.
    let op_rows = sqlx::query_as::<_, (String, String)>(
        "SELECT op_type, payload FROM op_log WHERE device_id = ? ORDER BY seq",
    )
    .bind(DEV)
    .fetch_all(pool)
    .await
    .unwrap();
    let op_log = op_rows
        .into_iter()
        .filter_map(|(op_type, payload)| {
            let key = serde_json::from_str::<Value>(&payload).ok().and_then(|p| {
                // SetProperty payload nests under `SetProperty` (enum tag);
                // fall back to a flat `key` field.
                p.get("SetProperty")
                    .and_then(|sp| sp.get("key"))
                    .or_else(|| p.get("key"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            RawOp::canonicalize(&op_type, key.as_deref())
        })
        .collect();

    RawState {
        blocks,
        properties,
        block_tags,
        page_links,
        op_log,
    }
}

/// Read the ids of blocks CREATED via ops, in creation (seq) order, from the
/// op_log's indexed `block_id` sidecar. Drives the canonical relabel order for
/// the post-seed portion of the block set.
async fn read_created_block_ids_in_op_order(pool: &SqlitePool) -> Vec<String> {
    let rows = sqlx::query_as::<_, (Option<String>,)>(
        "SELECT block_id FROM op_log WHERE device_id = ? AND op_type = 'create_block' ORDER BY seq",
    )
    .bind(DEV)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter().filter_map(|r| r.0).collect()
}

// ---------------------------------------------------------------------------
// Per-fixture run + assert / update
// ---------------------------------------------------------------------------

async fn run_fixture(path: &PathBuf) {
    let raw = std::fs::read_to_string(path).unwrap();
    let mut fixture: Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("parse fixture {}: {e}", path.display()));
    let name = fixture["name"].as_str().unwrap_or("<unnamed>").to_owned();

    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // #891: install the process-global Loro engine so ops route through the
    // production `apply_*_via_loro` ENGINE path (dense-reproject positions),
    // not the SQL-only fallback. `install_for_test` is a no-op once the
    // OnceLock is set, so the SAME `LoroState` is shared by every fixture in
    // this test binary. Fixtures all scope to TEST_SPACE_ID and reuse the same
    // `'0'`-padded ids (S1→B1, …), so the prior fixture's per-space tree would
    // otherwise bleed in. `registry.clear()` drops every registered engine,
    // so the `for_space` below lazy-creates a FRESH empty tree for this
    // fixture — equivalent to a first boot, against this fixture's own fresh
    // pool.
    let state = crate::loro::shared::install_for_test();
    state.registry.clear();

    // 1. Seed blocks (literal expanded ids), then scope every seed block to one
    //    test space so created children inherit it and same-space ref/link
    //    validation passes.
    let seed = &fixture["seed"];
    if let Some(blocks) = seed["blocks"].as_array() {
        for b in blocks {
            insert_seed_block(&pool, b).await;
        }
    }
    // #891: scope the seed blocks to TEST_SPACE_ID NOW (before any property/tag
    // seed op or fixture op) so `resolve_block_space` returns a space and the
    // engine path engages instead of the SQL-only fallback.
    assign_all_to_test_space(&pool).await;
    // #891: replay each seed block into the per-space engine tree so the engine
    // and SQL agree on the pre-op state. Page-first seed order satisfies the
    // engine's parent-before-child requirement.
    if let Some(blocks) = seed["blocks"].as_array() {
        for b in blocks {
            seed_block_into_engine(state, b);
        }
    }
    // Seed properties (non-reserved keys only — reserved ones are column-backed).
    if let Some(props) = seed["properties"].as_array() {
        for p in props {
            let block_id: crate::ulid::ActiveBlockId =
                seed_label_to_id(p["block_id"].as_str().expect("seed prop block_id"))
                    .as_str()
                    .into();
            let key = p["key"].as_str().expect("seed prop key").to_owned();
            let v = &p["value"];
            set_property_inner(
                &pool,
                DEV,
                &mat,
                block_id,
                key,
                v.get("value_text")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                v.get("value_num").and_then(Value::as_f64),
                v.get("value_date")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                v.get("value_ref")
                    .and_then(Value::as_str)
                    .map(seed_label_to_id),
                v.get("value_bool").and_then(Value::as_bool),
                None,
            )
            .await
            .expect("seed set_property");
            settle(&mat).await;
        }
    }
    // Seed tags.
    if let Some(tags) = seed["tags"].as_array() {
        for t in tags {
            let block_id = seed_label_to_id(t["block_id"].as_str().expect("seed tag block_id"));
            let tag_id = seed_label_to_id(t["tag_id"].as_str().expect("seed tag tag_id"));
            add_tag_inner(
                &pool,
                DEV,
                &mat,
                BlockId::from(block_id.as_str()),
                BlockId::from(tag_id.as_str()),
            )
            .await
            .expect("seed add_tag");
            settle(&mat).await;
        }
    }
    assign_all_to_test_space(&pool).await;

    // 2. Apply ops.
    if let Some(ops) = fixture["ops"].as_array() {
        for op in ops.clone() {
            apply_op(&pool, &mat, &op).await;
        }
    }
    // Catch any top-level pages created mid-op so their descendants resolve a
    // space (otherwise a follow-up cross-space ref/link op would be rejected).
    assign_all_to_test_space(&pool).await;

    // #891 ENGINE-PATH GUARD: every block CREATED by an op must be present in
    // the per-space engine tree. The SQL-only fallback never touches the
    // engine, so this asserts the ops genuinely ran the production
    // `apply_*_via_loro` path (dense-reproject positions) — not the fallback
    // whose gapped provisional positions produced the spurious #763 drift. If
    // a future change regresses the runner back to the fallback (e.g. drops
    // `install_for_test`, the engine seed, or space assignment), this fails
    // loudly instead of silently re-encoding fallback positions into fixtures.
    {
        let space = SpaceId::from_trusted(TEST_SPACE_ID);
        let created = read_created_block_ids_in_op_order(&pool).await;
        let mut guard = state.registry.for_space(&space, DEV).expect("for_space");
        for id in &created {
            assert!(
                guard
                    .engine_mut()
                    .read_block(id)
                    .expect("read_block")
                    .is_some(),
                "fixture '{name}': op-created block {id} is absent from the engine tree — \
                 the op took the SQL-only FALLBACK, not the production engine path (#891)",
            );
        }
        drop(guard);
    }

    // 3. Canonical order: seed blocks first (fixture seed order), then created
    //    blocks in op (creation) order — read from the op_log's `create_block`
    //    entries in seq order. The same order is computed on the TS side.
    let mut canonical_order: Vec<String> = Vec::new();
    if let Some(blocks) = seed["blocks"].as_array() {
        for b in blocks {
            canonical_order.push(seed_label_to_id(b["id"].as_str().expect("seed block id")));
        }
    }
    for created in read_created_block_ids_in_op_order(&pool).await {
        if !canonical_order.contains(&created) {
            canonical_order.push(created);
        }
    }

    // 4. Snapshot.
    let raw_state = read_raw_state(&pool).await;
    let snapshot: Snapshot = build_snapshot_with_order(raw_state, &canonical_order);
    let snapshot_value = serde_json::to_value(&snapshot).unwrap();

    if std::env::var("CONFORMANCE_UPDATE").as_deref() == Ok("1") {
        fixture["expected"] = snapshot_value;
        // Pretty-print with a trailing newline so the file stays diff-friendly.
        let mut out = serde_json::to_string_pretty(&fixture).unwrap();
        out.push('\n');
        std::fs::write(path, out).unwrap();
        eprintln!("CONFORMANCE_UPDATE: wrote expected for fixture '{name}'");
        return;
    }

    let expected = &fixture["expected"];
    assert!(
        !expected.is_null(),
        "fixture '{name}' has no `expected` — run with CONFORMANCE_UPDATE=1 to author it",
    );
    // Compare via canonical BTreeMap round-trip so key order never matters.
    let expected_canon: BTreeMap<String, Value> = serde_json::from_value(expected.clone()).unwrap();
    let actual_canon: BTreeMap<String, Value> =
        serde_json::from_value(snapshot_value.clone()).unwrap();
    assert_eq!(
        json!(actual_canon),
        json!(expected_canon),
        "conformance snapshot mismatch for fixture '{name}' (backend is source of truth; \
         re-author with CONFORMANCE_UPDATE=1 if the backend behaviour changed intentionally)",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conformance_fixtures_match_backend() {
    let paths = fixture_paths();
    assert!(!paths.is_empty(), "no conformance fixtures found");
    for path in &paths {
        run_fixture(path).await;
    }
}
