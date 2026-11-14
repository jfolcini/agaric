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

Agaric is a note-taking app for one person and their own devices. Notes are blocks in an outline, the default view is a daily journal, and everything lives in a local database that syncs directly between your devices over your own network. There is no account, no server and no cloud copy. It runs on **Linux**, **Windows**, **macOS** and **Android**, and takes its ideas from Org-mode and Logseq.

It is free software (GPL-3.0-or-later), pre-1.0, and has [one maintainer](GOVERNANCE.md).

## Who it is for

Someone who thinks in outlines, keeps a daily journal, tracks tasks beside their notes, and wants a phone and a computer to hold the same notes without a subscription or a third party in between.

## What it does not do

- **No cloud and no sync from anywhere.** Devices find each other on one local network. An off-by-default internet fallback relays between devices that have already paired; it is not a hosted service.
- **No iOS build**, and none is planned for now.
- **No plugins or scripting.** What you can change is the keyboard shortcuts, the theme, a custom stylesheet, and what an agent does through MCP.
- **No collaboration, sharing or publishing.** One user, their devices.
- **Your notes are not Markdown files.** They are rows in a SQLite database. A Markdown export, an import and an optional desktop mirror folder are the routes to and from files.
- **No encryption at rest.** The database is a plain file; use your operating system's disk encryption (LUKS, FileVault, BitLocker).
- **No built-in AI.** An agent connects from outside, through MCP, if you turn that on.
- **English interface.** Spanish covers error messages only so far.

## What you can do

**Outline.** Every paragraph, heading, task or code snippet is a block with its own id. Blocks nest (to `MAX_BLOCK_DEPTH`), fold, drag, zoom and multi-select. A page is a block that holds blocks; page titles can be namespaced (`work/meetings/standup`).

**Write.** *Block mode* edits one block at a time, with the Markdown syntax shown around the cursor. *Page mode* (off by default; `Ctrl+E`, or Settings › Editor) edits the whole page as one document while each block keeps its id. *Edit as Markdown* opens the page as plain Markdown text, with a preview and a diff before you save. All three write the same blocks.

**Format.** Bold, italic, strikethrough, highlight, underline, inline code, headings, bulleted, numbered and task lists, quotes and callouts, tables, footnotes, code blocks with highlighting, math (KaTeX) and Mermaid diagrams. Pasted Markdown or HTML becomes blocks.

**Link.** `[[page]]` links and `#tags` are stored by id, so a rename breaks nothing. `((block))` references show as a chip with a peek; `/embed` shows a block or a page live inside another page. Each page lists what links to it, and what mentions it without linking. A graph shows pages and their links.

**Journal.** One page per day, made from your journal template, shown as a day, a week, a month, a continuous stream, or an agenda of tasks.

**Tasks.** A block can be `TODO`, `DOING`, `DONE` or `CANCELLED` (`Ctrl+Enter` cycles), with a priority, due and scheduled dates, and a repeat rule. The Agenda filters, sorts and groups tasks and lists the future occurrences of repeating ones. On desktop, an optional reminder notifies you of tasks on their due date while the app is running.

**Properties.** Typed values on any block or page: text, number, date, select, reference, boolean, URL. Definitions belong to a space and can be renamed, merged and retyped.

**Query.** A `{{query tag:#work state:TODO}}` block lists the matching blocks live inside a page, as a list or as a table with the columns you pick. The Advanced Query view filters by tags, properties, task state, dates and links with nested AND / OR / NOT, sorts, groups and summarises, and can lay the results out as a board with one column per task state or select option, where *Move to…* moves a card. A query can be saved as a view.

**Search.** Full-text search over every block (SQLite FTS5) with filters such as `tag:`, `state:` and `due:`; find and replace in the open page; replace across pages with a preview and an undo. See [docs/SEARCH.md](docs/SEARCH.md).

**Spaces.** Separate contexts such as Personal and Work in one database, each with its own journal, pages, tags, property definitions, tabs and accent colour. `Alt+1` … `Alt+9` switch between them.

**Files and media.** Attach files to blocks. Images show inline; audio plays inline, and `/voice` records a voice note. A PDF opens in a reader whose highlights and pinned comments become blocks under the PDF's block when you save. Where the operating system has a voice (macOS, Windows, Android), Agaric reads a block or a page aloud.

**Capture.** A system-wide Quick Capture hotkey on desktop (`Ctrl+Alt+N`), and `agaric://` links that open a page, a block, or Quick Capture with text (desktop only).

**History and undo.** Every change is an operation in a log. Undo works per page, the History view shows who changed what and can restore a page to an earlier point, and deleted blocks wait in the Trash before they are purged.

**Fast on a large vault.** Interactive commands are held to latency budgets on a vault of `FIXTURE_SIZE` blocks, checked weekly by [`src-tauri/benches/interactive_slo.rs`](src-tauri/benches/interactive_slo.rs): reading a block within a millisecond, saving an edit or creating a block within a few, loading a page within tens, and the heaviest reads within the product target of 200 ms. The budgets are the `BUDGET_MS` constants in that file; [docs/architecture/operations.md](docs/architecture/operations.md#product-slo) says what the gate measures and which commands it leaves out.

**Templates, tabs, bookmarks, back and forward, a command palette, rebindable shortcuts, themes, a custom stylesheet and printing** are there too. [docs/FEATURE-MAP.md](docs/FEATURE-MAP.md) is the full inventory.

## Getting notes in and out

- **Import** Markdown files and folders, an Obsidian vault, a Logseq graph, Org files, a Notion export, Evernote (`.enex`), Joplin (`.jex`) and BibTeX / CSL-JSON bibliographies. Importing a file again updates its page in place.
- **Export** one page as Markdown, or a space or every space as a ZIP of Markdown files with their attachments. A folder import of that ZIP, unzipped, restores the spaces. It does not restore history or the Trash.
- **Markdown mirror** (desktop, off by default): keeps every page as a `.md` file in a folder you choose, and reads edits made there back into the page. The database stays the source of truth.

Details and limits: [docs/features/import-export.md](docs/features/import-export.md).

## Sync

Two of your devices pair once, by QR code or a four-word passphrase, and then sync whenever both are running on the same local network. An edit reaches the other device a few seconds after you stop typing.

- **Direct.** Devices discover each other by mDNS and talk over QUIC ([iroh](https://www.iroh.computer/)), each identified by its own key. Nothing is stored anywhere else.
- **No conflicts to resolve.** Edits merge through a CRDT ([Loro](https://loro.dev/)): text, the block tree, properties, tags and attachments converge without a dialog.
- **Limits.** Both devices must be on one network to pair, and normally to sync. Android syncs only while the app is in the foreground. Two devices on different versions of Agaric do not sync until both are updated. A network that isolates its clients, or a VPN that captures the LAN, stops it; [docs/features/sync.md](docs/features/sync.md) lists the cases and the fixes.
- **Internet fallback** (off by default, set on both devices): when the direct path fails, traffic goes through a relay run by iroh's maintainers, which forwards encrypted data it cannot read but sees which devices talk and when.

## How your notes are stored

Three layers, each with one job ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

1. **The op log** is the history: an append-only, hash-chained list of typed operations. Undo, the History view and attribution read it.
2. **The Loro engine** is the merge truth: one CRDT document per space holding text, the block tree and properties. Sync exchanges its changes, and recovery rebuilds from it.
3. **The SQLite tables** are the query view: what every list, search, agenda and backlink reads, derived from the engine and rebuilt from it in recovery.

All three live in one SQLite file, `notes.db`.

Safety nets: a daily snapshot of the database kept beside it, a copy before each update that changes the schema, an integrity check in Settings › App health, and, when the vault will not open, a dialog that links the [recovery steps](docs/TROUBLESHOOTING.md#8-agaric-failed-to-start-the-vault-will-not-open). None of these is a backup on another disk; the export ZIP and a second paired device are.

The data folder holds `notes.db`, the attachments, the snapshots and the log:

| Platform | Data folder |
| --- | --- |
| Linux | `~/.local/share/com.agaric.app/` (under `$XDG_DATA_HOME` when set) |
| macOS | `~/Library/Application Support/com.agaric.app/` |
| Windows | `%APPDATA%\com.agaric.app\` |
| Android | `/data/data/com.agaric.app/`, private to the app |

**What leaves your device.** No telemetry and no analytics. Besides sync with your paired devices, the desktop app asks GitHub at start, at most once a day, whether a newer release exists, and a web link in your notes is fetched from its own site for a preview when you paste or hover it (Settings › Editor turns the hover fetch off).

## Install

Download the installer for your system from [**GitHub Releases**](https://github.com/jfolcini/agaric/releases).

| System | Needs | File |
| --- | --- | --- |
| **Linux** (x86-64) | A distribution at least as new as the one releases are built on (Ubuntu 24.04, Debian 13, Fedora 40) and `libwebkit2gtk-4.1` | `.deb`, `.rpm` or `.AppImage` |
| **Windows** (x64) | Windows 10 or later. The installer fetches WebView2 when it is missing | `-setup.exe` or `.msi` |
| **macOS** | Apple Silicon or Intel | `.dmg` (`aarch64` or `x64`) |
| **Android** | Android 11 (API 30) or later, 64-bit ARM (`arm64-v8a`) only | `.apk` |

The desktop app updates itself from GitHub Releases. Agaric is in no app store or package repository yet: a winget manifest is written but not submitted ([packaging/winget](packaging/winget/README.md)), and Flathub is not submitted either ([packaging/flathub](packaging/flathub/README.md)).

Desktop installers are **not code-signed** ([docs/BUILD.md § Signing posture](docs/BUILD.md#signing-posture)), so the system warns on first launch:

- **macOS (Gatekeeper):** try to open the app once, then open *System Settings* → *Privacy & Security*, scroll to *Security*, click *Open Anyway*, and click *Open* when the warning returns ([Apple's steps](https://support.apple.com/en-us/102445)). Or clear the quarantine flag: `xattr -dr com.apple.quarantine /Applications/Agaric.app`.
- **Windows (SmartScreen):** click *More info* → *Run anyway*.

The Android `.apk` is signed but distributed outside the Play Store:

- Enable *Install unknown apps* for the browser or file manager you open the `.apk` with, then tap the file. [Obtainium](https://obtainium.imranr.dev/) can track the releases and tell you about updates.
- Updates must carry the same signature. If one is rejected with a signature error, **sync the phone with a computer first: uninstalling deletes every note on the phone**, and Agaric keeps its data out of Android backups. Then uninstall, install the new build and pair again; the first sync brings the notes back.
- A new phone is set up the same way, by installing and pairing. Android's backup and phone-to-phone transfer carry neither the notes nor the device's identity.

## Using Agaric with MCP clients

Agaric can serve its notes to MCP clients such as Claude Desktop, Claude Code, Cursor and Continue. It is **off by default**, listens on a local socket (never a network port), and is desktop only.

1. Turn it on in Settings › Agent access and add an agent: a name, read-only or read-write, the spaces it may use. Each agent gets its own token.
2. Copy the config from the agent's row into your client. It runs the `agaric-mcp` bridge that ships beside the app, with `--socket <path>` and `--token <token>`. The config names the bridge without a path, which works where it is on your `PATH` (`/usr/bin/agaric-mcp` from the `.deb` or `.rpm`). Elsewhere, put its full path in the config's `command`: `/Applications/Agaric.app/Contents/MacOS/agaric-mcp` on macOS, `agaric-mcp.exe` in the install folder on Windows.

Agents read, search, query and write through the same operations the app uses, so their edits are attributed in History and can be undone. `agaric-mcp call <tool> <json>` runs one tool from a script. Tools and limits: [docs/features/agent-access.md](docs/features/agent-access.md).

## Compared with

- [Agaric and Logseq](COMPARISON-LOGSEQ.md)
- [Agaric and Obsidian](COMPARISON-OBSIDIAN.md)

## Development

React 19, TipTap and Tailwind on [Tauri 2](https://v2.tauri.app/), with a Rust backend over SQLite (sqlx) and Loro.

```bash
bash scripts/setup.sh                            # Node, dependencies, .env, dev database, git hooks
cargo tauri dev                                  # the desktop app with hot reload
npm run dev                                      # the frontend alone in a browser, on a mock backend
npm test                                         # frontend tests (Vitest)
cd src-tauri && cargo nextest run --workspace    # Rust tests
npx playwright test                              # end-to-end tests on the mock backend
```

Each desktop platform is built on that platform; Android builds on Linux. Releases are cut by the maintainer with `scripts/release.sh`.

- [docs/BUILD.md](docs/BUILD.md): prerequisites per platform, Android, testing, CI, releasing, troubleshooting. The optional [`justfile`](justfile) wraps the same commands (`just --list`).
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the data model, the op log, the editor, sync, search.
- [AGENTS.md](AGENTS.md): conventions and invariants for contributors, human or not. [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) cover the rest.
- [docs/UX.md](docs/UX.md) and [docs/UI-MAP.md](docs/UI-MAP.md): interface conventions and vocabulary.

## License

Agaric is free software released under the GNU General Public License, version 3 or later. See [LICENSE](LICENSE) for the full terms.
