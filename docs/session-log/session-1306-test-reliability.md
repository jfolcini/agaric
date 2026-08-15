# Session 1306 — test reliability: a cross-test timer leak and a structural fixture cost (2026-08-14/15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-14/15 |
| **Subagents** | 2 build + 2 review |
| **Items closed** | `#3810` |
| **Items modified** | `#3885` (partially — see below) |
| **Tests added** | +0 (frontend) / +0 (backend) |
| **Files touched** | 3 |

**Summary:** Diagnosed and fixed the pairing close-guard flake — a leaked 15-second timer
from one test firing its queued mutation into whatever test happened to be running at that
moment. Separately, exported `MAX_TRASH_BATCH_IDS` so the trash chunking fixture derives
from the constant instead of a magic `1001`, while establishing that this does **not**
reduce the fixture's cost, contrary to the issue's premise.

**Files touched (this session):**
- `src/components/dialogs/__tests__/PairingDialog.test.tsx`
- `src/lib/tauri/blocks.ts`
- `src/components/__tests__/TrashView.test.tsx`

**Verification:**
- `npx vitest run` (full frontend suite) — 754/754 test files, 16683 passed + 1 expected
  fail, 0 unexpected failures, under real concurrent load from sibling agents.
- `npx vitest run src/components/dialogs` — 314/314.
- 8 concurrent copies of `PairingDialog.test.tsx`, twice: 16/16 processes green at ~13s
  each under genuine CPU contention.
- `npx tsc -b` — clean.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**Process notes:**

- **#3810's failing assertion was in a different test from the one that caused it.** The
  test `shows loading state while the host is initializing` hangs every `invoke` with
  `new Promise(() => {})` and never resolves, unmounts, or drains before returning. Because
  `initHost` arms `backendArmedRef` *before* dispatching `start_pairing`, RTL's global
  `afterEach(cleanup())` unmounts a still-armed dialog and fires the cleanup's
  `pairingMutations.cancel()`. That queues behind the never-settling `start_pairing` on a
  module-level FIFO chain, bounded only by a real 15s `setTimeout` — a macrotask no
  microtask drain can flush. Solo, the file finishes in ~7-9s and the process exits before
  the timer fires, so nothing is visible. Under load it stretches to ~14s, the timer fires
  mid-suite, and a phantom `invoke('cancel_pairing')` lands in whichever test is executing
  then, inflating its count by exactly one. **That is why the count varied** — the
  originally reported 1-vs-2 and the 2-vs-3 observed tonight are the same mechanism landing
  on different victims. Fixed by draining and unmounting, matching what the file's two other
  hang-forever tests already do with fake timers.

- **The blast radius was checked rather than assumed.** A module-level queue leaking across
  test *files* would have been a much larger problem than one test. It cannot: vitest runs
  with `pool: 'forks'` and `isolate: true`, so each file gets a fresh module registry —
  confirmed empirically by observing 8 distinct fork processes. The leak can only travel
  forward into a later test in the same file. No wider issue filed, because there is no
  wider class.

- **The sweep for other offenders was done as a fraction, not an impression — and the
  fraction was wrong the first time.** Of 11 `new Promise(...)` occurrences in
  `PairingDialog.test.tsx`, exactly 3 are truly never-resolving; the other 8 call a captured
  resolver before the test ends. Two of the 3 were already bounded with
  `vi.useFakeTimers()` + advance + drain. The third — `shows loading state while the host is
  initializing` — was "fixed" in this session's first pass with a single `pendingInvokes.forEach(...)`
  drain before `unmount()`. That drain was itself one-shot: `unmount()`'s queued
  `cancel_pairing` doesn't land on `pendingInvokes` until the mutation queue advances a
  microtask *after* the forEach had already run and returned, so it armed a **fourth**
  never-resolving promise — the identical leak shape, created by the fix meant to remove it
  (caught in review of #3895, before merge). The real population was 3 pre-existing plus 1
  self-inflicted, not 3. Fixed by draining in a loop until a full microtask flush adds
  nothing new, and closed per the falsification standard rather than by argument: the test
  now asserts `pendingInvokes` is empty at the end, so a fifth hop would fail the test that
  introduced it instead of surviving invisibly. All 4 are now bounded.

- **The ruling was test-bug, and it was argued rather than assumed.** A user really can
  close a dialog mid-`start_pairing`, so the production path deserved scrutiny. It is
  already covered deliberately by the #3628/#3715 blocks, and strict FIFO ordering means a
  late phantom `cancel_pairing` from an abandoned session cannot land after — and so cannot
  cancel — a subsequent legitimate `start_pairing`. The one residual (a straggling reply
  from a call that already blew its 15s bound) is documented in `promise-timeout.ts` as a
  known accepted tradeoff, not something this test newly exposed.

- **#3885's premise was wrong, and the builder disproved it instead of implementing it.**
  The issue — filed earlier the same session — recommended exporting `MAX_TRASH_BATCH_IDS`
  so tests could `vi.mock` it down and shrink the 1001-block fixture. The mock half does not
  work: `purgeAllDeletedInSpace`'s loop closes over the module's own top-level `const`, so a
  factory spreading `{...actual, MAX_TRASH_BATCH_IDS: 2}` only changes what *importers* see
  on the exported binding, never what the already-compiled function body reads. Verified by
  probe (imported constant read `2`; feeding 3 ids still produced a single chunk) and
  independently re-derived in review as plain ES-module binding semantics rather than a
  Vitest quirk.

  So the export buys a self-describing fixture (`MAX_TRASH_BATCH_IDS + 1`, automatically
  correct if the cap changes) and nothing else. The fixture is still 1001 rendered items and
  the flake is untouched. **Dependency injection is the only option that actually shrinks
  N**, and #3885 stays open for it — the issue body has been corrected so it does not read
  as solved.

- **Making a test cheaper is exactly when to check it still fails.** The derived-fixture
  change was falsified by stepping the production chunk loop by `MAX_TRASH_BATCH_IDS + 1` —
  collapsing two chunks into one — and confirming RED. A cheaper test that no longer
  distinguishes correct from broken is a regression wearing an optimisation's clothes.

- **Wall-clock measurement was reported as inconclusive rather than flattering.** Timings
  were taken while sibling agents drove load average to ~26; the 19-24s spikes tracked system
  load, not the diff. "Too noisy to attribute" is the honest reading, and it is consistent
  with the mechanism proof showing the diff cannot affect the chunking loop at all.

- **Incidental finding:** `restoreAllDeletedInSpace` has no component-level chunked-path
  coverage — every Restore-All test uses a 2-6 item fixture. Its chunking is pinned only at
  the unit level in `src/lib/__tests__/tauri.test.ts`, where a 1500-item fixture runs in 9ms
  because no React render is involved. That contrast is itself the evidence that the DOM
  render, not the array, is where the cost lives. Recorded on #3885.
