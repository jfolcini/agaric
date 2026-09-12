# Session 1725 — the `loro/projection.rs` splits (#4639)

Refs #4639, sixth slice: the three `#[expect(clippy::too_many_lines)]`
sites in `agaric-engine/src/loro/projection.rs`, the engine-to-SQL
projection paths (`project_set_property_to_sql`,
`project_purge_blocks_to_sql`, `reproject_block_properties_from_engine`).
Pure moves inside the caller-owned transaction; no write reordered, no
SQL literal changed by a byte, no error text changed.

- `project_set_property_to_sql` (90 lines): `project_reserved_property_to_column`
  owns the reserved-key arm (the `reserved_key_blocks_column` lookup and the
  dynamic `UPDATE blocks SET {col}`, drift error included) and
  `project_property_row` the non-reserved arm (all-`None` deletes the row,
  otherwise the FK-guarded `INSERT OR REPLACE`); the `space` arm stays in
  the parent.
- `project_purge_blocks_to_sql` (129): `delete_purge_ids_relation_rows`
  runs the first five `DELETE`s (tags, inherited tags, both property
  shapes, links) and `delete_purge_ids_derived_rows` the next ten (the
  caches, refs and page links); the parent keeps the PRAGMA, the temp
  table, the final `DELETE FROM blocks` and the `DROP TABLE`, so all
  sixteen deletes run in the original order.
- `reproject_block_properties_from_engine` (113): `declared_value_type_or_text`
  is the `property_definitions` lookup with its warn,
  `reproject_property_row_from_engine` routes one key into its typed
  column and inserts it (the loop's `continue` on an all-`None` row became
  the helper's `return Ok(())`), and `reproject_reserved_columns_from_engine`
  is the hot-path four-column `UPDATE`. A tuple-returning router was tried
  first and tripped `clippy::type_complexity`; three helpers was the cut
  that left the loop body well under the threshold.
No lint suppression was added. The only re-indented literals are
`\`-continued strings, whose value ignores the continued line's leading
whitespace, so `.sqlx/` is untouched.

## Verified

`cargo clippy -p agaric-engine --lib --tests -- -D warnings` prints
nothing with the three attributes gone; `cargo fmt --all -- --check` clean;
`SQLX_OFFLINE=true cargo check --workspace --all-targets` 0 warnings;
`cargo nextest run --workspace` 6318 passed, 13 skipped; doc-tests green.
The reviewer lexed every string literal out of both revisions (725 against
722, the delta being the three removed `expect` reasons), so every SQL
literal, both `format!`-built `UPDATE blocks` sites and all three
validation messages are byte-identical and `.sqlx/` is untouched; replaying
the purge parent through its two helpers gives the same 21 literals in the
same order as HEAD, the sixteen `DELETE`s included. Falsified on copies:
the reserved-column `UPDATE` dropped reddened
`reproject_routes_reserved_keys_to_blocks_columns`; the row `INSERT`
dropped reddened `reproject_routes_values_into_typed_columns` and
`reproject_routes_ref_value`; the `text` default flipped reddened
`reproject_undefined_key_defaults_to_text`; the hot-path column `UPDATE`
dropped reddened
`project_set_property_writes_typed_value_and_hot_path_column`; the
derived-row purge step dropped reddened
`project_purge_blocks_deletes_explicit_set_from_all_tables`; the reviewer
independently routed `date` values into `value_text` and reddened
`reproject_routes_values_into_typed_columns`. All restored, `cmp` clean.
One gap recorded, not filed: dropping the whole relation-row purge step
stays green because those five tables cascade from `blocks`, so the
explicit deletes are belt and braces, not load-bearing. Attribute count
104 to 101.
