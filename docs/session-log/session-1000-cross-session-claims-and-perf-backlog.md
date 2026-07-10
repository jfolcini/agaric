## Session 1000 — Cross-session claim convention + perf backlog sweep (2026-07-10)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-10 |
| **Subagents** | 6 build + 5 review (+ 2 Explore scouts) |
| **Items closed** | #2298 (via PR #2529), #2201 (via PR #2530), #2178 (this PR) |
| **Items modified** | #2200 (3 items via PR #2547 + status corrections), #2508 (probes via PR #2548), #2504/#2178 (status comments) |
| **Tests added** | +9 (frontend) / +20 (backend, incl. 9 wire + 2 single-flight + 2 SLO probes) |
| **Files touched** | ~45 across 6 PRs |

**Summary:** Established the cross-session claim convention in the batch-issues skill
(PR #2520) and ran the perf backlog under it. Shipped the maintainer-decided 20K
count-then-cap for `list_page_links` with FE truncation affordance (#2298 → PR #2529),
the last #2201 quick win (restore-subtree materialize-once → PR #2530), the #2200
sync/misc trio (zstd wire compression with capability negotiation, spawn_blocking
snapshot codec, link-metadata single-flight → PR #2547), the #2508 cache-measurement
probes (PR #2548), a root-sandbox test guard (PR #2532), and — after the nightly lane
confirmed 84.14 ms / 181.33 ms — the #2178 problem-tier gate drops (this PR).

**Verification:**
- Every PR: adversarial review by a separate subagent; full `cargo nextest run`
  (5024-5025 passed) and/or full vitest (14,823 passed) per item; pre-push hook green
  end-to-end after PR #2532 (no `SKIP_CI_VERIFY` needed).
- #2178 promotion is data-backed: deep-checks dispatch 29122903173
  (`slo_include_problem=true`, main@66e4e1e) measured both former problem rows under
  the 200 ms budget.

**Process notes:**
- The claim convention worked live: #2504 was claimed by a sibling session mid-run
  (skipped here), and stale tracking-issue checklists (#2200/#2201) were corrected
  in-code-verified status comments — 7 of 8 "open" items were already on `main`.
- Two semantic conflicts with concurrently-merged work (#2503's new `LoroSync`
  producer; migration 100 dev.db drift) were caught by CI/hooks and fixed by rebase —
  rebase before push when `main` is moving this fast.
- Environment: 4-core / fixed-disk sandbox. Two parallel cargo target trees do not
  fit; `target/debug/incremental` (11G) is the first thing to reclaim, and
  `CARGO_INCREMENTAL=0` keeps hook pushes from regrowing it. zizmor needs
  `ZIZMOR_OFFLINE=true` here (proxy blocks its GitHub API calls); sqruff needed a
  manual `cargo binstall sqruff@0.38.0` (0.39 requires rustc 1.96).

**Lessons learned (for future sessions):**
- Verify tracking-issue checklists against `main` before claiming — comments go stale
  within hours when multiple sessions run.
- A cherry-pick that applies cleanly can still be a semantic conflict; re-run
  `cargo check --all-targets` after every rebase onto a moved `main`.

**Commit plan:** pushed — one PR per issue (#2520, #2529, #2530, #2532, #2547, #2548,
plus this gate-drop PR).
