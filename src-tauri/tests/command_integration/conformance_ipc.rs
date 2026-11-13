//! #6529 — the transport of the conformance command leg: a fixture's
//! `via: "command"` op crosses the app's own IPC surface.
//!
//! [`IpcTransport`] is a [`HeadlessApp`] over the fixture's pool, materializer
//! and data dir. An op sent through it meets tauri's argument decoder, the
//! `#[tauri::command]` wrapper with the events it emits, and the error's
//! serialization: what a frontend `invoke()` meets, and what the mock stands
//! in for. Nothing here names a command's Rust signature, so a wrapper that
//! decodes, calls or emits something else reddens its fixture.
//!
//! Fixture args are spelled as the wire spells them, with labels where the
//! wire takes ids. [`expand_op_args`] is the Rust twin of `expandOpArgs` in
//! `src/lib/tauri-mock/__tests__/conformance-replay.ts`, which does the same
//! for the mock.

use super::common::*;
use super::conformance::{
    expand_content_labels, resolve_attachment_label, resolve_op_arg_id, resolve_op_ref_label,
};
use super::conformance_query::SPACE_TOKEN;
use agaric_lib::headless::HeadlessApp;
use agaric_sync::sync_events::EVENT_PROPERTY_CHANGED;
use agaric_sync::sync_scheduler::{LocalEndpointAdvert, SyncScheduler};
use serde_json::{Map, Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{Listener as _, Manager as _};

pub(super) struct IpcTransport {
    app: HeadlessApp,
    pool: SqlitePool,
    property_events: Arc<Mutex<Vec<Value>>>,
}

/// What one op did on the wire.
pub(super) struct IpcOutcome {
    /// The response, or a refusal's `kind` and `code` as the wire spells them
    /// (`code` is `Null` when the refusal carries none).
    pub result: Result<Value, (Value, Value)>,
    /// The `block:properties-changed` payloads the wrapper emitted, in order.
    pub property_events: Vec<Value>,
}

impl IpcTransport {
    /// One app per fixture replay, over that replay's vault. Read and write
    /// share the fixture's single pool, as its `*_inner` calls always did.
    pub(super) fn new(pool: &SqlitePool, mat: &Materializer, app_data_dir: &Path) -> Self {
        let app = HeadlessApp::new(
            agaric_lib::db::DbPools {
                write: pool.clone(),
                read: pool.clone(),
            },
            DEV.to_owned(),
            mat.clone(),
            app_data_dir,
        );
        // `start_pairing` waits on `SyncScheduler::await_local_endpoint` before
        // it renders the QR, for five seconds of real time, and no sync daemon
        // runs here to publish one. Publishing first makes the wait return at
        // once. The advert feeds only the QR payload, which no fixture reads.
        app.app
            .state::<Arc<SyncScheduler>>()
            .publish_local_endpoint(LocalEndpointAdvert {
                device_id: DEV.to_owned(),
                endpoint_id: "conformance-endpoint".to_owned(),
                addrs: Vec::new(),
            });
        let property_events = Arc::new(Mutex::new(Vec::new()));
        let sink = property_events.clone();
        app.app.listen_any(EVENT_PROPERTY_CHANGED, move |event| {
            let payload = serde_json::from_str(event.payload()).expect("event payload is JSON");
            sink.lock().expect("event sink").push(payload);
        });
        Self {
            app,
            pool: pool.clone(),
            property_events,
        }
    }

    /// Send one fixture op. A mock app that is not running emits inline on the
    /// command's task, so every event has landed by the time the response has.
    pub(super) async fn apply_op(
        &self,
        op: &Value,
        created_ids: &[String],
        op_refs: &[(String, i64)],
    ) -> IpcOutcome {
        let command = op["command"].as_str().expect("op command");
        let args = expand_op_args(&self.pool, command, &op["args"], created_ids, op_refs).await;
        let result = self.app.invoke(command, args).await.map_err(|error| {
            // Anything but an `AppError` came from the IPC layer (an arg that
            // did not decode, a command or a managed state that is not there):
            // the op never reached its command, so there is no refusal to record.
            let kind = error
                .get("kind")
                .filter(|kind| kind.is_string())
                .unwrap_or_else(|| {
                    panic!("conformance op '{command}' did not reach its command: {error}")
                });
            (
                kind.clone(),
                error.get("code").cloned().unwrap_or(Value::Null),
            )
        });
        let property_events =
            std::mem::take(&mut *self.property_events.lock().expect("event sink"));
        IpcOutcome {
            result,
            property_events,
        }
    }
}

/// A label where the wire takes a block or space id: `$SPACE` names the
/// harness space, anything else resolves as [`resolve_op_arg_id`] resolves it.
fn resolve_label(label: &str, created_ids: &[String]) -> Value {
    json!(if label == SPACE_TOKEN {
        TEST_SPACE_ID.to_owned()
    } else {
        resolve_op_arg_id(label, created_ids)
    })
}

/// Replace `object[key]` with its resolved id when it is a label.
fn resolve_key(object: &mut Map<String, Value>, key: &str, created_ids: &[String]) {
    if let Some(Value::String(label)) = object.get(key) {
        let id = resolve_label(label, created_ids);
        object.insert(key.to_owned(), id);
    }
}

fn op_ref_json(label: &str, op_refs: &[(String, i64)]) -> Value {
    let (device_id, seq) = resolve_op_ref_label(label, op_refs);
    json!({ "device_id": device_id, "seq": seq })
}

/// A fixture op's args as the wire takes them: every label resolved, and the
/// args a fixture leaves to the harness filled in ([`fill_harness_args`]).
/// Text the caller typed (a property key, an alias, a space name) is left
/// alone.
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
        resolve_key(&mut out, key, created_ids);
    }
    // A block's text, whose link tokens may name labels.
    for key in ["content", "toText"] {
        if let Some(Value::String(text)) = out.get(key) {
            let text = expand_content_labels(text, created_ids);
            out.insert(key.to_owned(), json!(text));
        }
    }
    // `create_block`'s space, as the wire's `SpaceScope`.
    if let Some(Value::Object(scope)) = out.get_mut("scope") {
        resolve_key(scope, "space_id", created_ids);
    }
    // `add_meeting`'s one `input` object.
    if let Some(Value::Object(input)) = out.get_mut("input") {
        for key in ["space_id", "template_id", "link_block_id"] {
            resolve_key(input, key, created_ids);
        }
    }
    // `split_block`'s and `merge_blocks`'s one `request` object.
    if let Some(Value::Object(request)) = out.get_mut("request") {
        for key in ["blockId", "intoId", "newBlockId"] {
            resolve_key(request, key, created_ids);
        }
        for key in ["before", "after", "mergedText"] {
            if let Some(Value::String(text)) = request.get(key) {
                let text = expand_content_labels(text, created_ids);
                request.insert(key.to_owned(), json!(text));
            }
        }
    }
    // `set_property`'s value bundle: only a `value_ref` names a block.
    if let Some(Value::Object(value)) = out.get_mut("value") {
        resolve_key(value, "value_ref", created_ids);
    }
    // Lists of objects that each name blocks: `create_blocks_batch`'s specs,
    // `edit_blocks_batch`'s edits, `link_import_anchors`'s anchors.
    for (list, keys) in [
        ("specs", &["parentId"][..]),
        ("edits", &["blockId"][..]),
        ("anchors", &["page_id", "block_id"][..]),
    ] {
        for entry in out
            .get_mut(list)
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Value::Object(entry) = entry {
                for key in keys {
                    resolve_key(entry, key, created_ids);
                }
            }
        }
    }
    // Lists of labels. `blocks` is `link_import_anchors`'s.
    for key in ["blockIds", "spaceIds", "blocks"] {
        for id in out
            .get_mut(key)
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Value::String(label) = id {
                *id = json!(resolve_op_arg_id(label, created_ids));
            }
        }
    }
    // A seeded attachment id is the fixture's own short label (`ATT1`), and
    // `An` the n-th op-added one.
    if let Some(Value::String(label)) = out.get("attachmentId") {
        let id = resolve_attachment_label(pool, label).await;
        out.insert("attachmentId".to_owned(), json!(id));
    }
    // An op coordinate is an `On` label, never a literal: the two runners mint
    // their own `(device_id, seq)`. Three spellings, one convention.
    if let Some(Value::String(label)) = out.get("opRef") {
        let op_ref = op_ref_json(label, op_refs);
        out.insert("opRef".to_owned(), op_ref);
    }
    for op_ref in out
        .get_mut("ops")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if let Value::String(label) = op_ref {
            *op_ref = op_ref_json(label, op_refs);
        }
    }
    for (label_key, device_key, seq_key) in [
        ("undoOp", "undoDeviceId", "undoSeq"),
        ("targetOp", "targetDeviceId", "targetSeq"),
    ] {
        if let Some(Value::String(label)) = out.remove(label_key) {
            let (device_id, seq) = resolve_op_ref_label(&label, op_refs);
            out.insert(device_key.to_owned(), json!(device_id));
            out.insert(seq_key.to_owned(), json!(seq));
        }
    }
    fill_harness_args(pool, command, &mut out).await;
    Value::Object(out)
}

/// The wire args no fixture spells, because the frontend takes them from its
/// own state rather than from the user.
async fn fill_harness_args(pool: &SqlitePool, command: &str, out: &mut Map<String, Value>) {
    match command {
        // The guard is the live tombstone, as the trash view passes it; a block
        // with none passes 0, which the command refuses as not restorable.
        "restore_block" => {
            let block_id = out["blockId"].as_str().expect("restore_block blockId");
            let deleted_at: Option<i64> =
                sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                    .bind(block_id)
                    .fetch_optional(pool)
                    .await
                    .expect("restore_block: read the tombstone")
                    .flatten();
            out.insert("deletedAtRef".to_owned(), json!(deleted_at.unwrap_or(0)));
        }
        // A single file picked alone: no earlier pages in the run, and a
        // progress channel nothing listens on (the id is any number).
        "import_markdown" => {
            out.insert("runPages".to_owned(), json!([]));
            out.insert("progress".to_owned(), json!("__CHANNEL__:0"));
        }
        _ => {}
    }
}

mod tests {
    use super::*;

    /// Without `HeadlessDataDir` the attachment commands resolve the OS
    /// default, and a fixture's blobs land in the developer's own vault folder.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_app_resolves_the_fixtures_own_data_dir() {
        let (pool, dir) = test_pool().await;
        let mat = test_materializer(&pool);
        let ipc = IpcTransport::new(&pool, &mat, dir.path());
        assert_eq!(
            agaric_lib::app_paths::resolve_app_data_dir(ipc.app.app.handle())
                .expect("resolve the app-data dir"),
            dir.path(),
            "a headless app's data dir is the one it was built over"
        );
    }
}
