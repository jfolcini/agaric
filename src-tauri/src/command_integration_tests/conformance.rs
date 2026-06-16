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
//!
//! ## Isolation contract — run with `cargo nextest`, NEVER `cargo test` (#1079)
//!
//! The tests here `install_for_test()` the PROCESS-GLOBAL Loro engine and
//! isolate fixtures by `state.registry.clear()`, which drops EVERY engine in the
//! whole process. All fixtures reuse a single shared `TEST_SPACE_ID`. That means
//! two tests in this module CANNOT safely run concurrently in the same process —
//! one's `clear()` would destroy the other's just-seeded tree. Isolation holds
//! only because `cargo nextest` forks one process per test (what CI and the
//! pre-push hook run). Plain `cargo test` runs the whole binary in one process
//! across threads and will flake here. See `loro::shared::install_for_test` and
//! <https://github.com/jfolcini/agaric/issues/1079>.

use super::common::*;
use crate::op::{
    AddTagPayload, CreateBlockPayload, DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload,
    MoveBlockPayload, OpPayload, PurgeBlockPayload, RemoveTagPayload, RestoreBlockPayload,
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
        "add_tag" => OpPayload::AddTag(AddTagPayload {
            block_id: label_block_id("blockId"),
            tag_id: label_block_id("tagId"),
        }),
        "remove_tag" => OpPayload::RemoveTag(RemoveTagPayload {
            block_id: label_block_id("blockId"),
            tag_id: label_block_id("tagId"),
        }),
        "restore_block" => {
            // The restore op's `deleted_at_ref` is the originating delete op's
            // `created_at` — the epoch-ms guard the projection matches against
            // `blocks.deleted_at` to scope the un-delete to that delete's
            // cohort. The mock's `restore_block` carries no such guard (it
            // clears `deleted_at` unconditionally), so the fixture op args have
            // none; the runner sources it the way `restore_block_inner` does —
            // by reading the live tombstone's `deleted_at` from the DB now.
            let id = arg_label_id("blockId").expect("restore_block.blockId");
            let deleted_at_ref: i64 =
                sqlx::query_as::<_, (Option<i64>,)>("SELECT deleted_at FROM blocks WHERE id = ?")
                    .bind(&id)
                    .fetch_one(pool)
                    .await
                    .expect("restore_block: fetch deleted_at")
                    .0
                    .expect("restore_block: target block must be tombstoned");
            OpPayload::RestoreBlock(RestoreBlockPayload {
                block_id: BlockId::from(id.as_str()),
                deleted_at_ref,
            })
        }
        "purge_block" => OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: label_block_id("blockId"),
        }),
        "delete_property" => OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: label_block_id("blockId"),
            key: arg_str("key").expect("delete_property.key"),
        }),
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

/// #928 f7 — FE-`newIndex` ↔ engine-clamp parity at the sibling-group TAIL.
///
/// The engine's `move_block_impl` (`src/loro/engine.rs`) clamps a SAME-PARENT
/// (already-child) move's slot to `count - 1`: the node vacates its own slot
/// first, so the addressable range among the OTHER children shrinks by one.
/// The FE replicates the symmetric slot math separately — `moveDown`
/// (`src/stores/page-blocks.ts:1233`) emits `newIndex = sibIndex + 1`, which
/// for the LAST sibling lands one past the shrunk range. Nothing cross-checks
/// that the FE-emitted `newIndex` and the engine clamp agree at the tail.
///
/// This drives the SAME engine path production runs (seed → `dispatch_op` →
/// foreground engine apply + dense reproject → settle) for a same-parent group
/// `S1 > {A, B, C}` and pins:
///   1. `move_block(C, S1, 0)` — last child to the HEAD (slot 0, no clamp).
///   2. `move_block(A, S1, 2)` — A to the TAIL using the exact `sibIndex + 1`
///      basis `moveDown` emits for the last position (3 children, A vacates
///      slot 0 ⇒ 2 others ⇒ engine clamps slot 2 → `count - 1 = 1`… i.e. the
///      tail of the remaining group, NOT out of range / panic / a gap).
/// After settle, asserts the engine placed C at the head and A at the last
/// slot, and that the sibling group is dense 1-based with no duplicates.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_same_parent_tail_clamp_matches_fe_new_index() {
    // 26-char ids so `seed_label_to_id` / `apply_op` treat them as literal ids.
    let s1 = seed_label_to_id("S1");
    let a = seed_label_to_id("BA");
    let b = seed_label_to_id("BB");
    let c = seed_label_to_id("BC");

    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Install the process-global engine so ops route through the production
    // `apply_*_via_loro` ENGINE path (dense reproject), not the SQL-only
    // fallback. `registry.clear()` gives this test a fresh per-space tree.
    let state = crate::loro::shared::install_for_test();
    state.registry.clear();

    // Seed S1 > {A, B, C} into BOTH SQL and the engine tree (parent-first so the
    // engine's parent-before-child requirement holds), then scope to one space.
    let seed = [
        json!({"id": "S1", "block_type": "page",    "content": "Home", "parent_id": null, "position": 1}),
        json!({"id": "BA", "block_type": "content", "content": "A",    "parent_id": "S1", "position": 1}),
        json!({"id": "BB", "block_type": "content", "content": "B",    "parent_id": "S1", "position": 2}),
        json!({"id": "BC", "block_type": "content", "content": "C",    "parent_id": "S1", "position": 3}),
    ];
    for blk in &seed {
        insert_seed_block(&pool, blk).await;
    }
    assign_all_to_test_space(&pool).await;
    for blk in &seed {
        seed_block_into_engine(state, blk);
    }
    assign_all_to_test_space(&pool).await;

    // Read the settled dense 1-based rank for each child of S1 from the DB
    // (the engine reproject writes `blocks.position`). Returns (parent, pos).
    async fn child_pos(pool: &SqlitePool, id: &str) -> (Option<String>, Option<i64>) {
        let row = sqlx::query_as::<_, (Option<String>, Option<i64>)>(
            "SELECT parent_id, position FROM blocks WHERE id = ?",
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
        (row.0, row.1)
    }

    // 1. Move LAST child C to the HEAD (slot 0 — no clamp engages). Expected
    //    settled order: C, A, B → ranks C=1, A=2, B=3.
    apply_op(
        &pool,
        &mat,
        &json!({"command": "move_block", "args": {"blockId": "BC", "newParentId": "S1", "newIndex": 0}}),
    )
    .await;

    {
        let (cp, cpos) = child_pos(&pool, &c).await;
        let (_, apos) = child_pos(&pool, &a).await;
        let (_, bpos) = child_pos(&pool, &b).await;
        assert_eq!(cp.as_deref(), Some(s1.as_str()), "C stays under S1");
        assert_eq!(cpos, Some(1), "C moved to slot 0 ⇒ dense head rank 1");
        assert_eq!(apos, Some(2), "A slides to rank 2 after C jumps the head");
        assert_eq!(bpos, Some(3), "B slides to rank 3");
    }

    // 2. Move A to the TAIL with the exact FE `moveDown` last-position basis:
    //    `newIndex = sibIndex + 1`. Group is now [C, A, B]; A is at sibIndex 1,
    //    so the next slot is 2. A vacates its own slot first (already-child) ⇒
    //    only {C, B} remain addressable (count - 1 = 1), so the engine CLAMPS
    //    slot 2 → the last remaining slot. A must land at the TAIL, not out of
    //    range / panic / a gap. Expected settled order: C, B, A.
    apply_op(
        &pool,
        &mat,
        &json!({"command": "move_block", "args": {"blockId": "BA", "newParentId": "S1", "newIndex": 2}}),
    )
    .await;

    let (cp, cpos) = child_pos(&pool, &c).await;
    let (bp, bpos) = child_pos(&pool, &b).await;
    let (ap, apos) = child_pos(&pool, &a).await;

    // All three remain children of S1 (no reparent, no orphan).
    assert_eq!(cp.as_deref(), Some(s1.as_str()), "C stays under S1");
    assert_eq!(bp.as_deref(), Some(s1.as_str()), "B stays under S1");
    assert_eq!(ap.as_deref(), Some(s1.as_str()), "A stays under S1");

    // A clamped to the LAST slot — the engine did NOT honor the raw `newIndex`
    // of 2 against the FULL count (which would be a gap / past-the-end), it
    // clamped to `count - 1` so A sits at the dense tail.
    assert_eq!(cpos, Some(1), "C remains at the head (rank 1)");
    assert_eq!(bpos, Some(2), "B slides up to rank 2 after A vacates");
    assert_eq!(
        apos,
        Some(3),
        "A clamped to the TAIL (rank 3 of 3) — FE newIndex 2 == engine clamp"
    );

    // Dense 1-based with NO duplicates / NO gaps across the whole group.
    let mut ranks = [cpos, apos, bpos]
        .into_iter()
        .map(|p| p.expect("every child has a settled position"))
        .collect::<Vec<_>>();
    ranks.sort_unstable();
    assert_eq!(
        ranks,
        vec![1, 2, 3],
        "sibling group must be dense 1-based {{1,2,3}} with no duplicate / out-of-range rank after the tail clamp",
    );

    // ENGINE-PATH GUARD: A is present in the per-space engine tree, proving the
    // moves ran the production engine path (clamp + reproject), not the
    // SQL-only fallback (which never clamps and never touches the engine).
    {
        let space = SpaceId::from_trusted(TEST_SPACE_ID);
        let mut guard = state.registry.for_space(&space, DEV).expect("for_space");
        assert!(
            guard
                .engine_mut()
                .read_block(&a)
                .expect("read_block")
                .is_some(),
            "moved block A absent from the engine tree — the move took the SQL-only FALLBACK, not the engine clamp path",
        );
        drop(guard);
    }
}

/// #1257 PR-2 — LOCAL `create_block` is engine-fresh and densely positioned
/// IN-TRANSACTION, with the apply cursor PINNED.
///
/// Before PR-2 the LOCAL command path (`create_block_inner` →
/// `create_block_in_tx`) wrote a PROVISIONAL `index + 1` SQL position and NEVER
/// touched the Loro engine: positions were reconciled to dense ranks only on the
/// next boot replay (the #1245 / #1249 bug). PR-2 routes the create through
/// `apply_create_block_via_loro` inside the same `CommandTx` — engine apply +
/// `project_create_block_to_sql` + `reproject_dense_positions` — but
/// deliberately does NOT advance `materializer_apply_cursor` (so boot replay
/// re-applies idempotently; #1248).
///
/// This test drives the REAL command path (`create_block_inner` + `settle()`)
/// for an insert at index 0 BETWEEN two existing siblings and asserts, WITHOUT
/// any boot replay:
///   (a) the engine `read_block` / `children_ordered_block_ids(S1)` reflects the
///       new block at the head of the sibling list;
///   (b) the SQL `blocks.position` equals the engine's DENSE rank — new block at
///       rank 1, the two pre-existing siblings reprojected to ranks 2 and 3.
///       Under the OLD provisional path the index-0 insert would have written
///       position `index_to_provisional_position(0)` and left the siblings at
///       their seeded 1/2, so this dense-rank assertion would FAIL — exactly the
///       drift PR-2 closes; and
///   (c) the apply cursor (`materialized_through_seq`) did NOT advance.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_create_is_engine_fresh_and_dense_1257() {
    // 26-char ids so `seed_label_to_id` treats them as literal ids.
    let s1 = seed_label_to_id("S1");
    let a = seed_label_to_id("BA");
    let b = seed_label_to_id("BB");

    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Install the process-global engine so the LOCAL create routes through the
    // production `apply_create_block_via_loro` ENGINE path (dense reproject), not
    // the SQL-only fallback. `registry.clear()` gives this test a fresh tree.
    let state = crate::loro::shared::install_for_test();
    state.registry.clear();

    // Seed S1 > {A, B} into BOTH SQL and the engine tree (parent-first), then
    // scope every seed block to one space so `resolve_block_space` succeeds and
    // the LOCAL create engages the engine path for the child insert.
    let seed = [
        json!({"id": "S1", "block_type": "page",    "content": "Home", "parent_id": null, "position": 1}),
        json!({"id": "BA", "block_type": "content", "content": "A",    "parent_id": "S1", "position": 1}),
        json!({"id": "BB", "block_type": "content", "content": "B",    "parent_id": "S1", "position": 2}),
    ];
    for blk in &seed {
        insert_seed_block(&pool, blk).await;
    }
    assign_all_to_test_space(&pool).await;
    for blk in &seed {
        seed_block_into_engine(state, blk);
    }
    assign_all_to_test_space(&pool).await;

    // Cursor + op_log baselines BEFORE the local create.
    async fn apply_cursor(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }
    async fn max_seq(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(seq), 0) FROM op_log")
            .fetch_one(pool)
            .await
            .unwrap()
    }
    let cursor_before = apply_cursor(&pool).await;
    let seq_before = max_seq(&pool).await;

    // Drive the REAL local command path: insert a new content block at index 0
    // (BEFORE A and B) under S1.
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "inserted-at-head".into(),
        Some(BlockId::from(s1.as_str())),
        Some(0),
    )
    .await
    .expect("create_block_inner");
    let new_id = created.id.clone().into_string();

    // The dense rank is projected synchronously in the CommandTx — even before
    // settling background work. Drain background tasks anyway to prove they
    // don't perturb the dense ranks (and to mirror the production lifecycle).
    settle(&mat).await;

    // (a) ENGINE freshness — WITHOUT any boot replay, the engine already has the
    //     new block and orders it at the HEAD of S1's children.
    {
        let space = SpaceId::from_trusted(TEST_SPACE_ID);
        let mut guard = state.registry.for_space(&space, DEV).expect("for_space");
        let snap = guard
            .engine_mut()
            .read_block(&new_id)
            .expect("read_block")
            .expect("engine has the freshly-created block (no boot replay)");
        assert_eq!(snap.content, "inserted-at-head");
        assert_eq!(snap.parent_id.as_deref(), Some(s1.as_str()));
        let order = guard
            .engine_mut()
            .children_ordered_block_ids(Some(s1.as_str()))
            .expect("children_ordered_block_ids");
        drop(guard);
        assert_eq!(
            order,
            vec![new_id.clone(), a.clone(), b.clone()],
            "engine sibling order must place the index-0 insert at the head: \
             [new, A, B]; got {order:?}",
        );
    }

    // (b) SQL `blocks.position` must equal the engine's DENSE rank for EVERY
    //     sibling — new=1, A=2, B=3. Under the OLD provisional path the new
    //     block would carry `index_to_provisional_position(0)` and A/B would
    //     keep their seeded 1/2, so this block would FAIL.
    async fn pos(pool: &SqlitePool, id: &str) -> Option<i64> {
        sqlx::query_scalar::<_, Option<i64>>("SELECT position FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }
    assert_eq!(
        pos(&pool, &new_id).await,
        Some(1),
        "new block must be densely ranked 1 (head of S1)",
    );
    assert_eq!(
        pos(&pool, &a).await,
        Some(2),
        "A must reproject to dense rank 2 after the head insert (was seeded 1)",
    );
    assert_eq!(
        pos(&pool, &b).await,
        Some(3),
        "B must reproject to dense rank 3 after the head insert (was seeded 2)",
    );
    // The returned BlockRow must also carry the persisted dense rank, not a
    // provisional value.
    assert_eq!(
        created.position,
        Some(1),
        "create_block_inner must return the persisted dense rank",
    );

    // (c) Apply cursor must NOT advance: the LOCAL path engine-applies but boot
    //     replay still owns cursor progress (#1248 / #1257). The op DID land in
    //     the op_log.
    let cursor_after = apply_cursor(&pool).await;
    let seq_after = max_seq(&pool).await;
    assert!(
        seq_after > seq_before,
        "local create_block must append to op_log: {seq_before} -> {seq_after}",
    );
    assert_eq!(
        cursor_after, cursor_before,
        "local command path must NOT advance the apply cursor even though it now \
         engine-applies in-tx (#1248 / #1257); cursor moved {cursor_before} -> {cursor_after}",
    );

    mat.shutdown();
}

// ---------------------------------------------------------------------------
// #1257 PR-3 — local simple-op engine-freshness conformance.
//
// PR-3 routes the LOCAL edit_block / set_property / delete_property /
// add_tag / remove_tag command paths through their `apply_*_via_loro` engine
// helpers IN-TRANSACTION (instead of writing SQL directly and never touching
// the Loro engine). None of these ops touch `position`, so there is NO
// dense-reprojection subtlety (unlike create / move). Each test below drives
// the REAL local command (`edit_block_inner` / `set_property_inner` /
// `add_tag_inner`) + `settle()` with the engine installed, then asserts —
// WITHOUT any boot replay — that:
//   (a) the ENGINE reflects the change (read_block content / read_property_typed
//       / read_tags membership),
//   (b) the SQL matches the engine, AND
//   (c) the apply cursor (`materialized_through_seq`) did NOT advance while
//       `op_log.seq` DID — proving boot replay still owns cursor progress and
//       the local path is the engine-apply-without-cursor-advance shape (#1248
//       / #1257).
//
// Each test is its OWN `#[tokio::test]` fn so `cargo nextest` forks one process
// per test — REQUIRED by this module's process-global-engine isolation contract
// (see the module docstring); two tests sharing a process would `clear()` each
// other's engine.
// ---------------------------------------------------------------------------

/// Read the apply cursor (`materialized_through_seq`).
async fn pr3_apply_cursor(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Read the max op_log seq.
async fn pr3_max_seq(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(seq), 0) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// PR-3: a LOCAL `edit_block_inner` routes the content write through
/// `apply_edit_block_via_loro` IN-TX, so the engine's `read_block` reflects the
/// new content (no boot replay) AND the SQL `content` matches, AND the apply
/// cursor stays put while op_log advances.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_edit_block_is_engine_fresh_1257() {
    let target = seed_label_to_id("BA");

    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let state = crate::loro::shared::install_for_test();
    state.registry.clear();

    let seed = [
        json!({"id": "S1", "block_type": "page",    "content": "Home", "parent_id": null, "position": 1}),
        json!({"id": "BA", "block_type": "content", "content": "before","parent_id": "S1", "position": 1}),
    ];
    for blk in &seed {
        insert_seed_block(&pool, blk).await;
    }
    assign_all_to_test_space(&pool).await;
    for blk in &seed {
        seed_block_into_engine(state, blk);
    }
    assign_all_to_test_space(&pool).await;

    let cursor_before = pr3_apply_cursor(&pool).await;
    let seq_before = pr3_max_seq(&pool).await;

    let edited = edit_block_inner(
        &pool,
        DEV,
        &mat,
        BlockId::from(target.as_str()),
        "after-edit".into(),
    )
    .await
    .expect("edit_block_inner");
    assert_eq!(edited.content.as_deref(), Some("after-edit"));
    settle(&mat).await;

    // (a) ENGINE freshness — WITHOUT boot replay the engine already has the edit.
    {
        let space = SpaceId::from_trusted(TEST_SPACE_ID);
        let mut guard = state.registry.for_space(&space, DEV).expect("for_space");
        let snap = guard
            .engine_mut()
            .read_block(&target)
            .expect("read_block")
            .expect("engine has the edited block (no boot replay)");
        drop(guard);
        assert_eq!(
            snap.content, "after-edit",
            "engine read_block must reflect the local edit in-tx, no boot replay",
        );
    }

    // (b) SQL matches the engine.
    let sql_content: String =
        sqlx::query_scalar::<_, String>("SELECT content FROM blocks WHERE id = ?")
            .bind(&target)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        sql_content, "after-edit",
        "SQL content must match the engine"
    );

    // (c) cursor unmoved, op_log advanced.
    assert!(
        pr3_max_seq(&pool).await > seq_before,
        "local edit_block must append to op_log",
    );
    assert_eq!(
        pr3_apply_cursor(&pool).await,
        cursor_before,
        "local edit_block must NOT advance the apply cursor (#1248 / #1257)",
    );

    mat.shutdown();
}

/// PR-3: a LOCAL `set_property_inner` routes the property write through
/// `apply_set_property_via_loro` IN-TX, so the engine's `read_property_typed`
/// reflects the value (no boot replay) AND the SQL `block_properties` row
/// matches, AND the apply cursor stays put while op_log advances.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_set_property_is_engine_fresh_1257() {
    use crate::loro::engine::PropertyValue;

    let target = seed_label_to_id("BA");

    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let state = crate::loro::shared::install_for_test();
    state.registry.clear();

    let seed = [
        json!({"id": "S1", "block_type": "page",    "content": "Home", "parent_id": null, "position": 1}),
        json!({"id": "BA", "block_type": "content", "content": "A",    "parent_id": "S1", "position": 1}),
    ];
    for blk in &seed {
        insert_seed_block(&pool, blk).await;
    }
    assign_all_to_test_space(&pool).await;
    for blk in &seed {
        seed_block_into_engine(state, blk);
    }
    assign_all_to_test_space(&pool).await;

    let cursor_before = pr3_apply_cursor(&pool).await;
    let seq_before = pr3_max_seq(&pool).await;

    // Non-reserved text property → `block_properties` row.
    set_property_inner(
        &pool,
        DEV,
        &mat,
        target.as_str().into(),
        "status".into(),
        Some("active".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("set_property_inner");
    settle(&mat).await;

    // (a) ENGINE freshness — WITHOUT boot replay the engine has the property.
    {
        let space = SpaceId::from_trusted(TEST_SPACE_ID);
        let mut guard = state.registry.for_space(&space, DEV).expect("for_space");
        let v = guard
            .engine_mut()
            .read_property_typed(&target, "status")
            .expect("read_property_typed")
            .expect("engine has the freshly-set property (no boot replay)");
        drop(guard);
        assert_eq!(
            v,
            PropertyValue::Str("active".into()),
            "engine read_property_typed must reflect the local set_property in-tx",
        );
    }

    // (b) SQL `block_properties` matches the engine.
    let sql_val: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT value_text FROM block_properties WHERE block_id = ? AND key = ?",
    )
    .bind(&target)
    .bind("status")
    .fetch_optional(&pool)
    .await
    .unwrap()
    .flatten();
    assert_eq!(
        sql_val.as_deref(),
        Some("active"),
        "SQL block_properties.value_text must match the engine",
    );

    // (c) cursor unmoved, op_log advanced.
    assert!(
        pr3_max_seq(&pool).await > seq_before,
        "local set_property must append to op_log",
    );
    assert_eq!(
        pr3_apply_cursor(&pool).await,
        cursor_before,
        "local set_property must NOT advance the apply cursor (#1248 / #1257)",
    );

    mat.shutdown();
}

/// PR-3: a LOCAL `add_tag_inner` routes the `block_tags` write + inheritance
/// fan-out through `apply_add_tag_via_loro` IN-TX, so the engine's `read_tags`
/// reflects the membership (no boot replay) AND the SQL `block_tags` row
/// matches, AND the apply cursor stays put while op_log advances.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_add_tag_is_engine_fresh_1257() {
    let target = seed_label_to_id("BA");
    let tag = seed_label_to_id("TG");

    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let state = crate::loro::shared::install_for_test();
    state.registry.clear();

    // S1 > {BA}; TG is a top-level tag block. All scoped to one space so
    // `resolve_block_space` succeeds and add_tag engages the engine path.
    let seed = [
        json!({"id": "S1", "block_type": "page",    "content": "Home", "parent_id": null, "position": 1}),
        json!({"id": "BA", "block_type": "content", "content": "A",    "parent_id": "S1", "position": 1}),
        json!({"id": "TG", "block_type": "tag",     "content": "todo", "parent_id": null, "position": 2}),
    ];
    for blk in &seed {
        insert_seed_block(&pool, blk).await;
    }
    assign_all_to_test_space(&pool).await;
    for blk in &seed {
        seed_block_into_engine(state, blk);
    }
    assign_all_to_test_space(&pool).await;

    let cursor_before = pr3_apply_cursor(&pool).await;
    let seq_before = pr3_max_seq(&pool).await;

    add_tag_inner(
        &pool,
        DEV,
        &mat,
        BlockId::from(target.as_str()),
        BlockId::from(tag.as_str()),
    )
    .await
    .expect("add_tag_inner");
    settle(&mat).await;

    // (a) ENGINE freshness — WITHOUT boot replay the engine has the tag.
    {
        let space = SpaceId::from_trusted(TEST_SPACE_ID);
        let mut guard = state.registry.for_space(&space, DEV).expect("for_space");
        let tags = guard.engine_mut().read_tags(&target).expect("read_tags");
        drop(guard);
        assert!(
            tags.contains(&tag),
            "engine read_tags must reflect the local add_tag in-tx (no boot replay); got {tags:?}",
        );
    }

    // (b) SQL `block_tags` matches the engine.
    let sql_present: Option<i32> =
        sqlx::query_scalar::<_, i32>("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&target)
            .bind(&tag)
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(
        sql_present.is_some(),
        "SQL block_tags row must match the engine tag membership",
    );

    // (c) cursor unmoved, op_log advanced.
    assert!(
        pr3_max_seq(&pool).await > seq_before,
        "local add_tag must append to op_log",
    );
    assert_eq!(
        pr3_apply_cursor(&pool).await,
        cursor_before,
        "local add_tag must NOT advance the apply cursor (#1248 / #1257)",
    );

    mat.shutdown();
}
