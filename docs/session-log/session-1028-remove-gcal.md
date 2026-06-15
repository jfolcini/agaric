# Session 1028 — remove the Google Calendar integration entirely

User directive: "fully delete the goal [Google Calendar] integration, all that
feature, all the code for it, gone — it was not a good idea … also oauth and
anything purely used by gcal **and nothing else**." Scope confirmed: delete the
whole gcal push/sync feature including OAuth + OS-keychain storage; **keep the
general agenda subsystem** (gcal was only one consumer of it).

## Shipped — PR #1228 `chore/delete-gcal`

347-file change (+262 / −24788; 306 files deleted). Strictly gcal-only code.

**Backend.** Deleted `src/gcal_push/` (api, connector, digest, dirty_producer,
keyring_store, lease, migration, models, oauth, oauth_callback, mod + insta
snapshots), `commands/gcal.rs`, `materializer/dirty_sink.rs`, and the gcal hook
tests. De-threaded the `dirty_sink` param out of the materializer pipeline
(coordinator/consumer/handlers). Dropped `GcalErrorKind` + `AppError::Gcal`.
Removed the orphaned gcal-only deps `oauth2`, `keyring`, `secrecy`,
`tauri-plugin-oauth`, and `async-trait` (the last one only surfaced as unused
*after* the others went — `cargo machete` is the arbiter). Migration
`0091_drop_gcal_tables.sql` drops `gcal_agenda_event_map` / `gcal_settings` /
`gcal_space_config` (append-only; no agenda tables touched).

**Frontend.** Deleted `GoogleCalendarSettingsTab/`, `gcal/` (reauth banner) and
their tests. `SettingsView` 11→10 tabs; dropped 57 i18n keys, 6 tauri-mock
handlers, the `'gcal'` app-error kind; regenerated specta bindings.

**Docs.** `threat-model.md` lost trust boundary **B5 (GCal OAuth)** — the assets
bullet, the ASCII-diagram column, the boundary-list item, the B5 STRIDE table,
the B2 OAuth info-disclosure row, **Claim 6** (no keychain usage remains at all),
and every "three off-device boundaries" → "two". `integrations.md` lost its
Google Calendar section. `UX.md` / `security/README.md` / `FEATURE-MAP.md`
references removed; the dated, historical `security/review-2026-05-20.md` was
*annotated* as removed (not rewritten) and its three `src-tauri/…gcal…` inline
citations de-pathed so the `doc-vs-code-paths` guard passes.

## Notes / lessons

- **`.sqlx` warm-wipe almost shipped a repo-wide offline-build break.** A
  `cargo sqlx prepare` run during the build had pruned the offline cache from
  577 → 303 JSONs (it only re-emitted the queries it recompiled). Removing gcal
  legitimately drops only a handful of query files; a −274 diff is the warm-wipe
  signature. Fix: `git restore --source=origin/main src-tauri/.sqlx` — orphaned
  gcal query JSONs left behind are harmless (the offline check only fails on
  *missing* in-code queries, not extra ones). Always `git status src-tauri/.sqlx`
  after any prepare and reject a mass-delete.
- **The pre-commit trim hook re-introduced a `bindings.ts` mismatch.** The staged
  bindings had trailing whitespace on empty JSDoc lines; the trim hook stripped
  it (leaving the file `MM`). `origin/main`'s bindings have **zero** trailing-ws
  lines, so the post-trim form is the canonical generator output — re-stage it,
  don't fight the hook.
- **Doc-citation guard scope:** `doc-vs-code-paths` only resolves inline
  backtick-quoted `src-tauri/…`-prefixed paths in prose. The dozens of gcal paths
  in `docs/session-log/*` live in fenced code blocks and were never flagged —
  historical logs stay as written.
- **Push transport flaked once (EXIT 141 / SIGPIPE) after a fully-green pre-push
  gate** — the branch wasn't created. A plain retry re-ran the gate and pushed
  clean; not a `--no-verify` situation.

The four gcal feature issues (#1204, #142, #134, #126) were already closed in a
prior session; the PR references them without `Closes`.
