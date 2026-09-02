# Session 1480 — Group by date, boolean and ref properties

#4607, found by the reviewer on #4604: the group-key expression read `value_text` and `value_num` only, so a page grouped by a `date`-, `boolean`- or `ref`-declared property still swept every block into the `none` bucket, the #4570 failure repeated three columns over.

The fix is three terms added to the one `COALESCE` in `group_key_expr`; the rendered expression is already reused at the count, group-page, `PARTITION BY` and `IN` sites, so nothing else moved and the bind numbering is unchanged. Labels follow what the UI already renders for each type in `propertyRowDisplay`: the stored ISO text for a date, `true`/`false` for a boolean, the raw block id for a ref. The group header renders property labels verbatim, so no title join.

Three tests pin the three columns next to the number test, each shown red with its term removed (every block in `none`) and green after. The member-preview re-selection was dropped from all three: the `IN` site re-evaluates the same expression, so it cannot fail independently of the count. The engine comment was cut to the two renderings the SQL does not make obvious.

Verified: `cargo nextest run -p agaric-store` 1339 passed, 0 failed, 3 skipped; `SQLX_OFFLINE=true cargo check -p agaric-store --all-targets`, clippy with `-D warnings` and `cargo fmt` clean. No command signature or `.sqlx` change, so no codegen.
