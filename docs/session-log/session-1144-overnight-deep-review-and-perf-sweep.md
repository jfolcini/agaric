## Session 1144 — Overnight deep-review + perf sweep (2026-07-01/02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-01 → 2026-07-02 |
| **Subagents** | 21 build + 12 review (fable reviews opus/fable; every batch adversarially reviewed one model tier up) |
| **Items closed** | #2205 #2209–#2217 #2230 #2231 #2233–#2237 #2239 #2240 #2259–#2274 (via merged PRs); #2218 #2220 #2222 #2223 #2225–#2227 #2190 #2238 in flight/merged same night |
| **Items modified** | #2178 (measured, gate stays), #2200/#2282 (partial, carve-outs filed), #2298 (harness half shipped) |
| **Tests added** | ~+180 (frontend) / ~+70 (backend), incl. reviewer falsification tests |
| **Files touched** | ~200 across 12 PRs |

**Summary:** Cleared the bulk of the 2026-07-01 deep-review backlog plus the perf-tagged
issues in one overnight autonomous loop: 12 PRs (11 merged by morning), ~45 issues
closed, 10 follow-up issues filed. Highest-value finds came from the adversarial review
tier: a recovery-replay data-divergence hole in the sync no-op fast path (pre-existing
since #2036), a wrong-retire regression in the retry-queue ancestor gate, a measured
330× SQL regression reverted before ship, a latent FE↔BE redo-contract bug, and a
false-green stale-guard test. Also un-redded two CI lanes: the nightly bench lane (an
always-failing `#[ignore]` oracle the `--run-ignored=only` lane executed) and main
(a backlinks at-rest scroll hijack introduced by the UX batch itself — bisected,
root-caused to `useFocusedRowEffect` treating `focusedIndex=0` as focus, fixed at the
hook level).

**Merged PRs (chronological):** #2208 (pre-session, swept), #2283 nightly-oracle fix,
#2285 FE correctness batch (8 issues), #2286 retry-queue ancestor purge + saturation
probe, #2287 FE render hotpaths (5 issues), #2290 O(delta) inbound sync import,
#2293 UX/a11y mediums (5 issues), #2296 per-space registry shard, #2297 low-sev perf
roll-up (6 of 9 items), #2299 bench measure-all-probes, #2302 testing-gaps batch,
#2307 backlinks scroll-hijack un-red. Open at session close: #2303 batched
undo/move/grouped-preview, #2306 docs mediums, plus the maintainability batch carrying
this log.

**Verification:** every batch: builder-targeted tests → adversarial reviewer re-runs +
full suite (`cargo nextest` 4800+ green ×6 independent runs; vitest 14.4k+ green ×4)
→ rebase onto moved main → targeted re-gate before push. SLO problem tier measured on
a real runner (`list_page_links @100K = 557ms > 200ms` — #2178 gate stays, #2298
filed).

**Process notes:**
- The fable-reviews-everything policy paid for itself repeatedly (5 ship-blocking
  defects caught post-green-builder-tests). Falsification (revert-the-fix, no-op the
  path) is the strongest reviewer tool; several "passing" tests were proven vacuous.
- A deep-review issue can race already-landed work — two batches found their headline
  finding partially fixed on main (#2264/#2265 vs #2036; #2272's parse LRU); builders
  must verify against live source before implementing.
- Session-limit cut three agents mid-run; SendMessage-resume from transcript recovered
  all three with full context — no work lost.
- `.sqlx` offline entries are the recurring CI trap: tests that compile against the
  online dev.db pass locally and fail SQLX_OFFLINE lanes; `cargo sqlx prepare --check`
  belongs in every Rust reviewer's gate list, and regens must be workspace-aware to
  preserve diagnostics-crate entries.

**Lessons learned (for future sessions):**
- At-rest UI affordances gated on "index 0" instead of real focus are a scroll-hijack
  class; the un-red fix moved the guard into the shared hook so both panels inherit it.
- The dynamic-SQL baseline regenerates non-count-preserving from a moved main — bump
  touched files' lines surgically instead of `--update-baseline`.

**Commit plan:** per-batch PRs (12 shipped/open); this log rides the maintainability PR.
