# Session 1365 — #4012/#4011/#4040 frontend residuals, reviewed twice (2026-08-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-20 |
| **Subagents** | orchestrator-only (adversarial review of a pre-existing uncommitted diff, then a corrective pass on it) |
| **Items closed** | #4011, #4040 (file-scoped fix; systemic exposure tracked separately); **#4012 item 1 only partially** — see the correction below |
| **Items modified** | — |
| **Tests added** | frontend: the settle-callback and table cases from the reviewed diff, plus 9 more added by the corrective pass (2 table false positives, 1 serializer-escaping pin, 1 width-change split, 1 alternating-width split, 1 DOM-not-yet-there reveal, 1 re-arm, 1 parent-cycle, 1 middleware-reset) |
| **Files touched** | 9 (8 reviewed; the corrective pass changed 6 of them plus this log) |

## Correction (read this first)

**The first pass of this session reported "probed the new table-split detector
against seven edge cases … no false positives or negatives found" and "no
defects found; no code changes were needed". That conclusion was wrong.** A
second review (`agaric-reviewer`, on PR #4212) found two false positives in
exactly the class the seven probes claimed to cover, and both reproduce
against the real parser:

1. **A dash-only DATA row past index 1 was misread as an absorbed delimiter,
   and the row was deleted.** For
   `| Name | Value |` / `| --- | --- |` / `| x | 1 |` / `| --- | --- |` /
   `| y | 2 |` — valid GFM, one table with three data rows, `---` being the
   ordinary "n/a" placeholder — the run split at index 2: table 1 kept only
   its header, `x | 1` was promoted to a header, and the `| --- | --- |` row
   was consumed as that new table's delimiter and vanished. Silent data loss
   on the ordinary render/edit path (a table lives in one block as multi-line
   markdown, so it is re-persisted on the next save), which is precisely what
   #3274/#4003 exist to prevent.
2. **Off-by-one: the scan started at `k = 2`, so the split point `k - 1` could
   be the run's OWN delimiter row.** `| a |` / `| --- |` / `| --- |` came back
   as a table with a header and no delimiter, followed by a table whose header
   cell is the literal `---` — neither reading anyone could have meant.

**Why the seven probes missed both.** They tested cases the detector's own doc
comment already claimed (`\---` escaped, `--`, `:-`/`-:`, whitespace-padded
`---`, absorbed separator as the last line, three chained tables) — i.e. they
checked the implementation against its stated scope instead of attacking the
premise that defines that scope: *"an unescaped bare `---` row past the run's
own header pair can only be an absorbed second table's delimiter"*. That
premise is true of our own re-serialized output and false of foreign markdown,
which this same parser is fed on import, paste, and every reparse of a stored
block — and jfolcini's issue comment said so in passing ("from a merge **or
from foreign markdown**"). Not one of the seven probes was a rectangular
foreign table with a dash-only data row. Nor did any of them touch the `k = 2`
boundary the comment explicitly claimed was excluded. Probing inside a stated
scope is not adversarial review; the scope statement is the thing to attack.

The same overconfidence shows in the first pass's #4011 note, which recorded
"the reveal now hangs silently forever" as an *accepted tradeoff* rather than
chasing a trigger for it. There is an ordinary one: if the navigation target
is already `focusedBlockId`, `setFocused` is a no-op, BlockTree's reveal effect
never re-runs, and no `onRevealSettled` ever arrives — the navigation hangs
with no scroll, no notice, and the selection never cleared. A bug, not a
tradeoff. The old bounded poll always terminated.

## What the corrective pass changed

**#4012 item 1 — the split now fires only where it is DECIDABLE.** The two
readings of a rectangular run are isomorphic: the exact string in false
positive 1 is byte-for-byte what `serialize` emits for a header-only table
followed by a two-row table, so no property of the text can separate "one
table with a `---` data row" from "two tables". Guessing there corrupts valid
GFM; the honest answer is not to guess. `splitTableRuns` now requires, on top
of the bare-dash shape: `k >= 3` (an absorbed delimiter is index 1 of its own
table, so the earliest it can sit in a run is 3), the candidate delimiter and
the row above it agreeing in width (a table's delimiter always matches its own
header), and that width DISAGREEING with the table it would otherwise join.
That last condition is the decidable one: it makes the merged reading
malformed GFM (a row whose width disagrees with the header is not a row of
that table; the merged `TableNode` would be ragged), so the split loses
nothing. Consequence, deliberate: two adjacent tables of the SAME width merge
again, with the absorbed delimiter surviving as an escaped `\---` data row —
the canonical normalization that was already pinned before this PR, restored
here along with the property-suite seeds that encode it. **#4012 item 1 is
therefore only partially resolved**, and the PR no longer claims to close it:
tables that change width across the boundary split, tables that do not, merge.

**Review note 5 — the serializer claim, checked rather than trusted.** The
reviewer read `markdown-serialize.ts:1052-1054` and inferred that a cell of
`"--- "` would emit an unescaped `| --- |`, because `serializeParagraph`'s
`^-{3,}$` guard runs before `serializeTable`'s `.trim()`. It does not: the
cell is trimmed at the NODE level by `canonicalCellParagraphs` (line 1049)
*before* `serializeParagraph` ever sees it, and the string `.trim()` is only a
finisher for the multi-paragraph seam. The claim holds; the comment now says
*why* it holds, and a test pins it (RED, emitting `| --- |`, when the
node-level trim is removed).

**#4011 — three fixes.** A `found: true` report whose DOM row is not there yet
is treated as not-yet-settled instead of silently clearing the intent (the
#3276 symptom the feature exists to prevent). `PageEditor` bumps an explicit
`revealNonce` when it registers a pending reveal, so a report is guaranteed
even when `setFocused` changed nothing — the hang above. `onRevealSettled` is
read through a ref instead of being an effect dependency, so an un-memoized
callback from a future caller cannot re-run `expandAncestors` (a transient
reveal write that runs before the effect's bail, #4002) on every parent
render. `isInZoomPane`'s `parent_id` walk is bounded by a visited set like
every other parent walk in the app — it runs on the render path, and a cycle
would spin the main thread with no error and no frame.

**Test-quality notes.** The 200-iteration `setState` loop is 2 iterations now
(with no bound left to exceed, the 200th iteration asserts nothing the 2nd
does not). The #4040 demonstration pair asserts its own ordering, so it fails
loudly rather than going vacuous if it is ever reordered or shuffled.
`flip`/`shift`/`offset` are reset with the rest of the floating-ui mocks, with
a test pinning the clean call history (RED at 48 leaked calls without it).

## Original session record (uncorrected except where marked)

**Summary:** Adversarially reviewed an uncommitted diff claiming to fix #4012
(table-merge junk row), #4011 (block-reveal false-negative), and #4040
(unconsumed `mockReturnValueOnce` hang). Verified the diff's factual claims
against the actual git history and issue threads (all held); ~~probed the new
table-split detector against seven edge cases (all behaved as documented, no
false positives or negatives found)~~ — **wrong, see the correction above**;
confirmed the old rAF stall-polling mechanism in `PageEditor` was fully
removed rather than left as dead code beside the new callback-based mechanism,
and re-proved five representative tests RED by reverting the exact production
line each depends on — including reproducing the #4040 hang itself (not a
stand-in assertion) by temporarily restoring `vi.clearAllMocks()`. ~~No
defects found; no code changes were needed.~~ Filed #4211 for the systemic
`*Once`-mock/`clearAllMocks()` exposure across 123 other test files and closed
#4040 with a scope comment.

- `src/components/editor/BlockTree.tsx` — reviewed (#4011 `onRevealSettled` / `isInZoomPane`); corrective pass: visited-set bound, callback via ref, `revealNonce`
- `src/components/editor/__tests__/BlockTree.focusReveal.test.tsx` — reviewed, both new cases falsified RED; corrective pass: +3 cases (re-arm, callback identity, parent cycle)
- `src/components/pages/PageEditor.tsx` — reviewed (#4011, old rAF mechanism confirmed fully removed); corrective pass: not-yet-settled DOM branch, `revealNonce` bump
- `src/components/pages/__tests__/PageEditor.test.tsx` — reviewed; corrective pass: +2 cases, 200-iteration loop reduced to 2
- `src/editor/markdown-parse/parser.ts` — reviewed (#4012 `splitTableRuns`/`ABSORBED_TABLE_SEPARATOR_CELL`), probed with 7 ad hoc cases in a scratch spec (deleted after use) that **missed two false positives**; corrective pass: width-decidable split rule
- `src/editor/__tests__/markdown-roundtrip-fidelity.test.ts` — reviewed; corrective pass: merge restored for same-width runs, +4 cases
- `src/editor/__tests__/markdown-roundtrip.property.test.ts` — reviewed; corrective pass: reverted to the pinned merge policy (`table` back in the greedy-adjacency set) with a note on the narrowed split
- `src/components/editor/__tests__/BlockPropertyEditor.test.tsx` — reviewed (#4040), falsified RED by restoring `vi.clearAllMocks()` and confirming the second test hangs at `waitFor.timeout` on `mockSetProperty` — the hang reason, not an unrelated assertion; corrective pass: ordering pin, middleware resets + their test

## Findings

**#4012 — table-merge junk row.** Verified independently via
`git show`/`git merge-base --is-ancestor`: PR #4067 (merged, ancestor of
`HEAD`) genuinely fixed items 2 (`DOMParser` fallback — documented, not
restored, matching the issue's own framing) and 3 (render-time ref write —
moved to `useLayoutEffect`, with the residual mount-window caveat explicitly
commented). jfolcini's issue comment states a "weak preference" for
split-not-merge on item 1, reasoning that a user who pasted two tables
probably meant two tables. The corrective pass keeps that resolution only
where it is decidable (width change at the boundary) — see the correction
above for why the general case cannot be decided, and note that jfolcini's own
comment named the foreign-markdown case that breaks it.

**#4011 — reveal-completion signal replaces frame-count heuristic.** Confirmed
the entire old `requestAnimationFrame`/`STALL_LIMIT`/`mountedSignature`
mechanism is gone from `PageEditor.tsx` — not left as dead weight beside the
new `onRevealSettled` callback. The new `isInZoomPane` structural check and its
two BlockTree tests were falsified RED by individually reverting the
`mountedVisible`-membership branch and the `isInZoomPane` branch.
`PageEditor`'s `pendingRevealBlockIdRef` staleness guard was read and confirmed
correct. ~~One residual risk, not a defect in this diff: … the reveal now hangs
silently forever … This is exactly the tradeoff the issue's "Option 2"
explicitly proposes and accepts.~~ **Wrong: an ordinary trigger exists (a
target that is already the focused block) and it is fixed by an explicit
re-arm — see the correction above.**

**#4040 — file-scoped `mockReset()` fix, judged correct.** Measured the
systemic exposure directly rather than trusting the number in the task brief:
777 test files under `src/` (411 `.test.ts` + 366 `.test.tsx`); **123** combine
an `...Once` mock with `vi.clearAllMocks()` in the same file (one additional
match was comment-only text, excluded). File-scoped was the right call:
`mockReset()` also clears each mock's base implementation, so every mock needs
an explicit re-seed afterward — `BlockPropertyEditor.test.tsx` already
re-seeded every mock in its `beforeEach` for unrelated reasons, so the swap was
a zero-new-work, one-line-per-mock change there; the other 122 files are
unaudited, and a project-wide `mockReset: true` would flip
base-implementation-reset behavior for all 777 at once. Falsified the
demonstration pair for the hang reason specifically: reverted `beforeEach` to
the original `vi.clearAllMocks()` + manual re-seed and reran just the `#4040`
describe block — the first test passes, the second fails at `waitFor.timeout`
on `expect(mockSetProperty).toHaveBeenCalledWith(...)` (0 calls), which is the
hang symptom. Filed **#4211** for the systemic 123-file exposure and posted a
scope comment on #4040.

**Verification (corrective pass):**
- `npx tsc -b --noEmit` — clean.
- `npx oxlint` on the changed files — clean.
- `npx vitest run` (full suite, foreground) — the load-bearing check for #4040
  specifically, since cross-file contamination only shows up in a full run.
- Every fix proved non-vacuous by reverting the exact production line it covers
  and confirming the new test goes RED (the parent-cycle case does not fail but
  HANGS the file without its visited set, which is the point).

**Process note:** the lesson worth keeping from this session is the first
pass's, not the second's — a review that probes only the cases a comment
already claims will report "no false positives" and mean nothing by it. Write
down the premise the implementation rests on, then try to build an input that
satisfies the premise's letter and violates its intent.
