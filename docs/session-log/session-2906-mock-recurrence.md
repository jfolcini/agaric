# Session 2906 — the tauri mock makes a repeating task's next occurrence

#6054 D3; the maintainer decided on 2026-10-22 to port recurrence. Marking a repeating task DONE in the mock wrote the state and nothing else, so every recurring-task flow could only be tested on the real backend.

**What was ported.**
- **Date math:** `src/lib/tauri-mock/recurrence.ts` holds it, each function named after its Rust twin:
  - the three modes, with the clocked `.+` and `++` taking `now` as an argument;
  - the month-end clamp;
  - the `++` catch-up loop, with its exact step budget;
  - the 1900–2200 calendar rail;
  - rule normalization.
- **One grammar:** `isValidRepeatRuleMock` now runs that parser, so the hand-copied grammar in `shared.ts` is gone.
- **`writeTodoState`:** it mirrors `set_todo_state_in_tx`. On the edge into DONE it computes the next occurrence first, so a `++` rule that cannot advance refuses with nothing written. Then it writes the state, the stamps and the occurrence:
  - **op order:** create, TODO, repeat, due, scheduled, until, count, seq, origin;
  - **placement:** appended under the original's parent;
  - **end conditions:** `repeat-until` checked against the shifted due-else-scheduled date, the count gate, and seq carried only with a count.
  - `set_todo_state` and `set_property(todo_state)` use it.
  - **Batch writers:** they keep skipping recurrence, as the backend's do.
  - **`apply_page_source`:** stays unwired, because the mock's save writes no task state.

**Trap.** Rust's `str::trim` strips Unicode `White_Space`, which includes U+0085 and not U+FEFF. JS `trim()` does the opposite, so the review found `"\u0085daily"` and a BOM-prefixed rule judged differently. Normalization now trims `\p{White_Space}`.

**Pinned by:**
- **Unit tests:** `recurrence.test.ts`, whose vectors are copied from the Rust unit tests, plus a `++` boundary vector derived from Rust's loop.
- **Fixtures:** two backend-authored ones, `recurrence_done_creates_sibling` and `recurrence_end_conditions`. The mock matched them on the first authoring run.
- **e2e:** a Playwright case in `toolbar-and-blocks.spec.ts`, where a weekly task marked DONE shows next week's occurrence after navigating away and back.

**Shown red:**
- dropping the DONE-edge check;
- the count gate's `>=`;
- reading the next occurrence after the write;
- the seq increment;
- the clamp;
- the `++` cap, at 9 999, 10 001 or 100 000;
- plain `trim()`;
- removing the occurrence, for the Playwright case.

**Not here:**
- `list_projected_agenda` stays waived. It needs `project_block_dates`, paging and the clock.
- The `repeat-until` equality boundary is not pinned on either side.

**Suites:** vitest over `src/lib`, `src/stores`, `src/hooks`, `src/editor` and `src/components`; typecheck, lint and knip; and nine agenda, task and page-mode Playwright specs.
