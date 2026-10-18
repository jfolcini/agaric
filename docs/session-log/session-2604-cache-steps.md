# Session 2604 — the npm Tauri CLI in the bundle jobs, restore-only caches on PRs, no TRAP cache

Steps 4, 5 and 7 of #5853's cache map.

- **Step 4:** `ci.yml`'s `build` and `android-build` run `npm run tauri --`
  instead of compiling `tauri-cli` on every Rust-cache miss. Both jobs
  already run `npm ci`, and the npm CLI is the same 2.12.2 the cargo install
  pinned. `android init` writes the CLI that ran it into the Gradle build,
  so init and build must use the same one, and do. `patch-android-build.sh`
  regenerates the launcher icons through the npm CLI too: with no
  `cargo-tauri` installed, its `cargo tauri icon` would have failed into a
  warning and shipped the generic icon. `release.yml` still compiles the CLI,
  because it signs (#3542).
- **Step 5:** `apt-tauri-Linux-v1` saves only on `main` (the toolchain
  composite and `cargo-tests`), as #5861 did for the e2e key.
- **Step 7:** CodeQL's `trap-caching: false` (the input exists at the pinned
  v4.38.3, and `config-utils.ts` honours it). The Playwright browser and
  apt caches key on the installed `@playwright/test` version, not the
  lockfile, and save only on `main`.

Ran: prek on every changed file (actionlint, zizmor, typos, markdownlint);
`npm run tauri -- build/android build/icon --help` for the flags. The PR
runs `build` and `android-build`, which is the real test of step 4.
