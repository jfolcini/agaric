## Session 855 — breadcrumb resolver no longer re-fires on unresolvable page_ids (#153 sub-item) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (one sub-item of #153 shipped; the issue stays open for the other two items, which are gated on measured data) |
| **Items modified** | #153 (comment added describing the sub-item shipped + which sub-items remain) |
| **Tests added** | +1 frontend (`SearchPanel.test.tsx` — `does not re-fire batchResolve for unresolvable parent page_ids across loadMore (#153)`) |
| **Files touched** | 3 |

**Summary:** Ships the third sub-item of #153 (CR-PERF). The breadcrumb `useEffect` in `useSearchResults.ts` previously filtered `parentIds` only by `!pageTitles.has(id)`. Soft-deleted or missing parents never land in `pageTitles` (their `batchResolve` returns no row for that id), so each subsequent `loadMore` whose results carried the same unresolvable id would re-fire `batchResolve` against the backend with that id again, indefinitely. Added `attemptedBreadcrumbIdsRef = useRef<Set<string>>(new Set())` and an additional `!attemptedBreadcrumbIdsRef.current.has(id)` filter; the ref is populated up-front before the IPC call (so a rejected promise also marks the ids attempted), bounding each unresolvable id to exactly one `batchResolve` round-trip for the life of the hook instance.

The other two sub-items of #153 stay open: the exit-save `block_on` timeout is explicitly gated on "measured large-workspace save duration first — do not invent the timeout" (per the issue body and the project's "measure, don't imagine" rule), and the snapshot-mutex item is marked "Fix only if multi-space workspaces grow." A status comment on the issue records this.

**Files touched (this session):**
- `src/components/SearchPanel/useSearchResults.ts` (+13 net — new ref + extra filter clause + comment explaining the bound)
- `src/components/__tests__/SearchPanel.test.tsx` (+59 — new test that drives two `search_blocks` pages with the same unresolvable `page_id` and asserts `batch_resolve` fires exactly once total)
- `docs/session-log/session-855-…md` (new — this log)

**Verification:**
- `npx vitest run -t 'does not re-fire batchResolve'` — new test passes.
- `npx vitest run -t 'dedupes parent'` — sibling dedup test still passes (the filter ordering didn't regress it).
- `npx vitest run` — full suite green (no new failures).
- pre-commit hook will run on commit; pre-push hook on push.

**Process notes:** Picked this sub-item because it was the only one in #153 with no measurement gate. The other two have explicit "needs profile data first" / "fix only if X grows" clauses — exactly the shape of work that the "measure, don't imagine" rule says not to ship on speculation. The fix is small enough that an orchestrator-direct edit + one focused test fit one PR comfortably without needing subagents.

**Lessons learned (for future sessions):** When a multi-item issue mixes "ready now" and "gated on measurement" items, ship the ready-now items as their own PRs and comment-update the issue with what shipped and what remains. Don't bundle a speculative-perf item with a ready-now item just to close the issue in one go — the speculative half ages the PR and entangles review.

**Commit plan:** single commit on branch `fix/breadcrumb-no-refire-unresolvable-153`; PR against `main`. Issue #153 stays open (only one of three sub-items shipped).
