# Session 4238 — pin every external input by digest

An audit found that we digest-pinned the lockfiles, the action refs and a handful of downloads, but not the tooling around them. The maintainer asked for everything to be pinned by digest. AGENTS.md now has a "Supply-chain pinning" section with the rule:

- **Digest:** lockfiles, Actions by commit SHA, a sha256 beside every direct download, and Gradle dependency verification.
- **Exact version:** where the installer takes no hash (`setup-node`, `setup-java`, rustup, sdkmanager, `cargo install`, binstall, `uv tool`).
- **Accepted floating exceptions:** runner images, and apt and brew packages.

## What changed

- **Release and CI:**
  - The AppImage tools tauri-bundler downloads (AppRun, linuxdeploy, linuxdeploy-plugin-appimage) are seeded sha256-checked into `~/.cache/tauri`. The plugin comes from its tagged release `1-alpha-20250213-1` instead of the rolling `continuous`, which no hash can pin. The seeding action fails if a Tauri CLI pins a different linuxdeploy.
  - minisign, syft and sqruff come from upstream releases checked against a recorded sha256, instead of apt, `install.sh` and binstall respectively. `check-tool-pins.mjs` reads sqruff's version from its new action.
  - Exact versions:
    - Node, from `.nvmrc`
    - JDK
    - the review runner (`ubuntu-24.04`)
    - the emulator build
    - a dated fuzz nightly
    - sqlx-cli, tauri-driver and cargo-fuzz
    - cargo-deny, cargo-machete, cargo-audit and cargo-nextest
- **Dev setup:**
  - `setup-hooks.sh` installs every tool at an exact version, the same one CI uses.
  - lychee, nextest and the taplo fallback are sha256-checked.
  - `setup.sh` checks `nvm.sh` before sourcing it.
  - `cargo_get` (install latest) and its empty MSRV table are deleted.
- **Android:** a tracked `gradle/verification-metadata.xml` covers the x86_64 debug, x86_64 release and aarch64 release builds, APK and AAB. It includes the aapt2 jars for macOS and Windows. `scripts/update-gradle-verification.sh` regenerates it, and `patch-android-build.sh` fails if it is missing.
- **Docs that overclaimed:** the lychee step's "only unverified-binary gap", `SECURITY.md`'s "`--locked` everywhere" and `rust-toolchain.toml`'s "AGP pinned".

## What ran

- The seeding, syft, sqruff, lychee, nextest and taplo download paths, run locally against throwaway homes. Each one also failed closed on a wrong sha256. I could not run the downloaded binaries in this sandbox, so `file` confirmed only their type.
- `bash scripts/setup-hooks.sh`: every tool landed at its pinned version, and older-pinned tools replaced the newer local ones.
- Android, with Temurin 17.0.21+9 and SDK 36 / NDK 27.2.12479018 installed:
  - `--write-verification-metadata sha256` over the six variant tasks, with the Rust libraries skipped.
  - A clean rebuild in strict mode: green.
  - With one tampered hash: `Dependency verification failed`.
  - `update-gradle-verification.sh` restored the removed macOS and Windows aapt2 entries with the same hashes.
- `node scripts/check-tool-pins.mjs`: catches a mismatched sqruff version.
- `prek run` over every changed file: green, including zizmor and actionlint.

## Not run here

These need a real CI run:

- The release lanes: AppImage seeding on a tag build, minisign, syft on macOS and Windows.
- The weekly fuzz and e2e-tauri lanes.
- The emulator launch smoke.
