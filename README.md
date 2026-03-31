# Block Notes (Agaric)

A local-first, block-based note-taking app for Linux desktop (and eventually Android). Inspired by Org-mode and Logseq — journal-first, with powerful tagging and emergent structure. No cloud, no accounts. Your data lives on your machine.

## What is it?

Block Notes treats everything as a **block** — paragraphs, headings, code snippets, tasks. Blocks live in a tree: pages contain blocks, blocks can nest infinitely. Tags and links are first-class citizens that connect your knowledge graph.

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
- **System deps** (Linux): `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev` (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

### Running the App

```bash
# Start the full Tauri app (frontend + backend) with hot reload
cargo tauri dev
```

This starts:
1. Vite dev server on `http://localhost:5173`
2. Rust backend compiled and launched with a WebKit webview

### Running Tests

```bash
# Frontend tests (Vitest)
npm test                    # single run
npm run test:watch          # watch mode
npm run test:coverage       # with v8 coverage

# Backend tests (Rust)
cd src-tauri && cargo nextest run

# E2E tests (Playwright)
npx playwright test
```

### Building for Production

```bash
cargo tauri build
```

Produces a `.deb` and `.AppImage` in `src-tauri/target/release/bundle/`.

### Linting and Formatting

```bash
npm run lint                # Biome check
npm run lint:fix            # Biome auto-fix
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy -- -D warnings
```

### Pre-commit Hooks

The project uses `prek` for pre-commit hooks. They run automatically on `git commit` — no need to manually run the full suite beforehand:

```bash
prek run --all-files        # run all hooks on entire repo
prek run                    # run on staged files only
```

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
├── ADR.md                  # Architecture Decision Records
└── COMPARISON.md           # Feature comparison with Logseq
```

### Key Architecture Notes

- **Op log is append-only** — all mutations are recorded as operations; the materializer derives current state (CQRS pattern)
- **Cursor-based pagination** on all list queries — no offset pagination
- **Single TipTap instance** — roving editor pattern for performance
- **sqlx compile-time queries** — SQL is checked at compile time; `.sqlx/` cache is committed
- **TypeScript bindings** auto-generated from Rust types via specta; regenerate with `cd src-tauri && cargo test -- specta_tests --ignored`

## Database

SQLite database stored at `~/.local/share/com.blocknotes.app/notes.db`. WAL mode with foreign keys enforced. 1 writer + 4 reader connection pool.

## License

Private project — not yet licensed for distribution.
