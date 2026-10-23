# Session 2892 — one page-mode save timed on the real backend at the cap

#5691's MVP budget at the cap includes "one save's IPC cost", which had been measured on the mock only. A mock IPC is a deferred task, not SQLite and Loro. `e2e-tauri/page-mode-save-cost.e2e.ts` is an opt-in real-backend harness: it skips unless `AGARIC_PERF` is set.

**What it does:**
- It seeds a 1000-block page through one `create_blocks_batch` and opens it in page mode with the cap intact.
- It times each kind of save from the app's own `page-mode-save` measure, which ships in production builds: typing, a blur with nothing to save, Enter then a key, and Tab.
- It times the same edits' single IPC round trip in block mode on other blocks of the page.
- Writes are counted as the growth of `total_ops`.
- Each edit starts only once the materializer is idle: its queues are empty and its dispatch counters have stopped moving, since a drained batch still runs while the queue reads empty. The 1000-block batch's overflow comes back through the retry queue.

**Measured** (debug build, WebKitGTK under Xvfb, 5 repeats, median [min–max] in ms):

| edit | page mode save | block mode IPC | writes, each mode |
|---|---|---|---|
| typing | 14 [13–26] | 9 [8–10] | 1 |
| blur, nothing to save | 3 [2–9] | no IPC | 0 |
| Enter, then a key | 41 [32–47] | 23 [20–31] | 1 |
| Tab | 44 [39–156] | 35 [31–44] | 1 |

Page mode's save costs 5 to 18 ms more than block mode's round trip for the same edit, and writes the same one op. Load average during the run: 0.24 / 0.91 / 1.72. Enter runs two saves: an empty flush of the block being left, then the create.

**Run with:**

```
AGARIC_PERF=1 just e2e-real e2e-tauri/page-mode-save-cost.e2e.ts
```

`AGARIC_PERF_REPEATS` sets the repeat count. Without `AGARIC_PERF` the spec reports three skipped tests.

**Checks:**
- `npm run typecheck:e2e-tauri`;
- `npx vitest run e2e-tauri` (46 passed);
- `node --test scripts/e2e-related.test.mjs`;
- the measured run and the skip run.
