<!-- markdownlint-disable MD060 -->
# Agaric Features

What a user can do with Agaric. Each linked file is self-contained — open just the one you need.

Companion docs: [`docs/UI-MAP.md`](UI-MAP.md) (surface vocabulary + glossary) · [`docs/UX.md`](UX.md) (conventions for building UI) · `AGENTS.md` (architectural invariants) · [`docs/session-log/`](session-log/README.md) (chronological history; one file per session).

## Feature catalog

| Area | What you can do | Detail |
| --- | --- | --- |
| **Journal & agenda** | Daily / Weekly / Monthly / Agenda views over dated blocks; per-day Due / Done panels with source breakdown; projected future occurrences of repeating tasks. | [features/journal-and-agenda.md](features/journal-and-agenda.md) |
| **Editor** | Markdown-style formatting, block operations (split, merge, indent, drag, multi-select), inline tokens (page links, block refs, tags), task management, inline query blocks. | [features/editor.md](features/editor.md) |
| **Pickers & slash menu** | Inline pickers triggered by `[[`, `@`, `((`, `/`, `::`. The slash menu inserts tasks, dates, structure, properties, queries, repeat rules, emoji. | [features/pickers-and-slash.md](features/pickers-and-slash.md) |
| **Keyboard** | Every action is keyboard-reachable. Shortcuts are customisable. | [features/keyboard.md](features/keyboard.md) |
| **Properties** | Type-aware property values (text / number / date / boolean / select / ref), built-in properties for tasks (todo state, priority, due / scheduled / completed dates), repeat-rule properties. | [features/properties.md](features/properties.md) |
| **Tags & links** | First-class tags with hierarchy + boolean queries, ULID-anchored block / page links that survive renames, linked + unlinked backlinks, inline `{{query …}}` blocks. | [features/tags-and-links.md](features/tags-and-links.md) |
| **Spaces** | Partition pages into user-defined contexts (e.g. Personal, Work). Each space has its own journal, templates, accent colour, tabs, recent pages, and is reachable via a dedicated hotkey. | [features/spaces.md](features/spaces.md) |
| **Sync** | Local WiFi peer-to-peer. Pair devices by QR code or 4-word passphrase. Edits converge via CRDT — no cloud, no conflict dialogs. | [features/sync.md](features/sync.md) |
| **Agent access** | Read-only and read-write MCP tools for AI agents (Claude, Cursor, Continue, etc.); an in-app activity feed; `agaric://` deep links. | [features/agent-access.md](features/agent-access.md) |
| **Views** | Search, Pages browser, Tags browser, Trash, History, Templates, Graph, Status, Settings. | [features/views.md](features/views.md) |
| **Import & export** | Markdown / Logseq import; per-page export with YAML front-matter; export-all-as-ZIP. | [features/import-export.md](features/import-export.md) |

## Cross-cutting facts

A handful of facts touch every feature; rather than repeat them in each file:

- **All UI is keyboard-reachable.** See [features/keyboard.md](features/keyboard.md).
- **All text is internationalised** via i18next. Every visible string — toasts, ARIA labels, empty states, error messages — passes through `t()`.
- **All interactive elements meet a 44 px touch floor** on coarse-pointer devices (see `docs/UX.md` § Touch & responsive).
- **All edits are offline-first.** They land in the local SQLite database first and sync afterwards (see [features/sync.md](features/sync.md)).
- **Everything is space-scoped by default.** The active space filters every list, search, agenda, backlink and history view (see [features/spaces.md](features/spaces.md)).
- **Reduced motion is respected** globally; JS-driven animations check explicitly (see `docs/UX.md` § Accessibility).

## Roadmap

Features that aren't yet shipped or that are intentionally deferred are tracked separately. The major outstanding items today:

- **OS notifications** for due tasks and scheduled events (Android-mobile parity).
- **Per-space Google Calendar push** — foundation landed; the connector still pushes one calendar for all spaces.
- **Google Calendar on Android** — desktop only today (loopback OAuth + Keychain are non-portable).
- **iroh transport** (replaces the current mDNS + WebSocket + TLS + TOFU stack) — scoped, not yet started.
