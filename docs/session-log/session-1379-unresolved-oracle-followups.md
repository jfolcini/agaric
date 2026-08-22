# Session 1379 — A performance guard that could not catch the regression it exists for (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | one builder, one adversarial reviewer, one tightening pass |
| **Items closed** | `#4241`, `#4242` |
| **Items modified** | — |
| **Tests added** | +5 (backend: 1 scale sweep, 1 oracle-branch test, 3 residency measurements) |
| **Files touched** | see the PR's file list |

**Summary:** two follow-ups on the `block_links_unresolved` machinery from #4243.

**#4241 part 1 — the sweep, and why it needed a second pass.** Artefact 7 had no scale
sweep, so an accidental O(n²) fold would surface as a slow lane rather than a failure. One
was added mirroring the sibling's shape — and review then demonstrated it **did not bite at
the scale it shipped with**.

That is the finding worth recording. A behaviour-preserving O(n²) defect (re-running the
unfiltered `dump_blocks` scan once per source block instead of folding the loaded slice)
was injected at the committed 2,042-row scale: reconcile went 27ms → **20.1s**, wall 21.6s,
against a kill at 60s. Comfortably green. A **740× reconcile regression would have shipped
silently** through the guard written to stop exactly that.

The timeout was also stricter than the review assumed: `bench-slo` runs with **no
`--profile`**, so `profile.default`'s `terminate-after = 2 × 30s` applies — **60s**, not
`profile.ci`'s 120s.

Retuned by measurement rather than extrapolation:

| scale | reconcile clean | wall clean | reconcile O(n²) | wall O(n²) |
|---|---|---|---|---|
| 20×100 = 2,042 (old) | 27ms | 1.7s | 20.1s | 21.6s |
| 40×100 = 4,082 | — | — | 102.0s | 113.9s |
| **50×100 = 5,103 (chosen)** | **66ms** | **4.1s** | **138.3s** | **142.3s** |

50 pages gives **2.4×** over the kill; 40 was only ~1.9×, inside machine variance. Confirmed
end-to-end under nextest: `1 test run: 0 passed, 1 timed out`, terminated on the first try
**and** the retry, so it reddens the lane rather than merely crawling. The clean side stays
~15× under the kill at 4.1s; weekly cost goes 1.7s → ~4.1s.

**Worth naming:** the O(n²) proof is a **manual** procedure. Nothing in CI re-injects the
defect, so the 2.4× margin is only as current as the doc claims. All four numbers and the
method are recorded in the test so the next person can re-derive rather than trust.

**#4241 part 2 — making the purge window triageable.** The MISSING arm has an irreducible
window: a `PurgeBlock` of a linked target hard-deletes the row, the cascade takes the edge,
nothing reindexes the referrer, and the artefact reports MISSING on a vault where every
writer behaved correctly. A purged target and a never-created one are indistinguishable
*from state*, so it cannot be closed — but it can be made triageable.

The `expected` string now names the target's presence and liveness, from the **already-built
`by_id` map** — verified to cost no extra query, and verified to cover the absent case,
since `dump_blocks` has no `WHERE` clause so a purged row is correctly absent rather than
filtered. Three branches, each naming the actionable delta rather than restating state:
repairable-the-moment-something-reindexes, dormant-unless-restored, and an honest
indistinguishable-from-state for the absent case rather than falsely picking a cause.

Review found the soft-deleted branch had **zero** coverage — a half-covered pair — and
closed it with pairwise cross-marker exclusions across all three.

**#4242 — measured before changing, and the measurement kept.** The issue said measure
first and close unchanged if the effect did not show. It showed: at 100k blocks the
duplicate residency is 13.9% of the restore's peak-over-baseline RSS, reproducing the
original diagnostic's 14.64%. So `fetch_all` became a streaming `fetch`, scoped so the
stream's borrow of `conn` ends before the INSERT reuses it — same SQL text, same error
propagation, same behaviour on empty.

The diagnostic was originally **deleted**, which review flagged: numbers that can never be
re-run are folklore. It now ships as three `#[ignore]`d tests varying **one** variable
(block count; content size and link density held fixed), each running both arms with
`VmHWM` reset between them. 20k → 0–520 kB, 50k → 13.8–14.5%, 100k → 13.9%.

The 20k point is documented as **below the method's noise floor** (520 kB once, 0 kB on a
rerun — the buffered vector fits in the arena the streaming arm just released), including
the bias direction: streaming runs first, so the gap is a **lower** bound. No memory
threshold is pinned — inventing one would be exactly the made-up number to avoid. What is
pinned is the equivalence the rewrite had to preserve: both folds derive byte-identical
obligations.

**Verification:** targeted suite 351 passed; the ignored lane 5 passed; `cargo check`,
`clippy -D warnings`, `fmt --check` and the SQL guards all clean.
