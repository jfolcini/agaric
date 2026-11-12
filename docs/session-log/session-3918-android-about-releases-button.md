# Session 3918 — Android About and the version-mismatch toast point at the releases page

Finishes #6538's last checkbox. #6569 had already replaced the false Play Store sentence; two things were still wrong or missing on Android.

- **About still said "Agaric checks for updates automatically when it starts. You can also check manually."** That is `help.updateDescription`, shown on every platform; on Android the update check returns early and the updater plugin is desktop-only. On Android the row's description is now `help.updateMobileHint` ("Agaric does not update itself on Android. Install the newest APK from Agaric's GitHub releases page."), and the separate paragraph is gone. The row's button is "Open releases page", which calls `openUrl(RELEASES_URL)`.
- **The `engine_format_mismatch` toast** now carries the same action on Android (`sync.openReleasesAction`); desktop is unchanged. It tells the user to update both devices, and the phone is the one that cannot update itself.
- **`openUrl`, not `tauri-plugin-opener`.** Every other external link in the app goes through `@/lib/open-url` (the single URL-scheme choke point, `plugin-shell` with a `window.open` fallback), and the JS package for the opener plugin is not a dependency. The URL is `RELEASES_URL` in `src/lib/config.ts`, beside `BUG_TRACKER`.
- **Spanish** has no `help.*` or `sync.*` keys (partial catalog by design), so the new keys fall back to English like their neighbours.
- **Not done:** removing the "Known issue" paragraph from the #6513 issue body. That is a GitHub edit the builder cannot make.

Checks: `HelpTab.test.tsx` and `useSyncEvents.test.ts` each went red on the old behaviour (About still showed "checks for updates automatically"; no toast action) and green after. Falsified by dropping the Android gate (desktop test red) and the action (Android test red).
