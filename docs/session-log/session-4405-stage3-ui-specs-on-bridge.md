# Session 4405: stage 3, UI-only specs on the bridge (paused, work in progress)

Paused by the maintainer partway through; this branch has no PR.

**Measured on main 3f6aad8, local, `real-backend` project at 3 workers:**
- All 1,080 unlisted tests, once: 997 passed, 71 failed, 12 skipped; 174 files passed whole.
- The 179 candidate files (those 174, plus enter-merge-latency, settings-help and phone-view-headers with their mock-hook tests tagged, plus block-editing-text and phone-block-lists) with `--repeat-each=2`: 1,766 passed, 8 failed.

**Listed:** 171 files join `REAL_BACKEND_SPECS` (195 to 366).

**Flaky on the bridge, kept off the list until the cause is found:** block-dnd-mouse, block-syntax-reveal, diagram-reduced-motion, phone-block-lists, toolbar-and-blocks, block-editing-text, background-tabs, editor-keyboard-6537. The last two failed only in the #6529 stage-3 measurement on a531ce9.

**CI baseline (#7007, run 44468192717), e2e job wall time:** mock shards 6.3, 6.4 and 6.7 min; `bridge-build` 3.4 min; bridge shards 9.2, 8.2 and 11.0 min; about 51 job-minutes.

**Not done:**
- Read the 171 files for `page.clock` used around backend-owned timing (undo grouping, backend-stamped dates).
- One whole-lane bridge run, for `e2e/bridge-durations.json` (`AGARIC_E2E_BRIDGE=… node scripts/playwright-shard.mjs --update <report>`).
- Resize the shards in `_validate.yml`: the mock lane to about 1, the bridge lane to about 6.
- Measure the job-minutes after the change.
