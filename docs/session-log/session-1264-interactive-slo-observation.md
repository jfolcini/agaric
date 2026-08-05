## Session 1264 — Interactive SLO result observation (2026-08-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-05 |
| **Subagents** | 1 build + 2 review |
| **Items closed** | #3304 |
| **Items modified** | — |
| **Tests added** | +17 bench fixture/effect assertions |
| **Files touched** | 7 |

**Summary:** Made every default-enforced read probe validate its intended fixture result
outside the timed loop, and made the mutating create probe validate exact durable growth
after timing. Corrected the SLO documentation to distinguish the product's per-call p95
target from the accumulated-mean metric the scheduled gate actually enforces.

**Files touched (this session):**
- `.github/workflows/scheduled-deep-checks.yml`
- `docs/BUILD.md`
- `docs/architecture/operations.md`
- `src-tauri/benches/AGENTS.md`
- `src-tauri/benches/groups/export_bench.rs`
- `src-tauri/benches/interactive_slo.rs`
- `docs/session-log/session-1264-interactive-slo-observation.md` (new)

**Verification:**
- `cargo check --bench interactive_slo` — passed.
- Release-profile `interactive_slo` build and unfiltered warm gate — passed with every
  default probe observing the intended fixture and remaining within its inline mean budget.
- Actionlint, Markdown lint, documentation link targets, Rust formatting, and
  `git diff --check` — passed.
- Independent technical and adversarial reviews — approved; both reviewers agreed with
  the corrected fixture and the evidence-backed export budget rebaseline.
- Canonical `just verify` — passed end-to-end: 219 Vitest files / 6,491 tests;
  5,487 Nextest tests passed / 6 skipped; 7 doctests passed / 4 ignored; all four
  SQLx cache lanes; MCP UDS smoke and release externalBin checks; Cargo audit and
  npm signature audit.
- pre-commit hook — pending commit.
- pre-push hook — covered by the canonical verifier before transfer-only push.

**Process notes:** The new export assertion immediately exposed that both benchmark seeders
set only `parent_id`, while export discovers descendants through the denormalized `page_id`.
After fixing both fixtures, two warm measurements of the real 2,000-child path took 13.40 ms
and 19.45 ms, proving that the old 10 ms budget had been baselined against a heading-only
export. The corrected budget is 30 ms: comparable headroom to the existing command budgets
and still 6.7 times tighter than the 200 ms product target. No production path changed.

**Lessons learned (for future sessions):** A latency threshold is meaningful only when the
fixture proves that the timed command traverses the intended data. Keep shape assertions
outside timed loops, keep mutating preflights out of the fixture, and rebaseline from the
first truthful measurements when a formerly empty fixture invalidates its historical budget.

**Commit plan:** single commit, then push and open a stacked PR.
