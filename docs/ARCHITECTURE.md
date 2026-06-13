<!-- markdownlint-disable MD060 -->
# Agaric Architecture

How the system is built. Companion to:

- [`docs/UI-MAP.md`](UI-MAP.md) — surface vocabulary + glossary
- [`docs/UX.md`](UX.md) — UI conventions
- [`docs/FEATURE-MAP.md`](FEATURE-MAP.md) — what users can do
- [`docs/BUILD.md`](BUILD.md) — build / test / release
- `AGENTS.md` — architectural invariants (root)
- `docs/session-log/` — chronological history (one file per session: `session-NNN-<slug>.md`; sessions 1 – 800 in two archive files)

## Map

| Area | File |
| --- | --- |
| Stack + data model + database + op log + materializer | [`architecture/data-and-events.md`](architecture/data-and-events.md) |
| ↳ Op-log wire format (byte layout, versioning) | [`architecture/op-log-format.md`](architecture/op-log-format.md) |
| ↳ Schema-design lessons learned | [`architecture/schema-lessons.md`](architecture/schema-lessons.md) |
| Content format, serializer, editor architecture, undo/redo | [`architecture/editor-and-content.md`](architecture/editor-and-content.md) |
| Frontend architecture + spaces (stores, ViewDispatcher, per-space slicing) | [`architecture/frontend.md`](architecture/frontend.md) |
| Pages view (density, sort modes, grooming) | [`architecture/pages-view.md`](architecture/pages-view.md) |
| Filters (compound grooming + agenda filter model) | [`architecture/filters.md`](architecture/filters.md) |
| CRDT convergence + snapshots + crash recovery | [`architecture/crdt-and-recovery.md`](architecture/crdt-and-recovery.md) |
| Sync transport + protocol + Android constraints | [`architecture/sync-and-network.md`](architecture/sync-and-network.md) |
| ↳ Sync protocol specification (message framing, handshake) | [`architecture/sync-protocol-spec.md`](architecture/sync-protocol-spec.md) |
| Integrations (Google Calendar, MCP / agent access) | [`architecture/integrations.md`](architecture/integrations.md) |
| Search + query system | [`architecture/queries.md`](architecture/queries.md) |
| ↳ Full-text search engine (FTS5, trigram, ranking) | [`architecture/search.md`](architecture/search.md) |
| Bindings + dev tooling + security boundary | [`architecture/tooling.md`](architecture/tooling.md) |
| ↳ CI + tooling pipeline | [`architecture/ci-and-tooling.md`](architecture/ci-and-tooling.md) |
| ↳ Threat model (trust boundaries, accepted risks) | [`architecture/threat-model.md`](architecture/threat-model.md) |
| Performance posture + scalability + roadmap pointer | [`architecture/operations.md`](architecture/operations.md) |
| Rejected alternatives (decision archaeology) | [`architecture/rejected.md`](architecture/rejected.md) |

## Core principles

1. **Local-first.** SQLite on disk; no cloud, no accounts.
2. **Event-sourced.** Every state change is an append-only op log entry. Materialized views are derivable; the op log is the truth.
3. **CRDT convergence.** Loro engine fans out every op into per-space CRDT state. Concurrent edits converge automatically; no merge dialog, no conflict UI.
4. **Single roving editor.** Exactly one block hosts a TipTap editor at a time; everything else renders static.
5. **Type-safe IPC.** Every Tauri command flows through specta-generated TypeScript. The `agaric_commands!` macro is the single source of truth — handler and bindings cannot drift.
6. **Per-space partitioning.** A `space` ref-property on every page partitions the vault. Lists, search, agenda, backlinks, history, journals all scope to the active space.
7. **Offline-first sync.** Local writes commit immediately; sync converges peers over local WiFi via Loro CRDT messages + TLS-pinned WebSocket.
8. **Tokens, not literals.** OKLCH semantic tokens, i18n for every visible string, 44 px touch floor — see `docs/UX.md`.

## Reading order for a new contributor

1. `AGENTS.md` § Key Architectural Invariants — the rules.
2. This file (orientation).
3. [`architecture/data-and-events.md`](architecture/data-and-events.md) — the data model + how writes flow through the op log.
4. The area you're touching.

## What lives where

- **Schema / migrations**: `src-tauri/migrations/*.sql` (auto-run; `sqlx` compile-time validated; offline cache in `.sqlx/`).
- **Backend code**: `src-tauri/src/` (commands, materializer, sync, Loro engine, recurrence, FTS, snapshot, GCal, MCP).
- **Frontend code**: `src/` (components, editor, hooks, stores, lib).
- **Bindings**: `src/lib/bindings.ts` (specta-generated; checked in; CI fails on drift).
- **Tests**: `src-tauri/tests/` (Rust integration), `src/**/__tests__/` (frontend), `e2e/` (Playwright).
- **Backlog**: tracked on the GitHub issue tracker.
