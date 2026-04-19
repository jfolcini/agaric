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
- **Month** — calendar grid with content indicator dots, click a day to switch to daily view, configurable week start
- **Agenda** — tasks grouped by date (Overdue / Today / Tomorrow / future) with stackable filters across eight dimensions (status, priority, due date, scheduled date, completed date, created date, tag, property), sort and group controls, projected recurring task occurrences

### Tags and Links

- **Tags** (`#[ULID]`) — categorize blocks. Rendered as named chips, backed by ULIDs so renaming propagates everywhere. Tag inheritance: child blocks inherit parent tags for queries.
- **Block links** (`[[ULID]]`) — link to any page or block. Shows the resolved title as a clickable chip.
- **Block references** (`((ULID))`) — inline embed of another block's content. Hover preview, click-to-navigate.
- **Backlinks** — see everything that links to the current block, grouped by source page with filtering.

### Properties

Blocks can have typed properties (text, number, date, select, reference). A built-in **priority** property shows color-coded badges. Properties panel for inline editing. Properties are queryable — the agenda view uses them to find and filter tasks across eight dimensions.

### Editor

WYSIWYG editing powered by TipTap. A single roving editor instance mounts into whichever block you click — all other blocks render as static text. Supports:

- Markdown bold (`**`), italic (`*`), inline code (`` ` ``), strikethrough (`~~`), highlight (`==`), headings, code blocks, tables
- Tag picker (`#` in editor), block link picker (`[[`), block reference picker (`((`)
- Task cycling (`Ctrl+Enter`: TODO -> DOING -> DONE -> none), custom task keywords
- Indent/dedent (`Tab` / `Shift+Tab`)
- Templates with dynamic variables (via `/template` slash command)
- Inline queries (`{{query ...}}` syntax) with visual query builder
- Multi-selection with batch operations (Ctrl+Click / Shift+Click)
- Drag-and-drop + clipboard paste for file attachments

### Sync

Peer-to-peer sync over local WiFi — no cloud server needed. Append-only operation log with three-way merge conflict resolution.

- **Discovery** — mDNS automatic peer discovery on the local network
- **Pairing** — QR code or 4-word passphrase, per-session ephemeral keys
- **Transport** — TLS WebSocket with self-signed ECDSA certificates, certificate pinning
- **Merge** — three-way text merge via `diffy`, LWW for properties and moves, conflict copies for overlapping edits
- **Conflicts view** — review and resolve merge conflicts inline
- **Auto-sync** — background daemon with change-triggered and periodic sync, exponential backoff on failure

### More Features

- **Graph view** — force-directed page relationship visualization (d3-force), click-to-navigate, zoom/pan, keyboard-accessible
- **History view** — browse the operation log for any block, point-in-time page restore
- **Visual query builder** — modal for constructing inline queries by tag, property, or backlinks
- **Mermaid diagrams** — code blocks with `mermaid` language auto-render as diagrams
- **Keyboard customization** — customize all keyboard shortcuts via settings, conflict detection
- **Status panel** — materializer queue stats, FTS health, sync state, op log compaction
- **Attachments** — attach files to any block (drag-and-drop, paste), MIME validation, size limits
- **Import / Export** — Logseq/Markdown import (YAML frontmatter stripping, tab normalization), Markdown export with ULID-to-name resolution
- **Trash** — soft delete with 30-day auto-purge, restore at any time
- **Recurring tasks** — three repeat modes (+, .+, ++), end conditions (count, date), agenda projection

## Tech Stack

| Layer | Technology |
| ----- | ---------- |
| Desktop shell | [Tauri 2](https://v2.tauri.app/) |
| Frontend | React 19 + Vite + TipTap + Tailwind CSS 4 |
| Backend | Rust + SQLite (via sqlx) |
| Database | SQLite in WAL mode, 18 tables + 1 FTS5 virtual table, 29 indexes across 30 migrations |
| State | Zustand stores |
| Linting | Biome (no ESLint/Prettier) |
| Testing | Vitest + vitest-axe + fast-check (frontend), cargo-nextest + insta + Criterion (backend), Playwright (E2E) |

## Development

See **[BUILD.md](BUILD.md)** for the complete build guide — prerequisites, platform-specific setup, Android signing, CI pipeline, and troubleshooting. See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the architecture deep-dive.

### Quick Start

```bash
npm ci                       # Install frontend dependencies
cargo tauri dev              # Launch app with hot reload
```

### Testing

```bash
npm test                     # Frontend tests (~7300 tests, Vitest)
cd src-tauri && cargo nextest run   # Rust tests (~2100 tests)
npx playwright test          # E2E tests (26 spec files, Playwright + Chromium)
```

### Building

```bash
cargo tauri build             # Linux: .deb + .rpm + .AppImage (~9 MB)
                              # Windows: .msi + .exe (run on Windows)
                              # macOS: .dmg + .app (run on macOS)

cargo tauri android build --target aarch64           # Release APK (~24 MB, Pixel 8 / ARM)
cargo tauri android build --target aarch64 --debug   # Debug APK (400 MB)
```

No cross-compilation — each desktop platform must be built on that platform. Android builds run on Linux. CI handles the full matrix automatically.

### Android

Both debug and release APKs build and run successfully. Release APKs are 24 MB (vs 402 MB debug) thanks to R8/ProGuard minification. Requires Android SDK, NDK 27, and JDK 17. See [BUILD.md](BUILD.md#android-builds) for signing and emulator setup.

### Project Structure

```text
src/                         # React frontend
  components/                #   UI components (JournalPage, BlockTree, GraphView, etc.)
    ui/                      #   Design system primitives (Button, Dialog, FilterPill, etc.)
    journal/                 #   Journal-specific components (MonthlyDayCell, etc.)
  editor/                    #   TipTap editor setup and extensions
    extensions/              #   Custom TipTap extensions (tag-ref, block-link, etc.)
  stores/                    #   Zustand state stores (8 stores, per-page factory)
  hooks/                     #   Custom React hooks (~53 hooks)
  lib/                       #   Tauri API wrappers, utilities, and bindings
  index.css                  #   Tailwind theme (OKLch colors, semantic tokens)
src-tauri/                   # Rust backend
  src/                       #   Commands, database, materializer, sync, merge
  migrations/                #   SQLite migrations (30 files, auto-run on startup)
  tests/                     #   Integration tests
  benches/                   #   Criterion benchmarks (24 bench files)
  icons/                     #   App icons (all platforms)
  tauri.conf.json            #   Tauri configuration
e2e/                         # Playwright E2E tests (26 spec files)
public/                      # Static assets (agaric.svg icon)
BUILD.md                     # Complete build guide
AGENTS.md                    # Developer conventions
ARCHITECTURE.md              # Architecture deep-dive
FEATURE-MAP.md               # Complete feature inventory
REVIEW-LATER.md              # Deferred items and tech debt
```

## Database

SQLite database stored at the platform's app data directory. WAL mode with foreign keys enforced. 2 writers + 4 readers (6 total) connection pool.

| Platform | Path |
| -------- | ---- |
| Linux | `~/.local/share/com.agaric.app/notes.db` |
| Windows | `C:\Users\<User>\AppData\Local\com.agaric.app\notes.db` |
| macOS | `~/Library/Application Support/com.agaric.app/notes.db` |
| Android | `/data/data/com.agaric.app/notes.db` |

## License

Private project — not yet licensed for distribution.
