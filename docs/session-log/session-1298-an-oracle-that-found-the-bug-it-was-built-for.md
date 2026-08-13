# Session 1298 — an oracle that found the bug it was built for (2026-08-13)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-13 |
| **Subagents** | 1 discovery, 1 build, 1 review |
| **Items advanced** | `#3296` (closed), `#3345` (re-scoped, one artefact covered) |
| **Items filed** | `#3839` |
| **Tests added** | 4 new tests, 1 proptest regression seed, 5 pinning tests corrected |

**Summary:** #3345 asked for a reconciliation oracle. One already existed — 921 lines, wired into the B6 proptest, running on every PR — so the issue was re-scoped from *build it* to *cover the remaining artefacts*, and the work became extending it to `page_link_cache`. That artefact was chosen because #3296 documented a live bug in exactly that rollup, which gave the extension something real to prove itself against. It caught it, and proptest shrank the counterexample to a single `create_block`.

**Process notes:**

**The fourth issue in this cluster with a false central premise.** #3345 is labelled `severity:critical` and calls itself "the highest-yield item in the whole programme", on the strength of: "*Nothing* rebuilds caches from base tables and diffs them against incrementally-maintained state — the cheapest, highest-yield invariant available, and it isn't taken." The mechanism exists and already does the hard part correctly, including the part easiest to get wrong: each `rebuild_*_from_base` folds raw base rows **in Rust** rather than re-expressing the production SQL, so it is not a tautology.

The issue also attributes the attachment data-loss bug to #3258, which is a CI-docs issue; the real one is #3259, closed — and attachment refcounts were already in the covered set, so one acceptance criterion was met before the issue was opened. Body re-scoped to a checklist of what is genuinely done (4 artefacts) versus outstanding (7).

The pattern across #3345/#3346/#3347 is now clear enough to name: they were filed together by one deep review, the cheap findings got fixed, and the expensive structural ones sat long enough that the tree moved underneath them. Verifying premises before building is the main risk control on this cluster, not diligence theatre.

**The oracle earned its cost immediately, and the shrink is the evidence.** With the extension in place and the `CreateBlock` fix reverted, B6 failed on op #0 and proptest shrank to `[Create { content: "s139vUuWw 03V " }]` — one op, the minimal reproduction of #3296. That seed is checked into `proptest-regressions/`, so it replays before any generated case and the falsification no longer depends on the RNG.

**The circularity problem, and why the fix is not circular.** `page_link_cache` has no synchronous maintenance arm — nothing in `apply_op_tx` writes it, only a background task does. So the driver had to run *something*, and a hand-written list of maintainers would have quietly repaired the very thing #3296 is about: the per-op fan-out table is the hand-maintained part.

The resolution was to ask **production's own `invalidations_for_op`** which link maintainers the op needs and run only those. The expected value still comes from the independent Rust fold, so the dispatch table decides *what maintenance runs* — which is what it decides in production — and never what the answer should be. A forgotten enqueue runs zero maintainers and shows up as a state divergence.

The property worth keeping: the oracle never asserts on the enqueue at all, only on state. So "correctly needs no maintainer" and "forgot the enqueue" are distinguished structurally, with no per-op allowlist to maintain and drift.

**Three things the design does NOT cover, now written at the code rather than left implied.** Review found each claim in the module's own prose slightly stronger than the code delivers:

The settle calls `reindex_page_link_cache_for_block` directly rather than through `handle_background_task`, so the task→function *wiring* is bypassed — deleting the call in `task_handlers.rs` leaves the oracle green. That wiring is pinned elsewhere, but the rustdoc said "breaking it turns the oracle red" without qualification.

The harness runs `invalidations_for_op`'s raw output while production runs it through `enqueue_background_tasks`, which filters lifecycle rebuilds into a debounce. The harness therefore settles more eagerly than production — the safe direction, but "asks production's own table" is one level shallower than the function that actually runs.

And the `COALESCE(page_id, parent_id, id)` attribution chain **is** transcribed from the writers, which the rustdoc admitted in its body while its header claimed the rules came "NOT from either maintenance query". So the oracle catches implementation bugs but cannot catch a specification bug in the attribution rule itself — if that chain is the wrong idea, the fold is wrong the same way and the two agree.

**A test that was green because of the bug.** `list_page_links_optimized_matches_oracle` passed only because `create_block` enqueued no link reindex: the cache stayed entirely empty, which triggered the lazy self-heal, which fires *only* on a completely empty table. Fixing the bug made the cache non-empty, the heal correctly stopped firing, and the fixture broke.

Chasing that down produced the session's most consequential finding (#3839), which is about production rather than the test. That empty-table gate is the **only** backfill `page_link_cache` has — migration 0065 ships no backfill, `recovery/` never touches it, and `rebuild_all_caches` is test-only. So the first row ever written disarms it permanently. The #3296 fix widens the trigger from "first edit" to "first edit or create", and creates are far more common. Pre-existing and strictly better than before, but the gate's shape is wrong: "is the table empty" is a proxy for "has this vault been backfilled" that stops being valid exactly when it matters.

**The builder shipped a red suite.** An integration test pins the create fan-out at an exact task count, and the fix adds one; the builder ran targeted filters only and never `--workspace`. Caught by review, which owns the single full-suite run for the item — 5658 passed after the pin was corrected to 5 with the enumeration comment updated to name the new task and why.

Worth stating plainly because the reasoning is generalisable: a literal-equality pin over a task list is only as good as the list someone typed, and a task missing from **both** the code and the list reads as agreement rather than as a gap. The old pin's *name* said "falls back to full fan out" while its *body* froze a list that did not. That is why the replacement is relational — the no-hint arm must be a superset of every hinted arm — and why the oracle, which checks state rather than task lists, is the real backstop.

**Honest limits on the new coverage, measured rather than assumed.** An instrumented 64-case run showed 40 of 68 chains carry a link token, and every one of those materialised a row — better than the builder's own estimate. But `peak_page_link_rows` never exceeds 1, and that is structural: every chain block lives on one page and there is one link target, so exactly one cache key is reachable. B6 exercises `edge_count` and the three flags on a single row and never touches multi-page aggregation or the nested-page boundary; those come only from the hand-written unit test. Recorded at the assertion so nobody reads a green B6 as broad page-link coverage.
