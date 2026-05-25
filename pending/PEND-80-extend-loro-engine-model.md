# PEND-80 — Extend Loro's role: typed engine model + LoroTree + lossless projection

**Goal:** push *more of the right data into Loro* — typed property values, a real
`deleted_at`, and the block tree via `LoroTree` — so the engine holds a **complete,
lossless model** of everything Loro should own, while keeping the architectural
boundary we deliberately want. This removes the "reduced engine model" that is the
root cause of inbound-sync metadata loss (the PEND-76 F1 residual) and lets us *delete*
custom tree-move logic rather than maintain it.

This is the **foundation** the sync-completeness work (PEND-81) builds on: once the
engine is lossless, remote changes can be re-projected to SQL completely.

> **DECISION (locked 2026-05-24): this is the committed path.** PEND-81 settled its
> central A-vs-B question on **Option A** (enrich the engine, re-project from engine
> state) — i.e. exactly this plan — and rejected Option B (op-based sync). PEND-80
> Phase 0–1 (→2) therefore lands *before* PEND-81's data-completeness phase. The
> open questions in §8 are now scoped to *how* (migration path, `LoroTree`
> sequencing, encoding), not *whether*.

**PROGRESS (2026-05-25): inbound property re-projection shipped.** The
*functional* goal of Phase 1 for properties — remote `SetProperty`/`DeleteProperty`
changes reaching SQL losslessly — is done (`reproject_block_properties_from_engine`
in `apply_remote`; closes the PEND-76 F1 property residual). **Key finding:** it
needed **no engine-model migration**. The engine's existing string value plus
`property_definitions.value_type` (all of text/number/date/select/ref/boolean
present since migration 0043) recovers the SQL type losslessly (`f64::to_string`
round-trips), so §2.1 ("native typed values in the engine") is **not required for
correctness** and is deferred as a pure representation refinement (it only matters
for §4 Phase-4 unified projection). **Remaining Phase-1 follow-ups:** reserved
hot-path keys (`todo_state`/`priority`/`due_date`/`scheduled_date`) + their agenda
derivation on inbound sync; tag re-projection + `block_tag_inherited` rebuild (needs
`tag_inheritance::rebuild::rebuild_all` + materializer `flush_background`); real
`deleted_at`/restore (Phase 2). `LoroTree` (Phase 3) is independent of this.

## 0. The boundary this plan respects (read first)

We are **extending Loro's storage/merge role, not dissolving the architecture.**
The responsibilities stay split:

| Layer | Owns | This plan |
|-------|------|-----------|
| **Loro engine** | merge + storage of *mergeable* data: text content, the tree, scalar field values | **grows** — typed values, real `deleted_at`, `LoroTree` |
| **op_log (event log)** | the canonical, typed, hash-chained **domain history**; audit; undo; the **rebuild/migration source**; Loro-independence | unchanged (stays canonical) |
| **SQLite + materializer** | **query/index** + **derivations** (tag-inheritance, agenda, soft-delete cascade, page_id) | unchanged (stays the query/derive layer) |
| **App/domain** | schema, **enums/`property_definitions`**, validation/invariants, integrations (gcal, MCP, activity feed) | unchanged (stays in the app) |

**Explicitly NOT in scope (stays out of Loro):** the SQL query layer (SQLite is the
query engine and the most future-proof piece — keep it); enum/select constraints +
all validation (`property_definitions` + the command-layer validator); derived data
(tag inheritance, page_id, cascade, agenda/recurrence); attachment **file bytes**
(stay on disk + P2P; CRDTs are not blob stores); the op_log as canonical source
(Loro stays a *derived* merge index, rebuildable from op_log replay).

## 1. Why (the root cause)

The engine stores a *reduced* model: properties as **strings only**
(`engine.rs::apply_set_property(value: Option<&str>)` — "string values only at this
stage"), and `deleted_at` as a **fixed marker** on the **seed only**
(`LoroValue::from("2025-01-15T12:00:00Z")`). So engine→SQL re-projection is **lossy**
(can't recover `value_num`/`value_date`/`value_ref`/`value_bool`) and **incomplete**
(no real timestamp; no descendants). The block tree is a **flat `LoroMap` +
`parent_id` + `i64` position**, so concurrent moves are naive per-key LWW with
documented cycle/position-collision edge cases. Loro *supports* doing all of this
properly (its `LoroValue` already carries `I64`/`Double`/`Bool`/`String`/`Binary` —
the engine already stores `position` as `I64`; and `LoroTree` is a real move-CRDT) —
the current shape is an early simplification, not a Loro limit.

## 2. What changes

1. **Typed property values in the engine.** Store each property value as its native
   `LoroValue` (`Double`/`I64`/`Bool`/`String`) instead of a compressed string. The
   SQL *column* it routes to (`value_num`/`date`/`ref`/`bool`) is decided by the
   property's `property_definitions.value_type` (reserved keys keep their hardcoded
   hot-path routing). Engine→SQL becomes lossless.
2. **Real `deleted_at`.** Store the actual timestamp (still on the seed); the SQL
   descendant cascade + restore-cohort-by-timestamp stay in the projection
   (derivation = app/SQL, per the boundary). Enables correct remote delete/restore.
3. **`LoroTree` for the hierarchy.** Replace the flat-map + `parent_id` + `i64`
   position with `LoroTree` (convergent moves, cycle-safety, fractional-index
   ordering). **Deletes** the custom move/position/cycle logic; the SQL side derives
   `parent_id`/`position`/`page_id` from the tree for querying.
4. **Lossless per-block re-projection from engine state** — the read surface
   (`read_all_properties`, real `read_deleted_at`, tree-derived parent/position) +
   a projection helper that writes a block's *full* SQL state from the engine. This
   is the exact primitive PEND-81 needs.
5. **Engine-format version + migration** (see §4).

## 3. Incremental phases (each lands independently, tests green, reversible)

- **Phase 0 — spike + representation decisions (~1–2 wk).** Decide: typed-value
  encoding (native `LoroValue` + schema-driven column routing vs a `{kind,value}`
  wrapper); `LoroTree` node model (block = node, fields/content in the node's
  metadata map; ordering→`position` mapping); **migration approach** (op-log-replay
  rebuild vs snapshot-format migration; how each interacts with log compaction);
  prove engine→SQL re-projection is lossless for one typed property + one delete.
  **Kill criterion:** if `LoroTree` or typed migration can't be done compatibly,
  drop Phase 3 and ship 1–2 only.
- **Phase 1 — typed property values (M–L).** Engine stores typed values; read paths
  accept all variants (today they reject non-`String`); add `read_all_properties`;
  lossless property re-projection; migration; round-trip + typed-filter tests.
  → unblocks remote property propagation in PEND-81.
- **Phase 2 — real `deleted_at` + restore (S–M).** Store/read the real timestamp;
  projection applies it + the SQL descendant cascade; restore cohort by timestamp;
  tests (incl. "re-project does not resurrect a soft-deleted subtree").
- **Phase 3 — `LoroTree` adoption (L — the big one; candidate for its own PEND).**
  Model blocks as a `LoroTree`; migrate; rewrite create/move/delete onto tree ops;
  derive `parent_id`/`position`/`page_id` for SQL; **delete** the naive move/position
  logic; tests incl. concurrent-move convergence + cycle-avoidance. Highest risk —
  do only after 0–2 are stable, and feature-flag/shadow it.
- **Phase 4 — unify the projection path (optional, M).** With a lossless engine,
  consider collapsing the two projection paths (per-op materializer for local;
  state-projection for remote) into one state-projection. Pure simplification;
  skip if the materializer churn isn't worth it.

## 4. Migration & safety (the highest-risk area)

- **The op_log is the migration mechanism.** It already carries the *typed*
  payloads, so the universal path on an engine-format-version bump is **rebuild the
  engine from op_log replay** (typed `SetProperty` → typed Loro; `Create`/`Move` →
  `LoroTree`). This is *another* reason the op_log stays canonical.
- **Compaction wrinkle:** if old ops were compacted away behind a snapshot, replay
  can't fully rebuild — then you need a **snapshot-format migration** (read old
  string/marker/flat-map snapshot, write new typed/`LoroTree` snapshot). Phase 0
  decides which path(s) are needed and whether to retain pre-bump op history.
- **Shadow + verify:** behind a flag, build the new-format engine alongside the old,
  re-project both, and **diff the SQL output** before cutover. Interacts with the
  existing snapshot/recovery machinery (mind the C1/C2 snapshot-wedge heal).
- **Sync compatibility:** two peers on different engine formats must not corrupt
  each other — gate by a protocol/format version during the rollout (coordinate
  with PEND-81).

## 5. Documentation, AGENTS.md & architecture-doc updates

**Doc accuracy is load-bearing here** (the `doc-citations`, `markdownlint`, and
`lychee` hooks enforce it, and `AGENTS.md` invariants are contracts). Treat docs as
part of each phase's definition-of-done, plus a final consistency pass. Concretely:

### Root `AGENTS.md` (invariants are contracts — update in lockstep)

- **Invariant #2 (event sourcing + materialized views):** refine to state the
  three-layer boundary explicitly — *op_log = canonical typed history; Loro engine =
  derived merge index, rebuildable from op_log replay; SQL = derived query view* —
  and that **Loro owns merge/storage of content + tree + scalar values only**;
  enums/validation/derivations/queries live in the app + SQL.
- **Remove/rewrite any "reduced/string-only engine model" wording** so no stale
  claim survives (search the file for engine/property/deleted_at notes).
- Add (or fold into #2) a **"Loro ↔ op_log ↔ SQL responsibility boundary"** note +
  the **engine-format version** concept and the rebuild-from-op-log migration rule.
- Threat-model section: unaffected — note it explicitly so a reviewer doesn't
  re-open it.

### `docs/architecture/` (the deep-dive docs — primary targets)

- **`crdt-and-recovery.md`** — the main one: rewrite the engine data model (typed
  values, real `deleted_at`, `LoroTree`), the recovery/rebuild-from-op-log path, and
  the engine-format version + migration strategy.
- **`data-and-events.md`** — the op_log/materializer/projection model: the now-
  lossless engine↔SQL projection and the boundary.
- **`sync-and-network.md`** — note the engine-model change that unblocks remote-change
  propagation; cross-reference PEND-81.
- **`queries.md`** — reaffirm SQLite remains the query layer (no change, but record
  *why* it stays after this work).
- **`threat-model.md`** — confirm unchanged.

### `docs/` top-level + feature docs

- **`docs/ARCHITECTURE.md`** — the data-model / op-log / materializer / engine
  sections.
- **`docs/features/properties.md`** — typed properties + that enums/select =
  `property_definitions` + app validation (NOT Loro).
- **`docs/features/tags-and-links.md`** — tags stored in Loro; inheritance is a SQL
  derivation.
- **`docs/features/sync.md`** — behavior cross-ref to PEND-81.
- **`docs/FEATURE-MAP.md`** — update the engine/sync/properties entries; add the new
  read methods / projection helper / engine-format version; keep the deferred-
  features section (§22) in sync (per `PROMPT.md`).

### Nested `AGENTS.md`

- **`src-tauri/src/commands/AGENTS.md`** — if write-path/op-emit shapes change
  (typed property payloads, tree ops).
- **`src-tauri/src/mcp/AGENTS.md`** — if property typing affects the MCP tool surface.
- **`src-tauri/migrations/AGENTS.md`** — if a SQL migration is added (STRICT +
  append-only rules); likely minimal since the change is engine-side, but a
  `property_definitions`/projection tweak may touch SQL.
- **`src-tauri/tests/AGENTS.md`** + **`src/__tests__/AGENTS.md`** — document the new
  test patterns (engine round-trip fidelity; concurrent-move convergence proptests;
  lossless re-projection oracle).

### Process

- **`SESSION-LOG.md`** — one entry per phase (the `PROMPT.md` template).
- Run the doc hooks (`doc citations point at tracked code`, `markdownlint`, `lychee`)
  each phase; fix moved code citations.
- **Final pass:** re-read the root `AGENTS.md` invariants end-to-end to ensure no
  stale "reduced model" statement remains, and that the boundary table here matches
  the docs.

## 6. Cross-feature impact (what else shifts)

- **Recovery** gains the rebuild-from-op-log path (also the migration path) —
  reinforces op_log-as-source; coordinate with snapshot/heal (C1/C2).
- **Undo/redo, activity feed, audit** — unaffected (op_log stays canonical + typed).
- **Properties/agenda/gcal** — benefit (typed values flow correctly); validation +
  recurrence + agenda projection stay in the app/SQL layer.
- **Tags** — direct tags already in Loro; inheritance stays a SQL derivation.
- **MCP / spaces / search** — read SQL; unaffected if projection stays complete.

## 7. Cost / Impact / Risk

- **Cost:** L (multi-month, phased). P0 ~1–2 wk; P1 M–L; P2 S–M; **P3 L** (the
  `LoroTree` migration is the bulk + the risk); P4 optional M. Schedule phase-by-
  phase; P3 may become its own PEND.
- **Impact:** foundational — removes the metadata-loss root cause (enables sync
  completeness), deletes custom tree-move logic, and improves *local* fidelity too
  (lossless snapshot round-trip + recovery), not only sync. Mostly **latent until
  sync is used** (the maintainer doesn't currently sync) — weigh that before
  scheduling ahead of in-use features.
- **Risk:** HIGH — it changes the CRDT data model and migrates existing engine
  state. Phase 0 + op-log-rebuild migration + shadow/verify + format-versioning are
  the de-risking levers.

## 8. Open questions

1. **Migration path** — op-log-replay rebuild vs snapshot-format migration (and the
   compaction interaction)? (Phase 0.)
2. **`LoroTree` now or later** — include Phase 3 here or split it into its own PEND?
3. **Phase 4 unify-projection** — worth the materializer churn, or leave the two
   paths?
4. **Sequencing** — ✅ **confirmed 2026-05-24:** this is the foundation; do P0–P1
   before PEND-81's data-completeness phase (Option A locked — see the banner above
   and PEND-81 §3).
5. **Typed-value encoding** — native `LoroValue` + schema-driven routing, or an
   explicit `{kind, value}` wrapper for self-describing engine state?

> **Dependency note:** this plan is the foundation for **PEND-81** (sync
> completeness & hardening) — do PEND-80 Phase 0–1 before PEND-81's data-completeness
> phase. (PEND-81 was renumbered from a transient PEND-78 collision; the other
> PEND-78 is the unrelated recent-strip fix.)
