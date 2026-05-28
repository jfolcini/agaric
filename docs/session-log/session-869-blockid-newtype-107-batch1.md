## Session 869 — BlockId newtype: Batch 0 + Batch 1 (issue #107) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | — |
| **Items modified** | `#107` (partial — Batch 0 + Batch 1) |
| **Tests added** | 0 (type-level migration; compiler-enforced, existing integration tests cover the decode paths) |
| **Files touched** | 4 (+2 `.sqlx` swapped) |

**Summary:** First two batches of the `BlockId`-newtype propagation (#107). Batch 0 lifts `BlockId` to the `sqlx::Type` + `specta::Type` derive set (matching the `ActiveBlockId` precedent) so it can decode from TEXT columns and cross the Specta boundary. Batch 1 migrates the block-ULID fields of the `FromRow` structs in `commands/pages.rs` from `String` to `BlockId`. Out-of-scope structs (`BlockRow`/`ActiveBlockRow` in `pagination/`, `SearchBlockRow` in `fts/`) are deliberately left for later batches.

**Files touched (this session):**
- `src-tauri/src/ulid.rs` (+1/-1 derive line) — `BlockId` gains `sqlx::Type, specta::Type` + `#[sqlx(transparent)]`. `Deserialize` (hand-written, uppercase-normalizing) and `Ord`/`PartialOrd` deliberately NOT added (no call site needs them).
- `src-tauri/src/commands/pages.rs` (~26 lines) — `PageAliasPrefixRow.page_id`, `PageHeading.id`, `PageWithMetadataRow.{id,parent_id,page_id}` → `BlockId`/`Option<BlockId>`; `query_as!` casts updated to `"…!: BlockId"`; 5 cursor call-sites + the alias-row map adapted with `.into_string()` because `Cursor.id` (in out-of-scope `pagination/`) stays `String`.
- `src-tauri/.sqlx/` — 2 query-cache JSONs swapped (cast change); the runtime `query_as` for `PageWithMetadataRow` produces no cache entry.
- `src/lib/bindings.ts` — regenerated; net change is a new `export type BlockId = string` alias + `id`/`parentId`/`pageId` fields typed `BlockId`. Wire-identical (`BlockId = string`), so the frontend is unaffected. (Remaining diff lines are pre-existing trailing-whitespace drift the regen cleaned.)

**Verification:**
- `cd src-tauri && cargo sqlx prepare -- --tests` — regenerated cleanly (DATABASE_URL from `src-tauri/.env`).
- `cd src-tauri && cargo nextest run` — 4039 passed, 6 skipped.
- `cargo test -- specta_tests --ignored` — `git diff -w src/lib/bindings.ts` shows only the BlockId alias + field-type changes; no wire change.
- Independent review subagent: APPROVE — derive set correct, `into_string()` lossless, half-migration boundaries sound (cursor IDs canonical-uppercase on both sides of the SQL comparison), no dropped derive.
- pre-commit hook — staged-file checks. pre-push hook — full clippy + push-staged checks.

**Process notes:** Ran concurrently with the #150 proptest batch (separate worktree) per the new "two issues in flight" rule, so neither idled on the other's compile. Optional follow-up: a focused `BlockId` TEXT-column decode round-trip unit test (mirroring the `ActiveBlockId` precedent) for symmetry — not required (compiler-enforced + integration-covered).

**Follow-up — CI fix (same PR):** the PR's `validate / lint` job failed at `sqlx offline cache check`. Root cause was **not** the BlockId change: sqlx-cli 0.9.x's `cargo sqlx prepare --check` connects to `DATABASE_URL` to re-derive query metadata (it ignores `SQLX_OFFLINE` for `--check`), but `_validate.yml` pointed it at an empty `sqlite::memory:` placeholder → "no such table" for every query → ~hundreds of cascading `str` E0277 errors. The placeholder only worked under sqlx-cli 0.8.x's offline delegation. Fixed by creating + migrating a throwaway file DB before the check (`.github/workflows/_validate.yml`). Verified locally: `prepare --check` passes against a migrated DB, fails against the empty one. (`#179` is the first rust-touching PR since the 0.9 upgrade + placeholder commit, so it's the first to surface this; the committed `.sqlx` cache itself was correct and byte-identical under both CLI versions.)

**Commit plan:** two commits on the branch (BlockId Batch 0+1; CI sqlx-check fix), pushed; PR is a partial of #107 (status comment, issue stays open).
