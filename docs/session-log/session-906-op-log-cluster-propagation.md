## Session 906 — #109 Phase 2 op_log cluster: Rust + FE propagation (mergeable) (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator + 2 (FE test-fixture ISO→ms; Rust test-fixture + uncovered-prod-path fixes) |
| **Items closed** | #109 (Phase 2 op_log cluster — propagation complete; PR #238 ready) |
| **Items modified** | — |
| **Tests added** | 0 (existing suites re-greened; they caught 3 prod bugs the type-check could not) |
| **Files touched** | ~140 (source/test/bindings + 53 regenerated `.sqlx`) |

**Summary:** Completed the propagation begun in [session-905](session-905-op-log-cluster-foundation.md).
The 4 columns migrated to INTEGER epoch-ms (`op_log.created_at`, `blocks.deleted_at`,
`attachments.created_at`, `block_drafts.updated_at`) are now read as `i64` across every
Rust call site, the sync wire format, the snapshot format, the op payload, the pagination
rows, and the 4 FE IPC types. The branch compiles, lints, and passes the full Rust +
frontend suites; PR #238 dropped its DRAFT/DO-NOT-MERGE marker and is mergeable.

**Convention applied (from `docs/cluster-109-op-log-plan.md`, unchanged):**
- Core type flips: `OpRecord.created_at`, `RestoreBlockPayload.deleted_at_ref`,
  `OpTransfer.created_at`, `BlockSnapshot.deleted_at: Option<i64>`,
  `AttachmentSnapshot.created_at`, `Draft.updated_at`, and the pagination row structs
  (`BlockRow`/`ActiveBlockRow`/`HistoryEntry`/`SearchBlockRow`) → `i64`.
- Producers: `crate::now_rfc3339()` → `crate::db::now_ms()` **only** where feeding the 4
  migrated columns or `deleted_at_ref`. Columns that stay TEXT (`attachments.deleted_at`,
  `due_date`/`scheduled_date`/`value_date`, `property_definitions.created_at`, `gcal_*`,
  tags/agenda date strings) were left untouched.
- **Opaque-slot bridges kept as `String`, parsed to `i64` at the SQL boundary** (never
  flip-flopped — this is what made the first attempt oscillate): pagination
  `Cursor.deleted_at` (encode `last.created_at.to_string()`, decode
  `.parse::<i64>()` → `AppError::Validation`), and the Loro engine seed
  (`apply_*` reads `engine_deleted_at: Option<&str>`, parses to i64 before binding the
  INTEGER `blocks.deleted_at`). `loro/projection.rs` bridge double-checked: round-trip
  confirmed by the soft-delete/sync proptests.
- The FTS search path's `Option<String>` `deleted_at` fields (`FtsSearchRow`,
  `RegexScanRow`, `SearchBlockRow`) → `Option<i64>` for cluster consistency; always `None`
  on search rows (`WHERE deleted_at IS NULL`) but now type-correct against the column.

**FE:** Specta bindings regenerated (the 4 IPC types now `number`); hand-mirrored
`tauri.ts` types (`AttachmentRow.created_at`, `CompactionStatus.oldest_op_date`,
`restoreBlock(deletedAtRef)`) and `formatRelativeTime` widened to accept `number` (epoch-ms
flows straight into `new Date()`). ~180 test-fixture ISO-string timestamps converted to
exact UTC epoch-ms (monotonic, so relative ordering preserved); 3 `restore_block` assertion
expectations updated to the matching ms values.

**Three production query paths the type-checker could NOT catch (found only by running the
full suite — `cargo check` is green while they're broken, because they're dynamic/string
SQL using SQLite date functions):**
1. `commands/history.rs` `find_undo_group_inner` — used `julianday(created_at)` for the
   undo-window gap; `created_at` is now INTEGER ms, which `julianday()` misparses. Replaced
   with direct integer subtraction `(w.created_at - o.created_at) <= ?`.
2. `filters/primitive.rs` LastEdited Rolling/OlderThan/Range — compared the INTEGER-ms
   column against `datetime('now',?)` / ISO-string binds (always false → every page
   excluded). Migrated to ms: `CAST(strftime('%s','now',?) AS INTEGER) * 1000`, epoch
   sentinel `0`, integer Range binds (bounds parsed via `chrono`, bare-date end still
   extended to end-of-day).
3. `commands/pages.rs` `RecentlyModified` keyset — `last_modified_at` (`MAX(op_log.created_at)`)
   is INTEGER; migrated the row type to `Option<i64>`, the NULL sentinel string→`0`, and the
   cursor slot to the standard i64↔opaque-string bridge.

FE consumers of `last_modified_at` (`lastModifiedAt`) followed: `usePageBrowserSort`
recently-modified now sorts numerically DESC (was `localeCompare`), and
`DensityRow.formatRelativeShort` accepts epoch-ms numbers (was `Date.parse`-only).

A round of clippy cleanup removed `.clone()`/`&` on the now-`Copy` `i64`/`Option<i64>`
fields across crud/history/handlers/batch/restore (the `String`→`i64` flip turned former
borrows/clones into `clippy::clone_on_copy` / `needless_borrow`).

**Process note (lesson):** an earlier "green" reading was false — `cargo nextest run | tail`
returns `tail`'s exit code, masking nextest's failure. Re-running without the pipe surfaced
201 → (after fixes) 0 failures. Always read nextest's printed `Summary` line, never a piped
exit code.

**Verification (all green, re-confirmed without pipe-masking):**
- `cargo check --all-targets`, `cargo clippy -- -D warnings` (the CI gate), `cargo fmt --check` — clean.
- `cargo sqlx prepare --check -- --tests` — 53 `.sqlx` files regenerated + verified against the INTEGER schema.
- **`cargo nextest run` — Summary: 4067 passed, 0 failed, 6 skipped** (correctness arbiter:
  event-log immutability, soft-delete/restore cascade, recovery, cross-device sync, dag/merge proptests).
- FE: `tsc -b` 0 errors; `vitest run` 10932 passed / 0 failed; `oxlint` only pre-existing
  complexity warnings; `oxfmt --check` clean.
