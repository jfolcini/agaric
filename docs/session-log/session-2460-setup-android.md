# Session 2460 — `just setup-android`

The maintainer asked for a just command that sets up the Android dev env, next
to `just setup`. `docs/BUILD.md` listed the manual steps; nothing ran them.

**The recipe,** `just setup-android` (`scripts/setup-android.sh`), idempotent,
with two opt-in flags:
- **Prerequisites first:** Java 17, an SDK at `ANDROID_HOME` (else
  `~/Android/Sdk`), `android` or `sdkmanager`, `rustup`. A missing SDK or
  command-line tools prints the instructions and the download URL; the script
  never fetches Google's zip.
- **SDK packages:** `android sdk install` (slash names), `sdkmanager` plus a
  non-interactive licence accept as the fallback. Presence is a directory test,
  so a re-run, and `--check`, never touch the network or the CLI. The
  android CLI's silent first-run download is announced, and the install has a
  timeout.
- **Rust targets, `spike_test` AVD** (`avdmanager`, only when absent), the
  three env lines printed rather than written to the shell profile.
- **`--check`** reports and changes nothing (exit 1 while anything is left).
  **`--init-project`** runs the stash, wipe, `cargo tauri android init`,
  restore sequence of the CI `android-build` job, then
  `scripts/patch-android-build.sh`.

**Versions are not repeated:** the platform, build-tools, NDK and Rust targets
are parsed from the `android-build` job in `ci.yml` (and the system image
follows the platform's API level). The script refuses to run if it cannot parse
them. `release.yml` repeats the same three pins independently; this does not
touch it.

**Checked** with `--check` on the real SDK (everything present, nothing to do)
and on an empty SDK (everything listed as missing), and the install, AVD and
`--init-project` paths against stub `android`, `avdmanager`, `rustup` and
`cargo` in a scratch repo, including a failing init restoring the tracked
overrides. The real SDK and AVD were not modified.

**Found on the way:** `NDK_HOME` in the maintainer's shell points at
`ndk/27.0.12077973`, which is not installed (only `27.2.12479018` is).
