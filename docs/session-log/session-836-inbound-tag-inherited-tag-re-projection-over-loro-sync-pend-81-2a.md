## Session 836 — inbound tag + inherited-tag re-projection over Loro sync (PEND-81 §2A) (2026-05-25)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-25 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | PEND-81 §2A tags (remote AddTag/RemoveTag → SQL `block_tags` + `block_tag_inherited`) |
| **Items modified** | PEND-80/81 (sync metadata completeness) |
| **Tests added** | +6 (backend) |
| **Files touched** | 2 |

**Summary:** Remote `AddTag`/`RemoveTag` changes now reach SQL. `apply_remote`'s Phase 2
is a two-pass replace inside the existing tx — Pass A upserts every block's core
columns + properties (so all tag-block rows referenced by `block_tags.tag_id` exist),
Pass B re-projects each block's tags from `engine.read_tags` (authoritative
DELETE + existence-gated INSERT). After commit, `tag_inheritance::rebuild_all` rebuilds
`block_tag_inherited` (a global rebuild, correctness-first; targeted reindex is a
documented perf follow-up). Builds on session 835's property re-projection; together
they close the PEND-76 F1 tag/property propagation residual.

**Process:** built + independently reviewed (no self-review), and **committed before
review** (the session-835 reviewer had discarded uncommitted work). Review caught a
**BLOCKER**: a purged tag block leaves a dangling element in other blocks' engine tag
lists (`apply_purge_block` doesn't scrub element refs) and a cross-space tag block isn't
in this space's doc, so `read_tags` can return a `tag_id` with no `blocks` row — and
`INSERT OR IGNORE` does NOT suppress FK violations, which would abort the entire
inbound-sync tx and keep failing on retry. Fixed with an existence-gated INSERT +
regression test. Also un-masked the F1 E2E guard (now that tags *and* properties are
both re-projected, a REPLACE regression would be re-inserted — so the test now asserts
`deleted_at`/`todo_state`, which nothing re-projects, survive the core upsert).

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (PEND-track items).
- **Previously resolved:** 1342+ (unchanged).

**Files touched (this session):**
- `src-tauri/src/loro/projection.rs` (`reproject_block_tags_from_engine` + 3 tests)
- `src-tauri/src/sync_protocol/loro_sync.rs` (two-pass `apply_remote` + rebuild_all + 3 E2E tests + F1 guard)

**Verification:**
- `cargo nextest run loro_sync reproject tag_inheritance` — 63 pass (6 new); `prek` at commit.
- `scripts/push.sh` CI-equivalent at push.

**Lessons learned:** Engine vs SQL diverge on purge (engine keeps dangling tag-list
elements; SQL cascade-deletes them) — any engine→SQL re-projection over an FK must
tolerate dangling references. Remaining PEND-81 §2A: reserved hot-path keys + agenda,
real `deleted_at`/restore (Phase 2), and a targeted (non-global) inheritance reindex.

**Commit plan:** code + review-fix + docs commits on `loro-inbound-tag-reprojection` (stacked on the property branch); pushed; PR to open.
