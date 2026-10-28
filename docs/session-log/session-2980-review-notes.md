# Session 2980 — review notes from #6137 and #6139

Non-blocking notes the reviewer left on two PRs merged in this sweep, batched into one follow-up.

**#6137:** `builtin_options_json_is_a_selects_options_as_a_json_array` asserted both `priority`'s and `todo_state`'s options. Any mutant of `options_json` that leaves one select's options intact leaves the other's intact too, so the `todo_state` assertion is dropped and `priority` stands for selects.

**#6139:** `dismissToasts` pressed every toast's close button once and then waited for the toasts to leave. Sonner draws no close button on a loading toast, so one still loading at that moment settled into a toast nobody closed, and the wait sat through its expiry. The presses now repeat on every poll of the wait, and they skip toasts already leaving.

**Suites:**
- the op.rs tests in `agaric-store`, and the four op.rs mutants still caught;
- `agenda-projected-repeat.e2e.ts` on the real lane;
- `npm run typecheck:e2e-tauri`, oxlint and oxfmt;
- `cargo clippy --workspace --all-targets -- -D warnings`.
