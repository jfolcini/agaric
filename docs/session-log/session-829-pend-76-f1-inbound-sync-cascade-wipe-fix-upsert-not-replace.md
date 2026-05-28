## Session 829 — PEND-76 F1: inbound-sync cascade-wipe fix (UPSERT, not REPLACE) (2026-05-24)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-24 |
| **Subagents** | orchestrator-direct (1 Explore code-map + 1 technical review) |
| **Items closed** | PEND-76 F1 — cascade-wipe + edit-resurrection facets |
| **Items modified** | PEND-76 (F1 status block; propagation residual scoped) |
| **Tests added** | +0 (frontend) / +4 (backend) |
| **Files touched** | 5 |

**Summary:** Fixed the headline CRITICAL in PEND-76 (F1). Inbound delta-sync
projected engine state to SQL via `project_block_full_to_sql` using
`INSERT OR REPLACE INTO blocks` — under `foreign_keys=ON` + `ON DELETE CASCADE`,
REPLACE deletes the row first, cascade-wiping every block's
`block_tags`/`block_properties`/`block_links`/caches and nulling
`deleted_at`/hot-path columns. Because `import_with_changed_blocks` returns *every*
block in the space, one inbound sync wiped the whole space's derived state. Changed
the helper to an UPSERT (`INSERT … ON CONFLICT(id) DO UPDATE`) of only the
engine-authoritative core columns, so derived + soft-delete state survives; swapped
`apply_remote`'s tx to `begin_immediate_logged` (SQL-M-1). Deliberately did NOT
re-derive `deleted_at` from the engine — `read_deleted` marks only the delete seed
(descendant soft-deletes are an SQL-side CTE fan-out), so a per-block re-derive
would resurrect soft-deleted descendants. The remote-change *propagation* gap
(tag/property/delete changes reaching SQL via the bulk path) is pre-existing and
documented as a deferred per-op-projection follow-up.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (F1 is a PEND-76 cluster, partially fixed; no REVIEW-LATER rows touched).
- **Previously resolved:** 1342+ (unchanged).

**Files touched (this session):**
- `src-tauri/src/loro/projection.rs` (upsert + doc + 3 regression tests)
- `src-tauri/src/sync_protocol/loro_sync.rs` (tx → begin_immediate_logged + 1 e2e test)
- `src-tauri/src/loro/engine.rs` (stale `import_with_changed_blocks` doc note)
- `pending/PEND-76-preexisting-data-integrity-bugs.md` (F1 status block)
- `pending/README.md` (PEND-76 index row)

**Verification:**
- `cargo nextest run -p agaric loro:: sync_protocol::` — 132 tests, all pass (4 new included).
- `prek run --all-files` — run at commit.

**Process notes:** Orchestrator-direct per PROMPT.md — sync/data-integrity is the
highest-risk path, not delegated to a build subagent. One Explore subagent mapped
the inbound-sync→SQL path; one general-purpose subagent reviewed
(APPROVE-WITH-NITS). The two worthwhile nits (stale `import_with_changed_blocks`
doc; a descendant-cohort non-resurrection test) were applied.

**Lessons learned:** On the CRDT-sync projection path, "re-derive everything from
the engine" is unsafe where the engine deliberately under-models a concept
(`deleted_at` seed-only). The safe move was the narrower upsert that *preserves*
the SQL-side derived state rather than the broad re-projection the plan first
sketched.

**Commit plan:** single commit; not pushed.
