# Agaric (Agaric)

A local-first, block-based note-taking app for **Linux**, **Windows**, **macOS**, and **Android**. Inspired by Org-mode and Logseq — journal-first, with powerful tagging and emergent structure. No cloud, no accounts. Your data lives on your machine.

## What is it?

Agaric treats everything as a **block** — paragraphs, headings, code snippets, tasks. Blocks live in a tree: pages contain blocks, blocks can nest infinitely. Tags and links are first-class citizens that connect your knowledge graph.

Think Logseq or Notion, but:
- **Local-first** — SQLite database on your filesystem, no server required
- **Offline-first** — works without internet, syncs over local WiFi (planned)
- **Fast** — Rust backend, instant search via FTS5, sub-millisecond operations
- **Private** — no telemetry, no cloud, filesystem-level encryption

## Core Concepts

### Blocks and Pages

Everything is a block. A **page** is just a special block type that acts as a container. Blocks nest via parent-child relationships with drag-and-drop reordering.

### Journal

The default view is a **daily journal** — one page per day, created automatically. Four viewing modes:
- **Day** — single day with full editing
- **Week** — Mon–Sun overview, click any day heading to jump to its daily view
- **Month** — all days in the month, stacked
- **Agenda** — task panels grouped by TODO / DOING / DONE status

### Tags and Links

- **Tags** (`#[ULID]`) — categorize blocks. Rendered as named chips, backed by ULIDs so renaming propagates everywhere.
- **Block links** (`[[ULID]]`) — link to any page or block. Shows the resolved title as a clickable chip.
- **Backlinks** — see everything that links to the current block.

### Properties

Blocks can have typed properties (text, number, date, reference). A built-in **priority** property shows color-coded badges. Properties are queryable — the agenda view uses them to find tasks.

### Editor

WYSIWYG editing powered by TipTap. A single roving editor instance mounts into whichever block you click — all other blocks render as static text. Supports:
- Markdown bold (`**`), italic (`*`), inline code (`` ` ``), headings, code blocks
- Tag picker (`#` in editor) and block link picker (`[[`)
- Task cycling (`Ctrl+Enter`: TODO → DOING → DONE → none)
- Indent/dedent (`Tab` / `Shift+Tab`)

### Sync (Planned)

Append-only operation log with CRDT-style conflict resolution. Designed for peer-to-peer sync over local WiFi — no cloud server needed.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | [Tauri 2](https://v2.tauri.app/) |
| Frontend | React 18 + Vite + TipTap + Tailwind CSS 4 |
| Backend | Rust + SQLite (via sqlx) |
| Database | SQLite in WAL mode, 13 tables + FTS5 |
| State | Zustand stores |
| Linting | Biome (no ESLint/Prettier) |
| Testing | Vitest + vitest-axe + fast-check (frontend), cargo-nextest + insta (backend) |

## Development

### Prerequisites

- **Node.js** (v20+) and npm
- **Rust** (stable) — install via [rustup](https://rustup.rs/)
- **Tauri CLI** — `cargo install tauri-cli`

#### Linux

- System packages: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev` (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

#### Windows

- **WebView2** — ships with Windows 10/11 (nothing to install)
- **Visual Studio Build Tools** or full Visual Studio with the "Desktop development with C++" workload (provides the MSVC toolchain). See [Tauri prerequisites for Windows](https://v2.tauri.app/start/prerequisites/#windows)

#### macOS

- **Xcode Command Line Tools** — `xcode-select --install`
- **CLang and macOS development dependencies** are included with Xcode CLT. See [Tauri prerequisites for macOS](https://v2.tauri.app/start/prerequisites/#macos)

### Running the App

```bash
# Start the full Tauri app (frontend + backend) with hot reload
cargo tauri dev
```

This starts:
1. Vite dev server on `http://localhost:5173`
2. Rust backend compiled and launched with the platform's native webview (WebKitGTK on Linux, WebView2 on Windows, WKWebView on macOS)

### Running Tests

```bash
# Frontend tests (Vitest)
npm test                    # single run
npm run test:watch          # watch mode
npm run test:coverage       # with v8 coverage

# Backend tests (Rust)
cd src-tauri && cargo nextest run

# E2E tests (Playwright)
npm run test:e2e
```

### Building for Production

```bash
# Linux desktop (.deb + .AppImage)
cargo tauri build

# Windows (.msi + .exe via NSIS)
cargo tauri build

# macOS (.dmg + .app bundle)
cargo tauri build
# Universal binary (Intel + Apple Silicon):
cargo tauri build --target universal-apple-darwin
```

Each platform must be built **on** that platform (no cross-compilation — Tauri links the native webview at build time). CI handles this via a build matrix across Linux, Windows, and macOS runners.

Bundles land in `src-tauri/target/release/bundle/`.

### Android Development

The app targets Android via Tauri 2's mobile support. You can build, run, and test the Android APK entirely from your Linux machine using the Android emulator.

#### Android Prerequisites

On top of the base prerequisites you need:

- **Android SDK** with platform tools and build tools
- **Android NDK** (v27 recommended)
- **Android emulator** with a system image (e.g., `system-images;android-34;google_apis;x86_64`)
- **Rust Android targets** — install all four:
  ```bash
  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
  ```

Set these environment variables (e.g., in `~/.bashrc`):
```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"   # adjust to your NDK version
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

#### First-Time Setup

Initialize the Tauri Android project (only needed once):
```bash
cargo tauri android init
```

Create an emulator AVD if you don't have one:
```bash
# Install a system image
sdkmanager "system-images;android-34;google_apis;x86_64"

# Create the AVD
avdmanager create avd -n dev_phone -k "system-images;android-34;google_apis;x86_64" --device "pixel_6"
```

#### Building the APK

```bash
# Debug APK for emulator (x86_64, fastest)
cargo tauri android build --target x86_64 --debug

# Debug APK for physical device (arm64)
cargo tauri android build --target aarch64 --debug

# Release APK (all architectures)
cargo tauri android build --release
```

The APK lands in `src-tauri/gen/android/app/build/outputs/apk/`.

#### Running on the Emulator

```bash
# Start the emulator in the background
emulator -avd dev_phone -gpu host -no-snapshot-load &

# Wait for it to boot, then run the app with hot-reload
cargo tauri android dev --target x86_64
```

`cargo tauri android dev` builds, installs, and launches the app on the running emulator with live frontend reloading (Rust changes require a rebuild).

#### Running on a Physical Device

1. Enable **USB debugging** on the phone (Settings > Developer Options).
2. Connect via USB and confirm the authorization dialog.
3. Verify the device is visible: `adb devices`
4. Run:
   ```bash
   cargo tauri android dev --target aarch64
   ```

#### Inspecting and Debugging

```bash
# View app logs (Rust tracing output goes to logcat)
adb logcat -s RustStdoutStderr:V

# Install a previously built APK manually
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk

# Open Chrome DevTools for the Android WebView
# 1. Open chrome://inspect in your desktop Chrome
# 2. The app's WebView appears under "Remote Target"
```

#### Headless Android Testing via ADB

You can test the Android app entirely from the command line without ever looking at the emulator window. This is useful for CI, scripting, and AI-assisted development.

```bash
# Start emulator headless (no window)
emulator -avd dev_phone -gpu swiftshader_indirect -no-window -no-audio &

# Wait for boot to complete
adb wait-for-device
adb shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'

# Build and install the debug APK
cargo tauri android build --target x86_64 --debug
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk

# Launch the app
adb shell am start -n com.agaric.app/.MainActivity

# Take a screenshot and pull it to your machine
adb exec-out screencap -p > screenshot.png

# Send a tap at coordinates (x, y)
adb shell input tap 512 400

# Type text into the focused field
adb shell input text "hello"

# Swipe (scroll down)
adb shell input swipe 500 800 500 200

# Read Rust backend logs
adb logcat -s RustStdoutStderr:V -d

# Dump the current activity's view hierarchy
adb shell dumpsys activity top | head -100

# Access the app's private data directory (requires debug build)
adb shell run-as com.agaric.app ls files/
adb shell run-as com.agaric.app cat files/device-id

# Kill the app
adb shell am force-stop com.agaric.app

# Shut down the emulator
adb emu kill
```

You can also script the WebView via Chrome DevTools Protocol. Forward the debug port and use `curl` or a CDP client to execute JavaScript, inspect the DOM, and capture console output:

```bash
# Find the WebView debug socket
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.agaric.app)

# List inspectable pages
curl -s http://localhost:9222/json

# Execute JS in the WebView (via CDP websocket — use websocat or similar)
# e.g., check if Tauri IPC is available:
#   {"method":"Runtime.evaluate","params":{"expression":"typeof window.__TAURI__"},"id":1}
```

#### Known Limitations

The Android build is functional with all core IPC commands working (block creation, editing, persistence confirmed 2026-03-31). Open issues tracked in `REVIEW-LATER.md`:
- `window.prompt()` and `window.open()` don't work in Android WebView
- Touch targets and hover-dependent UI need mobile adaptation
- ProGuard keep rules are missing for release builds
- Stale databases from earlier builds will crash on launch — fix with `adb shell pm clear com.agaric.app`

### Linting and Formatting

```bash
npm run lint                # Biome check
npm run lint:fix            # Biome auto-fix
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy -- -D warnings
```

### Pre-commit Hooks

The project uses [`prek`](https://prek.j178.dev) (a fast, Rust-based pre-commit framework) instead of the Python `pre-commit`. Hooks are configured in `prek.toml` and run automatically on `git commit`. They are file-type-aware: Rust hooks skip when no `.rs` files are staged, frontend hooks skip when no `.ts`/`.tsx` files changed, etc.

```bash
# Install prek (if not already installed)
cargo install prek

# Manual run against entire repo
prek run --all-files

# Manual run on staged files only (same as what git commit triggers)
prek run
```

The hooks cover: trailing whitespace, EOF fixer, YAML/TOML/JSON validation, Biome lint+format, cargo fmt, cargo clippy, Vitest, cargo nextest, and TypeScript bindings sync. **prek hooks are the verification** — you never need to manually run the full lint/test suite before committing.

### Project Structure

```
├── src/                    # React frontend
│   ├── components/         # UI components (JournalPage, BlockTree, etc.)
│   ├── editor/             # TipTap editor setup and extensions
│   ├── stores/             # Zustand state stores
│   ├── lib/                # Tauri API wrappers and bindings
│   └── index.css           # Tailwind theme (Agaric color scheme)
├── src-tauri/              # Rust backend
│   ├── src/                # Commands, database, materializer, sync
│   ├── migrations/         # SQLite migrations (auto-run on startup)
│   ├── icons/              # App icons (all platforms)
│   └── tauri.conf.json     # Tauri configuration
├── public/                 # Static assets (agaric.svg icon)
├── AGENTS.md               # Developer conventions (for AI agents)
└── COMPARISON.md           # Feature comparison with Logseq
```

### Key Architecture Notes

- **Op log is append-only** — all mutations are recorded as operations; the materializer derives current state (CQRS pattern)
- **Cursor-based pagination** on all list queries — no offset pagination
- **Single TipTap instance** — roving editor pattern for performance
- **sqlx compile-time queries** — SQL is checked at compile time; `.sqlx/` cache is committed
- **TypeScript bindings** auto-generated from Rust types via specta; regenerate with `cd src-tauri && cargo test -- specta_tests --ignored`

## Database

SQLite database stored at the platform's app data directory. WAL mode with foreign keys enforced. 1 writer + 4 reader connection pool.

| Platform | Path |
|----------|------|
| Linux | `~/.local/share/com.agaric.app/notes.db` |
| Windows | `C:\Users\<User>\AppData\Local\com.agaric.app\notes.db` |
| macOS | `~/Library/Application Support/com.agaric.app/notes.db` |
| Android | `/data/data/com.agaric.app/notes.db` |

## License

Private project — not yet licensed for distribution.
