<!-- markdownlint-disable MD060 -->
# Agaric Features

What a user can do with Agaric. Each linked file is self-contained — open just the one you need.

Companion docs: [`docs/UI-MAP.md`](UI-MAP.md) (surface vocabulary + glossary) · [`docs/UX.md`](UX.md) (conventions for building UI) · `AGENTS.md` (architectural invariants) · [`docs/session-log/`](session-log/README.md) (chronological history; one file per session).

## Feature catalog

| Area | What you can do | Detail |
| --- | --- | --- |
| **Journal & agenda** | Daily / Weekly / Monthly / Agenda views over dated blocks; per-day Due / Done panels with source breakdown; projected future occurrences of repeating tasks. | [features/journal-and-agenda.md](features/journal-and-agenda.md) |
| **Editor** | Markdown-style formatting, block operations (split, merge, indent, drag, multi-select), inline tokens (page links, block refs, tags), task management, inline query blocks. | [features/editor.md](features/editor.md) |
| **Pickers & slash menu** | Inline pickers triggered by `[[`, `@`, `((`, `{{`, `/`, `::`, `:`. The slash menu inserts tasks, dates, structure, properties, queries, repeat rules, emoji. | [features/pickers-and-slash.md](features/pickers-and-slash.md) |
| **Keyboard** | Every action is keyboard-reachable. Shortcuts are customisable. | [features/keyboard.md](features/keyboard.md) |
| **Properties** | Type-aware property values (text / number / date / boolean / select / ref), built-in properties for tasks (todo state, priority, due / scheduled / completed dates), repeat-rule properties. | [features/properties.md](features/properties.md) |
| **Tags & links** | First-class tags with hierarchy + boolean queries, ULID-anchored block / page links that survive renames, linked + unlinked backlinks, inline `{{query …}}` blocks. | [features/tags-and-links.md](features/tags-and-links.md) |
| **Spaces** | Partition pages into user-defined contexts (e.g. Personal, Work). Each space has its own journal, templates, accent colour, tabs, recent pages, and is reachable via a dedicated hotkey. | [features/spaces.md](features/spaces.md) |
| **Sync** | Local WiFi peer-to-peer. Pair devices by QR code or 4-word passphrase. Edits converge via CRDT — no cloud, no conflict dialogs. | [features/sync.md](features/sync.md) |
| **Agent access** | Read-only and read-write MCP tools for AI agents (Claude, Cursor, Continue, etc.); an in-app activity feed; `agaric://` deep links. | [features/agent-access.md](features/agent-access.md) |
| **Views** | Search, Pages browser, Tags browser, Trash, History, Templates, Graph, Status, Settings. | [features/views.md](features/views.md) |
| **Import & export** | Markdown / Logseq import; BibTeX / CSL-JSON bibliography import to typed reference pages; per-page export with YAML front-matter; export-all-as-ZIP. | [features/import-export.md](features/import-export.md) |
| **Media & attachments** | Inline image rendering with resize handles and a zoom/pan lightbox; file attachments with drag-drop upload, MIME-type icons, and progress / rejection toasts. | `src/components/attachments/`, `src/components/rendering/` |
| **Emoji picker** | Full emoji dataset browsable via the `/emoji` slash command or a toolbar button; inserts the native character at the caret. | `src/components/EmojiPicker/` |
| **Draft autosave** | In-progress editor content is saved as you leave a block and restored at boot if the app crashed mid-edit. | `src/hooks/useDraftAutosave.ts`, `src-tauri/src/commands/drafts.rs` |
| **Debounced content commit** | Typing commits to the op log on a short idle debounce (not only on blur), so two devices editing the same block interleave through the `LoroText` char-CRDT instead of one blur overwriting the other (#2600). A per-block undo coalesce key keeps those commits a single Ctrl+Z. | `src/hooks/useDebouncedContentCommit.ts` |
| **Optimistic block writes** | Structural block edits — create, remove, reorder, indent/dedent, move — apply instantly and confirm or roll back on the IPC result (#2849). New blocks carry a **client-generated ULID**, so focus and selection never relocate to a server-assigned id. | `src/lib/block-id.ts`, `src/stores/page-blocks-reducers.ts`, `src/stores/page-blocks-move.ts` |
| **Page-open prefetch** | Hovering or focusing a page link (or a Pages-list row scrolling into reach) warms that page's block subtree before the click lands, hiding the load round-trip (#2850). A one-shot speculative handoff with a short TTL — not a persistent cache — that `load()` consumes while running every existing guard unchanged. | `src/lib/prefetch-page-subtree.ts`, `src/hooks/usePagePrefetchIntent.ts` |

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

- **OS notifications** — _partial_. A fire-now `notify_task` command ships (`src-tauri/src/commands/notifier.rs`; Linux via notify-rust, macOS/Windows via `tauri-plugin-notification`), wired through `src/lib/tauri/notifications.ts`. The scheduler, dedupe ledger, snooze semantics, and Settings sub-tab that would auto-fire for due tasks / scheduled events (incl. Android-mobile parity) remain outstanding (#138).
- **iroh transport** (replaces the current mDNS + WebSocket + TLS + TOFU stack) — scoped, not yet started.
