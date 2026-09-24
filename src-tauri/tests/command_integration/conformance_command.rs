//! #4670 — the MUTATING-command leg of the #763 conformance harness (Rust
//! side / source of truth). TS twin:
//! `src/lib/tauri-mock/__tests__/conformance-command.ts`.
//!
//! A fixture op carrying `"via": "command"` calls its `*_inner` — the function
//! its `#[tauri::command]` wrapper calls — instead of the payload replay, and
//! its return value or refusal (the `AppErrorKind` wire string plus, for
//! `validation`, the `ValidationCode`) lands as one record in the fixture's
//! `expected_ops`, authored by `CONFORMANCE_UPDATE=1` and asserted by both
//! runners:
//!
//! ```json
//! { "name": "…", "returns": ["B2#deleted_at=DELETED#descendants_affected=3"],
//!   "error": null, "code": null }
//! ```
//!
//! `returns` reuses the query leg's row-token grammar ([`row_token`] /
//! [`relabel_token`]), so id relabelling, the `deleted_at` → `DELETED`
//! sentinel and the separator-aliasing refusals all apply. Two rules are
//! specific to this leg:
//!
//!   * **`op_refs` is dropped.** `WithOps.op_refs` carries `(device_id, seq)`,
//!     and the two runners' device ids differ. The op COUNT is already pinned
//!     by the snapshot's `op_log_digest`.
//!   * **A list-valued field** (`DeleteResponse::affected_page_ids`) becomes
//!     one `<field>-><id>` token per element, in the order returned.
//!
//! A refusal must be declared (`expect_error`, plus `expect_code` when it
//! carries a `ValidationCode`) under the #3946 discipline of `run_query_steps`;
//! see [`check_declaration`].

use super::common::*;
use super::conformance::{resolve_op_arg_id, resolve_op_ref_label};
use super::conformance_query::{PROJECTING_STEP, PROPERTY_DEF_ATTRS, relabel_token, row_token};
use agaric_core::ulid::{AttachmentId, BlockId};
use agaric_store::op::OpRef;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// `id key` for a response carrying no row identity of its own — a unit return,
/// or an envelope that is only a count. The token head is the COMMAND NAME and
/// each `attrs` entry is read off the response, mirroring the query leg's
/// `headed` token kind. MUST match the TS twin's constant.
const HEADED_ID_KEY: &str = "<headed>";

/// `(command, id key, attributes, list-valued fields)` — how each mutating
/// command's response becomes tokens. MUST match `RETURN_SHAPE` in the TS
/// twin, which reads the mock's response through the same keys.
const RETURN_SHAPE: &[(&str, &str, &[&str], &[&str])] = &[
    (
        "delete_block",
        "block_id",
        &["deleted_at", "descendants_affected"],
        &["affected_page_ids"],
    ),
    ("purge_block", "block_id", &["purged_count"], &[]),
    // #3830 — both `property_definitions` writers answer with the row, so
    // their shape is `PROPERTY_DEF_ATTRS` read off a response instead of a
    // SELECT. `created_at` stays off it for the reason the token gives.
    ("create_property_def", "key", PROPERTY_DEF_ATTRS, &[]),
    (
        "update_property_def_options",
        "key",
        PROPERTY_DEF_ATTRS,
        &[],
    ),
    // #5057 — the undo family all answer `UndoResult`, singly or in a list, so
    // they share one shape: the `OpRef`s it carries are dropped because the two
    // runners' device ids differ, leaving the two op_type fields and `is_redo`.
    // `is_redo` is what tells a redo's result from an undo's; on a redo,
    // `reversed_op_type` names the UNDO ROW it was handed, not the op it
    // re-applies.
    (
        "undo_page_op",
        HEADED_ID_KEY,
        &["reversed_op_type", "new_op_type", "is_redo"],
        &[],
    ),
    (
        "undo_op",
        HEADED_ID_KEY,
        &["reversed_op_type", "new_op_type", "is_redo"],
        &[],
    ),
    (
        "undo_ops",
        HEADED_ID_KEY,
        &["reversed_op_type", "new_op_type", "is_redo"],
        &[],
    ),
    (
        "revert_ops",
        HEADED_ID_KEY,
        &["reversed_op_type", "new_op_type", "is_redo"],
        &[],
    ),
    (
        "redo_page_op",
        HEADED_ID_KEY,
        &["reversed_op_type", "new_op_type", "is_redo"],
        &[],
    ),
    // #5057 — a COUNT envelope over a list. The per-op detail rides in
    // `results`, which the snapshot and the two counts already pin between
    // them, so the shape names the counts rather than re-projecting the list.
    (
        "restore_page_to_op",
        HEADED_ID_KEY,
        &["ops_reverted", "non_reversible_skipped"],
        &[],
    ),
    // #5057 — a LIST of the same shape: one headed row per `UndoResult`, in
    // the order the group reversed them. That ORDER is the point — a group
    // undo that reversed the right ops in the wrong sequence would pass a
    // set-wise check and fail this one.
    (
        "undo_page_group",
        HEADED_ID_KEY,
        &["reversed_op_type", "new_op_type", "is_redo"],
        &[],
    ),
    // #5057 — the draft writers answer with `()`, so their whole record is the
    // refusal declaration plus a head naming which one ran. `flush_all_drafts`
    // adds the one field a caller can see: how many rows it CONSUMED, which
    // counts a draft dropped by a guard as well as one actually flushed.
    ("save_draft", HEADED_ID_KEY, &[], &[]),
    ("delete_draft", HEADED_ID_KEY, &[], &[]),
    ("flush_draft", HEADED_ID_KEY, &[], &[]),
    ("flush_all_drafts", HEADED_ID_KEY, &["flushed"], &[]),
    // #5057 — the trash-lifecycle batch trio answers with a COUNT envelope and
    // no row identity, so each is headed by its own command name. The counts
    // are what separates them from their single-block siblings: they report
    // the whole cohort the cascade reached, not the ids the caller listed.
    (
        "delete_blocks_by_ids",
        HEADED_ID_KEY,
        &["deleted_count"],
        &["affected_page_ids"],
    ),
    (
        "restore_blocks_by_ids",
        HEADED_ID_KEY,
        &["affected_count"],
        &[],
    ),
    (
        "purge_blocks_by_ids",
        HEADED_ID_KEY,
        &["affected_count"],
        &[],
    ),
    // #5057 — the three batch COUNTERS answer with a bare `i64`, which carries
    // no field to name it. The shape's single attribute names the scalar, so
    // the token reads `set_property_batch#updated=3` instead of exposing a
    // synthetic key. See `project_return`.
    ("set_property_batch", HEADED_ID_KEY, &["updated"], &[]),
    ("set_todo_state_batch", HEADED_ID_KEY, &["updated"], &[]),
    ("add_tags_by_ids", HEADED_ID_KEY, &["tagged"], &[]),
    // #5057 — the two batch commands that answer with a LIST OF ROWS. Each
    // element becomes its own row token in the order returned, so the returned
    // ORDER is pinned as well as the rows: a batch that answers with the right
    // set in the wrong order reds. The `_inner` returns the bare list; the
    // wrapper wraps it (`CreatedBlocks` / `MovedBlocks`, #5140), which is why
    // the TS twin's rows carry a `rows` key and these do not.
    (
        "create_blocks_batch",
        "id",
        &["block_type", "content", "parent_id", "position"],
        &[],
    ),
    (
        "move_blocks_batch",
        "block_id",
        &["new_parent_id", "new_position"],
        &[],
    ),
    // #5140 — the same row list as `create_blocks_batch`: the root copy, then
    // its descendants depth-first, so the order is pinned with the rows.
    (
        "duplicate_block",
        "id",
        &["block_type", "content", "parent_id", "position"],
        &[],
    ),
    // #5140 — the same row list again: the pages and tags the paste created,
    // then the pasted blocks in document order.
    (
        "paste_blocks",
        "id",
        &["block_type", "content", "parent_id", "position"],
        &[],
    ),
    // #5140 — a COUNT envelope with no row identity. `moved` stays off it:
    // the fewest moves a reorder needs is the backend's placement to pin, not
    // the mock's, and the snapshot pins where the blocks landed.
    (
        "apply_page_source",
        HEADED_ID_KEY,
        &["created", "edited", "deleted"],
        &[],
    ),
    // #5057 — five writers whose table is OUTSIDE the snapshot's five arrays
    // (`peer_refs`, `app_settings`, `property_definitions`), so what they wrote
    // is pinned by the read that follows them in the same fixture rather than
    // by the settled state. Each answers with `()`, so the record is the
    // refusal declaration plus a head naming which one ran.
    ("delete_peer_ref", HEADED_ID_KEY, &[], &[]),
    ("update_peer_name", HEADED_ID_KEY, &[], &[]),
    ("set_peer_address", HEADED_ID_KEY, &[], &[]),
    ("set_reminder_settings", HEADED_ID_KEY, &[], &[]),
    // #4549 — same shape: one `app_settings` row, observed by the
    // `get_sync_relay_settings` step that follows.
    ("set_sync_relay_settings", HEADED_ID_KEY, &[], &[]),
    ("delete_property_def", HEADED_ID_KEY, &[], &[]),
    // #5057 — the two attachment writers that need no blob. Both answer `()`,
    // and `attachments` is outside the snapshot's five arrays, so the
    // `list_attachments` step is what observes them.
    ("delete_attachment", HEADED_ID_KEY, &[], &[]),
    ("rename_attachment", HEADED_ID_KEY, &[], &[]),
    // #5057 — the bytes writer, whose `AttachmentRow` is HALF stack-local:
    // `id`, `fs_path` and `content_hash` are minted per stack (two fresh
    // ULIDs and a real blake3) and `created_at` is `now_ms()`. The shape names
    // the four fields that are not — the ones the caller supplied and the row
    // stores verbatim — so the return pins what was written without binding a
    // value either stack invents. What stays unpinned is stated in
    // `attachment_add_bytes.json`'s description.
    (
        "add_attachment_with_bytes",
        HEADED_ID_KEY,
        &["block_id", "filename", "mime_type", "size_bytes"],
        &[],
    ),
    // #5057 — `page_aliases` is outside the snapshot's five arrays too, so the
    // `get_page_aliases` step observes the table. The RETURN is its own
    // evidence: a LIST OF BARE STRINGS naming the rows the write actually
    // INSERTED, which is narrower than what the caller passed — an entry that
    // trims to nothing, and one another page already holds, are both dropped
    // by the command and so never appear here.
    ("set_page_aliases", HEADED_ID_KEY, &["inserted"], &[]),
    // #5057 — op-log maintenance. `CompactionResult` is one count, and on this
    // corpus it is deterministically zero: the cutoff is `now() - retention`
    // with a seven-day floor, and every op a fixture replays is minted during
    // the run. What the record pins is therefore the no-op path and, through
    // the refusals beside it, the `retention_days` floor itself.
    ("compact_op_log_cmd", HEADED_ID_KEY, &["ops_deleted"], &[]),
    // #5057 — the joiner half of pairing answers `()`. Its durable write that
    // anything READS is the `unpaired_by_peer_at_ms` clear across `peer_refs`,
    // so the `list_peer_refs` step beside it is the observation.
    ("confirm_pairing", HEADED_ID_KEY, &[], &[]),
    // #5057 — the HOST half, and the attrs are empty for a different reason
    // than the unit returns above: `PairingInfo` HAS two fields and neither is
    // nameable. `passphrase` is `generate_passphrase()`, minted fresh per
    // stack, and `qr_svg` is rendered from it. The write anything READS is the
    // same `unpaired_by_peer_at_ms` clear, observed by the step beside it.
    ("start_pairing", HEADED_ID_KEY, &[], &[]),
    // #5057 — the two space CREATORS answer with the new block's id, which
    // `relabel_token` maps to its canonical label like any other id-valued
    // attribute, so the return names WHICH block was made rather than a
    // stack-local ULID. Both also land in the snapshot (the projection excludes
    // only the harness's own test space), so the return and the settled state
    // pin different halves: the return says what the caller was told, the
    // snapshot says what was written.
    ("create_space", HEADED_ID_KEY, &["space_id"], &[]),
    ("create_page_in_space", HEADED_ID_KEY, &["page_id"], &[]),
    // #5057 — the batch MOVER answers with a bare `i64` like the three
    // counters above, so its single attribute names the scalar. The count is
    // narrower than the input list: an id that no longer resolves to a live
    // block is skipped, not refused.
    ("move_blocks_to_space", HEADED_ID_KEY, &["moved"], &[]),
];

fn to_json<T: Serialize>(outcome: Result<T, AppError>) -> Result<Value, AppError> {
    outcome.map(|v| serde_json::to_value(v).expect("serialize command response"))
}

/// Run one fixture op through its `*_inner`, with the same arg expansion
/// `apply_op` gives the payload path. `Ok` is the serialized response; `Err`
/// is the command's own refusal, untouched.
pub(super) async fn apply_op_via_command(
    pool: &SqlitePool,
    mat: &Materializer,
    // The fixture's own `TempDir`. Threaded rather than faked because the
    // attachment commands take it by signature; `delete_attachment_inner`
    // ignores it (#1993 moved byte reclamation to the GC pass) but
    // `add_attachment_with_bytes_inner` writes into it, so a placeholder here
    // would work today and silently write somewhere real tomorrow.
    app_data_dir: &std::path::Path,
    op: &Value,
    created_ids: &[String],
    op_refs: &[(String, i64)],
) -> Result<Value, AppError> {
    let command = op["command"].as_str().expect("op command");
    let args = &op["args"];
    let arg = |k: &str| args.get(k);
    let arg_label_id = |k: &str| {
        arg(k)
            .and_then(Value::as_str)
            .map(|l| resolve_op_arg_id(l, created_ids))
    };
    let block_id = || BlockId::from(arg_label_id("blockId").expect("blockId").as_str());
    // A batch command's `blockIds` is a LIST of the same labels `blockId`
    // takes, each expanded through `resolve_op_arg_id`, so a fixture names
    // seed rows and op-created blocks in a batch exactly as it does singly.
    // `create_blocks_batch` is the one batch command whose list is not ids but
    // SPECS. Only `parentId` inside a spec is a label — everything else is the
    // caller's own text, as for the scalar args above.
    let block_specs = || {
        arg("specs")
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("conformance op '{command}' is missing arg 'specs'"))
            .iter()
            .map(|spec| CreateBlockSpec {
                block_type: spec["blockType"]
                    .as_str()
                    .unwrap_or_else(|| panic!("conformance op '{command}': spec blockType"))
                    .to_owned(),
                content: spec["content"].as_str().unwrap_or_default().to_owned(),
                parent_id: spec["parentId"]
                    .as_str()
                    .map(|l| BlockId::from(resolve_op_arg_id(l, created_ids).as_str())),
                position: spec["position"].as_i64(),
                properties: spec["properties"]
                    .as_object()
                    .map(|map| {
                        map.iter()
                            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect::<Vec<_>>()
    };
    let block_ids = || {
        arg("blockIds")
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("conformance op '{command}' is missing arg 'blockIds'"))
            .iter()
            .map(|l| {
                let label = l.as_str().unwrap_or_else(|| {
                    panic!("conformance op '{command}': blockIds entry is not a string")
                });
                BlockId::from(resolve_op_arg_id(label, created_ids).as_str())
            })
            .collect::<Vec<_>>()
    };
    // String args take no label expansion: a `property_definitions` key is
    // the user's own text, not a seed id.
    let opt_str = |k: &str| arg(k).and_then(Value::as_str).map(str::to_owned);
    let req_str = |k: &str| {
        opt_str(k).unwrap_or_else(|| panic!("conformance op '{command}' is missing arg '{k}'"))
    };
    // #5057 — an `OpRef` arg is an `On` label, never a literal: the two
    // runners mint their own `(device_id, seq)`. Mirrors `block_id()` above.
    let op_ref = |k: &str| {
        let label = arg(k)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("conformance op '{command}' is missing arg '{k}'"));
        let (device_id, seq) = resolve_op_ref_label(label, op_refs);
        OpRef { device_id, seq }
    };
    // The list form of the above: `ops` is an array of `On` labels, expanded
    // exactly as `blockIds` expands the scalar `blockId`.
    let op_ref_list = |k: &str| {
        arg(k)
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("conformance op '{command}' is missing arg '{k}'"))
            .iter()
            .map(|label| {
                let label = label.as_str().unwrap_or_else(|| {
                    panic!("conformance op '{command}': '{k}' entry is not a string")
                });
                let (device_id, seq) = resolve_op_ref_label(label, op_refs);
                OpRef { device_id, seq }
            })
            .collect::<Vec<_>>()
    };
    // The SPLIT form: two commands take an op coordinate as two positional
    // args rather than an `OpRef`. The fixture still spells one `On` label —
    // splitting it here keeps a single convention across all five.
    let op_ref_split = |k: &str| {
        let label = arg(k)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("conformance op '{command}' is missing arg '{k}'"));
        resolve_op_ref_label(label, op_refs)
    };
    let req_i64 = |k: &str| {
        arg(k)
            .and_then(Value::as_i64)
            .unwrap_or_else(|| panic!("conformance op '{command}' is missing arg '{k}'"))
    };

    match command {
        "delete_block" => to_json(delete_block_inner(pool, DEV, mat, block_id()).await),
        "purge_block" => to_json(purge_block_inner(pool, DEV, mat, block_id()).await),
        "create_property_def" => to_json(
            create_property_def_inner(
                pool,
                req_str("key"),
                req_str("valueType"),
                opt_str("options"),
            )
            .await,
        ),
        "update_property_def_options" => to_json(
            update_property_def_options_inner(pool, req_str("key"), req_str("options")).await,
        ),
        // `save_draft` and `delete_draft` have no `*_inner`: their wrappers are
        // the thin layer over these engine functions directly.
        "save_draft" => to_json(
            agaric_engine::draft::save_draft(pool, DEV, block_id().as_str(), &req_str("content"))
                .await,
        ),
        "delete_draft" => {
            to_json(agaric_engine::draft::delete_draft(pool, block_id().as_str()).await)
        }
        "flush_draft" => to_json(flush_draft_inner(pool, DEV, block_id(), mat).await),
        "flush_all_drafts" => to_json(flush_all_drafts_inner(pool, DEV, mat).await),
        "delete_blocks_by_ids" => {
            to_json(delete_blocks_by_ids_inner(pool, DEV, mat, block_ids()).await)
        }
        "restore_blocks_by_ids" => {
            to_json(restore_blocks_by_ids_inner(pool, DEV, mat, block_ids()).await)
        }
        "purge_blocks_by_ids" => {
            to_json(purge_blocks_by_ids_inner(pool, DEV, mat, block_ids()).await)
        }
        "set_property_batch" => to_json(
            set_property_batch_inner(
                pool,
                DEV,
                mat,
                block_ids(),
                req_str("key"),
                opt_str("value"),
            )
            .await,
        ),
        "set_todo_state_batch" => {
            to_json(set_todo_state_batch_inner(pool, DEV, mat, block_ids(), opt_str("state")).await)
        }
        "add_tags_by_ids" => to_json(
            add_tags_by_ids_inner(
                pool,
                DEV,
                mat,
                block_ids(),
                BlockId::from(arg_label_id("tagId").expect("tagId").as_str()),
            )
            .await,
        ),
        "delete_peer_ref" => to_json(delete_peer_ref_inner(pool, req_str("peerId")).await),
        "update_peer_name" => {
            to_json(update_peer_name_inner(pool, req_str("peerId"), opt_str("deviceName")).await)
        }
        "set_peer_address" => {
            to_json(set_peer_address_inner(pool, req_str("peerId"), req_str("address")).await)
        }
        // No `*_inner`: the wrapper is the thin layer over this directly.
        "set_reminder_settings" => to_json(
            agaric_lib::reminders::set_settings(
                pool,
                // The IPC arg is the whole `ReminderSettings` under `settings`,
                // so the fixture spells it nested exactly as a caller does.
                &agaric_lib::reminders::ReminderSettings {
                    enabled: args["settings"]["enabled"].as_bool().unwrap_or_else(|| {
                        panic!("conformance op '{command}' is missing arg 'settings.enabled'")
                    }),
                    time: args["settings"]["time"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("conformance op '{command}' is missing arg 'settings.time'")
                        })
                        .to_owned(),
                },
            )
            .await,
        ),
        "set_sync_relay_settings" => to_json(
            set_sync_relay_settings_inner(
                pool,
                agaric_lib::commands::SyncRelaySettings {
                    enabled: args["settings"]["enabled"].as_bool().unwrap_or_else(|| {
                        panic!("conformance op '{command}' is missing arg 'settings.enabled'")
                    }),
                },
            )
            .await,
        ),
        "delete_property_def" => to_json(delete_property_def_inner(pool, req_str("key")).await),
        // #5057 — positional undo. `pageId` is a label like any other block
        // arg; `undoDepth` is an ORDINAL ("the newest undoable op on this
        // page"), which is why this one is spellable where the ref-addressed
        // undo commands are not: an `OpRef` carries a device id, and the two
        // runners' differ.
        "undo_page_op" => to_json(
            undo_page_op_inner(
                pool,
                DEV,
                mat,
                arg_label_id("pageId").expect("undo_page_op pageId"),
                req_i64("undoDepth"),
            )
            .await,
        ),
        // #5057 — the grouped positional undo. Same ordinal `depth` as
        // `undo_page_op`, plus a `windowMs` that decides how many ops around
        // that depth are reversed together. Both are the fixture's own
        // literals, so the group is deterministic.
        "undo_page_group" => to_json(
            undo_page_group_inner(
                pool,
                DEV,
                mat,
                arg_label_id("pageId").expect("undo_page_group pageId"),
                req_i64("depth"),
                req_i64("windowMs"),
            )
            .await,
        ),
        // #5057 — the first of the ref-addressed undo commands, and the one
        // that proves the `On` convention: the fixture names the op it wants
        // undone by position in its own op list, and each runner resolves that
        // to its own coordinate.
        "undo_op" => to_json(undo_op_inner(pool, DEV, mat, op_ref("opRef")).await),
        "undo_ops" => to_json(undo_ops_inner(pool, DEV, mat, op_ref_list("ops")).await),
        "revert_ops" => to_json(revert_ops_inner(pool, DEV, mat, op_ref_list("ops")).await),
        "redo_page_op" => {
            let (device_id, seq) = op_ref_split("undoOp");
            to_json(redo_page_op_inner(pool, DEV, mat, device_id, seq).await)
        }
        "restore_page_to_op" => {
            let (device_id, seq) = op_ref_split("targetOp");
            to_json(
                restore_page_to_op_inner(
                    pool,
                    DEV,
                    mat,
                    arg_label_id("pageId").expect("restore_page_to_op pageId"),
                    device_id,
                    seq,
                )
                .await,
            )
        }
        // An attachment id is the fixture's own short label (`ATT1`), inserted
        // verbatim by the seed loader, so it takes no expansion.
        "delete_attachment" => to_json(
            delete_attachment_inner(
                pool,
                DEV,
                mat,
                app_data_dir,
                AttachmentId::from(req_str("attachmentId").as_str()),
            )
            .await,
        ),
        "rename_attachment" => to_json(
            rename_attachment_inner(
                pool,
                DEV,
                mat,
                AttachmentId::from(req_str("attachmentId").as_str()),
                req_str("newFilename"),
            )
            .await,
        ),
        // The BYTES are the fixture's own literal array, so the two stacks
        // upload the same content and agree on `size_bytes` — what they cannot
        // agree on is what each MINTS from it (see the `RETURN_SHAPE` entry).
        // The blob lands under the fixture's `TempDir`, which is what
        // `app_data_dir` is threaded for.
        "add_attachment_with_bytes" => to_json(
            add_attachment_with_bytes_inner(
                pool,
                DEV,
                mat,
                app_data_dir,
                block_id(),
                req_str("filename"),
                req_str("mimeType"),
                arg("bytes")
                    .and_then(Value::as_array)
                    .unwrap_or_else(|| panic!("conformance op '{command}' is missing arg 'bytes'"))
                    .iter()
                    .map(|b| {
                        u8::try_from(b.as_u64().unwrap_or(u64::MAX)).unwrap_or_else(|_| {
                            panic!("conformance op '{command}': bytes entry is not a u8")
                        })
                    })
                    .collect(),
            )
            .await,
        ),
        // `retentionDays` is the fixture's own literal, and the cutoff it
        // derives is `now()`-relative — which is exactly why this corpus can
        // only reach the no-op and the refusal.
        "compact_op_log_cmd" => to_json(
            compact_op_log_cmd_inner(
                pool,
                u64::try_from(req_i64("retentionDays")).unwrap_or_else(|_| {
                    panic!("conformance op '{command}': retentionDays must be non-negative")
                }),
            )
            .await,
        ),
        // Both of `confirm_pairing`'s non-DB collaborators are constructed
        // here rather than faked: a joiner has no local session to begin with
        // (the command nulls it), and the scheduler wake is an in-process
        // notify with nothing to observe. `scanned` stays `None` — the QR
        // candidate is published to that same scheduler and writes no row.
        "confirm_pairing" => {
            let pairing_state = std::sync::Mutex::new(None);
            let scheduler = agaric_sync::sync_scheduler::SyncScheduler::new();
            to_json(
                confirm_pairing_inner(
                    pool,
                    &pairing_state,
                    &scheduler,
                    req_str("passphrase"),
                    None,
                )
                .await,
            )
        }
        // The host half, with the same two constructed collaborators — plus a
        // published endpoint advert, which is NOT decoration. `start_pairing_
        // armed` waits on `SyncScheduler::await_local_endpoint` before it
        // renders the QR, and its budget is five seconds of REAL time on this
        // module's multi-thread runtime (no `start_paused`). A freshly
        // `new()`ed scheduler has published nothing, so without this the
        // conformance run would sit out the whole budget on every replay.
        // Publishing first makes the wait return on its first `borrow`, and
        // the advert is invisible to the fixture: it only feeds the QR
        // payload, and neither `PairingInfo` field is projected.
        "start_pairing" => {
            let pairing_state = std::sync::Mutex::new(None);
            let scheduler = agaric_sync::sync_scheduler::SyncScheduler::new();
            scheduler.publish_local_endpoint(agaric_sync::sync_scheduler::LocalEndpointAdvert {
                device_id: "conformance-host".to_string(),
                endpoint_id: "conformance-endpoint".to_string(),
                addrs: Vec::new(),
            });
            to_json(
                start_pairing_armed_inner(pool, &pairing_state, &scheduler, "conformance-host")
                    .await,
            )
        }
        // An alias is the caller's own text, so `aliases` takes no label
        // expansion — the same rule `req_str` states for the scalar args.
        "set_page_aliases" => to_json(
            set_page_aliases_inner(
                pool,
                arg_label_id("pageId")
                    .unwrap_or_else(|| panic!("conformance op '{command}' is missing arg 'pageId'"))
                    .as_str(),
                arg("aliases")
                    .and_then(Value::as_array)
                    .unwrap_or_else(|| {
                        panic!("conformance op '{command}' is missing arg 'aliases'")
                    })
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .unwrap_or_else(|| {
                                panic!("conformance op '{command}': aliases entry is not a string")
                            })
                            .to_owned()
                    })
                    .collect(),
            )
            .await,
        ),
        // A space NAME and an accent token are the caller's own text; only
        // `spaceId` / `parentId` are labels.
        "create_space" => to_json(
            create_space_inner(pool, DEV, mat, req_str("name"), opt_str("accentColor")).await,
        ),
        "create_page_in_space" => to_json(
            create_page_in_space_inner(
                pool,
                DEV,
                mat,
                arg_label_id("parentId"),
                req_str("content"),
                arg_label_id("spaceId").unwrap_or_else(|| {
                    panic!("conformance op '{command}' is missing arg 'spaceId'")
                }),
            )
            .await,
        ),
        "move_blocks_to_space" => to_json(
            move_blocks_to_space_inner(
                pool,
                DEV,
                mat,
                block_ids(),
                arg_label_id("spaceId").expect("spaceId"),
            )
            .await,
        ),
        "create_blocks_batch" => {
            to_json(create_blocks_batch_inner(pool, DEV, mat, block_specs()).await)
        }
        "duplicate_block" => to_json(duplicate_block_inner(pool, DEV, mat, block_id()).await),
        // `input` is the caller's own text or blocks, so it takes no label
        // expansion; only the anchor is a label.
        "paste_blocks" => to_json(
            paste_blocks_inner(
                pool,
                DEV,
                mat,
                BlockId::from(
                    arg_label_id("anchorBlockId")
                        .expect("anchorBlockId")
                        .as_str(),
                ),
                serde_json::from_value(arg("input").cloned().unwrap_or_else(|| {
                    panic!("conformance op '{command}' is missing arg 'input'")
                }))
                .unwrap_or_else(|e| panic!("conformance op '{command}': input: {e}")),
            )
            .await,
        ),
        // The two buffers are the caller's own text, anchors spelled as the
        // seed labels' expanded ids; only the page is a label.
        "apply_page_source" => to_json(
            apply_page_source_inner(
                pool,
                DEV,
                mat,
                arg_label_id("pageId").expect("pageId").as_str(),
                req_str("source"),
                req_str("baseSource"),
                arg("force")
                    .and_then(Value::as_bool)
                    .unwrap_or_else(|| panic!("conformance op '{command}' is missing arg 'force'")),
            )
            .await,
        ),
        "move_blocks_batch" => to_json(
            move_blocks_batch_inner(
                pool,
                DEV,
                mat,
                block_ids(),
                arg_label_id("newParentId").map(|id| BlockId::from(id.as_str())),
                arg("newIndex").and_then(Value::as_i64).unwrap_or_else(|| {
                    panic!("conformance op '{command}' is missing arg 'newIndex'")
                }),
            )
            .await,
        ),
        other => panic!("conformance op '{other}' is not wired in the command leg"),
    }
}

/// Project a command's serialized response into row tokens (raw ids; the
/// caller relabels): the row token, then one `<field>-><id>` per element of
/// each list-valued field.
pub(super) fn project_return(command: &str, response: &Value) -> Vec<String> {
    let (_, id_key, attrs, lists) = RETURN_SHAPE
        .iter()
        .find(|(c, ..)| *c == command)
        .unwrap_or_else(|| panic!("conformance op '{command}' has no RETURN_SHAPE entry"));
    // A headed shape has no id column: the head is the command name and the
    // attributes are read off the row beside it. Applied PER ROW rather than
    // to the response as a whole, because a list return of headed rows
    // (`undo_page_group`) needs the head on each element — `row_token` reads
    // `row[id_key]` and renders `<missing-id>` for a row that has none.
    let head_row = |row: &Value| -> Value {
        if *id_key != HEADED_ID_KEY {
            return row.clone();
        }
        // A row that is not an object has no field for an attribute to name.
        // `()` serializes to `null` and declares no attributes, so it renders
        // as the bare head; a bare COUNT is the whole return value, so the
        // shape's single attribute names it.
        let mut obj = if let Some(fields) = row.as_object() {
            fields.clone()
        } else {
            assert!(
                attrs.len() <= 1,
                "conformance op '{command}' returns a scalar, so at most ONE attribute can name \
                 it; `RETURN_SHAPE` declares {attrs:?}"
            );
            let mut fields = serde_json::Map::new();
            if let Some(name) = attrs.first() {
                fields.insert((*name).to_owned(), row.clone());
            }
            fields
        };
        obj.insert(HEADED_ID_KEY.to_owned(), json!(command));
        Value::Object(obj)
    };

    // A LIST return is a list of ROWS: one row token per element, in the order
    // the command returned them. Distinct from `tuple_token`, which reads a
    // JSON array POSITIONALLY as a single row.
    if let Some(rows) = response.as_array() {
        return rows
            .iter()
            .map(|row| row_token(&head_row(row), id_key, attrs))
            .collect();
    }
    let row = head_row(response);
    let mut out = vec![row_token(&row, id_key, attrs)];
    for field in *lists {
        for id in response
            .get(*field)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            out.push(format!(
                "{field}->{}",
                id.as_str().unwrap_or("<not-a-string>")
            ));
        }
    }
    out
}

/// A declaration key as the wire string it must be; `None` when absent or
/// null. A non-string is refused, as `run_query_steps` refuses one.
fn declared(at: &str, op: &Value, key: &str) -> Option<String> {
    match op.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => panic!("{at}: `{key}` must be a wire string, got {other}"),
    }
}

/// The #3946 declaration discipline over a command outcome: both arms or
/// neither, for the kind AND for the `ValidationCode`.
pub(super) fn check_declaration(
    at: &str,
    declared_kind: Option<&str>,
    declared_code: Option<&str>,
    actual_kind: Option<&str>,
    actual_code: Option<&str>,
) {
    match (declared_kind, actual_kind) {
        (None, Some(kind)) => panic!(
            "{at}: the command REFUSED with `{kind}`, and the op did not declare it. A refusal \
             is only evidence when it was intended. FIX by EITHER correcting the op's args, OR \
             — if the refusal IS the behaviour being pinned — adding \"expect_error\": \
             \"{kind}\" to the op plus a \"comment\" saying which refusal it pins."
        ),
        (Some(kind), None) => panic!(
            "{at}: the op declares \"expect_error\": \"{kind}\" but the command SUCCEEDED. \
             Restore the input that makes the command refuse, or drop the declaration."
        ),
        (Some(declared), Some(kind)) if declared != kind => panic!(
            "{at}: the op declares \"expect_error\": \"{declared}\" but the command refused \
             with `{kind}`. Declare the recorded kind, or restore the input that raises the \
             declared one."
        ),
        _ => {}
    }
    assert!(
        declared_code.is_none() || declared_kind == Some("validation"),
        "{at}: `expect_code` is a ValidationCode, so it accompanies \"expect_error\": \
         \"validation\" only"
    );
    match (declared_code, actual_code) {
        (None, Some(code)) => panic!(
            "{at}: the refusal carries ValidationCode `{code}`, and the op did not declare it. \
             Add \"expect_code\": \"{code}\"."
        ),
        (Some(code), None) => panic!(
            "{at}: the op declares \"expect_code\": \"{code}\" but the refusal carries no code."
        ),
        (Some(declared), Some(code)) if declared != code => panic!(
            "{at}: the op declares \"expect_code\": \"{declared}\" but the refusal carries \
             `{code}`."
        ),
        _ => {}
    }
}

/// Run one `via: "command"` op, enforce its declarations, and build its
/// `expected_ops` record with raw ids (the caller relabels once the canonical
/// order is final).
pub(super) async fn run_command_op(
    pool: &SqlitePool,
    mat: &Materializer,
    app_data_dir: &std::path::Path,
    fixture_name: &str,
    op: &Value,
    created_ids: &[String],
    op_refs: &[(String, i64)],
) -> Value {
    let command = op["command"].as_str().expect("op command");
    let name = op["name"].as_str().unwrap_or_else(|| {
        panic!(
            "fixture '{fixture_name}': a `via: \"command\"` op (command '{command}') must carry \
             a string `name`, or its record cannot be named in any diff"
        )
    });
    let at = format!("fixture '{fixture_name}' op '{name}' (command '{command}')");
    let (returns, error, code) =
        match apply_op_via_command(pool, mat, app_data_dir, op, created_ids, op_refs).await {
            Ok(response) => (
                PROJECTING_STEP.sync_scope(at.clone(), || project_return(command, &response)),
                Value::Null,
                Value::Null,
            ),
            Err(e) => (
                Vec::new(),
                serde_json::to_value(e.kind()).expect("serialize AppErrorKind"),
                serde_json::to_value(e.validation_code()).expect("serialize ValidationCode"),
            ),
        };
    check_declaration(
        &at,
        declared(&at, op, "expect_error").as_deref(),
        declared(&at, op, "expect_code").as_deref(),
        error.as_str(),
        code.as_str(),
    );
    json!({ "name": name, "returns": returns, "error": error, "code": code })
}

/// The `expected_ops` value: every record's `returns` relabelled through the
/// canonical map, or `Null` when no op opted in (so the key stays absent).
pub(super) fn relabel_records(records: &[Value], labels: &BTreeMap<String, String>) -> Value {
    if records.is_empty() {
        return Value::Null;
    }
    Value::Array(
        records
            .iter()
            .map(|record| {
                let mut record = record.clone();
                let returns: Vec<String> = record["returns"]
                    .as_array()
                    .expect("record returns")
                    .iter()
                    .map(|t| relabel_token(t.as_str().expect("token"), labels))
                    .collect();
                record["returns"] = json!(returns);
                record
            })
            .collect(),
    )
}

mod tests {
    use super::*;

    #[test]
    fn delete_block_projects_the_row_and_one_arrow_per_affected_page() {
        let response = json!({
            "block_id": "AAA",
            "deleted_at": 1_700_000_000_000_i64,
            "descendants_affected": 3,
            "affected_page_ids": ["AAA", "BBB"],
            "op_refs": [{ "device_id": "x", "seq": 1 }],
        });
        assert_eq!(
            project_return("delete_block", &response),
            vec![
                "AAA#deleted_at=DELETED#descendants_affected=3",
                "affected_page_ids->AAA",
                "affected_page_ids->BBB",
            ]
        );
    }

    #[test]
    fn relabel_records_rewrites_heads_and_arrow_targets_and_keeps_absence() {
        let labels: BTreeMap<String, String> = [
            ("AAA".to_owned(), "B1".to_owned()),
            ("BBB".to_owned(), "B2".to_owned()),
        ]
        .into();
        assert_eq!(relabel_records(&[], &labels), Value::Null);
        let records = [json!({
            "name": "n",
            "returns": ["AAA#deleted_at=DELETED#descendants_affected=3", "affected_page_ids->BBB"],
            "error": null,
            "code": null,
        })];
        assert_eq!(
            relabel_records(&records, &labels),
            json!([{
                "name": "n",
                "returns": ["B1#deleted_at=DELETED#descendants_affected=3", "affected_page_ids->B2"],
                "error": null,
                "code": null,
            }])
        );
    }

    #[test]
    fn matching_declarations_pass() {
        check_declaration("at", None, None, None, None);
        check_declaration(
            "at",
            Some("invalid_operation"),
            None,
            Some("invalid_operation"),
            None,
        );
        check_declaration(
            "at",
            Some("validation"),
            Some("DuplicatePageTitle"),
            Some("validation"),
            Some("DuplicatePageTitle"),
        );
    }

    #[test]
    #[should_panic(expected = "REFUSED with `not_found`, and the op did not declare it")]
    fn an_undeclared_refusal_is_rejected() {
        check_declaration("at", None, None, Some("not_found"), None);
    }

    #[test]
    #[should_panic(expected = "but the command SUCCEEDED")]
    fn a_declaration_that_succeeded_is_rejected() {
        check_declaration("at", Some("not_found"), None, None, None);
    }

    #[test]
    #[should_panic(
        expected = "declares \"expect_error\": \"not_found\" but the command refused with `validation`"
    )]
    fn a_declaration_of_a_different_kind_is_rejected() {
        check_declaration("at", Some("not_found"), None, Some("validation"), None);
    }

    #[test]
    #[should_panic(expected = "accompanies \"expect_error\": \"validation\" only")]
    fn a_code_declared_on_a_non_validation_kind_is_rejected() {
        check_declaration(
            "at",
            Some("not_found"),
            Some("InvalidGlob"),
            Some("not_found"),
            None,
        );
    }

    #[test]
    #[should_panic(
        expected = "carries ValidationCode `DuplicatePageTitle`, and the op did not declare it"
    )]
    fn an_undeclared_code_is_rejected() {
        check_declaration(
            "at",
            Some("validation"),
            None,
            Some("validation"),
            Some("DuplicatePageTitle"),
        );
    }

    #[test]
    #[should_panic(
        expected = "declares \"expect_code\": \"InvalidGlob\" but the refusal carries no code"
    )]
    fn a_stale_code_declaration_is_rejected() {
        check_declaration(
            "at",
            Some("validation"),
            Some("InvalidGlob"),
            Some("validation"),
            None,
        );
    }

    #[test]
    #[should_panic(
        expected = "declares \"expect_code\": \"InvalidGlob\" but the refusal carries `DuplicatePageTitle`"
    )]
    fn a_code_declaration_that_mismatches_is_rejected() {
        check_declaration(
            "at",
            Some("validation"),
            Some("InvalidGlob"),
            Some("validation"),
            Some("DuplicatePageTitle"),
        );
    }

    #[test]
    #[should_panic(expected = "`expect_error` must be a wire string, got true")]
    fn a_non_string_declaration_is_rejected() {
        declared("at", &json!({ "expect_error": true }), "expect_error");
    }

    /// Every command the dispatcher wires has a `RETURN_SHAPE` entry and
    /// vice versa, and the count is the one this module claims — so a
    /// mutating command cannot join one table without the other, and cannot
    /// join at all without this number moving.
    const MUTATING_ARM_COUNT: usize = 42;

    #[test]
    fn the_dispatcher_and_the_return_shape_table_name_the_same_commands() {
        let (commands, arms) =
            super::super::conformance_query::reader_delegation_tests::wired_commands(
                include_str!("conformance_command.rs"),
                "async fn apply_op_via_command(",
                "match command {",
            );
        assert_eq!(
            commands.len(),
            MUTATING_ARM_COUNT,
            "dispatcher wires {commands:?}"
        );
        assert_eq!(
            arms,
            MUTATING_ARM_COUNT + 1,
            "the arm walk crossed {arms} arms but found {} command literals; it should have \
             crossed exactly one MORE arm than commands — the `other =>` catch-all",
            commands.len()
        );
        let mut shaped: Vec<&str> = RETURN_SHAPE.iter().map(|(c, ..)| *c).collect();
        shaped.sort_unstable();
        let mut wired: Vec<&str> = commands.iter().map(String::as_str).collect();
        wired.sort_unstable();
        assert_eq!(wired, shaped, "RETURN_SHAPE and the dispatcher disagree");
    }
}
