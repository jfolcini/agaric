//! #6529 spike — the conformance fixtures' `via: "command"` ops through the
//! REAL IPC surface instead of the hand-written `*_inner` dispatcher.
//!
//! Inside [`with_ipc`], `run_command_op` sends each op to a
//! [`agaric_lib::headless::HeadlessApp`] built over the fixture's own pool,
//! materializer and data dir: tauri's argument decoder, the `#[tauri::command]`
//! wrapper (event emission included), `AppError` serialization. The args are
//! expanded the way the TS twin expands them for the mock
//! (`expandOpArgs` in `src/lib/tauri-mock/__tests__/conformance-replay.ts`),
//! because the mock is keyed by the same wire names and shapes.
//!
//! The record the op produces is compared with the fixture's committed
//! `expected_ops` by the unchanged `run_fixture`, so a pass means the wire
//! response tokenizes byte-identically to the `*_inner` response.

use super::common::*;
use super::conformance::{
    expand_content_labels, resolve_attachment_label, resolve_op_arg_id, resolve_op_ref_label,
};
use super::conformance_query::SPACE_TOKEN;
use agaric_lib::headless::HeadlessApp;
use agaric_sync::sync_events::EVENT_PROPERTY_CHANGED;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use tauri::Listener as _;

pub(super) struct IpcTransport {
    app: RefCell<Option<(PathBuf, Rc<HeadlessApp>)>>,
    events: Arc<Mutex<Vec<(String, Value)>>>,
}

tokio::task_local! {
    static IPC: IpcTransport;
}

/// Run `fut` with every `via: "command"` op routed through IPC.
pub(super) async fn with_ipc<F: std::future::Future>(fut: F) -> F::Output {
    IPC.scope(
        IpcTransport {
            app: RefCell::new(None),
            events: Arc::new(Mutex::new(Vec::new())),
        },
        fut,
    )
    .await
}

pub(super) fn active() -> bool {
    IPC.try_with(|_| ()).is_ok()
}

/// The app for this fixture: built on first use, keyed by the fixture's data dir.
fn app_for(pool: &SqlitePool, mat: &Materializer, dir: &Path) -> Rc<HeadlessApp> {
    IPC.with(|t| {
        let mut slot = t.app.borrow_mut();
        if let Some((d, app)) = slot.as_ref()
            && d == dir
        {
            return app.clone();
        }
        let app = Rc::new(HeadlessApp::new(
            agaric_lib::db::DbPools {
                write: pool.clone(),
                read: pool.clone(),
            },
            DEV.to_owned(),
            mat.clone(),
            dir,
        ));
        for name in [EVENT_PROPERTY_CHANGED, "blocks:changed"] {
            let sink = t.events.clone();
            app.app.listen_any(name, move |e| {
                let payload = serde_json::from_str(e.payload()).unwrap_or(Value::Null);
                sink.lock().unwrap().push((name.to_owned(), payload));
            });
        }
        *slot = Some((dir.to_path_buf(), app.clone()));
        app
    })
}

fn space_or_label(s: &str, created_ids: &[String]) -> String {
    if s == SPACE_TOKEN {
        TEST_SPACE_ID.to_owned()
    } else {
        resolve_op_arg_id(s, created_ids)
    }
}

fn op_ref_json(label: &str, op_refs: &[(String, i64)]) -> Value {
    let (device_id, seq) = resolve_op_ref_label(label, op_refs);
    json!({ "device_id": device_id, "seq": seq })
}

/// Rust port of the TS twin's `expandOpArgs`: fixture labels → wire values.
async fn expand_op_args(
    pool: &SqlitePool,
    command: &str,
    args: &Value,
    created_ids: &[String],
    op_refs: &[(String, i64)],
) -> Value {
    let mut out: Map<String, Value> = args.as_object().cloned().unwrap_or_default();
    for key in [
        "blockId",
        "anchorBlockId",
        "parentId",
        "newParentId",
        "tagId",
        "pageId",
        "spaceId",
    ] {
        if let Some(Value::String(s)) = out.get(key) {
            let v = space_or_label(s, created_ids);
            out.insert(key.to_owned(), json!(v));
        }
    }
    for key in ["content", "toText"] {
        if let Some(Value::String(s)) = out.get(key) {
            let v = expand_content_labels(s, created_ids);
            out.insert(key.to_owned(), json!(v));
        }
    }
    if let Some(Value::Object(scope)) = out.get_mut("scope")
        && let Some(Value::String(s)) = scope.get("space_id")
    {
        let v = space_or_label(s, created_ids);
        scope.insert("space_id".into(), json!(v));
    }
    if let Some(Value::Object(input)) = out.get_mut("input") {
        for key in ["space_id", "template_id", "link_block_id"] {
            if let Some(Value::String(s)) = input.get(key) {
                let v = space_or_label(s, created_ids);
                input.insert(key.into(), json!(v));
            }
        }
    }
    if let Some(Value::Array(specs)) = out.get_mut("specs") {
        for spec in specs.iter_mut() {
            if let Some(Value::String(s)) = spec.get("parentId") {
                let v = resolve_op_arg_id(s, created_ids);
                spec["parentId"] = json!(v);
            }
        }
    }
    for key in ["blockIds", "spaceIds"] {
        if let Some(Value::Array(ids)) = out.get_mut(key) {
            for id in ids.iter_mut() {
                if let Value::String(s) = id {
                    *id = json!(resolve_op_arg_id(s, created_ids));
                }
            }
        }
    }
    if let Some(Value::String(s)) = out.get("attachmentId") {
        let v = resolve_attachment_label(pool, s).await;
        out.insert("attachmentId".into(), json!(v));
    }
    if let Some(Value::String(s)) = out.get("opRef") {
        let v = op_ref_json(s, op_refs);
        out.insert("opRef".into(), v);
    }
    if let Some(Value::Array(ops)) = out.get_mut("ops") {
        for op in ops.iter_mut() {
            if let Value::String(s) = op {
                *op = op_ref_json(s, op_refs);
            }
        }
    }
    for (label, device, seq) in [
        ("undoOp", "undoDeviceId", "undoSeq"),
        ("targetOp", "targetDeviceId", "targetSeq"),
    ] {
        if let Some(Value::String(s)) = out.remove(label) {
            let (d, n) = resolve_op_ref_label(&s, op_refs);
            out.insert(device.into(), json!(d));
            out.insert(seq.into(), json!(n));
        }
    }
    // Per-command shims: fixtures written against an `*_inner` signature,
    // where the wire takes more (the mock never ran these, so the TS twin has
    // no expansion for them).
    shim_wire_args(pool, command, &mut out, created_ids).await;
    if let Some(Value::Object(v)) = out.get_mut("value")
        && let Some(Value::String(s)) = v.get("value_ref")
    {
        let r = resolve_op_arg_id(s, created_ids);
        v.insert("value_ref".into(), json!(r));
    }
    Value::Object(out)
}

/// The three commands whose fixture args are not the wire's.
async fn shim_wire_args(
    pool: &SqlitePool,
    command: &str,
    out: &mut Map<String, Value>,
    created_ids: &[String],
) {
    match command {
        // The frontend passes the tombstone it read; the fixture names only
        // the block, so read it as `apply_op_via_command` does.
        "restore_block" if !out.contains_key("deletedAtRef") => {
            let id = out["blockId"]
                .as_str()
                .expect("restore_block blockId")
                .to_owned();
            let at: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(&id)
                .fetch_optional(pool)
                .await
                .expect("read the tombstone")
                .flatten();
            out.insert("deletedAtRef".into(), json!(at.unwrap_or(0)));
        }
        // The wrapper takes a progress channel and the run's page list.
        "import_markdown" => {
            out.entry("runPages").or_insert(json!([]));
            out.entry("vault").or_insert(Value::Null);
            out.insert("progress".into(), json!("__CHANNEL__:4242"));
        }
        // Labels nested in objects and a list the generic expansion skips.
        "link_import_anchors" => {
            if let Some(Value::Array(anchors)) = out.get_mut("anchors") {
                for a in anchors.iter_mut() {
                    for key in ["page_id", "block_id"] {
                        if let Some(Value::String(l)) = a.get(key) {
                            let v = resolve_op_arg_id(l, created_ids);
                            a[key] = json!(v);
                        }
                    }
                }
            }
            if let Some(Value::Array(blocks)) = out.get_mut("blocks") {
                for b in blocks.iter_mut() {
                    if let Value::String(l) = b {
                        *b = json!(resolve_op_arg_id(l, created_ids));
                    }
                }
            }
        }
        _ => {}
    }
}

/// `WithOps<{ <rows>: T[] }>`: a `Vec` cannot be flattened, so the wire nests
/// the rows under a key the `*_inner` never had. Same table as `rows` in the
/// TS twin's `RETURN_SHAPE`.
fn unwrap_rows(command: &str, response: Value) -> Value {
    let key = match command {
        "create_blocks_batch" | "duplicate_block" | "paste_blocks" => "blocks",
        "move_blocks_batch" => "moves",
        "set_page_aliases" => "aliases",
        _ => return response,
    };
    response.get(key).cloned().unwrap_or(response)
}

/// What one op did on the wire.
pub(super) struct IpcOutcome {
    /// `Ok(response)` or `Err((kind, code))`.
    pub result: Result<Value, (Value, Value)>,
    /// `block:properties-changed` payloads, in emission order.
    pub property_events: Vec<Value>,
}

pub(super) async fn apply_op_via_ipc(
    pool: &SqlitePool,
    mat: &Materializer,
    app_data_dir: &Path,
    op: &Value,
    created_ids: &[String],
    op_refs: &[(String, i64)],
) -> IpcOutcome {
    let command = op["command"].as_str().expect("op command");
    let app = app_for(pool, mat, app_data_dir);
    let args = expand_op_args(pool, command, &op["args"], created_ids, op_refs).await;
    let events = IPC.with(|t| t.events.clone());
    events.lock().unwrap().clear();
    let result = app
        .invoke(command, args)
        .await
        .map(|v| unwrap_rows(command, v))
        .map_err(|e| {
            (
                e.get("kind")
                    .cloned()
                    .unwrap_or_else(|| json!(format!("<not an AppError: {e}>"))),
                e.get("code").cloned().unwrap_or(Value::Null),
            )
        });
    let property_events = events
        .lock()
        .unwrap()
        .drain(..)
        .filter(|(name, _)| name == EVENT_PROPERTY_CHANGED)
        .map(|(_, p)| p)
        .collect();
    IpcOutcome {
        result,
        property_events,
    }
}

// ---------------------------------------------------------------------------
// Spike measurements
// ---------------------------------------------------------------------------

fn panic_message(p: &Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<String>()
        .cloned()
        .or_else(|| p.downcast_ref::<&str>().map(|s| (*s).to_owned()))
        .unwrap_or_else(|| "<non-string panic>".to_owned())
}

/// Criterion (b), all of it: every committed fixture that has `expected_ops`,
/// with its `via: "command"` ops sent through IPC. The snapshot, query and
/// command comparisons are `run_fixture`'s own. Writes a JSON report to
/// `$IPC_SPIKE_REPORT` when set.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conformance_command_ops_match_via_ipc() {
    use futures_util::FutureExt as _;
    let mut passed: Vec<String> = Vec::new();
    let mut failed: Vec<(String, String)> = Vec::new();
    let mut ops = 0usize;
    for path in super::conformance::fixture_paths() {
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        if fixture.get("expected_ops").is_none_or(Value::is_null) {
            continue;
        }
        ops += fixture["ops"]
            .as_array()
            .map_or(0, |o| o.iter().filter(|op| op["via"] == "command").count());
        let name = fixture["name"].as_str().unwrap_or("?").to_owned();
        let run = std::panic::AssertUnwindSafe(Box::pin(with_ipc(
            super::conformance::run_fixture(&path),
        )))
        .catch_unwind()
        .await;
        match run {
            Ok(()) => passed.push(name),
            Err(p) => failed.push((name, panic_message(&p))),
        }
    }
    eprintln!(
        "IPC SPIKE: {} fixtures with via-command ops ({ops} ops): {} match, {} differ",
        passed.len() + failed.len(),
        passed.len(),
        failed.len()
    );
    for (name, msg) in &failed {
        eprintln!("  DIFF {name}: {}", msg.lines().next().unwrap_or(""));
    }
    if let Ok(out) = std::env::var("IPC_SPIKE_REPORT") {
        let report = json!({
            "passed": passed,
            "failed": failed.iter().map(|(n, m)| json!({"name": n, "message": m})).collect::<Vec<_>>(),
        });
        std::fs::write(out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    }
    assert!(
        failed.is_empty(),
        "{} fixtures differ through IPC",
        failed.len()
    );
}

/// Criterion (b), the plain read: `get_block` through IPC against the
/// fixture's recorded `expected_queries` tokens, and against the `*_inner`
/// the wrapper calls, as JSON.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn point_read_matches_fixture_via_ipc() {
    use super::conformance::{fixtures_dir, read_created_block_ids_in_op_order, replay_fixture};
    use super::conformance_command::Declarations;
    use super::conformance_query::{BLOCK_ATTRS, expand_query_args, relabel_token, row_token};
    use super::conformance_snapshot::canonical_label_map;

    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(fixtures_dir().join("query_point_reads_blocks.json")).unwrap(),
    )
    .unwrap();
    let replay = replay_fixture(&fixture, "query_point_reads_blocks", Declarations::Enforced).await;
    let labels = canonical_label_map(&replay.canonical_order);
    let created = read_created_block_ids_in_op_order(&replay.pool).await;
    let app = HeadlessApp::new(
        agaric_lib::db::DbPools {
            write: replay.pool.clone(),
            read: replay.pool.clone(),
        },
        DEV.to_owned(),
        replay._mat.clone(),
        replay._dir.path(),
    );
    let expected = fixture["expected_queries"].as_array().unwrap();
    let mut checked = 0;
    for step in fixture["queries"].as_array().unwrap() {
        if step["command"] != "get_block" {
            continue;
        }
        let want = expected
            .iter()
            .find(|e| e["name"] == step["name"])
            .expect("expected entry");
        let args = expand_query_args(&step["args"], &created);
        let wire = app.invoke("get_block", args.clone()).await;
        let direct = agaric_lib::commands::get_active_block_inner(
            &replay.pool,
            serde_json::from_value(args["blockId"].clone()).unwrap(),
        )
        .await;
        match (wire, direct) {
            (Ok(v), Ok(row)) => {
                assert_eq!(
                    serde_json::to_string(&v).unwrap(),
                    serde_json::to_string(&serde_json::to_value(&row).unwrap()).unwrap(),
                    "IPC JSON differs from the inner's"
                );
                let token = relabel_token(&row_token(&v, "id", BLOCK_ATTRS), &labels);
                assert_eq!(json!([token]), want["rows"], "step {}", step["name"]);
                assert!(want["error"].is_null());
            }
            (Err(e), Err(inner)) => {
                assert_eq!(e["kind"], want["error"], "step {}", step["name"]);
                assert_eq!(e, serde_json::to_value(&inner).unwrap(), "error envelope");
            }
            (w, d) => panic!("IPC and inner disagree: {w:?} vs {d:?}"),
        }
        checked += 1;
    }
    assert_eq!(checked, 2);
    eprintln!("IPC SPIKE: get_block matched the fixture on {checked} steps");
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// A reset must leave a working vault: write a page through IPC, read it back.
fn assert_live(app: &HeadlessApp) {
    let spaces =
        tauri::async_runtime::block_on(app.invoke("list_spaces", json!({}))).expect("list_spaces");
    let space_id = spaces[0]["id"]
        .as_str()
        .expect("a bootstrapped space")
        .to_owned();
    let page = tauri::async_runtime::block_on(app.invoke(
        "create_page_in_space",
        json!({ "parentId": null, "content": "reset probe", "spaceId": space_id }),
    ))
    .expect("create_page_in_space");
    let row = tauri::async_runtime::block_on(app.invoke("get_block", json!({ "blockId": page })))
        .expect("get_block");
    assert_eq!(row["content"], "reset probe");
}

fn stats(label: &str, mut ms: Vec<f64>) -> (f64, f64) {
    ms.sort_by(f64::total_cmp);
    // Nearest-rank percentile: index `ceil(q * n) - 1`, in integer arithmetic.
    let pick = |pct: usize| ms[(pct * ms.len()).div_ceil(100).saturating_sub(1)];
    let (median, p95) = (pick(50), pick(95));
    eprintln!(
        "IPC SPIKE reset [{label}] n={} median={median:.1}ms p95={p95:.1}ms min={:.1} max={:.1}",
        ms.len(),
        ms[0],
        ms[ms.len() - 1]
    );
    (median, p95)
}

/// Criterion (c): a vault reset, 50 times, two ways. "fresh" boots an empty
/// directory (migrations included); "template" copies a vault booted once and
/// boots the copy. Each iteration shuts the previous app down first, and every
/// new vault must pass [`assert_live`], which is also the check that the
/// process-global statics survive a reset in one process.
#[test]
fn headless_reset_timing() {
    let n: usize = std::env::var("IPC_SPIKE_RESETS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50);
    let root = tempfile::TempDir::new().unwrap();
    let ms = |t: std::time::Instant| t.elapsed().as_secs_f64() * 1000.0;

    let mut fresh = Vec::new();
    let mut shutdown = Vec::new();
    let mut previous: Option<HeadlessApp> = None;
    for i in 0..n {
        let dir = root.path().join(format!("fresh-{i}"));
        let t = std::time::Instant::now();
        if let Some(app) = previous.take() {
            let s = std::time::Instant::now();
            app.shutdown();
            shutdown.push(ms(s));
        }
        let app = HeadlessApp::boot(&dir).expect("boot fresh vault");
        fresh.push(ms(t));
        assert_live(&app);
        previous = Some(app);
    }
    if let Some(app) = previous.take() {
        app.shutdown();
    }

    let template = root.path().join("template");
    HeadlessApp::boot(&template)
        .expect("boot template")
        .shutdown();
    let mut copied = Vec::new();
    for i in 0..n {
        let dir = root.path().join(format!("copy-{i}"));
        let t = std::time::Instant::now();
        if let Some(app) = previous.take() {
            app.shutdown();
        }
        copy_dir(&template, &dir);
        let app = HeadlessApp::boot(&dir).expect("boot copied vault");
        copied.push(ms(t));
        assert_live(&app);
        previous = Some(app);
    }
    if let Some(app) = previous.take() {
        app.shutdown();
    }
    let threads = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("Threads:"))
                .map(str::to_owned)
        });
    eprintln!(
        "IPC SPIKE reset: after {} boots, {}",
        2 * n + 1,
        threads.unwrap_or_default()
    );
    stats("shutdown only", shutdown);
    stats("fresh: shutdown + boot empty dir", fresh);
    stats("template: shutdown + copy + boot", copied);
}
