# PEND-15 — Hard space separation (no cross-space links)

## Problem

User intent: *"I want spaces separate, no links between them."* Each space is a sealed unit. No ULID inside `blocks.content` of space A may reference a block whose space resolves to space B. No `block_links`, `block_tags`, or `block_tag_refs` row crosses a space boundary. No backlinks display cross-space results.

This goes further than the current Phase-7 enforcement (rejects new cross-space `[[link]]` and `#tag` insertions at op boundary, but tolerates legacy / migrated cross-space references rendering them as "Broken link" — UX-366 in REVIEW-LATER).

### Current Phase-7 enforcement
- **File:** `commands/spaces.rs` (`create_page_in_space_inner` validates `parent_id`'s space matches target)
- **Mechanism:** Pre-emit cross-space check; reject with `AppError::Validation` before op reaches log
- **Gap:** Write-time guard only, only for two op types; legacy stored data is tolerated

## Scope: what becomes scoped

| Entity | Scoped? | Notes |
|---|---|---|
| Pages | YES (already) | `space` ref property |
| Content blocks | YES (already) | Inherit space via `page_id` |
| Block links (`[[ULID]]`) | NO cross-space | Both inline tokens AND maintained `block_links` rows |
| Block refs (`((ULID))`) | NO cross-space | Same |
| Inline tag refs (`#[ULID]`) | NO cross-space | Treats tags as space-scoped |
| **Tags themselves (`block_type='tag'`)** | **YES (NEW)** | Each space gets independent tag namespace. **Requires user approval — biggest design decision.** |
| Attachments | Not space-scoped | Reachable only through their owning block; transitively in that block's space |

## The tags-scoping question (gating user decision)

**Path A: tags space-scoped (RECOMMENDED, consistent with user intent).** `#work/meeting` in Personal and `#work/meeting` in Work are independent tags (separate ULIDs). Tag autocomplete only suggests in-space tags. Backlinks only show in-space results.

**Reviewer correction — Path A is incomplete in the original draft.** Tags are currently global (verified: `commands/tags.rs::add_tag_inner` does NOT check tag-vs-block space match; `tag_query/query.rs` filters by space at *projection* step but the tag resolver itself is unscoped; `list_tags_by_prefix` returns all tags regardless of space). Adopting Path A requires three sub-phases the original draft did not enumerate:

1. **Tag-block migration.** Every existing tag block needs a `space` property assignment. Strategy: assign all current tag blocks to Personal (matches the `migrate_pages_to_personal_space_batched` pattern in `spaces/bootstrap.rs`). One-time UX cost: a tag legitimately used from both spaces will need to be recreated in the second space; the user can do this manually post-migration. Document it.

2. **`block_tag_inherited` cache (migration 0021) becomes space-scoped.** The recursive walk via `parent_id` would cross space boundaries and pollute the inherited table. Add a `space_id` column to the table (one new SQL migration) so the existing query path doesn't need restructuring.

3. **Tag resolver path filtering.** Update `commands/tags.rs::add_tag_inner` to validate target-tag space matches source-block space. Update `tag_query` resolution to filter at the resolver, not just projection. Update `list_tags_by_prefix` to take a space parameter.

**Path B: tags global.** Tags are shared; cross-space references allowed only for tags. Asymmetric — breaks the "no links between them" rule.

**Recommendation: Path A with the three sub-phases above.** Confirm before implementation.

## Phased plan

### Phase 0 — Audit (1 day)

One-shot SQL audit script that enumerates current cross-space references in stored data. Output: count per category + examples.

```sql
-- A1: cross-space block_links rows
SELECT bl.source_id, bl.target_id,
  (SELECT bp.value_ref FROM block_properties bp 
   WHERE bp.block_id = COALESCE(bs.page_id, bs.id) AND bp.key='space') AS source_space,
  (SELECT bp.value_ref FROM block_properties bp 
   WHERE bp.block_id = COALESCE(bt.page_id, bt.id) AND bp.key='space') AS target_space
FROM block_links bl
JOIN blocks bs ON bs.id = bl.source_id AND bs.is_conflict = 0 AND bs.deleted_at IS NULL
JOIN blocks bt ON bt.id = bl.target_id AND bt.is_conflict = 0 AND bt.deleted_at IS NULL
WHERE source_space IS NOT target_space;

-- A2: cross-space block_tags (if Path A)
-- A3: cross-space block_tag_refs (if Path A)
-- A4: inline `[[ULID]]` / `((ULID))` / `#[ULID]` tokens in blocks.content whose target is in another space
--     (requires Rust-side regex scan; SQL alone is awkward)
```

Audit runs as a maintenance command (`audit_cross_space_refs`) or as a one-off script during the migration.

### Phase 1 — Migration of legacy cross-space references (2-3 weeks; depends on audit volume)

**Strategy: Sever via Op-Log Emission (Option B only — Option A is broken).**

Reviewer correction: the planner's draft offered two severance options and deferred the decision. **Option (a) "runtime severance via materializer-time helper" is broken** — it fights op-log replay; the next replay would re-introduce the cross-space refs unless the helper is wired into every content-touching apply path. Use Option (b) only:

**Phase 1b emits real `EditBlock` ops via the normal command pipeline.** Each op rewrites one block's content to remove cross-space tokens. The ops land in op_log normally, replay correctly forever, and the migration is a one-time-on-first-boot batch. **Op-log invariant #1 is preserved** (we don't mutate or delete op_log rows; we append new ones).

Justification: deterministic, no policy decisions needed, user's dataset is solo, severance acceptable.

Two parts:

**1a. Cache-row purge** (single migration, fast):

```sql
-- 0042_purge_cross_space_refs.sql
DELETE FROM block_links WHERE EXISTS (
  SELECT 1 FROM blocks bs JOIN blocks bt ON bt.id = block_links.target_id
  WHERE bs.id = block_links.source_id
    AND COALESCE((SELECT bp.value_ref FROM block_properties bp WHERE bp.block_id = COALESCE(bs.page_id, bs.id) AND bp.key='space'), '__GLOBAL__')
     != COALESCE((SELECT bp.value_ref FROM block_properties bp WHERE bp.block_id = COALESCE(bt.page_id, bt.id) AND bp.key='space'), '__GLOBAL__')
);

-- Same shape for block_tags + block_tag_refs (if Path A approved)
```

**1b. Inline-content-token rewrite — emit `EditBlock` ops** (Rust boot-time helper, runs once, similar to `migrate_pages_to_personal_space_batched`).

For every `blocks.content` whose source block is `is_conflict=0` and `deleted_at IS NULL`:
1. Scan via the canonical Rust-side regexes in `cache/mod.rs:64-85`:
   - `ULID_LINK_RE` for `[[ULID]]` and `((ULID))`
   - `TAG_REF_RE` for `#[ULID]`
   - `PAGE_LINK_RE` for `[[ULID]]` (page-link variant)
2. For each token, resolve the target's space via the same `COALESCE(b.page_id, b.id) → block_properties space` pattern used in PEND-12.
3. If target's space != source block's space, rewrite the content with the token removed (or replaced by a tombstone marker).
4. Emit one `EditBlock` op via `edit_block_in_tx` with the rewritten content. The op enters op_log normally with origin marker `'space_severance_migration'` (see Risks for sync-protocol implications).

**Idempotency:** the helper is idempotent — once a block has no cross-space tokens, the helper finds nothing to rewrite and emits zero ops. Safe to re-run.

**Batching:** process ~100 blocks per transaction (chunked to avoid lock-holding). Match the convention in `spaces/bootstrap.rs::migrate_pages_to_personal_space_batched`.

**Replay survival:** because the migration emits real ops, the cleanup is durable across op-log replay (op log is the source of truth).

### Phase 2 — Write-time enforcement extension (1 week)

Extend Phase-7 enforcement to **every** code path that produces a cross-space reference:

| Path | Validation |
|---|---|
| `create_block` with content containing `[[ULID]]` / `((ULID))` / `#[ULID]` | Parse content for tokens; resolve each target's space; reject if mismatch |
| `edit_block` (content edit) | Same content scan |
| `set_property` with ref-type values | If `value_ref` resolves to a different space, reject |
| `add_tag` | Reject if tag's space differs from target block's space (Path A) |
| Sync ingress (remote ops apply) | Materializer rejects cross-space ops; logs a metric `cross_space_ops_dropped` |
| Bulk import | Same content scan during import parser |

Pattern: add a `validate_cross_space_refs(target_space, content_or_ref) -> Result<(), AppError::Validation>` helper used at every entry point.

### Phase 3 — Materializer cache filtering (3-5 days)

`block_links`, `block_tags`, `block_tag_refs` cache rebuilds add space-scoping to their `INSERT OR IGNORE` clauses. If a remote op produces a cross-space pair, drop the pair (log metric, don't insert).

Concrete: extend `cache/block_links.rs:84-92` and `cache/block_tag_refs.rs:105-114` with a same-space check:

```sql
INSERT OR IGNORE INTO block_links (source_id, target_id)
SELECT ?, value FROM json_each(?)
WHERE EXISTS (SELECT 1 FROM blocks WHERE id = value)
  AND -- both ends resolve to the same space (or both global, which won't happen post-FEAT-3)
      COALESCE((SELECT bp.value_ref FROM block_properties bp
                WHERE bp.block_id = COALESCE((SELECT page_id FROM blocks WHERE id = ?), ?)
                  AND bp.key = 'space'), '__GLOBAL__')
    = COALESCE((SELECT bp.value_ref FROM block_properties bp
                WHERE bp.block_id = COALESCE((SELECT page_id FROM blocks WHERE id = value), value)
                  AND bp.key = 'space'), '__GLOBAL__')
```

The fragment is verbose. **Soft coupling with PEND-12:** if PEND-12 has landed, generate a `same_space_check.sql` fragment alongside the existing `space_filter_bind_<N>.sql`. Otherwise inline the SQL above (one more inlining site, but acceptable).

### `set_property` ref-type validation (Phase 2 enforcement detail)

`commands/properties.rs::set_property_in_tx` accepts `value_ref: Option<String>`. Phase 2 adds a same-space check immediately after the ref is resolved:

```rust
if let Some(target_id) = &value_ref {
    let target_space = resolve_block_space(tx, target_id).await?;
    let source_space = resolve_block_space(tx, &block_id).await?;
    if target_space != source_space {
        return Err(AppError::Validation(format!(
            "ref-property '{key}' target '{target_id}' is in space '{:?}' but source '{block_id}' is in space '{:?}'",
            target_space, source_space)));
    }
}
```

Same `resolve_block_space` helper as every other Phase 2 enforcement point, ensuring uniform semantics. The helper resolves via `COALESCE(page_id, id) → block_properties.value_ref WHERE key='space'` — the canonical pattern.

### Move-block attachment ownership (reviewer addition)

When a block is moved between spaces (`move_block_inner`), its attachments move *with* it transitively (attachments are reachable only via their owning block, not via the space directly). The materializer's move-block handler does not need explicit attachment-space updates. Add an integration test verifying: create a block in Personal with an attachment, move the block to Work, query attachments scoped to Personal (zero results), query attachments scoped to Work (the attachment shows). This guards against a future regression where attachment ownership is denormalized incorrectly.

### Phase 4 — Frontend cleanup (1-2 days)

Delete the broken-link UX surface (UX-366 closure):

- `src/editor/extensions/block-link.ts` — remove the `status === 'deleted'` rendering branch + `resolveStatus` option + click-to-remove deleted-link handler.
- `src/editor/extensions/block-ref.ts` — same if it has analogous logic.
- `src/editor/extensions/tag-ref.ts` — same.

Backlinks + LinkedReferences UI already scope to active space (Phase 4 of FEAT-3); verify no extra changes needed.

### Phase 5 — Tests + docs (1 week)

- Integration test: every enforcement path rejects cross-space refs.
- Materializer test: cross-space ops from "remote" peer are dropped at apply.
- Migration test: legacy cross-space data → run severance migration → audit returns zero violations.
- Frontend tests: chip rendering verifies in-space links work; broken-link tests deleted (the path no longer exists).
- Docs: update ARCHITECTURE.md §9 to reflect "hard separation, no cross-space links."

## Files touched

**Backend:**
- New: `src-tauri/migrations/0042_purge_cross_space_refs.sql`
- New: `src-tauri/src/spaces/cross_space_severance.rs` (Rust pre-migration helper)
- Modified: `commands/blocks/crud.rs` (edit_block content scan), `commands/properties.rs` (ref-type validation), `commands/blocks/tags.rs` (add_tag validation), `commands/import.rs` if exists (bulk-import scan)
- Modified: `materializer/handlers.rs` (apply-time cross-space rejection)
- Modified: `cache/block_links.rs`, `cache/block_tag_refs.rs` (insert-time filtering)
- Modified: `sync_protocol/orchestrator.rs` if needed (sync-ingress rejection metric)

**Frontend:**
- Modified: `src/editor/extensions/block-link.ts`, `block-ref.ts`, `tag-ref.ts` (delete broken-link rendering)

**Docs:**
- ARCHITECTURE.md §9 (Spaces) — update to describe hard separation
- AGENTS.md — update the "Cross-space link enforcement" line if present

## Cost (reviewer-revised)

**L (7-12 weeks calendar, 5.5-9 person-weeks for a solo maintainer).** Reviewer corrected upward from the planner's 4-8 weeks after surfacing: the tag-scoping sub-phase, the op-emission complexity in 1b, the materializer-filter dependency on PEND-12, and the test-coverage breadth.

| Phase | Time |
|---|---|
| 0 — Audit script | 1 day |
| Tag-scoping decision (gating) | S — discussion only |
| 1 — Migration of legacy data | 1-2 weeks |
| 2 — Write-time enforcement extensions | 1 week |
| 3 — Materializer cache filtering | 3-5 days |
| 4 — Frontend cleanup | 1-2 days |
| 5 — Integration tests + docs | 1 week |

## Impact

- **Closes UX-366 by code deletion** — no broken-link chip class to render.
- **Simplifies the mental model** — every space is sealed. "What space am I in" becomes a hard guarantee, not a discipline.
- **Affects long-tail queries** — graph view spanning all spaces (if such a feature exists) becomes per-space; backlinks already scope. **Audit Phase 0 verifies no user-facing feature relies on cross-space discoverability.**

## Risk

| Risk | Mitigation |
|---|---|
| **Legacy data destruction (severance)** | Migration runs on a backed-up DB; explicit user confirmation prompt at first run; commit log preserves the inputs the migration saw. |
| **Tags-scoping decision is wire-protocol-affecting** | User has zero paired peers today (per session 651/652 context). If sync resumes, peers must run migration before re-pairing. Document. |
| **Op-log immutability** | The migration must NOT delete op_log rows (invariant #1). Cache-row deletion is OK. Inline-token rewrite emits new `EditBlock` ops via the normal pipeline (preserves the chain). |
| **Inline-token regex fragility** | Use the canonical regexes already in the codebase (`ulid_link_re()`, `tag_ref_re()`); test against the existing markdown corpus + the existing `merge/tests.rs` cases. |
| **Sync-ingress rejection UX** | Cross-space ops from remote peer get silently dropped with logged metric. User-visible only via Sync status panel ("N ops rejected"). Acceptable. |
| **Interaction with PEND-09 (CRDT)** | A CRDT-merged ref from a remote peer might cross spaces. The Loro merge engine doesn't know about Agaric's semantic invariants. Apply the same materializer-level filtering at CRDT-apply time. Document. |

## Sequencing (reviewer-revised — CRITICAL)

- **PEND-15 Phase 1 MUST complete before PEND-09 Phase 2 cutover.** Reviewer correction: the planner's deferral of the CRDT interaction was insufficient. If PEND-09 cuts over first, Loro's character-level merge can synthesize new cross-space refs from concurrent edits — those land in materialized content as facts that PEND-15's one-shot severance never sees. Fix the legacy data **before** Loro becomes authoritative; PEND-09 then replays the cleaned op log into Loro and Phase 2 enforcement prevents new cross-space refs from being created.
- **Soft dependency on PEND-12.** Phase 3's materializer cache filtering wants to reuse the canonical space-filter fragment via `space_filter_template.sql`. If PEND-12 hasn't landed, Phase 3 inlines the same SQL pattern (one extra inlining site, but tractable).
- **Soft dependencies on PEND-18 and PEND-13** (recommended, not blockers): typed `SpaceScope` makes the new validation helpers cleaner; the drift test catches regressions during Phase 1b's op-emission migration.
- **Independent of PEND-14.**
- **Coordinates with PEND-10 (iroh).** Sync-ingress rejection hooks into the sync protocol's apply path; if iroh lands first, the hook moves transports.

## Open questions

1. **Are tags space-scoped under the new rule?** — gating decision. Recommendation: yes (Path A).
2. **Legacy-data treatment: sever vs migrate-targets vs prompt-user?** — recommendation: sever.
3. **Does the graph view today span spaces?** — verify via Phase 0 audit. If yes, becomes per-space (feature change).
4. **What about agenda items that reference cross-space blocks via ref-type properties** (e.g., `due_date_target`, custom ref properties)? — investigate.
5. **Should the audit script ship as a maintenance command** (`audit_cross_space_refs`)? — probably yes; lets the user re-run after sync events.
6. **PEND-09 (CRDT) interaction** — CRDT-merged ops can synthesize cross-space refs in the merge engine. The materializer-level filtering must apply at CRDT-apply time too. Land PEND-09's design before PEND-15's enforcement, or document the constraint as input to PEND-09.
