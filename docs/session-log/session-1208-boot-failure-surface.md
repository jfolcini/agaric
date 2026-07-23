# Session 1208 — Boot-failure user surface, null-editor toolbar guards, scheduled-checks hardening

**Date:** 2026-07-23
**Closes:** #2972, #2919, #3056
**Related:** #3057 + #3058 (CI hardening, shipped as a sibling PR this session); follow-up issues
#3061, #3062 filed. Continuation of the batch whose release/updater half landed as session 1207.

A parallel batch across the boot path, the editor toolbar, and CI. Each item ships as its own PR;
this log covers the batch.

## #2972 + #2919 — Surface boot failures to the user and back up the vault before migrating

Both boot-fatal exit points in `src-tauri/src/lib.rs` used to `exit(1)` after only a `tracing::error!`,
so a user whose vault failed to open (corrupt DB, failed/rolled-back update, unreadable file) saw the
app silently vanish with no explanation.

- **Native fatal-error dialog (#2972).** New `show_fatal_error_dialog(title, body)` helper. Under
  `#[cfg(test)]` it is a pure no-op. Under `#[cfg(not(test))]` it early-returns when headless (`CI`
  or `AGARIC_HEADLESS` set, or Linux with both `DISPLAY` and `WAYLAND_DISPLAY` absent) — a blocking
  dialog in a headless CI run would hang the pipeline — otherwise it shows a blocking
  `rfd::MessageDialog` at Error level with an OK button, pointing the user at `logs/agaric.log`.
  Wired into both fatal exit points: the `.build(...).unwrap_or_else(...)` handler, and the setup
  closure.
- **No double-dialog (#2919).** The setup closure's boot orchestration is wrapped in a fallible IIFE
  (`let boot_result: Result<(), Box<dyn Error>> = (|| { ... })();`); on `Err` it logs, shows a
  DB-specific dialog (mentions downgrade / failed update / the pre-migration backup), then `exit(1)`
  **inside** the closure — so the same error never propagates to the `.build()` handler and can't pop
  a second dialog. The success path ordering is unchanged, only relocated inside the block.
- **Pre-migration vault backup (#2919).** New `backup_db_before_migration(db_path)` in
  `src-tauri/src/db/pool.rs`, called as the **first** statement in `init_pools` — before the write
  pool connects, so `create_if_missing` / WAL-header writes can't turn a fresh vault into a
  "non-empty existing" file. Copies `notes.db` → sibling `notes.db.pre-migration-<unix_ts>`. Silent
  skip (never an error) for the `:memory:` sentinel, a missing file (fresh vault), and a zero-byte
  shell; a copy failure logs `warn!` and boot proceeds (best-effort). Copies only the main `.db`
  before any connection, which yields an internally-consistent SQLite snapshot (last checkpoint), not
  a torn read.

`rfd 0.17` is pulled with `default-features = false, features = ["gtk3"]` (not the default
`xdg-portal`) so it reuses the exact `gtk-sys`/`glib-sys`/`gobject-sys` 0.18.x versions Tauri already
links on Linux — zero duplicate native deps, confirmed single-versioned in `Cargo.lock`.

Tests: two new `pool.rs` unit tests (`backup_db_before_migration_copies_existing_file`,
`backup_db_before_migration_skips_missing_and_in_memory`) exercise the copy and all three skip
guards. Full suite green (3317 pass / 6 skip), clippy + fmt clean.

Follow-up (#3062): the backup runs on **every** boot (not only when a migration is pending) and is
never pruned — unbounded disk growth + boot-path latency proportional to vault size. Gate on an
actually-pending migration and/or keep last-N.

## #3056 — Guard editor-toolbar `useEditorState` selectors against a null editor (PR #3060)

The `useEditorState` selectors in `FormattingToolbar`, `FormatMenu`, `SelectionBubbleMenu`, and
`TurnIntoMenu` dereferenced `ctx.editor` unconditionally. During the editor mount/teardown race
`ctx.editor` can be `null`, throwing `Cannot read properties of null (reading 'can'/'isActive')` — the
intermittent Playwright flake seen across recent CI runs. Each selector now short-circuits to inert
resting-state defaults (history disabled, marks inactive, `TurnIntoMenu` reads as "paragraph" active)
when `ctx.editor` is null; the populated branch is byte-identical to the prior logic. Two new tests
render each toolbar with a null editor and assert the guarded values. Full frontend suite green
(15524 tests).

Follow-up (#3061): `SelectionBubbleMenu.tsx:186` still dereferences `editor.view?.dom` outside the
guarded selector — same crash class, left out of scope.

## #3057 + #3058 — Scheduled deep-checks hardening (sibling CI PR)

`.github/workflows/scheduled-deep-checks.yml`:

- **#3057** — the `cargo mutants` baseline could time out to `total_mutants: 0` while `|| true` kept
  the job green (false-green, no mutation coverage at all). Raised `MUTANTS_TIMEOUT` 300→900 and added
  a `--build-timeout` (`MUTANTS_BUILD_TIMEOUT=600`), plus a **zero-coverage guard** step placed
  *outside* the `|| true` (`if: always()`) that fails the job when `outcomes.json` is missing,
  `total_mutants == 0`, or the `Baseline` scenario summary != `Success`. Surviving/missed mutants stay
  non-gating triage signal.
- **#3058** — new `prek-all-files` job (`prek run --all-files`, hard-fail) seeded with the
  `_validate.yml` lint-job recipe (Rust/Node/sqlx), covering the whole-tree pre-commit stage the
  existing jobs don't.
