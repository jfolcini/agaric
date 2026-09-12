# Session 1722 — the `block_ops.rs` splits (#4639)

Refs #4639, fifth slice: the three `#[expect(clippy::too_many_lines)]`
sites in `agaric-engine/src/block_ops.rs`, the single-block create and
property-set kernels every command and batch path routes through
(`create_block_in_tx`, `validate_property_value`,
`set_property_in_tx_with_declaration`). Pure moves inside the
caller-owned transaction; no write reordered, no error text changed.

- `create_block_in_tx` (131 lines): `resolve_block_id_in_tx` (the strict
  ULID re-parse of a client id and its collision probe, else a fresh
  id), `validate_parent_in_tx` (the live-parent lookup, the #4725 tag
  rejection, the `MAX_BLOCK_DEPTH` walk and the cross-space content scan,
  all under the same `Some(parent)` gate as before) and
  `restore_bare_append_position_in_tx` (the #1257 engine-absent sentinel
  fixup, still gated on the engine returning no index, still after the
  apply).
- `validate_property_value` (88): `validate_declared_type` (shape against
  the declared type) and `validate_select_option` (options-JSON parse and
  membership); the reserved-key and is-clear dispatch stays in the parent.
- `set_property_in_tx_with_declaration` (110): `fetch_live_block_in_tx`
  (one query, then the not-found versus soft-deleted discrimination) and
  `validate_space_target_in_tx` (the R17 holder check, the `value_ref`
  requirement and the live-registered-space probe), still after the op
  append and before the engine apply.

One near miss worth recording: a moved multi-line raw-string query was
briefly re-indented, which changes the SQL text and so its `.sqlx` hash;
`cargo check` refused it offline and the original indentation was
restored. No `.sqlx` entry moved. No lint suppression was added.

## Verified

`cargo clippy -p agaric-engine --lib --tests -- -D warnings` prints
nothing with the three attributes gone; `SQLX_OFFLINE=true cargo check
--workspace --all-targets` 0 warnings; `cargo nextest run --workspace` 6318
passed, 13 skipped; `cargo test --doc --workspace` 10 passed. The reviewer
reconciled the comment-stripped diff line by line (every net removal is a
mechanical rewrite: let-else, an inlined binding, a moved `.as_deref()`,
two inline format args), confirmed the four parent checks were all gated
on `Some(parent)` at HEAD so folding the gate is exact, and parsed all 21
SQL literals out of both revisions: identical multisets, no `.sqlx`
change. Falsified on copies: the tag check disabled reddened
`create_block_under_tag_parent_returns_validation_error`; a `number`
arm accepting text reddened
`validate_property_value_number_with_text_payload_rejects`; the holder
check forced true reddened
`set_property_space_key_rejected_on_content_block`; the reviewer
independently dropped the `MAX_BLOCK_DEPTH` guard and reddened
`create_block_exceeding_max_depth_returns_validation_error`. All
restored, `cmp` clean. Attribute count 107 to 104 on this branch.
