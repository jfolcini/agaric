-- M-90 (REVIEW-LATER.md §"M-90 — `is_space` typed as `text`; equality
-- probed on the literal string `"true"`"): tighten the `is_space`
-- property definition from the free-form `text` value_type to a
-- `select` value_type with a single allowed option, `"true"`.
--
-- Why this is safe:
--   * Production writers only ever set `is_space = "true"` — see
--     `ensure_is_space_property` in `src-tauri/src/spaces/bootstrap.rs`
--     and `create_space` in `src-tauri/src/commands/spaces.rs`. Every
--     read site filters on `value_text = 'true'` (e.g.
--     `list_spaces_inner`, `bootstrap_spaces`'s idempotency check,
--     `create_block_inner`'s space-cascade guard). The "absent
--     property = not a space" convention means there is no semantic
--     meaning for `is_space = "false"` and the literal string was
--     never written.
--   * The `select` value_type is the only one whose
--     `property_definitions.options` JSON is enforced by
--     `set_property_in_tx` (see the BUG-20 options-membership check
--     in `commands/blocks/crud.rs`). Tightening to `select` with
--     `options = '["true"]'` makes the existing typed-property
--     validation reject any future drift (`"True"`, `"yes"`,
--     `value_num`, `value_ref`, …) at the write layer instead of
--     relying on the unwritten convention that `bootstrap.rs` is the
--     sole writer.
--   * `options` is a bare JSON array of strings — matching the shape
--     used by `todo_state` (`'["TODO","DOING","DONE","CANCELLED"]'`),
--     `priority` (`'["1","2","3"]'`), `effort`, etc. The
--     `serde_json::from_str::<Vec<String>>` deserialiser in the
--     validation site assumes that flat shape.
UPDATE property_definitions
SET value_type = 'select',
    options = '["true"]'
WHERE key = 'is_space';
