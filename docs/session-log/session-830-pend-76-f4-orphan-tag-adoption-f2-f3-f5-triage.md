## Session 830 — PEND-76 F4 (orphan-tag adoption) + F2/F3/F5 triage (2026-05-24)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-24 |
| **Subagents** | orchestrator-direct (3 Explore investigations: F2, F3, pairing flow) |
| **Items closed** | PEND-76 F4 (session-created tags lack a `space` property) |
| **Items modified** | PEND-76 (F3 deferred-with-finding; F2/F5 scoped to own batches) |
| **Tests added** | +0 (frontend) / +2 (backend) |
| **Files touched** | 3 |

**Summary:** Fixed PEND-76 F4 — a tag created mid-session (no `space` property)
applied to a block in a non-default space was rejected as cross-space until the
next-boot orphan migration. `add_tag_inner` now ADOPTS an orphan tag into the
source block's space (emits `SetProperty(space=S)` + materialises the row in the
same tx, the eager equivalent of `migrate_orphan_tags_to_space`); genuine
cross-space (both assigned, differ) still rejects. Investigated F2/F3/F5: **F3
deferred** — the empty-string `peer_refs` row written at pairing-confirm is
load-bearing for waking the dormant daemon for the first sync (the FE has no remote
device_id at confirm time; TOFU writes the real row later), so the obvious "skip the
write" fix would break first-pairing; the real fix decouples activation from
`peer_refs` and needs runtime verification. **F2** (attachments) confirmed
WIP-by-design with a production-grade backend — completing it is a sizeable
FE+config feature, its own batch. **F5** (referential cross-space enforcement) is a
genuine non-duplicate gap (distinct from the wired PEND-24 MCP access-control check)
but wiring needs validator orphan-tolerance + create-time space resolution + a
full-suite fallout check — its own batch.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (PEND-76 clusters; no REVIEW-LATER rows touched).
- **Previously resolved:** 1342+ (unchanged).

**Files touched (this session):**
- `src-tauri/src/commands/tags.rs` (`add_tag_inner` orphan-tag adoption)
- `src-tauri/src/commands/tests/tag_cmd_tests.rs` (+2 tests)
- `pending/PEND-76-preexisting-data-integrity-bugs.md` (F4 fixed; F3 deferred-with-finding; F2/F5 scoped)

**Verification:**
- `cargo nextest run -p agaric tag_cmd_tests add_tag cross_space tags::` — 70 tests, all pass (2 new).
- `prek run --all-files` — run at commit.

**Process notes:** Three read-only Explore subagents de-risked the decision-gated
items (F2 intent, F3 pairing flow, F2 attachment wiring) before committing to fixes.
F3's investigation flipped the "obvious" fix — a good example of verifying before
touching the sync/pairing path.

**Commit plan:** single commit (F4 + triage docs); not pushed.
