## Session 975 — list_pages_with_metadata: perf gate for Default/Alphabetical sorts (#424, bench-first) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Subagents** | 0 (orchestrator direct) |
| **Items closed** | `#424` (measured within budget; schema promotion deferred behind the new gate) |
| **Items modified** | — |
| **Tests added** | +1 perf gate (`default_and_alphabetical_sort_perf_gate_20k_pages`, `#[ignore]`'d) |
| **Files touched** | 2 |

**Summary:** Second of the `backend-audit` SQL set, **bench-gated**. #424's
finding is real and not in dispute: the space-filter IN-subquery forces the
planner to drive off the membership set, so *every* sort mode — including
`Default` (`ORDER BY b.id`) and `Alphabetical` — gets `USE TEMP B-TREE FOR
ORDER BY`, the LIMIT can't short-circuit, and the 4 `has_*` EXISTS + the
`MAX(op_log.created_at)` correlated subquery run across the whole filtered set
before the first page. The existing perf gates covered MostLinked /
RecentlyModified / a filtered query, but **never the Default / Alphabetical
modes** the issue calls out.

The issue's remedy — a materialised per-page `space` column or folding `has_*`
into `pages_cache` — is a **schema promotion gated by AGENTS.md "Architectural
Stability"** ("promote with explicit user approval when the JOIN cost is
measurable"). Per the bench-first rule, the gating question is whether the
measured cost actually exceeds budget.

- **Added** `default_and_alphabetical_sort_perf_gate_20k_pages`: seeds the same
  realistic 20k fixture as the sibling gates (link skew + 8 op_log rows/page +
  tags on ~1/10 pages) so the per-row subqueries do genuine index probes, then
  times both modes' first page.
- **Measured (2026-06-05, 20k pages):** `Default` median **38 ms**,
  `Alphabetical` median **67 ms** — comfortably within budget (under even the
  materialised MostLinked 100 ms gate). The O(N) per-row cost has a tiny
  constant (index probes, not scans), matching #433's ~5 µs/row analysis.
- **Decision:** the schema promotion is **not justified at this scale** and
  stays **deferred behind this gate**, which will fire as an early warning if a
  future change regresses past 250 ms. No production SQL changed.

**Files touched (this session):**
- `src-tauri/src/commands/tests/list_pages_with_metadata_tests.rs` — new
  `#[ignore]`'d perf gate covering Default + Alphabetical; records observed
  medians.
- `src-tauri/src/commands/pages.rs` — doc note on `PAGES_METADATA_BASE_SELECT`
  recording the #424 measurement and the deferred (gated) remedy.

**Verification:**
- `cargo nextest run --run-ignored only default_and_alphabetical_sort_perf_gate_20k_pages`
  → 1 passed; medians above (captured via `rtk proxy`).
- Doc/test-only change → no `.sqlx` regen.

**Commit plan:** single commit; pushed; PR against `main`.
