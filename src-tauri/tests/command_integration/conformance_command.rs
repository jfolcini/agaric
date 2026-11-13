//! #4670 — the MUTATING-command leg of the #763 conformance harness (Rust
//! side / source of truth). TS twin:
//! `src/lib/tauri-mock/__tests__/conformance-command.ts`.
//!
//! A fixture op carrying `"via": "command"` is sent through the app's IPC
//! surface (`conformance_ipc.rs`, #6529) instead of the payload replay, and
//! its response or refusal (the `AppErrorKind` wire string plus, for
//! `validation`, the `ValidationCode`) lands as one record in the fixture's
//! `expected_ops`, authored by `CONFORMANCE_UPDATE=1` and asserted by both
//! runners:
//!
//! ```json
//! { "name": "…", "returns": ["B2#deleted_at=DELETED#descendants_affected=3"],
//!   "error": null, "code": null }
//! ```
//!
//! An op whose wrapper emits `block:properties-changed` also records those
//! events, in emission order, under `events` (#6054):
//! `["block:properties-changed#block_id=B2#changed_keys=[\"todo_state\"]"]`.
//! They are the payloads the wrapper emitted, so the mock is held to what the
//! app emits. An op that emits none records no `events` key.
//!
//! `returns` and `events` reuse the query leg's row-token grammar
//! ([`row_token`] / [`relabel_token`]), so id relabelling, the `deleted_at` →
//! `DELETED` sentinel and the separator-aliasing refusals all apply. Two rules
//! are specific to this leg:
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

use super::conformance::label_created_ids;
use super::conformance_ipc::IpcTransport;
use super::conformance_query::{PROJECTING_STEP, PROPERTY_DEF_ATTRS, relabel_token, row_token};
use agaric_sync::sync_events::EVENT_PROPERTY_CHANGED;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// `id key` for a response carrying no row identity of its own — a unit return,
/// or an envelope that is only a count. The token head is the COMMAND NAME and
/// each `attrs` entry is read off the response, mirroring the query leg's
/// `headed` token kind. MUST match the TS twin's constant.
const HEADED_ID_KEY: &str = "<headed>";

/// `(command, id key, attributes, list-valued fields)` — how each mutating
/// command's response becomes tokens. MUST match `RETURN_SHAPE` in the TS
/// twin, which reads the mock's response through the same keys. The importers
/// are the exception: their fixture pins the backend alone (#5071), so the TS
/// twin has no entry for them.
const RETURN_SHAPE: &[(&str, &str, &[&str], &[&str])] = &[
    (
        "delete_block",
        "block_id",
        &["deleted_at", "descendants_affected"],
        &["affected_page_ids"],
    ),
    ("purge_block", "block_id", &["purged_count"], &[]),
    // #3830 — the `property_definitions` writers answer with the row (a
    // delete with the row it deleted, #5841), so their shape is
    // `PROPERTY_DEF_ATTRS` read off a response instead of a SELECT.
    // `created_at` stays off it for the reason the token gives.
    ("create_property_def", "key", PROPERTY_DEF_ATTRS, &[]),
    (
        "update_property_def_options",
        "key",
        PROPERTY_DEF_ATTRS,
        &[],
    ),
    ("delete_property_def", "key", PROPERTY_DEF_ATTRS, &[]),
    // #5841 S2 — a rename answers the definition under its new key, a merge
    // the target's after the union.
    ("rename_property_key", "key", PROPERTY_DEF_ATTRS, &[]),
    ("merge_property_key", "key", PROPERTY_DEF_ATTRS, &[]),
    // #5841 S3 — a type change answers the definition after it.
    ("change_property_type", "key", PROPERTY_DEF_ATTRS, &[]),
    // #5841 S4 — an option rename answers the definition after it.
    ("rename_property_option", "key", PROPERTY_DEF_ATTRS, &[]),
    // #6206 — a removal or a conversion answers how many values it replaced;
    // adding to the options answers the definition after.
    (
        "remove_unfit_property_values",
        HEADED_ID_KEY,
        &["unfit", "unfit_in_trash"],
        &[],
    ),
    (
        "convert_unfit_property_values",
        HEADED_ID_KEY,
        &["unfit", "unfit_in_trash"],
        &[],
    ),
    // #6206 — a move answers what it moved and what it left.
    (
        "move_unfit_property_values",
        HEADED_ID_KEY,
        &["moved", "occupied", "unfit_there"],
        &[],
    ),
    (
        "add_unfit_values_to_options",
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
    // #5160 D11 — the row the property was set on; the snapshot pins the
    // value, and a text value under a `ref` definition is read as the block
    // it names, which only the command does.
    ("set_property", "id", &[], &[]),
    // #5074 — the row the state was set on. The `completed_at` it stamps or
    // clears carries a clock date, so the snapshot drops it and a
    // `query_by_property` step reads which blocks hold one.
    ("set_todo_state", "id", &["todo_state"], &[]),
    // #6054 — the three single-column setters, each the row it set.
    ("set_priority", "id", &["priority"], &[]),
    ("set_due_date", "id", &["due_date"], &[]),
    ("set_scheduled_date", "id", &["scheduled_date"], &[]),
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
    // set in the wrong order reds. The wire nests the list ([`ROWS_KEY`]). A
    // paste's rows ride beside its warnings, which are grammar the mock does
    // not model.
    (
        "create_blocks_batch",
        "id",
        &["block_type", "content", "parent_id", "position"],
        &[],
    ),
    // #5236 — the single create answers with the one row, under the batch's
    // attributes. The id is the record: a tag create that resolves to an
    // existing same-name tag answers that tag's label and no new block.
    (
        "create_block",
        "id",
        &["block_type", "content", "parent_id", "position"],
        &[],
    ),
    // #5281 — the renamed row; a rename onto a name its space already holds
    // is refused, which only the command sees.
    ("edit_block", "id", &["content"], &[]),
    // #6608 — the blocks the batch left alone; the snapshot pins the rest.
    ("edit_blocks_batch", HEADED_ID_KEY, &[], &["skipped"]),
    // #6054 — the four the differential fuzz drives as commands, so it compares
    // what each returns or refuses, not only the state it leaves.
    (
        "move_block",
        "block_id",
        &["new_parent_id", "new_position"],
        &[],
    ),
    ("restore_block", "block_id", &["restored_count"], &[]),
    ("add_tag", "block_id", &["tag_id"], &[]),
    ("remove_tag", "block_id", &["tag_id"], &[]),
    (
        "move_blocks_batch",
        "block_id",
        &["new_parent_id", "new_position"],
        &[],
    ),
    // #6531 — the block a split creates, and the block a merge writes.
    (
        "split_block",
        "id",
        &["content", "parent_id", "position"],
        &[],
    ),
    ("merge_blocks", "id", &["content"], &[]),
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
    // #5057 — writers whose table is OUTSIDE the snapshot's five arrays
    // (`peer_refs`, `app_settings`), so what they wrote is pinned by the read
    // that follows them in the same fixture rather than by the settled state.
    // Each answers with `()`, so the record is the refusal declaration plus a
    // head naming which one ran.
    ("delete_peer_ref", HEADED_ID_KEY, &[], &[]),
    ("update_peer_name", HEADED_ID_KEY, &[], &[]),
    ("set_peer_address", HEADED_ID_KEY, &[], &[]),
    ("set_reminder_settings", HEADED_ID_KEY, &[], &[]),
    // #4549 — same shape: one `app_settings` row, observed by the
    // `get_sync_relay_settings` step that follows.
    ("set_sync_relay_settings", HEADED_ID_KEY, &[], &[]),
    // Its `(block_id, key)` echo is the caller's own args; the row it removed
    // is the snapshot's to pin.
    ("delete_property", HEADED_ID_KEY, &[], &[]),
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
    // #5364 — the meeting's ids, which both stacks mint as created blocks the
    // relabel names; its attachments are observed by a `list_attachments`
    // step, since each row is half stack-local as above.
    (
        "add_meeting",
        "page_id",
        &["recording_block_id", "link_block_id"],
        &[],
    ),
    // #5057 — `page_aliases` is outside the snapshot's five arrays too, so the
    // `get_page_aliases` step observes the table. The RETURN is its own
    // evidence: a LIST OF BARE STRINGS naming the aliases the page holds after
    // the write, which is narrower than what the caller passed — an entry that
    // trims to nothing, and a second spelling of one alias, are dropped.
    ("set_page_aliases", HEADED_ID_KEY, &["alias"], &[]),
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
    // #5371 — answers `()`; `page_opens` is outside the snapshot, so a
    // `last-opened` query step observes it.
    ("record_page_open", HEADED_ID_KEY, &[], &[]),
    // #5667 — `mcp_agents` is outside the snapshot, so the `list_mcp_agents`
    // step observes both writers. A created agent's `id`, `token` and
    // `created_at_ms` are minted per stack, so the return names what the
    // caller chose; each granted space is a `space_ids-><id>` token, which
    // relabels where the space a fixture created would not inside a JSON list.
    (
        "create_mcp_agent",
        HEADED_ID_KEY,
        &["name", "mode", "last_used_ms"],
        &["space_ids"],
    ),
    ("revoke_mcp_agent", HEADED_ID_KEY, &[], &[]),
    // #5071 — the two imports, whose blocks the snapshot pins. `warnings` stay
    // off: they are prose that may carry `#`. The grammar has one
    // implementation, in Rust, so `markdown_imports` is backend-only on the mock
    // (`DRIFT_SKIP`); the TS twin carries `import_markdown` alone, for
    // `import_markdown_plain`'s grammar-trivial input.
    (
        "import_markdown",
        "page_id",
        &["page_title", "blocks_created", "properties_set"],
        &["collapsed"],
    ),
    (
        "import_bibliography",
        HEADED_ID_KEY,
        &["pages_created", "entries_skipped", "properties_set"],
        &[],
    ),
    // The end of a folder import answers a list of bare strings, its warnings,
    // which the fixture pins whole: none carries a `#`. Backend-only on the
    // mock like the two imports above.
    ("link_import_anchors", HEADED_ID_KEY, &["warning"], &[]),
];

/// `(command, key)`: the key a command's rows ride under. A LIST OF ROWS is
/// nested because the wrapper answers `WithOps<{ <key>: T[] }>` (a `Vec`
/// cannot be flattened beside `op_refs`, #5140); a split and a merge nest the
/// one row their record is (#6531). MUST match `rows` in the TS twin's
/// `RETURN_SHAPE`.
const ROWS_KEY: &[(&str, &str)] = &[
    ("create_blocks_batch", "blocks"),
    ("move_blocks_batch", "moves"),
    ("split_block", "created"),
    ("merge_blocks", "block"),
    ("duplicate_block", "blocks"),
    ("paste_blocks", "blocks"),
    ("set_page_aliases", "aliases"),
];

/// Project a command's serialized response into row tokens (raw ids; the
/// caller relabels): the row token, then one `<field>-><id>` per element of
/// each list-valued field.
pub(super) fn project_return(command: &str, response: &Value) -> Vec<String> {
    let response = match ROWS_KEY.iter().find(|(c, _)| *c == command) {
        Some((_, key)) => response.get(*key).unwrap_or_else(|| {
            panic!("conformance op '{command}' answered nothing under '{key}': {response}")
        }),
        None => response,
    };
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

/// Whether a `via: "command"` op's refusal must be declared in the fixture.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Declarations {
    /// A committed fixture: every refusal is declared (#3946).
    Enforced,
    /// A generated chain (#6054): the backend's record IS the declaration the
    /// fuzzer then hands the mock.
    Recorded,
}

/// Run one `via: "command"` op through `ipc`, enforce its declarations, and
/// build its `expected_ops` record with raw ids (the caller relabels once the
/// canonical order is final).
pub(super) async fn run_command_op(
    ipc: &IpcTransport,
    fixture_name: &str,
    op: &Value,
    created_ids: &[String],
    op_refs: &[(String, i64)],
    declarations: Declarations,
) -> Value {
    let command = op["command"].as_str().expect("op command");
    let name = op["name"].as_str().unwrap_or_else(|| {
        panic!(
            "fixture '{fixture_name}': a `via: \"command\"` op (command '{command}') must carry \
             a string `name`, or its record cannot be named in any diff"
        )
    });
    let at = format!("fixture '{fixture_name}' op '{name}' (command '{command}')");
    let outcome = ipc.apply_op(op, created_ids, op_refs).await;
    let (returns, error, code) = match outcome.result {
        Ok(mut response) => (
            PROJECTING_STEP.sync_scope(at.clone(), || {
                // A returned row's text, as the snapshot reads it.
                if let Some(Value::String(content)) = response.get_mut("content") {
                    *content = label_created_ids(content, created_ids);
                }
                project_return(command, &response)
            }),
            Value::Null,
            Value::Null,
        ),
        Err((kind, code)) => (Vec::new(), kind, code),
    };
    if declarations == Declarations::Enforced {
        check_declaration(
            &at,
            declared(&at, op, "expect_error").as_deref(),
            declared(&at, op, "expect_code").as_deref(),
            error.as_str(),
            code.as_str(),
        );
    }
    let mut record = json!({ "name": name, "returns": returns, "error": error, "code": code });
    if !outcome.property_events.is_empty() {
        let events: Vec<String> = PROJECTING_STEP.sync_scope(at, || {
            outcome
                .property_events
                .iter()
                .map(|payload| event_token(EVENT_PROPERTY_CHANGED, payload))
                .collect()
        });
        record["events"] = json!(events);
    }
    record
}

/// One emitted event as a token: the event name as the head, then every
/// payload field in name order, so an id-valued field relabels like an id in
/// `returns`. MUST match `eventToken` in the TS twin.
fn event_token(event: &str, payload: &Value) -> String {
    let Value::Object(mut row) = payload.clone() else {
        panic!("event '{event}' carries a payload that is not an object");
    };
    let mut fields: Vec<String> = row.keys().cloned().collect();
    fields.sort_unstable();
    row.insert(HEADED_ID_KEY.to_owned(), json!(event));
    let fields: Vec<&str> = fields.iter().map(String::as_str).collect();
    row_token(&Value::Object(row), HEADED_ID_KEY, &fields)
}

/// The `expected_ops` value: every record's `returns` and `events` relabelled
/// through the canonical map, or `Null` when no op opted in (so the key stays
/// absent).
pub(super) fn relabel_records(records: &[Value], labels: &BTreeMap<String, String>) -> Value {
    if records.is_empty() {
        return Value::Null;
    }
    let relabel = |tokens: &Value| -> Value {
        tokens
            .as_array()
            .expect("record tokens")
            .iter()
            .map(|t| json!(relabel_token(t.as_str().expect("token"), labels)))
            .collect()
    };
    Value::Array(
        records
            .iter()
            .map(|record| {
                let mut record = record.clone();
                record["returns"] = relabel(&record["returns"]);
                if let Some(events) = record.get("events") {
                    record["events"] = relabel(events);
                }
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
}
