# Testing dimension — analysis

**Summary.** The Agaric test suite is large and genuinely mature: 132 Rust `mod tests`,
~599 FE `.test.ts(x)` files, 91 e2e specs, proptests for the invariant-rich areas that
matter most (Loro merge **convergence** — two-device snapshot exchange; markdown
round-trip; pagination cursors; soft-delete; reverse-op DB harness; DAG). Discipline is
high: exact-count assertions, redacted snapshots, module-local helpers, documented
`#[ignore]` perf gates, no tautologies/empty-body tests found, fake-timer hygiene.
The findings below are the **specific** under-tested corners, not "add more tests".

**Counts:** HIGH 0 · MEDIUM 3 · LOW 3

---

### [MEDIUM] Recurrence date-math has zero property/fuzz coverage despite stated invariants
- **Location**: src-tauri/src/recurrence/parser.rs:22-160 (`shift_by_months`,
  `shift_date_once`, `days_in_month`); tests in src-tauri/src/recurrence/tests.rs
  (28 example tests, no proptest). Confirmed: `grep proptest|prop_assert|quickcheck`
  over `recurrence/**` → **no files**.
- **Evidence**: `parser.rs` is "pure date-math … deterministic given inputs" with explicit
  invariants in the doc comments: monotonic advance (every shift moves forward), sticky
  month-end clamp (`Jan-31 → Feb-28 → Mar-28 …`, parser.rs:74-90), day clamped to
  destination-month length (parser.rs:31-57), and a year guard rail
  `MIN_CALENDAR_YEAR..=MAX_CALENDAR_YEAR` returning `None` outside it (parser.rs:51).
  All of these are currently pinned only by hand-picked examples (e.g.
  `monthly_clamp_is_sticky_three_step_chain`).
- **Problem**: Convergence, round-trip, pagination cursors, soft-delete, markdown all got
  proptests; recurrence — equally invariant-rich and equally a "stated invariant only
  example-tested" case — did not. Date arithmetic with leap years, month-length clamping,
  div_euclid/rem_euclid month math (parser.rs:48-49), and i64 overflow guards
  (`checked_mul`/`checked_add`, parser.rs:44-47) is exactly where example tests miss edges.
- **Impact**: A regression in the clamp or the euclid month-wrap (e.g. an off-by-one at the
  Dec→Jan boundary, or a non-monotonic shift for a specific day/interval) would not be
  caught until a user's recurring task silently lands on a wrong/earlier date.
- **Fix**: Add `src-tauri/src/recurrence/proptest_*.rs` asserting, over arbitrary
  `(NaiveDate in [1900..2200], interval in {daily,weekly,monthly,+Nm,+Ny})`:
  (1) `shift_date_once(base, i) > base` whenever it returns `Some` (strict monotonicity);
  (2) result day ≤ `days_in_month(result.year, result.month)` (clamp invariant);
  (3) `+Nm`/`+Ny` never panic and return `None` exactly when the year leaves the guard
  rail; (4) sticky-clamp chain never re-expands a clamped day. 256 cases like the Loro
  proptest. Failing seeds auto-save under `proptest-regressions/`.
- **Confidence**: high — verified absence by grep and read the module/tests.
- **Effort**: M

### [MEDIUM] `formatRelativeTime` tests assert against a *second* live-clock read (flake window)
- **Location**: src/lib/__tests__/format-relative-time.test.ts:104-105 and 112-113;
  production reads its own clock at src/lib/format-relative-time.ts:18 (`const now = Date.now()`).
- **Evidence**: Test line 104 computes `const fiveMinAgoMs = Date.now() - 5*60_000` then
  asserts `toBe('sidebar.minutesAgo:5')`. Line 113 asserts
  `` toBe(`sidebar.daysAgo:${Math.floor((Date.now() - 0) / 86_400_000)}`) `` — expected
  computed from a `Date.now()` call **distinct** from the formatter's internal `Date.now()`
  (format-relative-time.ts:18, `diffMs = now - then`).
- **Problem**: This violates the FE AGENTS.md rule "no date-dependent assertions without
  computing expected values" in spirit: the expected value IS computed, but from a
  different clock sample than the code under test uses. Two `Date.now()` reads straddling a
  tick diverge. Line 104: crossing a minute boundary makes the formatter floor to 4 →
  `minutesAgo:4` ≠ `minutesAgo:5`. Line 113: crossing a UTC-midnight boundary changes the
  day count between the two reads.
- **Impact**: Rare CI flake (a few ms window per run) that is hard to reproduce and erodes
  trust in the suite; exactly the "wall-clock dependence" the prompt flags.
- **Fix**: Stub the clock once: `vi.useFakeTimers(); vi.setSystemTime(FIXED)` (or
  `vi.spyOn(Date,'now').mockReturnValue(FIXED)`) so both the test's expected math and the
  formatter read the same instant. Sibling tests in the same file already construct a fixed
  `now` (line 95) — apply that pattern to 104 and 113.
- **Confidence**: high — read both the test and the production clock read.
- **Effort**: S

### [MEDIUM] An `#[ignore]`d test documents a *real, unfixed* depth-boundary bug (I-Search-5)
- **Location**: src-tauri/src/tag_query/resolve/tests.rs:1485-1542
  (`materialized_matches_cte_oracle_at_depth_boundary_i_search_5`, `#[ignore]`).
- **Evidence**: The test body and its own doc comment state "**CURRENTLY FAILS** — this
  test surfaces a real M-59-class off-by-one bug. The materialised helper emits 102 entries
  (B000 + B001..=B101); the CTE oracle emits 101 entries (B000..=B100)." The materialised
  tag-inheritance path reaches one descendant deeper than the recursive-CTE oracle at the
  `depth < 100` boundary (root AGENTS.md invariant #9). Fix is identified as living in
  `tag_inheritance_macros.rs:235-251` and/or `resolve.rs:249-261`.
- **Problem**: Unlike the other documented ignores (perf gates; the I-Lifecycle-3 ignore at
  reverse/tests.rs:1540-1562 is a deliberate *design choice* — soft-delete tombstone — and
  correctly ignored), this one masks a genuine production divergence: the materialised
  resolve path and the CTE oracle disagree on which blocks a deep tag-inheritance query
  returns at the 100-deep boundary.
- **Impact**: A tag query on a ≥100-deep block chain can return a different result set
  depending on whether it goes through the materialised cache vs. the CTE fallback —
  i.e. a correctness inconsistency in `resolve_expr`, currently invisible because the only
  test that catches it is disabled.
- **Fix**: This is primarily a production fix (align the two seeds), but from the testing
  dimension: it should be tracked as an open bug, not a permanently-green ignore. Once the
  symmetric fix in both helpers lands, un-`#[ignore]`. Until then it is a known coverage
  hole at the depth boundary, not a passing guarantee.
- **Confidence**: high — read the full test and its rationale; cross-checked the sibling
  I-Lifecycle-3 ignore is genuinely a design choice and not flagged.
- **Effort**: M (fix is production; test re-enable is S)

### [LOW] Two e2e date-picker chip tests skipped — chip-click path is e2e-uncovered
- **Location**: e2e/toolbar-controls.spec.ts:373 and 382 (`test.skip('due date chip click
  opens the date picker')`, `test.skip('scheduled date chip click …')`).
- **Evidence**: Both skipped with the note "Skipped as a genuine harness/production gating,
  not a spec bug — follow-up #1170". The toolbar "Set due date" path is covered; the
  **chip-click** trigger (which does not blur) is not, on either e2e or — per the comment —
  any layer that exercises the portal trigger.
- **Problem**: A real user-facing interaction (clicking the due/scheduled chip to reopen the
  picker) has no automated coverage pending #1170. Skips are honest and tracked, but the
  gap is real.
- **Impact**: Regressions in chip→picker wiring would ship undetected until #1170 resolves.
- **Fix**: Either land the harness change in #1170 to un-skip, or add a component-level RTL
  test asserting the chip's `onClick` opens the date-picker popover (does not need the
  portal/blur dance e2e struggles with).
- **Confidence**: medium — verified the skips and their rationale; did not confirm whether a
  component test already covers the chip click elsewhere.
- **Effort**: S

### [LOW] Real-timer waits in async-scheduler tests (idle-callback drain)
- **Location**: src/lib/in-page-find/__tests__/matcher.test.ts:322
  (`await new Promise(r => setTimeout(r, 20))` to "give the scheduler enough idle ticks to
  drain" before asserting `completed === false`).
- **Evidence**: The walker schedules work via an idle/chunk scheduler; the test cancels then
  waits a real 20ms and asserts the cancellation held. This is a fixed real-timer sleep,
  which the FE AGENTS.md explicitly discourages ("No timing hacks. `waitFor`/`findBy*`, not
  `sleep`").
- **Problem**: Negative assertion (`completed` should stay false) after a fixed wall-clock
  wait is the less-dangerous direction, but under a loaded CI box the scheduler could be
  delayed such that the assertion is meaningless (it would pass even if cancel were broken,
  if no tick fired in 20ms) — a *weakened* assertion rather than a flaky one.
- **Impact**: Low — the test can silently stop testing what it claims under load; not a
  red-flake but a confidence erosion.
- **Fix**: Drive the scheduler with fake timers (`vi.useFakeTimers()` +
  `vi.advanceTimersByTime`) or, if it uses `requestIdleCallback`, stub that API so the drain
  is deterministic and the negative assertion is meaningful.
- **Confidence**: medium — read the test; did not fully trace the scheduler's timer source
  (could be rAF/idle, which fake timers handle differently).
- **Effort**: S

### [LOW] Pervasive bare `toHaveBeenCalled()` instead of `toHaveBeenCalledWith(...)`
- **Location**: ~1250 occurrences across `src/**/*.test.{ts,tsx}` (count via grep).
- **Evidence**: FE AGENTS.md quality standard #6: "`toHaveBeenCalledWith` with exact args,
  not `toHaveBeenCalled`." Many call sites only assert a mock fired, not the argument shape
  (command name / `null` vs `undefined`, per standard #5).
- **Problem**: A subset of these (specifically `invoke`/IPC mocks) assert *that* the backend
  was called but not *with what*, so an argument-shape regression (wrong command name,
  `null` vs `undefined`) passes. Not all 1250 are wrong — presence checks for refetch
  triggers are legitimate — so this is a sampling signal, not a blanket finding.
- **Impact**: Backend-contract drift can slip through at the FE/IPC boundary.
- **Fix**: Audit the `invoke`/command-mock assertions specifically (grep for
  `mockInvoke).toHaveBeenCalled()` and similar) and tighten to `toHaveBeenCalledWith`.
  Not a mass rewrite — target the IPC/contract surface.
- **Confidence**: low — count is real, but the proportion that is genuinely too-weak was not
  enumerated; many are legitimate presence checks.
- **Effort**: M (if pursued for the IPC surface only)

---

## Areas reviewed / not reviewed

**Reviewed:** AGENTS.md test conventions (all 3 + shared context); `.skip`/`.only`/`todo`
sweep (FE + e2e); `#[ignore]` sweep (Rust) with read-through of each non-perf case;
`setTimeout`/`Date.now`/`Math.random` in tests; proptest coverage cross-check for the
stated-invariant areas (Loro convergence ✓, markdown round-trip ✓, pagination ✓,
soft-delete ✓, reverse-op harness ✓, DAG ✓, **recurrence ✗**); tautology/empty-body sweep
(none found); `toHaveBeenCalled` bare-count signal; verified the two `#[ignore]` "documents
a bug" tests (one real bug masked, one genuine design choice). Confirmed sync network layer
has tests (`sync_net/tests.rs`, `sync_daemon/tests.rs`, `snapshot_transfer.rs`); the full
TLS+WS socket round-trip is a *documented* deferral (#602, per src-tauri/tests/AGENTS.md) —
not flagged as a new finding since it is explicitly tracked.

**Not deeply reviewed:** individual component-test over-mocking quality (sampled, not
exhaustive — would need per-file reads of the ~599 FE files); snapshot-vs-assertion
appropriateness across the insta snapshot corpus; bench correctness; axe/a11y test depth;
whether the `toHaveBeenCalled` bare uses on the IPC surface specifically are too weak
(estimated, not enumerated).
