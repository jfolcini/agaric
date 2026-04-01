# Architecture Decision Records — Pending & Future

> Implemented decisions have been moved to [ARCHITECTURE.md](ARCHITECTURE.md).
> This file contains only **pending, partial, or future** architectural decisions.

## Status Summary

| ADR | Title | Status | Remaining work |
|-----|-------|--------|----------------|
| 01 | Shell & Frontend | **Partial** | Export (P5). TanStack Query, XState not started. |
| 02 | State Management | **Partial** | TanStack Query (P3+), XState (P4+) pending. |
| 03 | UI Components | **Partial** | Noto Sans bundling deferred to P5 (i18n). |
| 06 | Data Model | **Partial** | Export (P5) pending. |
| 09 | Sync | **Planned** | Full implementation pending. Schema ready. |
| 10 | CRDT / Conflict | **Partial** | Sync-triggered merge execution pending. |
| 12 | Search | **Partial** | Tantivy + lindera CJK search (P5). |
| 16 | Build Order | **Reference** | Remaining phases (P4–P5). |
| 17 | Graph View | **Deferred** | Phase 5+. Schema supports it. |
| 19 | CJK Support | **Partial** | Tantivy + lindera (P5). |
| 20 | Content Storage | **Partial** | Export (P5) pending. |

**Legend:** P1=Phase 1, P2=Phase 2, etc. See ARCHITECTURE.md for all implemented decisions
(former ADR-04, 05, 07, 08, 11, 13, 14, 15, 18).

---

## ADR-01 — Shell & Frontend (Remaining)

**Implemented:** Tauri 2.0, React 18 + Vite, TipTap roving instance, Biome, specta bindings,
auto-split, keyboard handling, viewport observer. See ARCHITECTURE.md §1, §7.

**Pending:**

- **Export (Phase 5):** Markdown export with ULID → human name substitution. Not started.
- **TanStack Query:** Planned for Phase 3+ to manage server state with Tauri event invalidation.
  Not started — Zustand is sufficient for current complexity.
- **XState:** Planned for Phase 4+ for the sync state machine only. Not started.

---

## ADR-02 — State Management (Remaining)

**Implemented:** Zustand with explicit state enums for boot (`booting → recovering → ready | error`)
and editor lifecycle. Two-tier undo: TipTap history within session, page-level op reversal via
`useUndoStore` + `reverse.rs` for cross-flush Ctrl+Z/Y. See ARCHITECTURE.md §7, §8.

**Pending:**

| Phase | Addition |
|-------|----------|
| 3+ | TanStack Query for server state, invalidated by Tauri events |
| 4+ | XState for sync state machine only |

These are additive — they layer on top of existing Zustand stores, not replace them.

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

## ADR-09 — Sync

**Status:** Not started. Schema ready (peer_refs table, parent_seqs DAG support, device UUID).
Phase 4.

**Discovery:** mDNS on local network. Initiating device generates session passphrase.

**Pairing — per-session word passphrase + QR code:**
- Host generates a 4-word EFF large wordlist passphrase (~51 bits entropy) per session.
  Ephemeral — discarded after pairing or 5-minute timeout.
- Host displays QR code (passphrase + host address) and 4-word text. Both paths derive identical
  session keys.
- Rejected: persistent shared passphrase (hard to rotate), SPAKE2 (correct but adds a crypto
  dependency for marginal gain at this threat model).

**Transport:** tokio-tungstenite + rustls.

**Protocol:**
1. Exchange heads: latest `(device_id, seq, hash)` per device known to each peer.
2. Walk `parent_seqs` DAG back to find common ancestor.
3. If peer's last known op predates oldest retained op and no snapshot covers it →
   **RESET_REQUIRED**.
4. Otherwise → stream diverging ops. Receiver inserts with original `(device_id, seq)` via
   `INSERT OR IGNORE` (duplicate delivery is idempotent).
5. Receiver writes a merge op whose `parent_seqs` contains one entry per syncing device.
6. On successful completion → update `peer_refs` atomically (see below).

**`peer_refs` maintenance:**

| Column | Updated when | Value |
|--------|-------------|-------|
| `last_hash` | End of every successful sync | Hash of the last op *received* from this peer. Starting point for next sync — ops after this hash are new. |
| `last_sent_hash` | End of every successful sync | Hash of the last op *sent* to this peer. Avoids re-sending already-transferred ops on reconnect. |
| `synced_at` | End of every successful sync | Wall-clock timestamp, updated atomically with the two hashes. |
| `reset_count` | RESET_REQUIRED sync completes | Incremented by 1. |
| `last_reset_at` | RESET_REQUIRED sync completes | Set to current timestamp. |

On sync failure (connection lost mid-stream): `peer_refs` is **not** updated. The next sync
restarts from `last_hash`. Duplicate op delivery is safe due to `INSERT OR IGNORE` on the
composite PK.

**Offline peer / compaction reset:**
UI: *"[Device name] has been offline too long to sync incrementally. Reset this device's data
from [peer]?"* — explicit confirm, no silent replacement. On confirm: wipe local state, receive
and apply snapshot per ARCHITECTURE.md §11. `peer_refs.reset_count` incremented.

### Conflict resolution during sync

**Text conflicts:**
- Non-overlapping edits: `diffy::merge(ancestor_text, ours, theirs)` → `Ok(String)`. Written as
  new `edit_block` op. Invisible to user.
- Overlapping / ambiguous edits: diffy returns `Err(MergeConflict)`. Original block retains
  common ancestor content. Conflict copy created. Both visible. On resolution: chosen content →
  new `edit_block` on original; conflict copy → `delete_block`.

**Property conflicts:**
LWW on `created_at` with `device_id` tiebreaker. Logged in Status View.

**Attachment binary transfer:** Separate file-sync step after op streaming. Op log carries
reference only.

### Concurrent delete + edit resolution (#68)

A remote `edit_block` targeting a locally-deleted block means the remote user intended the block
to exist. **Resolution: resurrect.** Apply the edit AND clear `deleted_at`. Emit a synthetic
`restore_block` op before applying the `edit_block`. Log the auto-resurrection in Status View.

Rationale: Discarding silently loses data. Conflict copy is overcomplicated — the remote user's
intent is unambiguous (they edited a block they believed existed). Git's merge model also
resurrects: a merge commit that includes both a delete and an edit in different branches keeps
the file if the edit is more recent.

### `move_block` sync conflicts (#69)

Three scenarios, each with its own resolution:

1. **Same block moved to different parents:** LWW on `created_at` with `device_id` tiebreaker
   (same as property conflicts). Winner's parent is used. Logged in Status View.
2. **Block moved into a concurrently deleted subtree:** Reparent to document root
   (`parent_id = NULL`). Emit a synthetic `move_block` op to root. Log in Status View as
   *"Block [id] reparented to root — original parent was deleted."*
3. **Interleaved batch move ops:** Resolve position conflicts per-parent using the existing
   position compaction (insert at position, shift siblings). Process in `created_at` order
   within each parent.

### Duplicate tag blocks after sync (#70)

**Resolution: materializer background dedup.** On cache rebuild, detect tag blocks with duplicate
content (case-insensitive). Keep the lexicographically smallest ULID as canonical. Emit
`edit_block` ops to rewrite `#[loser-ULID]` tokens to `#[winner-ULID]` in all blocks that
reference the loser. Update `block_tags` rows. Background reconciliation — no user action needed.
Log dedup events in Status View.

Rationale: Option (a) merge-on-sync is correct but invasive and generates ops during sync
streaming. Option (c) expose-to-user adds UI complexity for a machine-fixable problem. Background
dedup runs after sync completes and is idempotent.

---

## ADR-10 — CRDT / Conflict Strategy (Remaining)

**Implemented:** merge.rs (diffy three-way merge, conflict copy creation, property LWW,
merge_block orchestrator, LCA algorithm). See ARCHITECTURE.md §10.

**Pending:**

- **Conflict copy semantics updated (#67):** The original block now retains local ("ours")
  content on conflict, not the common ancestor. Conflict copy contains remote ("theirs") content.
  This matches the Git model: your working copy keeps your changes; the conflict marker shows
  what the other side did.
- **Sync-triggered merge execution (Phase 4 Wave 5):** The merge infrastructure is built and
  tested, but it is not yet wired into the sync protocol. When ADR-09's sync streaming delivers
  concurrent ops, the materializer must invoke `merge_block()` to produce merge results. This is
  the integration point — no new merge logic is needed, only the trigger.

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

| Phase | Scope | Estimate |
|-------|-------|----------|
| 4 — Sync + Android | mDNS, passphrase / QR pairing, op streaming, sync-triggered merge, Android full. XState + TanStack Query. | 12–16 weeks |
| 5 — Polish | i18n (Noto Sans bundling), CJK search (Tantivy + lindera), export (ULID → name substitution, Markdown output), auto-updates, graph view. | 6–8 weeks |

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
