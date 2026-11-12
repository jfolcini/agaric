# Session 3883 — Android keeps the vault out of backups, and file saves stop claiming success

Issue #6538, its first two items. The third (About and the update hint) landed in #6569.

- **Backup opt-out.** The manifest set no backup attribute, so Android's default put the app data directory (`device-id`, `sync-endpoint.key`, `notes.db`) into Google backup and device-to-device transfer, and a restored phone came up as the old device with a rewound vault.
  - Where: `src-tauri/gen/android/` is gitignored except a few tracked override files, which every Android CI build (`ci.yml`, `release.yml`, `android-launch-smoke.yml`) stashes, regenerates around with `android init`, and restores. Past manifest changes (#5484, #6484) edited the tracked `AndroidManifest.xml` directly, so this does too. That is not the toolchain-owned part (AGP, Gradle, `buildSrc`) AGENTS.md forbids hand-editing.
  - What: `android:allowBackup="false"` (covers Android 11, the minSdk) and `android:dataExtractionRules="@xml/data_extraction_rules"` (12+, where `allowBackup` does not stop device transfer on every manufacturer's build). The rules file excludes every documented domain with `path="."` in both `<cloud-backup>` and `<device-transfer>`. A missing section would leave that mode fully on. Each domain is backed up as its own tree, so `root` alone is not enough. The issue asked for `fullBackupContent` and a second rules file. `allowBackup="false"` does the same job on Android 11 with no rule semantics to get wrong, and `fullBackupContent` is ignored on 12+ once `dataExtractionRules` is set.
  - **Trap:** `data_extraction_rules.xml` sits under the gitignored `src-tauri/gen/`, so it has to be committed with `git add -f`. If it is missing, the CI restore leaves no file behind and the build cannot resolve `@xml/data_extraction_rules`.
  - `scripts/patch-android-build.sh` now asserts both manifest attributes and both rule sections, and fails closed. Checked by running the block alone against copies of the files: it passes on the real ones and exits 1 with the restore command for a missing attribute, a missing file or a missing section.
- **False "Export complete" on Android.** Every file save is an anchor click on a `blob:` URL, and nothing in the Android WebView stack handles a download. On Android now (`isAndroid()`, UA-based):
  - Settings → Data keeps both export rows. The buttons are disabled and described by one line, `data.fileSaveUnavailableAndroid`: Agaric can't save files on Android yet, so sync to a computer and export there. The maintainer wants the phone treated as a full peer, so the entry points stay visible and say why they are disabled.
  - Bug report: the include-logs switch is disabled under the same line. Logs reach a report only as the saved ZIP, so the dialog offers copy and the GitHub form, and never names a ZIP that does not exist.
  - `downloadBlob` and `triggerDownload` show the same line as an info toast instead of clicking an anchor. That covers the attachment chip, the Markdown attachment's download, `attachment:` links and the diagram SVG.
  - The Android UI changes are disabled controls plus a notice. The real save path is #6546, which removes this notice.
- Docs: README § Install and `docs/BUILD.md` troubleshooting now say to sync to a computer before uninstalling, because uninstalling deletes `notes.db`. README and `docs/features/sync.md` say a new phone is set up by pairing. `import-export.md` and FEATURE-MAP note the Android behaviour.
- Checks that ran:
  - vitest red first, 4 failed against the unfixed code: `DataTab`, `BugReportDialog`, `attachment-utils` and `export-graph`.
  - Each gate was then mutated to `false` (the Android test reds) and to `true` (the desktop pair reds), and restored.
  - The affected and neighbouring suites pass: 529 plus 280 tests. `npm run typecheck` and prek on the changed files are green.
  - Playwright `e2e/import-export.spec.ts`: the new Pixel 7 spec and the desktop ZIP-export spec pass. The Pixel 7 spec reds with the gate forced off.
  - The manifest and rules file parse, and the attribute and domain names were checked against developer.android.com (Auto Backup, Android 12 backup changes).
- **What a real device must still confirm**, none of which ran here (no APK build, no device):
  - The APK builds: the manifest merges and lint accepts the rules file.
  - `aapt2 dump xmltree --file AndroidManifest.xml <apk>` shows both attributes.
  - A backup-enabled reinstall comes up with a fresh identity and an empty vault that pairs.
  - The export rows and the bug-report switch read as described at phone width.
- Not done: a CI step running `aapt dump` on the built APK. It could not be run here, and the patch script's assertion already covers the source.
