<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="Agaric logo" width="128" height="128">
</p>

<p align="center">
  <a href="https://github.com/jfolcini/agaric/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jfolcini/agaric/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/jfolcini/agaric/releases"><img alt="Release" src="https://img.shields.io/github/v/release/jfolcini/agaric?include_prereleases&sort=semver"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue"></a>
  <a href="https://securityscorecards.dev/viewer/?uri=github.com/jfolcini/agaric"><img alt="OpenSSF Scorecard" src="https://api.securityscorecards.dev/projects/github.com/jfolcini/agaric/badge"></a>
  <a href="https://www.bestpractices.dev/projects/12870"><img alt="OpenSSF Best Practices" src="https://www.bestpractices.dev/projects/12870/badge"></a>
  <a href="https://slsa.dev"><img alt="SLSA 3" src="https://slsa.dev/images/gh-badge-level3.svg"></a>
  <a href="https://v2.tauri.app"><img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-Linux%20%7C%20Windows%20%7C%20macOS%20%7C%20Android-lightgrey">
</p>

# Agaric

A local-first, block-based note-taking app for **Linux** (primary), **Windows**, **macOS**, and **Android**. Inspired by Org-mode and Logseq — journal-first, with powerful tagging and emergent structure. No cloud, no accounts. Your data lives on your machine, syncs over local WiFi. **AI-ready** — ships an MCP integration so Claude Desktop, Cursor, Continue, and other agents talk directly to your local vault.

## What is it?

Agaric treats everything as a **block** — paragraphs, headings, code snippets, tasks. Blocks live in a tree: pages contain blocks, blocks can nest infinitely. Tags and links are first-class citizens that connect your knowledge graph.

Think Logseq or Notion, but:

- **Local-first** — SQLite database on your filesystem, no server required
- **Offline-first** — works without internet, syncs peer-to-peer over local WiFi
- **Fast** — Rust backend, instant search via FTS5, sub-millisecond operations
- **Private** — no cloud telemetry / no external analytics, no cloud, filesystem-level encryption (the local logger in `src/lib/logger.ts` writes errors to disk so the in-app `BugReportDialog` can attach them — nothing leaves your machine)

## Core Concepts

### Blocks and Pages

Everything is a block. A **page** is just a special block type that acts as a container. Blocks nest via parent-child relationships with drag-and-drop reordering. Pages support namespaced titles (`work/meetings/standup`) with breadcrumb navigation. The Pages view adds density rows, seven sort modes, and compound grooming filters (orphan / stub / no-inbound-links / last-edited + shared tag / path / property / priority) — see [`docs/PAGES.md`](docs/PAGES.md).

### Journal

The default view is a **daily journal** — one page per day, created automatically. Four viewing modes:

- **Day** — single day with full editing
- **Week** — Mon-Sun overview, click any day heading to jump to its daily view
- **Month** — calendar grid with content indicator dots, click a day to switch to daily view, configurable week start
- **Agenda** — tasks grouped by date (Overdue / Today / Tomorrow / future) with stackable filters across eight dimensions (status, priority, due date, scheduled date, completed date, created date, tag, property), sort and group controls, projected recurring task occurrences

> See [docs/UX.md](docs/UX.md) for UI patterns and conventions, and [docs/UI-MAP.md](docs/UI-MAP.md) for the surface tree and shared glossary.

### Spaces

Partition your notes into independent contexts — **Personal**, **Work**, custom — each with its own data scope and visual identity. Switching space swaps the journal, tabs, recent pages, and link resolution. Pages never leak between spaces.

- **Per-space journal** — each space has its own daily-note timeline keyed by `(date, space)`
- **Per-space tabs and recents** — switching space swaps the open-tab strip and recent-pages MRU
- **Quick switching** — `Ctrl+1` … `Ctrl+9` (or `⌘+1` … `⌘+9`) jumps to the Nth space alphabetically
- **Visual identity** — accent colour, status-bar chip, window-title prefix per space
- **Cross-space links** — `[[ULID]]` to a foreign space renders as a broken-link chip (no auto-navigation, no leakage)

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

- **Search** — three surfaces: in-page find (`Ctrl+F`), find across pages (`Ctrl+Shift+F`), and the upcoming `Cmd+K` palette. Full-text engine is FTS5 (trigram index). In-app help via the `?` button in the search toolbar; user guide at [docs/SEARCH.md](docs/SEARCH.md).
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
- **Google Calendar push** — opt-in, off by default. Daily-digest event per date pushed to a dedicated "Agaric Agenda" calendar, per-space configuration foundation in place (FEAT-3p9 M1)

## Tech Stack

| Layer | Technology |
| ----- | ---------- |
| Desktop shell | [Tauri 2](https://v2.tauri.app/) |
| Frontend | React 19 + Vite + TipTap + Tailwind CSS 4 |
| Backend | Rust + SQLite (via sqlx) |
| Database | SQLite in WAL mode, 18 application tables + 1 FTS5 virtual table (plus a handful of internal/cache tables), 32 indexes across 41 migrations |
| State | Zustand stores |
| Linting | Biome (no ESLint/Prettier) |
| Testing | Vitest + vitest-axe + fast-check (frontend), cargo-nextest + insta + Criterion (backend), Playwright (E2E) |

## System requirements

| OS | Minimum |
| --- | --- |
| **Windows** | Windows 10 version 1803 (April 2018 Update) or later. WebView2 is installed automatically by the bundled installer; older Windows (7, 8, 8.1) is not supported because Microsoft does not ship WebView2 for it. |
| **macOS** | macOS 11 Big Sur or later (Apple Silicon native; Intel via Rosetta-free SDK build). |
| **Linux** | glibc 2.31+ (Ubuntu 20.04+ / Debian 11+ / Fedora 33+); `libwebkit2gtk-4.1` runtime. The AppImage bundles GTK; the `.deb` declares the WebKit dep. |
| **Android** | Android 11 (API 30) and above. |

## Development

See **[docs/BUILD.md](docs/BUILD.md)** for the complete build guide — prerequisites, platform-specific setup, Android signing, CI pipeline, and troubleshooting. See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the architecture deep-dive.

### Quick Start

```bash
npm ci                       # Install frontend dependencies
cargo tauri dev              # Launch app with hot reload
```

### Testing

```bash
npm test                     # Frontend tests (~8700 tests, Vitest)
cd src-tauri && cargo nextest run   # Rust tests (~3400 tests)
npx playwright test          # E2E tests (29 spec files, Playwright + Chromium)
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

### Releasing

Maintainers cut a release with a single command from a clean `main`:

```bash
scripts/release.sh <new-version>      # e.g. scripts/release.sh 0.2.1
```

It runs a local release-build check, bumps every version manifest in lockstep, GPG-signs and pushes the tag, and the tag triggers CI to build every platform and **draft** the GitHub Release (which a maintainer then reviews and publishes). Full details — provenance/SBOM artifacts, flags, and why the bump runs locally — in [docs/BUILD.md § Releasing](docs/BUILD.md#releasing).

### Android

Both debug and release APKs build and run successfully. Release APKs are 24 MB (vs 402 MB debug) thanks to R8/ProGuard minification. Requires Android SDK, NDK 27, and JDK 17. See [docs/BUILD.md](docs/BUILD.md#android-builds) for signing and emulator setup.

### Using Agaric with MCP clients

Agaric ships an `agaric-mcp` stub binary that MCP clients (Claude Desktop, Claude Code, Cursor, Continue, …) invoke as a stdio subprocess. The stub bridges stdio to Agaric's local MCP socket, so the client talks to the running app without any network hop.

After installing Agaric, point your MCP client's `command` field at the stub:

| Platform | Path |
| -------- | ---- |
| Linux `.deb` | `/usr/bin/agaric-mcp` |
| Linux AppImage | `<mount>/usr/bin/agaric-mcp` (inside the extracted AppImage) |
| macOS `.app` | `/Applications/Agaric.app/Contents/MacOS/agaric-mcp` |
| Windows installer | `C:\Program Files\Agaric\agaric-mcp.exe` |

Override the default socket path with the `--socket <path>` flag or `AGARIC_MCP_SOCKET` environment variable if your setup puts Agaric's data directory somewhere non-standard. The read-only socket is gated by a Settings → Agent access toggle (shipping with FEAT-4e).

### Project Structure

```text
src/                         # React frontend
  components/                #   UI components (JournalPage, BlockTree, GraphView, etc.)
    ui/                      #   Design system primitives (Button, Dialog, FilterPill, etc.)
    journal/                 #   Journal-specific components (MonthlyDayCell, etc.)
  editor/                    #   TipTap editor setup and extensions
    extensions/              #   Custom TipTap extensions (tag-ref, block-link, etc.)
  stores/                    #   Zustand state stores (11 stores: blocks, boot, journal, navigation, page-blocks, recent-pages, resolve, space, sync, tabs, undo)
  hooks/                     #   Custom React hooks (~53 hooks)
  lib/                       #   Tauri API wrappers, utilities, and bindings
  index.css                  #   Tailwind theme (OKLch colors, semantic tokens)
src-tauri/                   # Rust backend
  src/                       #   Commands, database, materializer, sync, merge
  migrations/                #   SQLite migrations (41 files, auto-run on startup)
  tests/                     #   Integration tests
  benches/                   #   Criterion benchmarks (24 bench files)
  icons/                     #   App icons (all platforms)
  tauri.conf.json            #   Tauri configuration
e2e/                         # Playwright E2E tests (29 spec files)
public/                      # Static assets (agaric.svg icon)
docs/BUILD.md                     # Complete build guide
AGENTS.md                    # Developer conventions
docs/ARCHITECTURE.md              # Architecture deep-dive
docs/FEATURE-MAP.md               # Complete feature inventory
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

Agaric is free software released under the GNU General Public License, version 3 or later. See [LICENSE](LICENSE) for the full terms.
