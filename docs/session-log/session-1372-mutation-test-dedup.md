# Session 1372 — Deleting tests, and proving the deletion cost nothing (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | one builder, one adversarial reviewer (no self-review) |
| **Items closed** | `#4223` |
| **Items modified** | — |
| **Tests added** | −4 (net); no production change |
| **Files touched** | see PR #4234's file list |

**Summary:** #4215 found that `stryker.modules.mjs`'s `page-blocks-move` entry never listed
`page-blocks-move.test.ts`, so the scoped mutation run could not see it and kept re-filing
mutants the full suite already killed. It fixed that two ways at once — wiring the file in
**and** adding tests to `page-blocks.reorder.test.ts` covering the same mutants. With the
wiring fixed, the second half is redundant. This removes it.

**The interesting part is the evidence, not the deletion.**

Deleting tests is easy to justify badly. Three things were required before anything was
removed:

1. **Each of the four cases was checked against the surviving one by hand**, not by trusting
   the issue's line numbers. Three of the four have *different fixtures*, so "duplicate" had
   to mean "reaches the same branch of `wouldCreateMoveCycle` with the same truth value" —
   verified per case against `page-blocks-move.ts:108-119`.
2. **The scoped Stryker module was run before and after**, and the survivor sets diffed
   byte-for-byte: `141 killed / 9 survived / 94.00` both times, survivors
   `113:7, 217:35, 254:9, 257:9, 317:20, 317:37, 361:9, 361:15, 366:7`, `diff` exit 0.
3. **The review checked that proof for vacuity** — if `page-blocks.reorder.test.ts` had not
   been in the module's `tests` array, the two runs would have matched *trivially* and
   proved nothing. It is in the array, confirmed by a live parse. The reviewer then went
   further than asked: it restored the deleted block by hand, re-ran, got the identical
   result, and reverted.

On the hardest case (`['A','B'] -> 'D'` deleted, `['B','A'] -> 'A1'` surviving) the review
noted the surviving test is **stronger**: its true-producing id is second, so it cannot be
satisfied by an implementation that only inspects `orderedIds[0]`.

**Kept deliberately:** the `logger.warn` three-argument assertion, even though the same
expectation exists in `page-blocks-move.test.ts`. That one drives the whole `moveBlocks`
action through to the reload; the duplication is in the assertion, not the scenario, and the
scenario is the point.

**Second half: marking evidence that cannot be re-derived.**

#4215's ledgers carry numbers from ad-hoc local runs with no committed artifact. The choice
was to commit the harnesses or to mark the figures — marking is right, because
reconstructing the harnesses now would produce *different* numbers, which is worse than
honest ones. Four sites annotated `UNREPRODUCED (#4223)`, each beside the figure it governs
rather than in a footnote:

- the 885,205-input differential sweep (`tree-utils.mutants-build.test.ts`)
- the `#3759` canary-hit counts (`page-blocks.move-reparent.test.ts`)
- the 3,068/722 sweep and the ad-hoc **526/0** pair (`page-blocks.reorder.test.ts`)
- the 98.99% / 96.43% / 94.00% Stryker scores (`session-1358`), since `reports/mutation/` is
  gitignored

The `217:35` entry was **split** rather than blanket-marked: its old 526/0 pair is
unreproduced, while the `#3804` re-measurement below it (0/21,120 and 9,581/42,240) is
genuinely reproducible and now carries its exact invocation. The review ran that harness and
got those figures exactly. Marking a reproducible number as unreproduced is also a defect —
it teaches readers to distrust good evidence — so both directions were checked.

The ledgers' semantic reasoning is untouched. It stands independently of the numbers; only
the numbers' status changed.

**Verification:** 907 tests passed across the touched files; `stryker.modules.mjs` parses;
scoped mutation run reproduced by the reviewer independently.

**Commit plan:** single commit on `claude/fe-mutation-test-dedup`, shipped as PR #4234.
