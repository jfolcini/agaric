# Session 1388 — picker cache races and the untitled-page search gap (2026-08-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-23 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | `#4270`, `#4152` |
| **Items modified** | `#4275` (items 1 and 4 fixed; item 2 decided and documented; item 3 deliberately not built) |
| **Tests added** | +4 (frontend) / +0 (backend) |
| **Files touched** | 2 |

**Summary:** Closed the two remaining ordering holes in the `[[` / `#` picker's resolve
cache and restored the ability to find a NULL-content page by typing its displayed label.
A create landing mid-fill was silently lost because `onCreatePage`/`onCreateTag` never bumped
the #4055 generation counter; two overlapping fills resolved last-resolved-wins rather than
latest-issued-wins. Both are now closed by guards that compose rather than replace each other.

**Files touched (this session):**
- `src/components/block-tree/use-block-resolve.ts`
- `src/components/block-tree/__tests__/use-block-resolve.test.ts`

**What changed, per issue:**

- **#4275 item 1** — `onCreatePage` and `onCreateTag` now bump `nameChangeGenerationRef`
  after the create commits. The #4008 append-only-if-filled guard means the append is
  skipped while the ref is empty, so before this fix a racing fill's *pre-create* snapshot
  landed last and won, and the new page or tag stayed absent until something else
  invalidated. Bumping makes that snapshot fail the existing generation guard, and the next
  read re-fetches with the create included.
- **#4275 item 2** — decision recorded rather than changed: the generation counter stays
  **global** across entity and kind. Over-rejection is the correct bias for a correctness
  guard (it can never under-reject), and two counters are two things to keep in sync for a
  cost that is one round trip and self-heals on the next keystroke. The reasoning now lives
  in a comment above the ref's declaration so the next reader does not re-derive it.
- **#4275 item 3** — deliberately not built. The issue itself says backoff under sustained
  invalidation is worth measuring before designing for, and no measurement of real sync
  fan-out exists yet. Left open on the issue.
- **#4275 item 4** — the rejection-fallback comment now describes the space-switch case as
  well as the invalidation case, and states why it is safe: the resolve-store writeback stays
  gated on `requestSpaceId`, so no cross-space write is reachable through that path.
- **#4270** — added per-list monotonic request sequence refs captured synchronously at
  dispatch and ANDed into the existing write guard, so the latest *issued* request wins
  regardless of resolve order. The test that previously *documented* last-resolved-wins was
  inverted to assert the corrected behaviour.
- **#4152** — the localised `untitledOr()` placeholder is now applied at **filter** time in
  both search paths (`searchPagesViaCache`'s `matchSorter` key and `searchPagesViaFts`'s
  cache supplement), not at seed time. Typing "untitled" finds a NULL-content page again,
  while the stored title and therefore the sort key stay raw — which was the point of #4150.
  It routes through the same `translate('block.untitled')` the render site uses, so the
  search text and the displayed label cannot diverge.

**Verification:**
- `npx vitest run` — 781 files / 17921 tests passed (1 pre-existing expected-fail,
  37 skipped; both unrelated to this diff and present on `main`).
- `npx tsc -b` — clean.
- `npx oxlint src/components/block-tree/` — clean.
- Every new test demonstrated RED against the reverted production change before being
  accepted, and the reverts were restored.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**Process notes:** One of five parallel streams in an overnight batch run; sessions 1388–1392
are siblings of the same run, each holding a distinct number per the numbering window.

**Commit plan:** single commit / pushed.
