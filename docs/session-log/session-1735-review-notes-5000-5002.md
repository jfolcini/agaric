# Session 1735 — review notes from #5000, #5001 and #5002

Non-blocking notes batched out of three approved PRs, per AGENTS.md
§ How we work ("on an approved, green PR a non-blocking note never causes
a push by itself"). No behaviour changes.

- `src/lib/tauri-mock/handlers/blocks.ts`: the `move_blocks_to_space`
  comment claimed to mirror the backend's `space` projection. The backend
  fans the `blocks.space_id` column out over the whole page group
  (`WHERE id = ? OR page_id = ?`, `block_ops::validate_space_target_in_tx`);
  the mock stamps the page row only. Every mock reader of `space_id`
  (`pages.ts` ×2, `tags.ts`) reads it on a page or top-level tag row, so
  the descendant stamp has no reader — the comment says that now instead
  of overstating the fidelity. Same one-line note on the `set_property`
  handler it points at.
- `src-tauri/src/db/recovery.rs`: `project_engine_core_rows` took both
  `space_id_str: &str` and `space_id: &SpaceId` for the same value; the
  `&str` is gone and the one log site reads `space_id.as_str()`.
- `src-tauri/src/lib.rs`: the `MaintenanceDaemon` job list in
  `spawn_background_tasks` omitted `reminders_tick` (it was already
  missing before the #4639 split); the two `schedule_*_rebuild_if_empty`
  doc comments restated their own names and now carry only the
  post-migration reason; `reminders_tick_job` dropped
  `let reminders_app = app;`, a rename of an owned parameter.

## Verified

- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `cargo nextest run --workspace`: 6318 passed, 13 skipped.
- `npx oxfmt --check` / `npx oxlint` on the two mock files: clean (the
  pre-existing `set_property` complexity warning is unchanged — confirmed
  by re-running it against a stashed tree).
- `npx vitest run src/lib/tauri-mock`: 44 files, 883 passed.
