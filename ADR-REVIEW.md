# ADR Review — Follow-up (post ARCHITECTURE.md split)

Checked every issue from the original review against the current `ARCHITECTURE.md` and `ADR.md`.

---

## Fixed

These issues from the original review are resolved:

| Issue | How it was fixed |
|-------|-----------------|
| `created_at` "display hint" contradiction | The misleading ADR-07 statement was removed. `ARCHITECTURE.md` §10 now uses `created_at` for LWW without contradicting itself. |
| ULID token length "28 characters" | `ARCHITECTURE.md` §6 line 443 now correctly says "`#[ULID]` at 29 characters, `[[ULID]]` at 30". |
| Enter key behavior stale | `ARCHITECTURE.md` §7 line 495: "Enter → Save block and close editor". Matches actual behavior. |
| diffy granularity mislabeled as "word-level" | `ARCHITECTURE.md` §10 line 630 now says "line-level granularity" and explicitly documents the single-line-block conflict implication (lines 633-636). |
| Redundant descriptions across ADRs | The split into ARCHITECTURE.md (implemented) and ADR.md (pending) eliminated most duplication. Conflict resolution is now primarily in §10, serializer in §6, tags in §2. |

---

## Still wrong in the docs

### Table and index counts

`ARCHITECTURE.md` line 174:
> 13 tables + 1 FTS5 virtual table, 11 indexes across 2 migrations

The actual migrations have **12 regular tables + 1 FTS5 virtual table** and **9 indexes**. Verified against `0001_initial.sql` and `0002_fts5.sql`.

**Fix:** Change line 174 to "12 tables + 1 FTS5 virtual table, 9 indexes across 2 migrations."

Additionally, the index listing at lines 207-210 only names 9 indexes but says 11. Just match the listing to the header count.

---

## Still needs a code fix

### Conflict copies discard "ours"

Verified in current `merge.rs` — the destructure is still `ours: _`. After a merge conflict:
- Original block gets **ancestor** text
- Conflict copy gets **theirs** (remote version)
- Local edits ("ours") are **lost**

The docs are internally consistent about this (ARCHITECTURE.md §2 line 141 and ADR.md §9 line 142 both say "original retains common ancestor"). But the design is wrong — the user loses their own edits with no way to recover them.

**Recommended fix:** Change the `to_text` in the merge op from `ancestor` to `ours`. The original block keeps the local version, the conflict copy holds the remote version. This is the Git model. One-line change in `merge.rs` at the `to_text: ancestor` assignment.

---

## Still needs documentation decisions (before Phase 4)

These are all sync-time concerns. None are bugs today — sync isn't implemented. But the op payload format is locked, so the intended behavior should be decided now.

### 1. `prev_edit` chains after compaction

Verified: `compact_op_log()` in `snapshot.rs` does a plain `DELETE FROM op_log WHERE created_at < ?`. It does **not** rewrite `prev_edit` pointers in surviving ops. After compaction, the LCA walk in `merge_text()` will hit a dangling reference when it follows a `prev_edit` that points to a purged op.

The LCA algorithm has a cycle guard (max 10,000 iterations) but no "op not found" fallback. It will either error or silently return the wrong ancestor.

**Needs a decision:**
- **Option A:** When the LCA walk hits a missing op, fall back to the snapshot's materialized content for that block. Treat it as an implicit `create_block` anchor. Document this as acceptable loss of merge precision for edits older than 90 days.
- **Option B:** During compaction, rewrite `prev_edit` pointers in surviving ops to point to a synthetic "anchor" op that captures the content at the compaction boundary.
- **Option C:** Never compact ops that are still referenced by a `prev_edit` in a surviving op (compact only unreferenced tails).

Option A is the simplest and probably sufficient — two edits that diverged more than 90 days ago will produce a conflict copy anyway.

### 2. Concurrent delete + edit during sync

Verified: locally, the `edit_block` command rejects edits to deleted blocks with `NotFound` (TOCTOU-safe via `BEGIN IMMEDIATE`). This is correct for single-device use.

But during sync, a remote `edit_block` op targeting a locally-deleted block arrives as a raw op, not through the command layer. The materializer would need to decide: apply the edit (resurrecting the block) or discard it?

**Needs a decision documented in ADR-09:**
- **Resurrect:** Clear `deleted_at`, apply the edit. The edit is evidence the remote user intended the block to exist.
- **Discard silently:** Treat the deleted state as authoritative.
- **Conflict copy:** Create a new block with the edited content, linked to the deleted block as `conflict_source`.

### 3. `move_block` conflict scenarios

ARCHITECTURE.md §2 describes position compaction for the simple case (same-parent insert conflict). Three scenarios are still unspecified:

1. **Same block moved to different parents** — which parent wins?
2. **Block moved into a deleted subtree** — orphan detection and repair
3. **Interleaved batch `move_block` ops** — a single insert generates N position-shift ops; these interleave with remote ops during sync

### 4. Duplicate tag blocks across devices

Two devices can independently create a tag block with content `"work/meeting"`. After sync, the `blocks` table has two tag blocks with the same name but different ULIDs. `tags_cache` handles this gracefully (`INSERT OR IGNORE`), but blocks tagged with one ULID won't appear in queries for the other.

**Needs a decision documented in ADR-09 (sync section):**
- Merge on sync (rewrite remote ULID references to local)
- Materializer background dedup
- Accept and expose to user

---

## Recommendations that remain valid but are lower priority

| Item | Status | Notes |
|------|--------|-------|
| `CHECK(block_type)` constraint | Still missing | One line in a migration. Cheap insurance against bad writes. |
| Max nesting depth | Still undocumented | Recursive CTE for cascade delete has no depth limit. Unlikely to be a real problem but worth a comment. |
| FTS5 staleness on tag/page rename | Still undocumented | Tag renamed → FTS5 still has old name → stale search results. Accept or reindex — either way, document the choice. |
| `created_at` timezone | Still unspecified | ARCHITECTURE.md §1 mentions "chrono — RFC 3339 with millisecond precision" which implies UTC offset is included. Confirm that all timestamps are UTC and document it, since LWW depends on comparable timestamps. |
| `peer_refs` stores hashes not `(device_id, seq)` | Still as designed | `last_hash` and `last_sent_hash` require a lookup to find the corresponding `(device_id, seq)`. Storing the pair directly would be more efficient. Minor — hash provides integrity verification. |
| Empty block on last Backspace | Still unspecified | "Backspace when block empty → Delete block" — is there a minimum block count per page/day? |

---

## Summary

| Category | Count | Items |
|----------|-------|-------|
| Fixed | 5 | `created_at` contradiction, ULID length, Enter key, diffy granularity, redundancy |
| Doc error (trivial) | 1 | Table/index counts |
| Code bug | 1 | Conflict copies lose "ours" |
| Needs decision before Phase 4 | 4 | LCA after compaction, delete+edit sync, move_block conflicts, tag dedup |
| Lower priority | 6 | CHECK constraint, nesting depth, FTS5 rename, timezone, peer_refs, empty block |
