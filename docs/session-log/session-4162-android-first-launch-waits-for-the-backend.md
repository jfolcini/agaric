# Session 4162 — Android: the first launch waits for a backend that is still starting

Set out to run the Android checklist of #6513 on a Pixel 8 (Android 17) over adb, on a debug build of main at `f57013f9` installed beside the release app. Two defects came out of it, #6774 and #6775.

## What shipped

- **The first launch waits for a backend that is still starting (#6775).** Tauri creates the window before the app's setup runs, and on Android the web view runs on another thread, so on a fresh install (every migration to run) `list_spaces` arrived before `app.manage(WritePool(…))` and `boot()` showed "Failed to start". `boot()` now retries while the refusal is Tauri's "state not managed", every 100 ms for up to 5 seconds.

## Decisions and traps

- #6774, a tapped link loading the website over the app: #6764 merged while this session ran and already moved `openUrl` to the opener plugin, so the fix written here was dropped. What the phone showed still stands for that code: on `f57013f9` the shell plugin's `open` never reached its Android side and the `window.open` fallback loaded the site in the app's only web view, where back could not leave it; a build calling `plugin:opener|open_url` brought Chrome to the front and back returned to Agaric. `openUrl` keeps the `window.open` fallback, which on Android would do the same again if the opener ever refused.
- The boot retry matches Tauri's message text. A readiness command would not depend on the wording, but it needs a new command, a binding and a mock handler for a window of a few tens of milliseconds.
- The boot draft flush and `getRecoveryStatus()` are refused in the same window and still only warn; the backend's own boot recovery had already run.
- `cargo tauri android build` rewrites `gen/android/app/build.gradle.kts` and drops a hand-added `applicationIdSuffix`. To install a debug build beside the release app, build once with the CLI, re-add the suffix, then run `./gradlew assembleUniversalDebug -x rustBuildUniversalDebug`.
- A link preview of `https://example.com` failed on the phone with "Connection reset by peer" while `https://github.com` loaded: the phone's VPN, not the client of #6768, which fetched and showed the preview.
- Not fixed: leaving the app with back at the root once ended in `FORTIFY: pthread_mutex_lock called on a destroyed mutex` after the exit snapshot was saved, and once did not. Nothing was lost either time. It is in Tauri's exit path (`finishAffinity`, then the process exits).
- Code-scanning alert 294 (`js/incomplete-sanitization` on `linkTitleText`) is a false positive: `escapeUrl` has doubled the backslashes before the quotes are escaped, and seven titles mixing backslashes, quotes and parens round-tripped through `serialize` and `parse`.

## Suites run

Before the rebase onto #6764: `npx vitest related src/lib/open-url.ts src/stores/boot.ts --run` (183 files, 5,261 passed) and `npm run typecheck`. After it: `src/stores/__tests__/boot.test.ts` and `npm run typecheck`. Each new test was shown red by one mutation of the code it covers. On the phone, with a debug build holding this fix: two launches on cleared app data each logged two refused `list_spaces` calls and reached the welcome dialog. No spec in `e2e-tauri/`: the defect needs Android's web view, which that lane does not run. Not run: the whole vitest suite, Playwright, the Rust suites (no Rust changed); CI's runs are the check.
