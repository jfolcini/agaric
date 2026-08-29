# Session 1432 — a nested page does not follow its parent

#4480 reported that a batch move-to-space evicts the selected roots from the origin `[[`
cache but not their moved-out children, and asked for the affected set to come back from
`move_blocks_to_space`. The premise did not survive measurement. The move symptom does not
exist; the *mirror* the issue named in passing — `handleTrash` — is where the bug actually
lives, and it lives there for the opposite reason.

## What the cited test actually pins

The issue's evidence was `move_blocks_to_space_propagates_space_id_to_descendants_533`. That
test seeds a page with a **content** child and asserts the child's `space_id` follows. The
`[[` picker offers **pages**, and a content descendant is not a nested page — so the test
proves something adjacent to, but not, the claim resting on it.

Two mechanisms say a nested page does not move, and they agree:

* the synchronous fan-out is `project_set_property_to_sql`'s
  `UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?`, and a page block's `page_id`
  is its own id (`page_id_self_for_pages`, migration 0073). A nested page can never match
  its parent's fan-out.
* the background reconciler, `cache::page_id::rebuild_space_ids`, carries
  `WHERE block_type != 'page'` — a page's `space_id` is authoritative and is never
  re-derived from an ancestor.

A throwaway probe driving the real command confirmed it end to end, read back through
`list_all_pages_in_space_inner` (the query that fills the picker cache), not through
`blocks.space_id` alone:

```
after moving the parent to B:
  PRB_PAGE     space_id = Some("PRB_SPACE_B")
  PRB_KIDPAGE  space_id = Some("PRB_SPACE_A")
  space A page listing = ["PRB_KIDPAGE", "PRB_SIB"]
```

The nested page is still **in** the origin space. The origin picker offering it is correct.
`handleMoveToSpace`'s roots-only fan-out was right all along, and the useful output there is
a test and a comment that stop the next reader from "fixing" it — evicting a page that never
left would be a new bug, not a smaller one.

## The same probe found the real one, one arm over

The delete cascade is a different walk.
`collect_subtree_ids_unbounded(.., Active)` filters on `deleted_at` and depth and nothing
else — there is no `block_type` stop — so trashing a page **does** tombstone its page
children:

```
delete_blocks_by_ids_inner(["PRB_PAGE"]) -> 2
  PRB_KIDPAGE  deleted_at = Some(...)
  space A page listing = ["PRB_SIB"]
```

`handleTrash` fanned out over `ids`, the roots it had sent, so the cascaded nested page stayed
in the warm cache — a row now sitting in the trash, still offered by `[[` for the rest of the
session. That is #4450's defect surviving one level down, which is exactly the shape #4480
described. It was just pointing at the wrong command.

## Fix: the delete reports its cohort, because only it can see it

`delete_blocks_by_ids` returned a bare `i64`. A count can word a toast; it cannot invalidate
anything. It now returns `BatchDeleteResponse { deleted_count, affected_page_ids }`, where
the page ids are read from the *same* `union_cohort_json` the soft-delete `UPDATE` consumes —
so the reported set and the tombstoned set are one list by construction and cannot drift.

The issue's own framing — "deletes tell you what they touched, moves do not" — turned out to
name a real asymmetry in the wrong place. `DeleteResponse::descendants_affected` is a *count*.
The gap is not between delete and move; it is between knowing a cohort and reporting one.

`handleTrash` evicts the **union** of its input and the reported cohort. Union rather than
replacement because a skipped id (missing, or soft-deleted by a concurrent write) never enters
the cohort, and dropping it would silently regress the pre-#4480 behaviour on a path nothing
else covers. The `NAME_CACHE_FANOUT_MAX_IDS` budget is measured against that union, since the
union is what will actually be emitted.

## Why the over-eviction guard counts events

A cache-level assertion cannot carry the narrowness claim here. The harness's
`list_all_pages_in_space` mock is static, so a wholesale `invalidateNameCaches()` self-heals on
the next synchronous refetch. The exact-equality assertion on the bus events falsifies four
distinct wrong versions at once, each confirmed red against a copy of the file:

| broken version | observed |
| --- | --- |
| `for (const id of ids)` (the bug) | 1 event, `P_NESTED` never evicted |
| `invalidateNameCaches()` (alternative 2) | 1 event, `{kind:'invalidated'}` |
| array instead of `Set` | 3 events — the backend echoes the roots back |
| threshold on `ids.length` | 30 synchronous events instead of 1 |

The last is the one worth keeping in mind: 20 selected roots is under the cap of 25, so the
pre-#4480 threshold test passes and the code takes the per-id branch — firing the whole union
anyway. The cap only holds if it is measured against what gets emitted.

The mock backend (`tauri-mock/handlers/blocks.ts`) collects page ids in its own BFS for the
same reason; a mock that returned only the roots would let this bug pass in the mock backend
while the real one was fixed.
