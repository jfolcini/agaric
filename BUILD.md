# Building Agaric

Comprehensive guide for building, testing, and packaging Agaric on all supported platforms.

## Quick Reference

```bash
# Dev mode (any platform)
cargo tauri dev

# Production build (run on each target platform)
cargo tauri build

# Android debug APK (Linux host with Android SDK)
cargo tauri android build --target aarch64 --debug

# Android release APK (aarch64 = Pixel 8 / modern ARM devices)
cargo tauri android build --target aarch64
```

## `agaric-mcp` sidecar binary (FEAT-4f)

Agaric ships an `agaric-mcp` stub binary alongside the main app for MCP (Model Context Protocol) clients. Tauri's build system validates the sidecar's path on every `cargo` invocation, which is a chicken-and-egg problem: the binary can't be built if its path isn't validated, and its path can't be validated if the binary doesn't exist.

**Solution:** `scripts/prepare-external-bins.mjs` creates an empty placeholder at `src-tauri/binaries/agaric-mcp-<triple>` so `cargo` commands can proceed, then optionally builds the real binary and overwrites the placeholder.

For local development, `tauri.conf.json`'s `beforeDevCommand` automatically runs the placeholder step; no manual action is needed for `cargo tauri dev`. The `beforeBuildCommand` for `cargo tauri build` runs the full script (placeholder + `cargo build --bin agaric-mcp --release`) so the real binary lands in the installer.

If you run bare `cargo` commands (e.g., `cargo clippy`, `cargo nextest run`) without going through `cargo tauri`, create the placeholder manually once:

```bash
node scripts/prepare-external-bins.mjs --placeholder-only
```

The placeholder is gitignored (`src-tauri/binaries/`) so it doesn't pollute commits.

Android builds exclude the sidecar via `tauri.android.conf.json`'s `externalBin: []` override; mobile MCP lands in FEAT-4i (deferred).

## Prerequisites

### All Platforms

- **Node.js 22+** and npm
- **Rust** (stable toolchain) via [rustup](https://rustup.rs)
- **Tauri CLI**: `cargo install tauri-cli --locked`
- **sqruff** (SQL linter used by the `sqruff` pre-commit hook against `src-tauri/migrations/*.sql`): `cargo install sqruff`. Without it, `prek run --all-files` fails with `sqruff: command not found` on any commit that stages SQL or runs the full hook set.

```bash
# Install npm dependencies
npm ci

# Verify Rust is available
rustc --version
cargo --version
```

After cloning, copy the sqlx offline cache env file so `cargo sqlx prepare`
and `cargo tauri dev` can resolve `DATABASE_URL`:

```bash
cp src-tauri/.env.example src-tauri/.env
```

`src-tauri/.env` is gitignored; keep any local overrides to that copy.

### Linux

System packages (Ubuntu/Debian):

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libssl-dev \
  librsvg2-dev \
  libsoup-3.0-dev \
  libayatana-appindicator3-dev \
  pkg-config
```

### Windows

- **Visual Studio Build Tools** (or full Visual Studio) with the "Desktop development with C++" workload — provides MSVC toolchain
- **WebView2** — ships with Windows 10/11 (nothing to install)

See [Tauri prerequisites for Windows](https://v2.tauri.app/start/prerequisites/#windows).

### macOS

- **Xcode Command Line Tools**: `xcode-select --install`
- CLang and macOS development dependencies are included with Xcode CLT

See [Tauri prerequisites for macOS](https://v2.tauri.app/start/prerequisites/#macos).

### Android

On top of the base prerequisites:

- **Android SDK** with platform tools and build tools
- **Android NDK v27**
- **JDK 17** (for Gradle)
- **Rust Android targets** (64-bit only — 32-bit `armv7` / `i686` are not supported):

  ```bash
  rustup target add aarch64-linux-android x86_64-linux-android
  ```

Environment variables (add to `~/.bashrc` or equivalent):

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"  # adjust to your NDK version
export JAVA_HOME="/usr/lib/jvm/java-17-openjdk-amd64"  # adjust to your JDK path
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

First-time Android setup:

```bash
# Initialize Tauri Android project (only needed once; regenerates src-tauri/gen/android/)
cargo tauri android init

# Apply our platform-baseline overrides (minSdk 24 -> 30, jvmTarget 1.8 -> 17).
# `src-tauri/gen/android/` is gitignored because Tauri regenerates it, so these
# overrides live in a post-init script that is idempotent — safe to re-run.
bash scripts/patch-android-build.sh

# Create an emulator AVD
sdkmanager "system-images;android-34;google_apis;x86_64"
avdmanager create avd -n dev_phone -k "system-images;android-34;google_apis;x86_64" --device "pixel_6"
```

---

## Development

```bash
# Start the full Tauri app with hot reload
cargo tauri dev
```

This launches:

1. Vite dev server on `http://localhost:5173`
2. Rust backend with the platform's native webview

Frontend changes hot-reload instantly. Rust changes require a recompile (automatic).

### Browser-Only Development

For frontend work without the Tauri backend:

```bash
npm run dev
# Open http://localhost:5173 in a browser
```

The app auto-detects the missing `window.__TAURI_INTERNALS__` and loads an in-memory mock backend (`src/lib/tauri-mock.ts`) with seed data. This mock is dev-only and tree-shaken from production builds.

### Android Development

```bash
# Start emulator
emulator -avd dev_phone -gpu host &

# Build + install + run with hot-reload
cargo tauri android dev --target x86_64
```

---

## Testing

### Frontend Tests (Vitest)

```bash
npm test                    # Single run (~7300 tests)
npm run test:watch          # Watch mode
npm run test:coverage       # With v8 coverage (thresholds: 80% lines/functions/statements, 75% branches)
```

### Backend Tests (Rust)

```bash
cd src-tauri

# All tests via nextest (parallel, retries)
cargo nextest run

# All tests via cargo test (includes doctests)
cargo test

# Specific test by name
cargo nextest run create_block_returns
cargo test -- create_block_returns

# Only integration tests
cargo test -- command_integration_tests
cargo test -- sync_integration_tests
```

### E2E Tests (Playwright)

```bash
# Install browsers (first time)
npx playwright install chromium

# Run E2E tests (starts dev server automatically)
npx playwright test

# Interactive UI mode
npx playwright test --ui
```

E2E tests run against the Vite dev server with the in-memory mock backend. They verify full user flows in headless Chromium.

### Benchmarks (Criterion)

```bash
cd src-tauri

# All benchmarks (24 bench files)
cargo bench

# Specific benchmark
cargo bench --bench hash_bench
cargo bench --bench commands_bench
```

Benchmarks are manual only — never run in CI. They cover: backlink queries, cache, commands, drafts, FTS, hash, import, merge, move/reorder, op_log, pagination, snapshot, soft_delete, sync, tag query, undo/redo.

### Pre-commit Hooks

```bash
# Run all hooks on entire repo
prek run --all-files

# Run on staged files only
prek run
```

The `prek.toml` configuration runs 26 hooks: 9 builtin file checks, gitleaks secret scanning, Biome lint, TypeScript check, CSS variable guard (`no-hsl-rgb-var-wrap`), Vitest, npm audit, license-checker, depcheck, knip, markdownlint, lychee link checker, sqruff (SQL lint for `src-tauri/migrations/`), cargo fmt, clippy, nextest, deny, machete. File-type-aware — Rust hooks skip when no `.rs` files are staged; sqruff runs only on `src-tauri/migrations/*.sql`.

---

## Production Builds

### Linux

```bash
cargo tauri build
```

**Output** (`src-tauri/target/release/bundle/`):

| Format | File | Typical Size |
| ------ | ---- | ------------ |
| `.deb` | `Agaric_0.1.0_amd64.deb` | ~9 MB |
| `.rpm` | `Agaric-0.1.0-1.x86_64.rpm` | ~9 MB |
| `.AppImage` | `Agaric_0.1.0_amd64.AppImage` | ~79 MB |

#### AppImage icon fix

Tauri 2's AppImage bundler emits a `.DirIcon` symlink pointing at an absolute path inside the build machine's file tree (broken on every other machine) and a root `agaric.png` that resolves to the 16×16 icon (silently ignored by Ubuntu 24's file manager and dock). The repo ships `scripts/fix-appimage-icons.sh` which replaces `.DirIcon` with a relative symlink to the 512×512 `Agaric.png` and relinks the root `agaric.png` to the 256×256 hicolor icon, then repacks the AppImage via `linuxdeploy-plugin-appimage.AppImage` (cached at `~/.cache/tauri/` by `cargo tauri build`). Run `bash scripts/fix-appimage-icons.sh` after `cargo tauri build` when distributing an AppImage locally; CI (`.github/workflows/ci.yml`) and the release workflow (`.github/workflows/release.yml`) already invoke it, and the release path sets `FIX_APPIMAGE_STRICT=1` so a missing `linuxdeploy-plugin-appimage` fails the release instead of silently shipping the un-repacked bundle.

### Windows

```bash
cargo tauri build
```

**Output** (`src-tauri/target/release/bundle/`):

| Format | File |
| ------ | ---- |
| `.msi` | `Agaric_0.1.0_x64_en-US.msi` |
| `.exe` | `Agaric_0.1.0_x64-setup.exe` (NSIS installer) |

### macOS

```bash
# Native architecture
cargo tauri build

# Universal binary (Intel + Apple Silicon)
cargo tauri build --target universal-apple-darwin
```

**Output** (`src-tauri/target/release/bundle/`):

| Format | File |
| ------ | ---- |
| `.dmg` | `Agaric_0.1.0_x64.dmg` |
| `.app` | `Agaric.app` bundle |

### No Cross-Compilation

Tauri links the platform's native webview at build time (WebKitGTK on Linux, WebView2 on Windows, WKWebView on macOS). Each platform **must be built on that platform**. CI handles this via a build matrix (`.github/workflows/ci.yml`).

---

## Android Builds

### Debug APK (for development/testing)

```bash
# For emulator (x86_64, fastest compile)
cargo tauri android build --target x86_64 --debug

# For physical device (arm64)
cargo tauri android build --target aarch64 --debug
```

**Output**: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`

Debug APKs are large (~400 MB) because they include unstripped Rust debug symbols. They install directly without signing.

### Release APK

```bash
# Single architecture (e.g., x86_64 for emulator testing)
cargo tauri android build --target x86_64

# All architectures
cargo tauri android build
```

**Output**: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`

Release APKs are ~24 MB (R8/ProGuard minification strips debug symbols and shrinks the Java layer). ProGuard keep rules are configured in `src-tauri/gen/android/app/proguard-rules.pro` and verified working.

### Signing a Release APK

Release APKs must be signed before installing on a device:

```bash
ANDROID_HOME="$HOME/Android/Sdk"
BUILD_TOOLS=$(ls -d "$ANDROID_HOME/build-tools/"* | sort -V | tail -1)
APK_IN="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
APK_OUT="agaric-release.apk"

# Align
"$BUILD_TOOLS/zipalign" -f 4 "$APK_IN" /tmp/aligned.apk

# Sign with debug keystore (for testing) or your release keystore
"$BUILD_TOOLS/apksigner" sign \
  --ks ~/.android/debug.keystore \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$APK_OUT" \
  /tmp/aligned.apk
```

For Play Store distribution, replace the debug keystore with your release signing key.

### Release signing in CI

The `release.yml` workflow signs the Android APK automatically on every tag push **iff** four GitHub Actions secrets are configured. If they aren't, the workflow falls back to uploading the unsigned APK so the rest of the release pipeline keeps working.

Setup (one-time):

1. **Generate a release keystore** locally (the `.jks` file is your forever-key for this app — back it up offline before configuring secrets):

   ```bash
   keytool -genkeypair -v \
     -keystore ~/agaric-release.jks \
     -alias agaric \
     -keyalg RSA -keysize 4096 -validity 10000 \
     -storetype PKCS12
   ```

   `keytool` will prompt for a keystore password, a key password (use the same), and a Distinguished Name (CN/OU/O/L/ST/C). The DN is embedded in the certificate users see in Android settings — pick something stable.

2. **Base64-encode the keystore** and add four repo secrets at `Settings → Secrets and variables → Actions`:

   ```bash
   base64 -w0 ~/agaric-release.jks | xclip -selection clipboard   # paste into ANDROID_KEYSTORE_BASE64
   ```

   | Secret name | Value |
   | --- | --- |
   | `ANDROID_KEYSTORE_BASE64` | base64-encoded keystore (output of `base64 -w0 …jks`) |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password from step 1 |
   | `ANDROID_KEY_ALIAS` | the alias from step 1 (`agaric` if you used the snippet verbatim) |
   | `ANDROID_KEY_PASSWORD` | the key password from step 1 |

3. **Tag a release.** The next `git push --tags` (or `gh release create`) triggers `release.yml`. Its Android job zipaligns the APK, signs it with `apksigner` (APK signing scheme v2/v3 + v4 idsig), `apksigner verify`s it, and uploads `agaric-<tag>-android-aarch64.apk` (no `-unsigned` suffix) to the GitHub Release.

**Critical**: lose the keystore and you can never ship updates that overwrite installed apps. Android refuses to upgrade an APK if the new signature doesn't match the installed one — users would have to uninstall and lose their data. Store a copy of `agaric-release.jks` (and the passwords) somewhere offline that survives losing your dev machine. The base64 in the GitHub secret is *not* a backup — secrets are write-only and you can't read them back.

This setup uses **APK direct distribution**. If you later move to Play Store, switch to **Play App Signing** (Google holds the app signing key; you only own the upload key) — the keystore generated here would become the upload key, not the app signing key.

### Installing on Emulator

```bash
# Start emulator
emulator -avd dev_phone -gpu host &
adb wait-for-device

# Install
adb install -r agaric-release.apk

# Launch
adb shell am start -n com.agaric.app/.MainActivity

# View logs
adb logcat -s RustStdoutStderr:V
```

### Android Build Details

| Property | Value |
| -------- | ----- |
| Package ID | `com.agaric.app` |
| Min SDK | 30 (Android 11, Sep 2020) |
| Target SDK | 36 |
| NDK | 27 |
| Java / Kotlin target | 17 |
| Supported ABIs | `arm64-v8a` (aarch64) on device, `x86_64` on emulator — 32-bit `armeabi-v7a` / `x86` dropped |
| Debug APK size | ~400 MB (unstripped symbols) |
| Release APK size | ~24 MB (R8 minified) |
| ProGuard | Configured and verified working |

---

## Desktop code signing in CI

**Desktop builds ship unsigned.** The maintainer has opted out of paid Apple Developer Program enrollment ($99/year) and Windows OV/EV certificates ($200–400/year) for this open-source project. Each platform's `release.yml` job produces unsigned bundles; the OS will warn on first install. Linux is unaffected because `.deb` / `.AppImage` consumers don't expect platform-level signatures.

Cross-references:

- **Android** signing lives in [Release signing in CI](#release-signing-in-ci) under Android Builds above (different mechanism: `apksigner` post-build, not `tauri-action`). Android signing IS wired and uses a self-generated keystore, no paid CA required — see PUB-8 in `REVIEW-LATER.md`.
- **Tauri updater** signing (`TAURI_SIGNING_PRIVATE_KEY`) is currently commented out in `release.yml`, gated on `PUB-5` in `REVIEW-LATER.md` (publish target / updater endpoint must be locked in first). The updater key is Minisign-based and free; orthogonal to platform code-signing.

### macOS unsigned bundles

`tauri-action` produces `.dmg` and `.app` bundles without `codesign` or notarization. On first launch macOS Gatekeeper shows: **"Apple could not verify 'Agaric' is free of malware that may harm your Mac or compromise your privacy."**

User-facing install instructions:

1. **First-launch bypass (one-time):** Right-click `Agaric.app` in Finder → **Open** → confirm in the dialog. After this, double-click works normally.
2. **Or strip the quarantine attribute (advanced):**

   ```sh
   xattr -dr com.apple.quarantine /Applications/Agaric.app
   ```

3. **System Settings approval (modern macOS):** if Gatekeeper still blocks the app after right-click → Open, go to `System Settings → Privacy & Security`, scroll to the bottom, and click **Open Anyway** next to the Agaric notice.

The maintainer may revisit signing if Apple offers a free open-source path (none exists today; all paths require Developer Program membership).

### Windows unsigned bundles

`tauri-action` produces `.msi` and `.exe` bundles without `signtool`. On first run Windows SmartScreen shows: **"Windows protected your PC"** (the "unrecognized publisher" prompt).

User-facing install instructions:

1. Click **More info** in the SmartScreen dialog.
2. Click **Run anyway** to launch the installer.
3. The MSI / EXE is otherwise normal — no admin prompts beyond what an installer expects.

The maintainer may revisit if **SignPath Foundation OSS Sponsorship** application is approved (free signing-as-a-service for qualifying open-source projects); see PUB-9 in `REVIEW-LATER.md`. Until then, Windows ships unsigned.

### Linux `.deb` and `.AppImage` — intentionally not signed

Direct `.deb` / `.AppImage` downloads from GitHub Releases are not GPG-signed. This is deliberate:

- **`.deb`** signing (`dpkg-sig`) is rare for direct downloads — most users `dpkg -i ./agaric.deb` without checking signatures, and apt-repo distribution (where signatures *do* matter, via the repo's `Release` file) isn't on the roadmap.
- **`.AppImage`** GPG signatures via `linuxdeploy --sign` exist but the verification UX is essentially non-existent on the user side; almost no AppImage runner checks them.
- **Integrity** for downloaded artifacts is covered by GitHub's HTTPS + the SHA256 sums GitHub publishes alongside each release asset. If you want stronger guarantees later, the right move is enabling `TAURI_SIGNING_PRIVATE_KEY` (Minisign updater key) — that signs every bundle including the AppImage, and the resulting `.sig` files are verifiable offline.

---

## iOS Builds (not yet supported)

Tauri 2 supports iOS and the codebase is structurally ready (`#[cfg_attr(mobile, tauri::mobile_entry_point)]` is in place, all Rust code is platform-agnostic). However, iOS builds are **not functional yet** due to a sync blocker.

### Known Blocker

- **#522 — mDNS peer discovery blocked on iOS.** The `mdns-sd` crate uses raw UDP multicast sockets (`socket2` + `mio`), which iOS prohibits. Sync peer discovery, announcements, and initiation all depend on mDNS — sync is completely non-functional on iOS without a workaround. See `REVIEW-LATER.md` #522 for details and fix path.

### Prerequisites (when iOS support is added)

- **macOS host** with Xcode installed (iOS apps cannot be cross-compiled)
- **Xcode Command Line Tools**: `xcode-select --install`
- **Rust iOS targets**:

  ```bash
  rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim
  ```

### First-Time Setup

```bash
# Initialize Tauri iOS project (generates Xcode project under src-tauri/gen/apple/)
cargo tauri ios init

# Build for iOS simulator
cargo tauri ios dev

# Build for physical device
cargo tauri ios build
```

### What Works Today

- Core note-taking (database, editor, UI) — fully compatible
- SQLite WAL mode — supported on iOS
- File system paths — `app.path().app_data_dir()` resolves correctly
- `tauri-plugin-shell` — `openUrl()` falls back to `window.open()` on iOS (no crash)

### What Does Not Work

- Sync peer discovery via mDNS (#522) — requires manual IP entry fallback or Apple Bonjour integration

---

## CI Pipeline

GitHub Actions (`.github/workflows/ci.yml`) runs three jobs:

1. **check** (Ubuntu) — Biome lint, TypeScript check, Cargo fmt/clippy, Rust tests (nextest), frontend tests (Vitest), E2E tests (Playwright), sqlx cache check
2. **build** (matrix: Linux + Windows + macOS) — `cargo tauri build` on each platform, uploads bundle artifacts
3. **android-build** (Ubuntu) — Debug APK build for x86_64

Build artifacts are uploaded as GitHub Actions artifacts and can be downloaded from the workflow run page.

---

## sqlx Compile-Time Queries

The project uses sqlx `query!` macros for compile-time-checked SQL. An offline cache (`.sqlx/` directory) is committed to the repo so builds work without a live database.

After changing SQL queries in Rust source:

```bash
cd src-tauri
cargo sqlx prepare -- --tests
```

This regenerates the `.sqlx/` cache files. Commit the changes. The CI `sqlx offline cache check` step verifies the cache is up to date.

---

## TypeScript Bindings (Specta)

`src/lib/bindings.ts` is auto-generated from Rust types via Specta. After changing Rust types used in Tauri commands:

```bash
cd src-tauri
cargo test -- specta_tests --ignored
```

This regenerates `bindings.ts`. The `ts_bindings_up_to_date` pre-commit hook verifies sync.

---

## Troubleshooting

### Android: Stale database crashes on launch

If the app crashes immediately after a schema change:

```bash
adb shell pm clear com.agaric.app
```

This wipes the app's data directory including the SQLite database.

### Android: Release APK won't install

Release APKs are unsigned. Sign them first (see [Signing a Release APK](#signing-a-release-apk)).

### Rust compilation errors after SQL changes

Run `cargo sqlx prepare -- --tests` to regenerate the offline query cache.

### TypeScript errors after Rust type changes

Run `cd src-tauri && cargo test -- specta_tests --ignored` to regenerate bindings.

### WebView not found (Linux)

Install `libwebkit2gtk-4.1-dev`. The exact package name varies by distro.

### Slow first build

Cold Rust compilation takes 2-5 minutes. Subsequent incremental builds are much faster (~1-15s depending on what changed). The `target/` directory caches compiled dependencies.
sequent incremental builds are much faster (~1-15s depending on what changed). The `target/` directory caches compiled dependencies.
