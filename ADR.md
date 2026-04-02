# Architecture Decision Records — Pending & Future

> Implemented decisions have been moved to [ARCHITECTURE.md](ARCHITECTURE.md).
> This file contains only **pending, partial, or future** architectural decisions.

## Status Summary

| ADR | Title | Status | Remaining work |
|-----|-------|--------|----------------|
| 01 | Shell & Frontend | **Partial** | Export (P5). TanStack Query not started. |
| 02 | State Management | **Partial** | TanStack Query (P3+) pending. |
| 03 | UI Components | **Partial** | Noto Sans bundling deferred to P5 (i18n). |
| 06 | Data Model | **Partial** | Export (P5) pending. |
| 12 | Search | **Partial** | Tantivy + lindera CJK search (P5). |
| 16 | Build Order | **Reference** | Phase 5 remaining. Phase 4 complete. |
| 17 | Graph View | **Deferred** | Phase 5+. Schema supports it. |
| 19 | CJK Support | **Partial** | Tantivy + lindera (P5). |
| 20 | Content Storage | **Partial** | Export (P5) pending. |

**Legend:** P1=Phase 1, P2=Phase 2, etc. See ARCHITECTURE.md for all implemented decisions
(former ADR-04, 05, 07, 08, 09, 10, 11, 13, 14, 15, 18).

---

## ADR-01 — Shell & Frontend (Remaining)

**Implemented:** Tauri 2.0, React 18 + Vite, TipTap roving instance, Biome, specta bindings,
auto-split, keyboard handling, viewport observer. See ARCHITECTURE.md §1, §7.

**Pending:**

- **Export (Phase 5):** Markdown export with ULID → human name substitution. Not started.
- **TanStack Query:** Planned for Phase 3+ to manage server state with Tauri event invalidation.
  Not started — Zustand is sufficient for current complexity.

---

## ADR-02 — State Management (Remaining)

**Implemented:** Zustand with explicit state enums for boot (`booting → recovering → ready | error`)
and editor lifecycle. Two-tier undo: TipTap history within session, page-level op reversal via
`useUndoStore` + `reverse.rs` for cross-flush Ctrl+Z/Y. See ARCHITECTURE.md §7, §8.

**Pending:**

| Phase | Addition |
|-------|----------|
| 3+ | TanStack Query for server state, invalidated by Tauri events |

TanStack Query is additive — it layers on top of existing Zustand stores, not replaces them.

---

## ADR-03 — UI Components (Remaining)

**Implemented:** shadcn/ui (copy-paste, owned), Tailwind with `rtl:` variants. See
ARCHITECTURE.md §1.

**Pending:**

- **Noto Sans bundling (Phase 5, i18n):** System fonts cause inconsistent CJK/Arabic rendering on
  Android. Noto Sans must be bundled for reliable multi-script display. Deferred because it adds
  ~4 MB to the APK and is only needed for i18n support.

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

## ADR-12 — Search (Remaining)

**Implemented:** FTS5 virtual table, strip pass, scheduled optimize, search command, SearchPanel
UI. See ARCHITECTURE.md §9.

**Pending — Phase 5: Tantivy + lindera**

**Tantivy:** Rust full-text search library with pluggable tokenizers.

**lindera:** Rust morphological analyser — Japanese (IPAdic), Chinese (CC-CEDICT), Korean
(KoDic). Linguistically-aware tokenisation: `会議室` → `["会議", "室"]`.

**Implementation plan:**
- Tantivy index lives on disk alongside SQLite. Source of truth remains op log + materialised
  blocks.
- Background materializer queue maintains the Tantivy index with stale-while-revalidate.
- lindera dictionaries are optional downloads, not bundled.
- FTS5 retained for non-CJK text during transition window. Both indexes maintained in parallel.

---

## ADR-16 — Build Order (Remaining Phases)

| Phase | Scope | Status |
|-------|-------|--------|
| 4 — Sync + Android | mDNS, pairing, op streaming, merge, Android spike. | **Complete.** Remaining: TanStack Query, Tauri command wiring for end-to-end sync. |
| 5 — Polish | i18n (Noto Sans bundling), CJK search (Tantivy + lindera), export (ULID → name substitution, Markdown output), auto-updates, graph view. | Pending. |

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

## ADR-19 — CJK Support (Remaining)

**Implemented:** CJK text renders, stores, and types correctly. FTS5 `unicode61` limitation
documented and accepted. See ARCHITECTURE.md §9.

**Pending — Phase 5: Tantivy + lindera**

(Merged with ADR-12 above for implementation details.)

**Dictionary sizes and Android strategy:**

| Language | Dictionary | Size |
|----------|------------|------|
| Japanese | IPAdic | ~18 MB |
| Japanese | IPADIC-NEologd | ~130 MB |
| Chinese | CC-CEDICT | ~8 MB |
| Korean | KoDic | ~8 MB |

Base APK ships with no dictionaries. First CJK search triggers: *"Better search for
Japanese / Chinese / Korean is available. Download language data? (~18 MB)"* Stored in
app-private storage. IPAdic and CC-CEDICT are priority targets. IPADIC-NEologd is optional, off
by default.

On Linux: dictionaries bundled in package or downloaded on first use, depending on distribution
packaging constraints.

**Interim option (noted, not planned):** FTS5 `trigram` tokenizer (SQLite 3.34+) enables CJK
substring search with no additional dependencies. Index size ~3x larger. Viable if CJK demand
arises before Phase 5 — recreate the FTS5 virtual table only, no schema migration.

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
