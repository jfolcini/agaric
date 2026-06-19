# Session 1013 — /batch-issues loop: backend robustness, batch 14 (2026-06-19)

## What happened

Fourteenth batch of the `/loop /batch-issues` run: four backend robustness
findings from the multi-agent deep review, each on a disjoint module, built by
parallel subagents (≤2 concurrent Rust via the shared target-lock) and
adversarially reviewed (each builder paired with a different reviewer). Ran
overlapped with frontend batch 13 in worktree `wt-fe13`.

## Shipped

Single PR `fix/be-robustness-deep-review-4`:

- **#1567** (HIGH, robustness) — the snapshot RESET path bound snapshot rows
  verbatim into the live post-0088 schema with only `blocks.space_id` repaired, so
  a legacy/foreign snapshot with a reserved-key property (`space`/`todo_state`)
  tripped the immediate `key_not_reserved` CHECK, and any single dangling reference
  (value_ref, block_links, page_aliases.page_id) failed the whole COMMIT as one
  opaque FK error with no offending row — wedging snapshot catch-up. `apply_snapshot`
  now, before COMMIT (mirroring the existing space_id repair, filtering local Vecs
  so the returned `SnapshotData` is untouched): drops reserved/column-backed-key
  `block_properties` rows via the canonical `COLUMN_BACKED_PROPERTY_KEYS` set
  (byte-identical to 0088's CHECK); drops `block_properties` with a dangling
  `value_ref` (dropping, not NULLing — NULL would violate `exactly_one_value`);
  drops `block_links` / `page_aliases` with dangling refs; and runs
  `PRAGMA foreign_key_check` logging each residual `(table, rowid, parent)` tuple via
  `tracing::warn!`. `block_tags` deliberately left un-repaired — the existing
  reject-on-dangling-tag contract still holds.
- **#1568** (HIGH, robustness) — the Logseq body-property branch accepted any
  `key:: value` with no reserved-key filter (unlike `parse_frontmatter`), so a body
  bullet `space:: X` became a property, `set_property_in_tx` returned a Validation
  error, and `?` rolled back the ENTIRE import chunk. The body branch now filters the
  same `FRONTMATTER_RESERVED_KEYS` set frontmatter uses (skip + `tracing::debug!` +
  surfaced count), so reserved keys are skipped and importable column-backed keys
  (`due_date`/`scheduled_date`/`todo_state`/`priority`) still import.
- **#1583** (LOW, robustness) — `purge_block_sql_cascade` explicitly DELETEd ~14
  derived tables but not `block_tag_refs` / `page_link_cache`, relying on FK
  `ON DELETE CASCADE`; a future cascade-altering migration would silently leak rows
  where contributors look (the explicit list). Added explicit
  `DELETE FROM block_tag_refs` (source_id/tag_id) and `DELETE FROM page_link_cache`
  (source_page_id/target_page_id) over the `_purge_descendants` subtree before the
  final `DELETE FROM blocks`.
- **#1584** (LOW, robustness) — `import`/`import_with_changed_blocks` applied
  arbitrary bytes with no positive format assertion, so a well-formed-but-wrong Loro
  blob imported and surfaced only as scattered per-block validation errors later.
  Export now stamps `ENGINE_FORMAT_VERSION=2` into `ENGINE_META_ROOT`; import gates
  via `reject_unknown_format_version` (after `reject_legacy_v1_snapshot`, before
  `rebuild_index`): equal → ok, newer → reject, corrupt/non-integer → reject, and
  **absent → accept** (pre-#1584 exports and older peers carry no stamp and must
  round-trip; genuinely-old v1 stays covered by the existing v1 reject).

## Review pass

Four adversarial reviewers, each re-ran the real gates (`cargo clippy --all-targets
-- -D warnings` + targeted nextest) — and the rigor paid off: three of the four
items had a CI/pre-push gate failure or a test defect that the reviewer caught and
fixed before shipping.

- **#1567 reviewer** found two pre-push gate failures: the new `PRAGMA
  foreign_key_check` raised restore.rs's runtime `sqlx::query(` count 3→4, failing the
  #646 dynamic-SQL guard (fixed: `// dynamic-sql:` marker + surgical baseline line
  bump, NOT `--update-baseline` which drifts unrelated entries), and a
  `clippy::unnecessary_filter_map` (fixed: `.filter_map`→`.filter`). Verified the
  reserved-key set matches 0088 byte-for-byte and clean snapshots restore unchanged.
- **#1583 reviewer** found the same #646 failure (loro_apply.rs 18→20 sites; fixed
  with a one-line baseline bump) AND that the purge test was a non-guard — the FK
  `ON DELETE CASCADE` cleaned the rows regardless, so the test passed even with the
  explicit DELETEs removed. Strengthened it with `PRAGMA foreign_keys = OFF` on the
  purge connection (counter-mutation verified it now fails without the fix).
- **#1568 reviewer** confirmed the filter set excludes the importable column-backed
  keys (no regression) and that the reserved-key skip sits before owner-attachment.
- **#1584 reviewer** focused on the backward-compat invariant (an unstamped doc must
  import) and the gate ordering in both import paths.

## Gotcha (recorded)

`scripts/check-dynamic-sql.py` with NO file argument vacuously exits 0 — it polices
only the files passed in argv (how prek/CI invoke it). To actually test a file's
runtime-`sqlx::query(` count against `dynamic-sql-baseline.txt`, pass the file path
explicitly. Two files in this batch (restore.rs, loro_apply.rs) added runtime
`PRAGMA`/`DELETE` sites and needed surgical single-line baseline bumps; always
hand-edit the affected line rather than `--update-baseline` (which rescans the whole
tree and drifts unrelated entries).

## Notes

- Files: `snapshot/restore.rs` (+`snapshot/tests.rs`), `import.rs`,
  `materializer/handlers/loro_apply.rs`, `loro/engine/snapshot.rs` (+`mod.rs`), and
  two surgical lines in `dynamic-sql-baseline.txt`. No `.sqlx` regen (PRAGMA + the new
  DELETEs are runtime queries; engine code is Loro, not SQL).
- Pushed serially with frontend batch 13 to avoid concurrent heavy pre-push (OOM):
  the wt-fe13 pre-push and the main-checkout pre-push use separate `target/` dirs, so
  they do NOT share the cargo target lock and must not run simultaneously.
