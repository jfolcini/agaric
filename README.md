# Agaric

A local-first, block-based note-taking app for **Linux** (primary), **Windows**, **macOS**, and **Android**. Inspired by Org-mode and Logseq — journal-first, with powerful tagging and emergent structure. No cloud, no accounts. Your data lives on your machine, syncs over local WiFi.

## What is it?

Agaric treats everything as a **block** — paragraphs, headings, code snippets, tasks. Blocks live in a tree: pages contain blocks, blocks can nest infinitely. Tags and links are first-class citizens that connect your knowledge graph.

Think Logseq or Notion, but:
- **Local-first** — SQLite database on your filesystem, no server required
- **Offline-first** — works without internet, syncs peer-to-peer over local WiFi
- **Fast** — Rust backend, instant search via FTS5, sub-millisecond operations
- **Private** — no telemetry, no cloud, filesystem-level encryption

## Core Concepts

### Blocks and Pages

Everything is a block. A **page** is just a special block type that acts as a container. Blocks nest via parent-child relationships with drag-and-drop reordering. Pages support namespaced titles (`work/meetings/standup`) with breadcrumb navigation.

### Journal

The default view is a **daily journal** — one page per day, created automatically. Four viewing modes:
- **Day** — single day with full editing
- **Week** — Mon-Sun overview, click any day heading to jump to its daily view
- **Month** — calendar grid with content indicators; click a day to switch to daily view
- **Agenda** — tasks grouped by date (Overdue / Today / Tomorrow / future) with sort and group controls

### Tags and Links

- **Tags** (`#[ULID]`) — categorize blocks. Rendered as named chips, backed by ULIDs so renaming propagates everywhere.
- **Block links** (`[[ULID]]`) — link to any page or block. Shows the resolved title as a clickable chip.
- **Backlinks** — see everything that links to the current block.

### Properties

Blocks can have typed properties (text, number, date, select, reference). A built-in **priority** property shows color-coded badges. Properties panel for inline editing. Properties are queryable — the agenda view uses them to find and filter tasks across five dimensions (status, priority, due date, scheduled date, tag).

### Editor

WYSIWYG editing powered by TipTap. A single roving editor instance mounts into whichever block you click — all other blocks render as static text. Supports:
- Markdown bold (`**`), italic (`*`), inline code (`` ` ``), headings, code blocks, tables
- Tag picker (`#` in editor) and block link picker (`[[`)
- Task cycling (`Ctrl+Enter`: TODO -> DOING -> DONE -> none), custom task keywords
- Indent/dedent (`Tab` / `Shift+Tab`)
- Templates with dynamic variables (via `/template` slash command)
- Inline queries (`{{query ...}}` syntax)
- Multi-selection with batch operations (Ctrl+Click / Shift+Click)

### Sync

Peer-to-peer sync over local WiFi — no cloud server needed. Append-only operation log with three-way merge conflict resolution.

- **Discovery** — mDNS automatic peer discovery on the local network
- **Pairing** — QR code or 4-word passphrase, per-session ephemeral keys
- **Transport** — TLS WebSocket with self-signed ECDSA certificates, certificate pinning
- **Merge** — three-way text merge via `diffy`, LWW for properties and moves, conflict copies for overlapping edits
- **Conflicts view** — review and resolve merge conflicts inline
- **Auto-sync** — background daemon with change-triggered and periodic sync, exponential backoff on failure

### More Features

- **History view** — browse the operation log for any block
- **Status panel** — materializer queue stats, FTS health, sync state
- **Attachments** — attach files to any block
- **Import / Export** — Logseq/Markdown import, data export
- **Trash** — soft delete with 30-day auto-purge, restore at any time

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | [Tauri 2](https://v2.tauri.app/) |
| Frontend | React 18 + Vite + TipTap + Tailwind CSS 4 |
| Backend | Rust + SQLite (via sqlx) |
| Database | SQLite in WAL mode, 14 tables + 1 FTS5 virtual table, 19 indexes |
| State | Zustand stores |
| Linting | Biome (no ESLint/Prettier) |
| Testing | Vitest + vitest-axe + fast-check (frontend), cargo-nextest + insta (backend) |

## Development

See **[BUILD.md](BUILD.md)** for the complete build guide — prerequisites, platform-specific setup, Android signing, CI pipeline, and troubleshooting. See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the architecture deep-dive.

### Quick Start

```bash
npm ci                       # Install frontend dependencies
cargo tauri dev              # Launch app with hot reload
```

### Testing

```bash
npm test                     # Frontend tests (~5000+ tests, Vitest)
cd src-tauri && cargo nextest run   # Rust tests (~850+ tests)
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
src/                         # React frontend
  components/                #   UI components (JournalPage, BlockTree, etc.)
  editor/                    #   TipTap editor setup and extensions
  stores/                    #   Zustand state stores
  hooks/                     #   Custom React hooks (sync, online status, etc.)
  lib/                       #   Tauri API wrappers and bindings
  index.css                  #   Tailwind theme (Agaric color scheme)
src-tauri/                   # Rust backend
  src/                       #   Commands, database, materializer, sync, merge
  migrations/                #   SQLite migrations (auto-run on startup)
  tests/                     #   Integration tests
  benches/                   #   Benchmarks
  icons/                     #   App icons (all platforms)
  tauri.conf.json            #   Tauri configuration
e2e/                         # Playwright E2E tests
public/                      # Static assets (agaric.svg icon)
BUILD.md                     # Complete build guide
AGENTS.md                    # Developer conventions
ARCHITECTURE.md              # Architecture deep-dive
```

## Database

SQLite database stored at the platform's app data directory. WAL mode with foreign keys enforced. 2 writers + 4 readers (6 total) connection pool.

| Platform | Path |
|----------|------|
| Linux | `~/.local/share/com.agaric.app/notes.db` |
| Windows | `C:\Users\<User>\AppData\Local\com.agaric.app\notes.db` |
| macOS | `~/Library/Application Support/com.agaric.app/notes.db` |
| Android | `/data/data/com.agaric.app/notes.db` |

## License

Private project — not yet licensed for distribution.
