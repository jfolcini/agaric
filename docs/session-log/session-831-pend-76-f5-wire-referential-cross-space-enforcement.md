## Session 831 — PEND-76 F5: wire referential cross-space enforcement (2026-05-24)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-24 |
| **Subagents** | orchestrator-direct |
| **Items closed** | PEND-76 F5 (cross-space ref/content validators were dead code) |
| **Items modified** | PEND-76 (F5 → fixed; bulk-import/sync-ingress noted as follow-up) |
| **Tests added** | +0 (frontend) / +5 (backend) |
| **Files touched** | 4 |

**Summary:** Wired the two dead PEND-15 Phase 2 validators
(`validate_content_cross_space_refs`, `validate_ref_property_cross_space`) into the
single-block write paths: `set_property_in_tx` (ref-type `value_ref`),
`create_block_in_tx` (content, after the INSERT so the new block's space resolves
via its `page_id`), and `edit_block_inner` (content). Refined the validators to take
`&mut SqliteConnection` (so all three CommandTx/Transaction sites pass `&mut **tx`)
and to enforce only when BOTH source and target are assigned to a space — an orphan
(unassigned) block is not cross-space to anything, so it is tolerated (matches the
F4 orphan-tag adoption; avoids false rejections of not-yet-spaced blocks at create
time). The `space` reserved key stays exempt. Confirmed during investigation that
this is distinct from / complementary to the already-wired PEND-24 MCP
`validate_block_in_space` access-control check (different concern: referential
integrity vs. agent-scope access control).

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (PEND-76 cluster; no REVIEW-LATER rows touched).
- **Previously resolved:** 1342+ (unchanged).

**Files touched (this session):**
- `src-tauri/src/spaces/cross_space_validation.rs` (validators: `&mut SqliteConnection` + orphan tolerance + module doc; +2 tests)
- `src-tauri/src/commands/blocks/crud.rs` (wired into set_property_in_tx / create_block_in_tx / edit_block_inner)
- `src-tauri/src/commands/tests/property_cmd_tests.rs` (+1 test)
- `src-tauri/src/commands/tests/block_cmd_tests.rs` (+2 tests)
- `pending/PEND-76-preexisting-data-integrity-bugs.md` (F5 status)

**Verification:**
- `cargo nextest run -p agaric spaces:: block_cmd property_cmd tag_cmd cross_space` — 316 tests pass (no fallout from the new rejections); the 5 new tests pass.
- `prek run --all-files` — run at commit.

**Process notes:** The wiring exposed a real subtlety — at create time the new
block's space isn't established until after the INSERT, and orphan blocks must be
tolerated to avoid false rejections; the "both-assigned-and-differ" semantics
handles both cleanly without breaking the existing test suite.

**Commit plan:** single commit; not pushed.
