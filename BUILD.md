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

## Prerequisites

### All Platforms

- **Node.js 22+** and npm
- **Rust** (stable toolchain) via [rustup](https://rustup.rs)
- **Tauri CLI**: `cargo install tauri-cli --locked`

```bash
# Install npm dependencies
npm ci

# Verify Rust is available
rustc --version
cargo --version
```

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
- **Rust Android targets**:
  ```bash
  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
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
# Initialize Tauri Android project (only needed once)
cargo tauri android init

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
npm test                    # Single run (~5000 tests)
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

# All benchmarks (16 bench files)
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

The `prek.toml` configuration runs 15 hooks: Rust formatting, Clippy, Biome lint, TypeScript check, Vitest, sqlx cache check, and more. File-type-aware — Rust hooks skip when no `.rs` files are staged.

---

## Production Builds

### Linux

```bash
cargo tauri build
```

**Output** (`src-tauri/target/release/bundle/`):

| Format | File | Typical Size |
|--------|------|-------------|
| `.deb` | `Agaric_0.1.0_amd64.deb` | ~9 MB |
| `.rpm` | `Agaric-0.1.0-1.x86_64.rpm` | ~9 MB |
| `.AppImage` | `Agaric_0.1.0_amd64.AppImage` | ~79 MB |

### Windows

```bash
cargo tauri build
```

**Output** (`src-tauri/target/release/bundle/`):

| Format | File |
|--------|------|
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
|--------|------|
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
|----------|-------|
| Package ID | `com.agaric.app` |
| Min SDK | 24 (Android 7.0) |
| Target SDK | 36 |
| NDK | 27 |
| Debug APK size | ~400 MB (unstripped symbols) |
| Release APK size | ~24 MB (R8 minified) |
| ProGuard | Configured and verified working |

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
cargo sqlx prepare -- --lib
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

Run `cargo sqlx prepare -- --lib` to regenerate the offline query cache.

### TypeScript errors after Rust type changes

Run `cd src-tauri && cargo test -- specta_tests --ignored` to regenerate bindings.

### WebView not found (Linux)

Install `libwebkit2gtk-4.1-dev`. The exact package name varies by distro.

### Slow first build

Cold Rust compilation takes 2-5 minutes. Subsequent incremental builds are much faster (~1-15s depending on what changed). The `target/` directory caches compiled dependencies.
sequent incremental builds are much faster (~1-15s depending on what changed). The `target/` directory caches compiled dependencies.
