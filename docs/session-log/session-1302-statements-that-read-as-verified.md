# Session 1302 — statements that read as verified and were not (2026-08-14)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-14 |
| **Subagents** | build + independent review per item; exact split spans a context boundary and is not reconstructible |
| **Items advanced** | `#3864`, `#3856`, `#3826`, `#3870`–`#3873`, `#3809` |
| **Items filed** | `#3869`, `#3876`, `#3878` |
| **PRs merged** | 5 |

**Summary:** The tail of the same run as sessions 1300 and 1301, and the point at which their two themes turned out to be one theme. Session 1300 named *a check that reads as coverage and supplies none*; session 1301 named *a filed claim that has drifted from the code*. Both are the same defect wearing different clothes: **a statement that reads as already verified and is not.** One lives in a guard, the other in prose. Both survive review for the same reason — they look like something that has already been checked, so nobody checks it.

**Process notes:**

**The prose half showed up three times in one PR.** #3877 closed four tauri-mock read divergences, and its review found three code comments saying a gap was "filed separately" with no issue number. A citation with no number cannot be followed, so it reads as diligence and functions as a dead end — the same failure that had already cost two corrections earlier the same day, when `#522` turned out to be cited in two places for unrelated work. Fixed by pointing them at #3878 and #3876, and by moving the tag-inheritance explanation out of the PR body and into the `rebuild_all` docstring, on the grounds that the code comment is what a future reader hits first and the PR body is what nobody reopens.

**The mock had been mirroring the backend instead of deriving from it.** `list_inherited_tags_for_block` was a hard-coded `() => []`, and the four incremental hooks that were supposed to maintain the relation had drifted from the definition in `rebuild_all`. Rewriting the read to *derive* the relation at query time removed the whole class: there is now one definition rather than five call sites that must agree with it. The backend still has the inconsistency the derivation exposed, which is #3876 — filed rather than fixed, because the two engines disagreeing is a separate decision from the mock lying about it.

**Pagination cursors were the one place the mock could not be papered over.** `list_blocks` ignored `limit` and `cursor` entirely. The fix had to mirror `list_blocks_inner`'s if/else chain branch for branch, because each branch sorts differently and a cursor encoded under one order is meaningless under another — `position` alone is not a total order, `(COALESCE(position, sentinel), id)` is. Making `paginateKeyset` take a key *tuple* rather than a column name is what makes the wrong-order reinterpretation unrepresentable rather than merely avoided.

**The ratchet has the same blind spot one level down.** The conformance coverage ratchet keys on the command, so an uncovered *branch* of a covered command reads as covered — which is precisely how `list_blocks` sat green with no pagination at all. Filed as #3878. It is worth saying plainly that the ratchet found none of the four divergences in this PR; #3826's differential harness did.

**What generalises:** the thing that caught every one of these was running something rather than reading it — gutting a handler and watching the suite stay green, un-skipping a fixture and reading the diff, grepping the built bundle for an identifier the recipe claimed was there. Re-reading the reasoning reproduces the reasoning, including its mistake. The cheap habit that follows: when a comment, a ledger, or an issue body asserts that something has been checked, treat the assertion as the *hypothesis* and the run as the evidence — and when the run is impossible, say so in the artefact instead of leaving the assertion to be read as a result.
