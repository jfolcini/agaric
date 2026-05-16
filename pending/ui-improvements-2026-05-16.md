# UI improvement ideas — 2026-05-16

> Captured during the `docs/UI-MAP.md` + `docs/UX.md` rewrite work. Independently actionable; each entry is a candidate for a future REVIEW-LATER ticket or a session task. Not yet scheduled.

## Wiring gaps

- **Properties tab in Settings is half-wired.** The `settings.tabProperties` i18n key exists but `SettingsView` never branches on `activeTab === 'properties'`. Either finish the tab branch + nav-item or drop the orphan key.
- **Properties view has no sidebar entry.** `nav-items.ts` doesn't list it; only reachable from internal nav state. If still supported, add a nav item; if not, fold into Settings or remove.

## UX consistency

- **Toast deduplication missing.** sonner doesn't dedupe by default and `notify()` doesn't either. Rapid identical errors (e.g. sync loops) stack visibly. Thread a dedup helper into `notify()` or use sonner's `id` field for known recurring error categories.
- **`MenuPopoverContent` adoption is partial.** Some popovers still use plain `PopoverContent` for menu surfaces. Grep + sweep would tighten consistency.
- **Toast action signature inconsistency.** Some call sites use raw sonner options; others wrap with `t()`-keyed text. Standardise on `notify.error(msg, { action: { label, onClick } })` and add a `notify.retry()` helper.

## Discoverability

- **`agaric://` deep-link scheme is undiscoverable.** Power users don't know it exists. A "Deep links" section in the `KeyboardShortcuts` panel listing `/block/<id>`, `/page/<id>`, `/settings/<tab>` surfaces a hidden feature.
- **Quick-capture hotkey is OS-global but unannounced.** Consider a one-time welcome-modal mention or settings tooltip.

## Mobile / responsive

- **Sidebar resize toggle appears clickable on mobile but is a no-op.** Either hide the toggle on mobile or match the affordance to behaviour.

## Maintenance / tooling

- **No CI lint catches doc-vs-code drift.** Many doc-audit findings would be auto-caught by a script that greps `src/...` paths in `docs/` against the filesystem and fails CI on miss. Low cost, high leverage.
- **JSDoc i18n drift.** Some component JSDoc comments reference English strings since moved into `t()` calls. Not user-facing, but agents reading JSDoc may infer wrong UI text. Low priority.

## Convention documentation

- **`max-sm:` vs `[@media(pointer:coarse)]` divergence is intentional but invisible.** Now documented in `docs/UX.md`. Consider linking from inline code comments where the convention is exercised so future maintainers don't try to "unify".

## Auto-update wire-up (desktop)

The plumbing is **wired** but the frontend never calls the API and the capability permission isn't granted, so the app silently never updates:

- `tauri-plugin-updater` is in `Cargo.toml` and registered on desktop (`lib.rs:566-575`, gated `#[cfg(not(mobile))]`).
- `tauri.conf.json` updater config points at `github.com/jfolcini/agaric/releases/latest/download/latest.json` and carries a real Minisign pubkey.
- `release.yml` exports `TAURI_SIGNING_PRIVATE_KEY` + `_PASSWORD` from GH secrets; bundles ship with valid signatures and a `latest.json` manifest.

What's missing:

1. **Capability permission.** Add `updater:default` (or specific `check` + `download_and_install`) to `src-tauri/capabilities/default.json`.
2. **Boot-time silent check.** In `App.tsx` boot, call `check()` from `@tauri-apps/plugin-updater` (npm install needed). Debounce to once per day in `localStorage`.
3. **Update-available toast.** When `check()` returns an update, show a sonner toast — `"Agaric <version> is available"` — with **Install & restart** + **Later** actions. The install path calls `update.downloadAndInstall()` then `relaunch()` from `@tauri-apps/plugin-process`.
4. **Settings → Help.** Add a *Check for updates now* button + *Last checked N ago* line for users who dismissed the toast.
5. **Mid-edit guard.** Before triggering install-and-relaunch, flush any pending drafts (`use the same path as before-close`) so an unsaved-edits race can't lose work.
6. **Cleanup `lib.rs:566-575` comment.** The "currently not wired up" note is half-stale — signing is done; the FE wire-up is the remaining gap.
7. **Drop the MAINT-16 TODO comment** in `lib.rs` once (6) is done.

Estimated cost: S (~2 h end-to-end for a clean implementation).

## Android publishing (Play Store)

Android updates **do not** go through the Tauri updater — desktop only. On Android, distribution is either sideloaded APK (already supported via `release.yml`'s Android job) or the Play Store. To publish on the Play Store:

**One-time setup:**

1. **Google Play Console account** — $25 one-time registration fee (per Google developer account).
2. **Decide on signing strategy.**
   - **Play App Signing (recommended).** Upload an AAB; Google manages the production signing key. You sign with an *upload key* (the keystore already used in CI). If you lose the upload key, Google can reset it. This is the safer default.
   - **Self-managed.** You keep the production signing key and re-upload yourself. Lose the key → you can never update the existing app ID; abandon and re-publish under a new app id.
3. **Build an AAB (Android App Bundle), not an APK.** Play Store requires AAB for new apps. Update `release.yml` Android job to emit `--target aab` (or use `cargo tauri android build --target aab`). The same keystore signs both APK and AAB.
4. **Privacy policy URL** — required. Host on any public URL. Cover: what data the app collects (Agaric: nothing, by default), how sync works (local WiFi peer-to-peer, no cloud), Google Calendar OAuth scope if enabled (read/write user's calendar).
5. **Data safety form** — declare what data the app collects / shares. Agaric's answer is "no data collected, no data shared" for the default install; if GCal is connected the app reads/writes the user's calendar (declare it).
6. **Content rating questionnaire** — Everyone, no special content.
7. **App content** — target audience, ads (none), in-app purchases (none).
8. **Target SDK requirement.** Google bumps the minimum target SDK each August / November. Today: `targetSdk 36` is current; the Gradle config already targets it. Re-check at each Play Store upload.

**Per-release flow:**

1. `gh workflow run release.yml -f version=<new>` (or push a tag).
2. CI produces `agaric-release.aab` signed with the upload key.
3. Upload the AAB via Play Console → *Production* (or *Internal testing* / *Closed testing* for staged rollouts).
4. Fill the release notes (Play limits ~500 chars). Pull from the GH Release notes.
5. Submit for review. Typical review time: hours to days.
6. Once published, in-app updates land via the Play Store automatically (no Tauri updater involvement).

**Optional: in-app update prompt** (Play Store flow, not Tauri). Use `Play Core` (com.google.android.play:app-update) to prompt the user when a Play Store update is available. Tauri doesn't bundle this; would require a custom Android plugin. Low priority — Play Store auto-update covers ~95% of users without prompting.

**What stays the same as desktop**: sideloaded APKs via the GitHub Release page still work for power users who don't want the Play Store. The two distribution paths can coexist (different signing keys are fine; only the Play Store cares about its own upload key).

**Tracking:** consider filing a single `pending/PEND-XX-play-store.md` if/when this work is scheduled; the work is more product than engineering and might warrant a full plan file rather than a one-line REVIEW-LATER entry.
