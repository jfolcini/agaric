# Session 3846 — the Android update hint names the releases page, and macOS declares the camera

- **Settings → About on Android said "Updates are managed by the Play Store on Android."** Agaric isn't on the Play Store: `docs/BUILD.md` § Distribution says there is no Play Store upload, and the APK ships only on the GitHub release. Beta testers (#6513) would have been told to wait for an update that never comes. The hint now says to install the newest APK from the releases page.
  - The same wrong claim appeared in six code comments (`HelpTab.tsx`, `useUpdateCheck.ts`, `App.tsx`, `lib.rs`, `Cargo.toml`, `release.yml`), and each now says Android updates by installing a newer APK. The mentions that say Agaric is distributed outside the Play Store stay as they are.
  - The Spanish catalog has no `help.*` keys, so Spanish shows the English hint as before.
- **`src-tauri/Info.plist` had no `NSCameraUsageDescription`.** Pairing offers **Scan QR code** first on every platform, and the scanner opens the camera through `getUserMedia`. macOS requires that key before an app may use the camera, and the file only had the microphone's (added with voice notes, #5484). Added: "Agaric uses the camera to scan the QR code that pairs another device."
- Tests:
  - `HelpTab.test.tsx` and the i18n tests pass (254); it asserts the mobile hint by key, so the new wording needs no test change.
  - The plist parses with both keys.
  - The camera prompt itself can only be seen on a Mac. That check is in #6514 ("Pairing and sync"), which asks testers to report what **Scan QR code** does.
