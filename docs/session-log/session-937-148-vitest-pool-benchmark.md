## Session 937 — #148 CI-R15 vitest pool A/B benchmark (forks vs threads) (2026-06-02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-02 |
| **Subagents** | orchestrator-only (test-infra/config benchmark) |
| **Items closed** | #148 (benchmark + documented decision; no config change) |
| **Items modified** | #148 |
| **Tests added** | — (test-infra measurement only; no new/changed code paths) |
| **Files touched** | 1 session log (no config change — see decision) |

**Summary:** Ran the CI-R15 vitest pool A/B benchmark — Vitest's default `forks` pool vs
`threads` — on the full frontend suite (478 files / 11 136 tests) and applied the issue's
explicit decision rule: **ADOPT `threads` only on a measured >30% speedup; document either
way.** The measured delta is well inside the noise band (paired per-round deltas swing
±20% and flip sign), nowhere near 30%, so **`forks` stays as the default — no
`vitest.config.ts` change.**

**Method:** Isolated worktree off `origin/main`. `npx vitest run --reporter=dot --pool=<p>`
(no coverage — coverage instrumentation is pool-independent and only adds noise). One
warm-up forks run discarded, then **3 rounds alternating forks→threads** so each pool sees
the same per-round load drift (A/B adjacency cancels machine-wide contention). The box was
under heavy, fluctuating shared load throughout (1-min loadavg swung 24→43→33→27 on a
16-core machine), so absolute wall-clock is unreliable; the paired adjacent comparison is
the only trustworthy signal.

**Raw results (wall-clock seconds; `load1` = 1-min loadavg at run start):**

| round | forks (s) | threads (s) | forks−threads | who won |
|-------|-----------|-------------|---------------|---------|
| 1 | 255.17 (load 24) | 319.35 (load 41) | −64.2 | forks ~20% faster |
| 2 | 226.60 (load 43) | 215.18 (load 32) | +11.4 | threads ~5% faster |
| 3 | 152.48 (load 34) | 162.45 (load 27) | −10.0 | forks ~6% faster |
| **median** | **226.60** | **215.18** | — | within ~5% (noise) |
| min | 152.48 | 162.45 | — | — |

**Finding:** No clear winner. The sign of the delta flips between rounds, the medians sit
within ~5% of each other, and the largest single-round gap (round 1, ~20% to forks) is
confounded by threads running that round under markedly higher load (41 vs 24). The 30%
ADOPT threshold is not approached in any round. The big absolute spread (152s–319s) is
pure machine-load noise — e.g. forks ran *faster* under load 43 (round 2) than under load
24 (round 1) — confirming wall-clock here is dominated by contention, not pool choice.

**Correctness note:** Both pools ran identical test counts (478 / 11 136). `threads`
passed all 3/3 runs; `forks` flaked 2/3 on a single load-sensitive test —
`SearchPanel.autocomplete.test.tsx:272` (`aria-activedescendant` not yet updated after an
`ArrowDown` within the `waitFor` window). This is the known CPU-contention async flake the
config already mitigates with 20 s test/hook timeouts (see `vitest.config.ts` comment); it
is **not** a pool-correctness difference. The issue's stated risk runs the *other* way
(`threads` can leak module state) — neither effect showed up here, so the decision rests
purely on the throughput rule, which says: no change.

**Decision (recorded on #148):** Keep `pool: 'forks'` (Vitest default). No measured
benefit ≥30%, results are environment-/load-dominated, and `forks`'s stronger test
isolation is the safer default for a suite that mocks Tauri IPC and resets Zustand global
stores per-test (module-state leakage under `threads` is a real, hard-to-debug risk for
exactly this style of suite). Re-run only if a future profiling pass shows vitest wall-clock
is a CI bottleneck on a quiescent machine.

**Files touched (this session):**
- `docs/session-log/session-937-148-vitest-pool-benchmark.md` — this log (the benchmark
  record; no source/config change by design).

**Scope:** test-infra/config only. No app source, no `src-tauri/src/db.rs`, no
`src-tauri/migrations/` (respecting concurrent-agent anti-collision for #286/#153).

**Commit plan:** single commit; PR opened against `main` (`Closes #148`), not merged.
