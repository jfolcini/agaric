# Project Milestones

High-level trajectory of Agaric. For full detail see [`SESSION-LOG.md`](SESSION-LOG.md) (sessions 401+) and [`docs/session-log/2024-2025.md`](docs/session-log/2024-2025.md) (sessions 1-400).

## 2026 May

- **2026-05-01** — Session 596: FEAT-3p9 M1 ships per-space GCal config foundation (gcal_space_config table, per-space keychain, legacy migration).
- **2026-05-01** — Session 595: FEAT-4 family entirely closed (MCP RW, agent access, observability, activity feed, Undo); FEAT-4i mobile-only carve-out dropped.
- **2026-05-01** — Session 594: MAINT-111 rmcp spike done — 3-milestone migration plan validated (12-14h).
- **2026-05-01** — Session 593: M-51 + L-67 closure — sync attachment + snapshot transfers stream (O(file_size) heap dropped).
- **2026-05-01** — Session 592: M-19 closure — cache rebuilds stream (block_tag_refs / agenda / projected_agenda).
- **2026-05-01** — Session 591: decisions cluster M-34 + M-81 + M-85 closure (pairing QR, conflict re-parent, list_tags/defs pagination).
- **2026-05-01** — Session 589: FEAT-3p4 Spaces Phase 4 closure — cross-space query scoping + per-space currentView.

## 2026 April

- **2026-04-30** — Session 586: C-2b op-log replay closes the last CRITICAL backend finding (CQRS automatic-divergence gap).
- **2026-04-30** — Sessions 559 – 580 (MAINT-118, MAINT-124, MAINT-125, MAINT-127, MAINT-128, MAINT-130, MAINT-131): god-component / store / hook decompositions across editor, page-blocks, history, conflict, settings.
- **2026-04-29** — Sessions 525 – 555: ~50+ backend LOW / MEDIUM / INFO findings closed in batches.
- **2026-04-23** — Session 467: FEAT-7 + FEAT-8 + FEAT-9 navigation cluster shipped (tab autohide, recent pages, swipe-to-open).
- **2026-04-23** — Session 463: FEAT-4c emission wiring + FEAT-4h slice 3 activity-feed Undo.
- **2026-04-22** — Session 460: FEAT-4h slice 2 — MCP RW server + Settings toggle.
- **2026-04-21** — Session 450: FEAT-4g + FEAT-5d + FEAT-5b — MCP + GCal + OAuth landed together.
- **2026-04-19** — Session 420: MAINT-48 React 18 → 19 major upgrade (40 files, zero breaking changes).
- **2026-04-18 onwards** — Sessions 401 – 419: tier-3+ accessibility + UX polish wave.

## Earlier 2026 / 2025 / 2024

See [`docs/session-log/2024-2025.md`](docs/session-log/2024-2025.md) for sessions 1 – 400, including: spaces phases 1-3, sync daemon + pairing + cert pinning, op-log + materializer + CQRS, FTS5 trigram, undo/redo + history view, agenda dashboard, Tauri 2 migration, React + Tailwind 4 upgrade, Android target, initial release pipeline.
