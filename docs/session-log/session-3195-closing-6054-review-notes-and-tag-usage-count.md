# Session 3195 — closing #6054: review notes and the tag usage count

This is the follow-up PR that batches the non-blocking review notes from the #6054 mock-parity PRs. It also settles the one fuzz-lane divergence that was still unexplained.

**Notes.**
- `allOrNothing` refills two link maps, but only the `keptLinkKinds` refill had a test that went red. A new case settles an owed link inside a refused reverse. It goes red when the `unresolvedLinks` refill is removed.
- `spaces_lifecycle.json` described the ranking rules at their old call site. They now live in `rankArrivals`.
- The fuzzer header's over-long line was fixed in #6215, which rewrote that paragraph.

**The tag `usage_count` divergence.** The differential fuzzer twice read a backend `usage_count` of 0 against the mock's 1 after a delete, restore and edit, and only under machine load.
- The harness is not the cause: it settles the background queue after every op.
- The backend is. `enqueue_lifecycle_rebuild_set` sends its tasks one at a time, so under load the set can split across drains. The #5275 tail fix in `dedup_tasks` holds only within one drain. `RebuildTagsCache` then runs before `RebuildBlockTagRefsCache` restores the block's refs, and nothing recounts afterwards.
- A user who restores a block holding a `#tag` chip can see that tag's count one too low until the tag changes again.
- Filed as #6216, with a deterministic repro (a 5 ms sleep per enqueue) and the smallest fix: list the refs rebuild before the tags rebuild. It is not fixed here, because this issue only covers mock parity.

**Also filed this run:** #6209, a tag's old-space refs survive its space move until the next full rebuild.

**Not mine to edit:** `src-tauri/tests/AGENTS.md` and `e2e/AGENTS.md` do not mention the `events` field that #6205 added to command records.

**Suites:** vitest over `src/lib/tauri-mock`, typecheck, and the conformance authoring run (only the description sentence changed).
