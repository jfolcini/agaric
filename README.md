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

See **[BUILD.md](BUILD.md)** for the complete build guide — prerequisites, platform-specific setup, Android signing, CI pipeline, and troubleshooting.

### Quick Start

```bash
npm ci                       # Install frontend dependencies
cargo tauri dev              # Launch app with hot reload
```

### Testing

```bash
npm test                     # Frontend tests (2063 tests, Vitest)
cd src-tauri && cargo nextest run   # Rust tests (~1300 tests)
npx playwright test          # E2E tests (Playwright + Chromium)
```

### Building

```bash
cargo tauri build             # Linux: .deb + .rpm + .AppImage (~9 MB)
                              # Windows: .msi + .exe (run on Windows)
                              # macOS: .dmg + .app (run on macOS)

cargo tauri android build --target x86_64           # Release APK (24 MB)
cargo tauri android build --target x86_64 --debug   # Debug APK (400 MB)
```

No cross-compilation — each desktop platform must be built on that platform. Android builds run on Linux. CI handles the full matrix automatically.

### Android

Both debug and release APKs build and run successfully. Release APKs are 24 MB (vs 402 MB debug) thanks to R8/ProGuard minification. Requires Android SDK, NDK 27, and JDK 17. See [BUILD.md](BUILD.md#android-builds) for signing and emulator setup.

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
├── BUILD.md                # Complete build guide
├── AGENTS.md               # Developer conventions
└── ARCHITECTURE.md         # Architecture deep-dive
```

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
