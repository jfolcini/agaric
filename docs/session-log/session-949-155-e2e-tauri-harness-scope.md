## Session 949 — CR-E2E-TAURI: Tauri-driven e2e harness — scoped, not shipped (#155) (2026-06-02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-02 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (#155 stays open) |
| **Items modified** | #155 (feasibility assessed + scoped implementation plan posted) |
| **Tests added** | — |
| **Files touched** | 1 (this session log) |
| **Outcome** | **SCOPED** — plan comment on #155; no code, no PR |

**Task:** tightly-scoped foundational slice of #155 — minimal real-Tauri-driven e2e
harness + one passing smoke test, OR (if real-Tauri harness needs substantial infra that
can't be verified GREEN in one iteration) a concrete scoped plan + clean stop.

**Verdict: scoped, not shipped.** A browser-level "drive the real Tauri binary" harness
needs multi-piece infra — `tauri-driver` + `webkit2gtk-driver` (system) + WebdriverIO
(new devDeps) + a built binary + a new CI job (xvfb + system webkit deps). None of that
can be stood up and verified GREEN in a single iteration, and a half-working WebDriver
harness would red every PR. Per the anti-rabbit-hole instruction, I posted a concrete
scoped plan and stopped cleanly.

**Findings (the gap is narrower than the issue's framing):**

- The **real FTS/regex/cursor pagination backend** is already covered at the command-inner
  boundary: `src-tauri/src/commands/tests/query_cmd_tests.rs` exercises
  `search_blocks_inner` → `fts::search_with_toggles` against a real SQLite pool
  (`test_pool()` + `TempDir`), including `has_more`. So the issue's "never runs the real
  Rust FTS/regex pipeline" concern is satisfied for the *backend* today.
- The genuinely **unreachable** surfaces on the current Playwright + `src/lib/tauri-mock.ts`
  harness are end-to-end / frontend-rendering ones:
  1. Full IPC marshalling of `search_blocks` (`src-tauri/src/commands/queries.rs:877`) — the
     JS mock returns the whole match set in one page and ignores cursor/limit.
  2. `<mark>` highlight rendering (`HighlightMatch`, `src/components`) fed by the real
     backend's row/snippet shape.
  3. Multi-page "Load More" against a real paginating backend (`has_more` → cursor → next
     page).
- Confirmed on this box: no `tauri-driver`, no `WebKitWebDriver`, no `@wdio/*` in
  `package.json`. So Approach A (WebDriver) is greenfield infra.

**Recommended approach (full detail in the #155 plan comment):** WebdriverIO + `tauri-driver`
(Tauri's official Linux/CI e2e path), as an **opt-in / nightly** job kept out of the default
CI gate until stable. Smoke test launches the real debug binary against a temp data-dir and
asserts the window title + a nav button; the search slice seeds >pageLimit matches, asserts
`<mark>` highlight + page-limited result count + working Load-More. Rejected
`tauri::test::mock_builder` (in-process Rust) because it exercises real command handlers but
**not** the real WebView, leaving the `<mark>`/Load-More frontend rendering — the issue's
actual target — untested. Effort: L; best as its own dedicated batch with the CI changes.

**Anti-collision:** stayed entirely out of `src-tauri/src/db.rs`, `src-tauri/migrations/`,
and all editor app source (concurrent #217 work). This session touched only this log file.

**Process notes:** Isolated worktree off `origin/main`
(`/home/javier/dev/agaric-wt-155`, branch `chore/e2e-tauri-harness-plan-155`),
`node_modules` symlinked before first edit (no `.env` in the main tree). Claim comment +
scoped plan comment posted on #155. No PR — scope-only outcome.
