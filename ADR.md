# Architecture Decision Records — Pending & Future

> Implemented decisions have been moved to [ARCHITECTURE.md](ARCHITECTURE.md).
> This file contains only **pending, partial, or future** architectural decisions.

## Status Summary

| ADR | Title | Status | Remaining work |
|-----|-------|--------|----------------|
| 01 | Shell & Frontend | **Partial** | Export (P5). |
| 06 | Data Model | **Partial** | Export (P5) pending. |
| 16 | Build Order | **Reference** | Phase 5 remaining. Phase 4 complete. |
| 17 | Graph View | **Deferred** | Phase 5+. Schema supports it. |
| 20 | Content Storage | **Partial** | Export (P5) pending. |

**Legend:** P1=Phase 1, P2=Phase 2, etc. See ARCHITECTURE.md for all implemented decisions
(former ADR-02, 03, 04, 05, 07, 08, 09, 10, 11, 12, 13, 14, 15, 18, 19).

---

## ADR-01 — Shell & Frontend (Remaining)

**Implemented:** Tauri 2.0, React 18 + Vite, TipTap roving instance, Biome, specta bindings,
auto-split, keyboard handling, viewport observer. See ARCHITECTURE.md §1, §7.

**Pending:**

- **Export (Phase 5):** Markdown export with ULID → human name substitution. Not started.

---

## ADR-06 — Data Model (Remaining)

**Implemented:** Everything is a block, block types, integer positions, cascade delete/trash,
ID-based references, tags, pages, block links, conflict copies. See ARCHITECTURE.md §2.

**Pending:**

### Export (Phase 5)

Lossy by design. On export:
- `#[ULID]` → `#tagname` (from `tags_cache`)
- `[[ULID]]` → `[[Page Title]]` (from `pages_cache`)
- Properties → frontmatter YAML
- Attachments → filename reference

This produces standard Markdown + Obsidian-style wikilinks, readable in any Markdown editor.
Round-trip import (Markdown → blocks with ULID tokens) is deferred to Phase 5.

---

## ADR-16 — Build Order (Remaining Phases)

| Phase | Scope | Status |
|-------|-------|--------|
| 4 — Sync + Android | mDNS, pairing, op streaming, merge, Android spike. | **Complete.** |
| 5 — Polish | i18n, export (ULID → name substitution, Markdown output), auto-updates, graph view. | Pending. |

**Total at ~10 h/week:** 12–18 months. Daily driver by month 3–4.

**Non-negotiables:** op log append-only invariant, materializer CQRS split, three-way merge for
sync, pagination on all list queries.

---

## ADR-17 — Graph View (Deferred)

**Status:** Deferred to Phase 5+. Schema supports it (`block_links` table).

Block and tag relationships are already in the schema; the graph view is a visualisation layer
only. If built: react-force-graph on WebGL canvas.

**Rejected for v1:** D3, Cytoscape.

---

## ADR-20 — Content Storage Format (Remaining)

**Implemented:** Serializer (parse + serialize), FTS5 strip pass, diffy integration, TipTap
integration. See ARCHITECTURE.md §6.

**Pending:**

### Export (Phase 5)

On export, the serializer emits the storage Markdown string with ULIDs replaced by human names:
- `#[ULID]` → `#tagname` (from `tags_cache`)
- `[[ULID]]` → `[[Page Title]]` (from `pages_cache`)

This produces standard Markdown + Obsidian-style wikilinks, readable in any Markdown editor.
Round-trip import (Markdown → blocks with ULID tokens) is deferred to Phase 5.
