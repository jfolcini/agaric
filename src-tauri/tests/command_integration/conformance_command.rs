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
use super::conformance::resolve_op_arg_id;
use super::conformance_query::{PROJECTING_STEP, relabel_token, row_token};
use agaric_core::ulid::BlockId;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

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
    op: &Value,
    created_ids: &[String],
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

    match command {
        "delete_block" => to_json(delete_block_inner(pool, DEV, mat, block_id()).await),
        "purge_block" => to_json(purge_block_inner(pool, DEV, mat, block_id()).await),
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
    let mut out = vec![row_token(response, id_key, attrs)];
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
    fixture_name: &str,
    op: &Value,
    created_ids: &[String],
) -> Value {
    let command = op["command"].as_str().expect("op command");
    let name = op["name"].as_str().unwrap_or_else(|| {
        panic!(
            "fixture '{fixture_name}': a `via: \"command\"` op (command '{command}') must carry \
             a string `name`, or its record cannot be named in any diff"
        )
    });
    let at = format!("fixture '{fixture_name}' op '{name}' (command '{command}')");
    let (returns, error, code) = match apply_op_via_command(pool, mat, op, created_ids).await {
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
    const MUTATING_ARM_COUNT: usize = 2;

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
