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
| ↳ Converging the `sql_only` apply fallback with the projection helpers | [`architecture/sql-only-convergence.md`](architecture/sql-only-convergence.md) |
| ↳ Rollback-safe engine apply | [`architecture/rollback-safe-engine-apply.md`](architecture/rollback-safe-engine-apply.md) |
| Sync transport + protocol + Android constraints | [`architecture/sync-and-network.md`](architecture/sync-and-network.md) |
| ↳ Sync protocol specification (message framing, handshake) | [`architecture/sync-protocol-spec.md`](architecture/sync-protocol-spec.md) |
| Integrations (MCP / agent access) | [`architecture/integrations.md`](architecture/integrations.md) |
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
3. **CRDT convergence.** The Loro engine fans out every op into per-space CRDT state. Concurrent edits converge automatically; no merge dialog, no conflict UI. One honest boundary: character-level merge applies to edits *committed as ops*, and in-progress typing stays frontend-local until it commits (principle 4). See [`architecture/editor-and-content.md`](architecture/editor-and-content.md) § FE / BE authority boundary.
4. **Roving editor, one per mounted tree.** Exactly one block hosts a mounted TipTap editor surface at a time — focus is global — and everything else renders static. The `Editor` objects behind it are per `BlockTree`, not per app: the journal week and stream views mount one tree (and one lazily-constructed editor) per day — the month view is a calendar grid and mounts none — so app-level code reaches the live editor through the focus-published registry `src/editor/active-editor.ts`. See [`architecture/editor-and-content.md`](architecture/editor-and-content.md) § Roving-editor invariant.
5. **Type-safe IPC.** Every Tauri command flows through specta-generated TypeScript. The `agaric_commands!` macro is the single source of truth — handler and bindings cannot drift.
6. **Per-space partitioning.** The native, indexed `blocks.space_id` column (migration 0086, #533) is the sole source of truth for space membership — with a `spaces` registry FK (0089), and `space` forbidden as a `block_properties` key (0088 `key_not_reserved` CHECK). An `is_space = 'true'` property still marks a space's own page. Lists, search, agenda, backlinks, history, journals all scope to the active space via the `b.space_id = ?N` filter.
7. **Offline-first sync.** Local writes commit immediately; sync converges peers over local WiFi via Loro CRDT messages over QUIC (iroh), with each peer named by a handshake-authenticated ed25519 `EndpointId`.
8. **Tokens, not literals.** OKLCH semantic tokens, i18n for every visible string, 44 px touch floor — see `docs/UX.md`.

## Reading order for a new contributor

1. `AGENTS.md` § Key Architectural Invariants — the rules.
2. This file (orientation).
3. [`architecture/data-and-events.md`](architecture/data-and-events.md) — the data model + how writes flow through the op log.
4. The area you're touching.

## What lives where

The Rust side is a Cargo workspace rooted at `src-tauri/`. Its members (see `[workspace]` in `src-tauri/Cargo.toml`):

| Crate | Owns |
| --- | --- |
| `.` — the app crate `agaric` (lib target `agaric_lib`) | Tauri commands, materializer, MCP server, deep links, spaces, recovery, the `agaric-mcp` sidecar binary |
| `agaric-core` | Leaf primitives with no DB dependency — ULIDs, time, errors, text/tag normalisation, diffing |
| `agaric-store` | SQLite access — op log (incl. the `op_log/bypass.rs` `truncate` / `prune` deletion carve-outs), caches, FTS, filters, queries, pagination |
| `agaric-engine` | Loro CRDT engine, op apply, merge, drafts, import, recurrence |
| `agaric-sync` | Peer discovery (mDNS), pairing, the iroh QUIC transport, sync protocol + daemon — **plus snapshot create/restore and op-log compaction** (`src-tauri/agaric-sync/src/snapshot/`) |
| `agaric-observability` | Tracing / OTLP / metrics plumbing |
| `diagnostics` | Read-only DB inspection binaries, kept out of the app crate so `tauri-bundler` doesn't scan them |

> **Snapshots live in `agaric-sync`, but they are not sync-only.** `create_snapshot`, `apply_snapshot` and `compact_op_log` (`src-tauri/agaric-sync/src/snapshot/`) serve two callers, not one. **Compaction is app-crate-only:** `compact_op_log` is reached through the user-facing `compact_op_log_cmd` (`src-tauri/src/commands/compaction.rs`, registered in `src-tauri/src/lib.rs`) and boot recovery, never from the protocol. **Snapshot transfer is not:** `sync_daemon/snapshot_transfer.rs` imports `apply_snapshot` and calls it in the peer catch-up path, and serves the offer side from the rows `create_snapshot` persisted, via `get_latest_snapshot_with_frontier`. So the compaction carve-out to invariant #1 ("the op log is append-only *except compaction*") is reached from `agaric-sync`, not from `agaric-store`, whose own `op_log/bypass.rs` holds only the row-deletion primitives (`truncate` for a snapshot RESET wipe, `prune` for compaction) those paths call. Details in [`architecture/crdt-and-recovery.md`](architecture/crdt-and-recovery.md).

- **Schema / migrations**: `src-tauri/migrations/*.sql` (auto-run; `sqlx` compile-time validated; offline caches in `.sqlx/`, one per crate that holds query macros).
- **Frontend code**: `src/` (components, editor, hooks, stores, lib).
- **Bindings**: `src/lib/bindings.ts` (specta-generated; checked in; CI fails on drift). Frontend call sites are mid-migration (#2927) from the hand-written wrappers in `src/lib/tauri/` onto the generated bindings; `src/lib/tauri.ts` is now just a barrel re-exporting that directory.
- **Tests**: Rust unit + integration tests are colocated under `src-tauri/` as `#[cfg(test)] mod tests`, `*/tests.rs`, `integration_tests.rs`, and `tests/command_integration/` — see [`src-tauri/tests/AGENTS.md`](../src-tauri/tests/AGENTS.md) for the layering. Frontend tests live in `src/**/__tests__/`, e2e specs in `e2e/`.
- **Backlog**: tracked on the GitHub issue tracker.
