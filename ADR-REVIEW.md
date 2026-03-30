# ADR Review — Consistency, Oversights, Improvements

Pragmatic review of `ADR.md`. Focused on things that could bite you, not cosmetic nitpicks.

---

## 1. Contradictions

### `created_at` — "display hint" vs actual merge key

ADR-07 (line 503):
> `created_at` is a display hint, not a merge ordering key.

ADR-06 (line 400):
> On sync conflict [...] the materializer resolves by last-writer-wins on `created_at`

ADR-09 (line 939):
> Two `set_property` ops [...] resolved silently: **last-writer-wins on `created_at`**

The code confirms `created_at` is the **primary** LWW tiebreaker (`merge.rs` line ~220). The ADR-07 statement is flatly wrong — `created_at` is a merge ordering key for both property and position conflicts. This matters for clock skew: if device A's clock is 5 minutes ahead, it wins every LWW tie. You should either:

- **Fix the ADR-07 statement** to say `created_at` is used for LWW ordering and document the clock-skew risk, or
- **Switch LWW to op_log `(device_id, seq)` ordering** and make `created_at` truly cosmetic.

### ULID token length — wrong number

ADR-20 (line 1269):
> ULID tokens are space-free 28-character strings treated as single words

Actual lengths:
- Raw ULID: **26** characters
- `#[ULID]`: **29** characters
- `[[ULID]]`: **30** characters

28 isn't any of these. Trivial fix but it's in a section that describes diffy's word-level merge semantics, so precision matters.

### Index count — stale

ADR-05 status summary says "8 indexes." The schema listing in the ADR body shows 7 explicit indexes. The actual `0001_initial.sql` has **9 indexes** — the ADR omits `idx_blocks_deleted` and `idx_attachments_block`. The status summary's "7 + 1 (FTS5)" doesn't match either count.

### Table count — off by one

The status summary (line 17) says "13 tables + FTS5 virtual table" implying 14 total. The schema section lists 12 regular tables. With FTS5 that's 13 total, matching the "13" in the summary but contradicting the "+ FTS5" phrasing. Probably meant "12 tables + 1 FTS5 virtual table = 13" or "13 tables including FTS5."

---

## 2. Design Gaps

### Conflict copies lose "ours"

This is the most consequential issue I found.

ADR-06 (line 472-474):
> When diffy produces a conflict, a new block is created as a copy of the conflicting version [...] The original block retains the common ancestor content.

The code confirms: original block gets **ancestor** text, conflict copy gets **theirs** (remote). But **"ours" (local version) is discarded** — the merge.rs destructure literally uses `ours: _`.

After a conflict, the user sees:
1. The original block with ancestor content (potentially very stale)
2. One conflict copy with the remote version

Their own local edits are gone. This defeats the purpose of conflict resolution. You need either:

- **Two conflict copies** (one for ours, one for theirs) with the original keeping ancestor, or
- **Original keeps ours**, conflict copy holds theirs (the more conventional approach — this is what Git does), or
- **Original keeps ours**, second conflict copy holds ancestor (for manual three-way review)

The second option is the simplest fix: change the `to_text` in the merge op from `ancestor` to `ours`, create the conflict copy with `theirs` as currently done. One extra line in merge.rs.

### Concurrent delete + edit — silent data loss

Not documented anywhere in the ADRs. If device A deletes a block and device B edits it concurrently:

- Currently: the edit is rejected with `NotFound` because `deleted_at IS NULL` check fails.
- During sync: whichever op gets materialized second "wins" — if delete lands first, the edit is silently dropped.

Most sync systems handle this explicitly:
- **Resurrect on edit:** if an incoming edit targets a soft-deleted block, clear `deleted_at` and apply the edit. The edit is evidence the user still wanted the block.
- **Conflict copy on delete:** create a conflict copy of the edited version so the user can review.

You don't need to implement this before sync (Phase 4), but the ADR should document the intended behavior. Right now it's an undecided case.

### `move_block` conflict resolution — specified but not designed fully

ADR-06 says position conflicts use LWW on `created_at`, but only covers the case where two devices assign the **same position** to **different blocks**. Missing scenarios:

1. **Same block moved to different parents** — which parent wins? LWW? What about the children that were also moved?
2. **Block moved into a subtree that was deleted** — the block now points to a deleted parent. Orphan.
3. **Batch `move_block` ops from a single insert** — a user inserts one block, generating N `move_block` ops for position compaction. During sync, these N ops interleave with the other device's position ops. The materializer needs to handle this atomically or the intermediate states create position gaps.

These are Phase 4 problems but worth documenting the intended resolution now, since the op payload format is already locked.

### FTS5 index staleness on rename

When a tag or page is renamed, the FTS5 index still contains the **old** name (since the strip pass resolved the ULID at indexing time). Searching for the new name won't find old content; searching for the old name will find content that no longer references it.

Options:
- Reindex all blocks containing `#[ULID]` / `[[ULID]]` tokens for the renamed entity (targeted, could be expensive for popular tags)
- Accept staleness and wait for the next edit to each block (cheap, but search results are wrong indefinitely)
- Store raw ULIDs in FTS5 and resolve at search time (eliminates the problem but changes search semantics)

### Snapshot + LCA interaction after compaction

ADR-06 mentions 90-day op log compaction. ADR-07's LCA algorithm walks `prev_edit` chains back to `create_block`. After compaction, old ops are deleted. If a `prev_edit` chain references a compacted op, the LCA walk fails.

The snapshot presumably captures the materialized state, so post-compaction merges would use the snapshot's content as the ancestor. But the ADR doesn't specify:
- How `prev_edit` references to compacted ops are handled (do they become null? point to a sentinel?)
- Whether the LCA algorithm has a fallback when a chain entry is missing
- Whether the snapshot's content is treated as an implicit `create_block` for LCA purposes

---

## 3. Missing Constraints / Hardening

### No CHECK on `block_type`

The schema has no `CHECK(block_type IN ('content', 'tag', 'page'))`. A bug in the command layer could write `block_type = 'tg'` and you'd discover it much later. Cheap insurance:

```sql
ALTER TABLE blocks ADD CONSTRAINT chk_block_type
  CHECK(block_type IN ('content', 'tag', 'page'));
```

(Or add it to the CREATE TABLE — either way, one line in a migration.)

### No max nesting depth

Tab indentation can nest blocks arbitrarily deep. The recursive CTE for cascade delete walks the full depth. A pathological nesting depth (user holds Tab) could make cascade operations slow. Consider a max depth (e.g., 20 levels) enforced at indent time.

### Duplicate tag names across devices

`tags_cache.name` has a UNIQUE constraint. The cache rebuild uses `INSERT OR IGNORE`, so the second tag with the same name is silently dropped from the cache. But the underlying `blocks` table now has **two tag blocks with identical content**. There's no dedup for this — `#[ULID_A]` and `#[ULID_B]` both mean "work/meeting" but are different entities. Blocks tagged with one won't appear in queries for the other.

Options:
- **Merge on sync:** when syncing a `create_block` for a tag that already exists locally, map the remote ULID to the local one and rewrite all `#[remote_ULID]` tokens. Invasive but correct.
- **Materializer dedup:** background task that detects duplicate tag names, picks a winner, rewrites `block_tags` and content tokens for the loser. Simpler but still content-rewriting.
- **Accept it:** display both in the tag browser with a "(duplicate)" indicator, let the user merge manually. Least code, worst UX.

This is a sync-time problem, so Phase 4, but the decision should be documented.

---

## 4. Redundancy / Structure

### Conflict resolution described three times

The conflict copy mechanism appears in ADR-06 (lines 471-475), ADR-09 (lines 929-935), and ADR-10 (lines 952-973). Each adds slightly different details. ADR-06 says "original retains common ancestor." ADR-09 repeats it. ADR-10 adds the diffy specifics.

Suggestion: single canonical description in ADR-10 (it's the conflict ADR), with ADR-06 and ADR-09 cross-referencing it. Currently if you update one you might forget the others.

### Serializer described twice

ADR-01 has a detailed serializer section (lines 95-129) and ADR-20 has the full spec. They're consistent but maintaining both is unnecessary. ADR-01 could just say "see ADR-20" for the serializer details.

### Tag namespacing described three times

ADR-05 (schema comments), ADR-06 (data model), and ADR-18 (the dedicated ADR) all describe tag namespacing. ADR-18 is the canonical source; the others could cross-reference it.

---

## 5. Minor Items

| Item | Location | Note |
|------|----------|------|
| `Enter` key behavior | ADR-01 line 138 | Says "Insert `\n` into content (auto-split fires on blur)" but the commit history shows `Enter` now saves and closes the editor. ADR is stale. |
| `block_drafts` no `session_id` | ADR-05 line 341 | Comment says "no session_id column" but doesn't explain why — the explanation is in ADR-07 crash recovery. A cross-ref would help. |
| Empty block on last Backspace | ADR-01 line 137 | "Backspace when block empty → Delete block" — what happens when it's the last block on a page? No minimum block count specified. |
| Timezone for `created_at` | Throughout | `created_at` is used for LWW but no timezone spec. If one device uses UTC and another uses local time, LWW is broken. Should specify UTC always. |
| `peer_refs` stores hashes not seqs | ADR-09 | `last_hash` and `last_sent_hash` store hashes, but finding "ops after this hash" requires a lookup + walk. Storing `(device_id, seq)` pairs directly would be more efficient for the common sync path. |
| Phase estimates likely stale | ADR-16 | Status summary shows P1-P4W2 done, but ADR-16 estimates don't reflect actual elapsed time. Not wrong, just not useful anymore. |
| `hardBreak` → `\n` claim | ADR-01 line 155 | "A hardBreak node from paste normalization is treated as a \n and triggers auto-split, not rendered as `<br>`." — worth a test case if not already covered. |

---

## 6. Suggested Priority

If I were spending a weekend on ADR cleanup:

1. **Fix the conflict copy to preserve "ours"** — this is a real bug, not a doc issue
2. **Correct the `created_at` contradiction** — decide if it's a merge key or not, update ADR-07
3. **Document delete+edit conflict behavior** — even if just "undefined until Phase 4"
4. **Fix the ULID length, index count, table count** — 5 minutes, removes noise
5. **Add `CHECK(block_type)` migration** — 2 minutes of SQL
6. **Document snapshot/LCA interaction after compaction** — needed before Phase 4 implementation
7. **Consolidate duplicate descriptions** — nice to have, prevents future drift
