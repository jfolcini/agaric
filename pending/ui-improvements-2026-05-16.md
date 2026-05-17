# UI improvement ideas — 2026-05-16

> Captured during the `docs/UI-MAP.md` + `docs/UX.md` rewrite work. Independently actionable; each entry is a candidate for a future REVIEW-LATER ticket or a session task. Not yet scheduled.

## UX consistency

- **Toast deduplication missing.** sonner doesn't dedupe by default and `notify()` doesn't either. Rapid identical errors (e.g. sync loops) stack visibly. Thread a dedup helper into `notify()` or use sonner's `id` field for known recurring error categories.

## Mobile / responsive

- **Sidebar resize toggle appears clickable on mobile but is a no-op.** Either hide the toggle on mobile or match the affordance to behaviour.

## Convention documentation

- **`max-sm:` vs `[@media(pointer:coarse)]` divergence is intentional but invisible.** Now documented in `docs/UX.md`. Consider linking from inline code comments where the convention is exercised so future maintainers don't try to "unify".

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
