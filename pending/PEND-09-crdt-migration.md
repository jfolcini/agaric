# PEND-09 — CRDT migration (Loro), merge layer only

## Decision recap

The user has approved migrating the merge layer to a CRDT (Loro). Rationale: the `is_conflict` invariant has metastasized into the schema (**293 `is_conflict = 0` SQL filter sites; 612 total `is_conflict` mentions across `src-tauri/src/*.rs`** — reviewer-verified count, ~10% higher than the original 559 estimate); MAINT-113 is a multi-month type-system rescue treating the symptom, not the cause; `merge/` is ~4,163 LOC (verified) of line-granularity diffy + conflict-copy creation that would disappear under a CRDT; and character-granularity merge produces fewer user-visible conflicts than line-granularity in practice.

**iroh (transport) is explicitly out of scope.** The user rejected internet-scale sync — sync stays on the existing mDNS+WebSocket+TLS+TOFU stack. CRDT is a **merge-layer change only**.

**Loro chosen over Automerge** because Loro has native tree CRDT support; the block tree (`parent_id` + `position`) maps cleanly. Automerge is document-shaped — simulating a tree on top is awkward. Loro is also more memory-efficient on large docs.

## Loro mapping

**One Loro document per space** (matches the existing `spaces` partitioning; per-space sync is already a thing in this codebase). One global doc would be simpler but would couple all spaces' op streams together unnecessarily.

Within each space's Loro doc:

```text
loro_doc = {
  "blocks": LoroMap<block_id_str, BlockData>
    where BlockData = LoroMap<{
      block_type:       LoroValue (string),
      content:          LoroText,        // <- character-level CRDT, the big win
      parent_id:        LoroValue (nullable string),
      position:         LoroValue (i64),  // app-maintained tree invariant
      deleted_at:       LoroValue (nullable string),
      archived_at:      LoroValue (nullable string),
      todo_state:       LoroValue (nullable string),
      priority:         LoroValue (nullable string),
      due_date:         LoroValue (nullable string),
      scheduled_date:   LoroValue (nullable string),
    }>,
  "block_properties": LoroMap<block_id_str, LoroMap<key_str, PropertyValue>>,
  "block_tags":       LoroMap<block_id_str, LoroList<tag_id_str>>,
  "block_links":      LoroMap<source_id_str, LoroList<target_id_str>>,
}
```

**Why this shape:**

- `content` as `LoroText` — character-level merge. Concurrent edits to different words in the same block coalesce automatically; **no conflict copy unless both devices touched the same character** (statistically rare for offline-occasional sync).
- `parent_id` + `position` as scalar LoroValues, with the **app layer maintaining the tree invariant** (no two siblings with the same position; no cycles). `LoroMovableList` could enforce position semantics natively but at higher cost; given Agaric's siblings-per-parent counts are small, app-level reordering is cheaper.
- Properties as nested map — LWW ("last write wins") semantics is sufficient. Agaric's properties don't need character-level merge.
- Tags / links as LoroList — set semantics enforced at the app layer (dedup on read).

The materialized `blocks` / `block_properties` / `block_tags` SQL tables become **derived views** of the Loro doc, maintained by the materializer same as today's caches. Source of truth shifts to the Loro doc; SQL stays for query performance.

## Op-log shape change

**Option A (chosen): preserve the op_log table, opaque payload.**

Each Loro export-batch becomes one row in `op_log`. The payload is the Loro batch bytes (binary). The schema stays:

```text
op_log: (device_id, seq, parent_seqs, hash, op_type='loro_batch', payload, created_at)
```

The 12 existing typed op variants disappear from the active set; legacy rows in the op_log get replayed once (during cutover) into the Loro doc and never written again. Hash chain logic is unchanged (still blake3 over the row contents). Sync protocol's `OpTransfer` wire shape is unchanged — it just carries opaque bytes.

**Why A over B (schema rewrite):** minimum churn, preserves the rollback path, decouples the change from the snapshot/sync protocol formats, leaves the existing crash-recovery + replay infrastructure unchanged.

## Phased plan

| Phase | Duration | Goal | Reversible |
| --- | --- | --- | --- |
| **0 — Spike** | 2 weeks (hard time-box) | Prototype: import existing op log into Loro, run merge/tests.rs corpus through both engines, measure payload sizes, validate tree mapping | YES — kill criteria explicit |
| **1 — Shadow** | 2-3 weeks | Loro engine runs alongside diffy in production. Both compute merges; only diffy's result is authoritative; parity is logged. No user-visible change | YES — Loro is isolated |
| **2 — Cutover** | 2-3 weeks | Loro becomes authoritative. Legacy ops in op_log replayed once into Loro. Existing `merge/` deprecated but kept as fallback through the release | YES with effort — old engine still around |
| **3 — Cleanup** | 1-2 weeks | Delete `merge/` (~4.2k LOC). Drop `is_conflict` column (migration 0042-or-later). Delete the 293 SQL filter sites + remaining `is_conflict` references (~559 mentions). Close MAINT-113. | NO — irreversible by design |
| **4 — UX polish** (optional) | 1 week | Remove conflict-copy UX from the frontend (it's already produced nothing since cutover). Add a "recent merges" indicator if users want awareness of cross-device convergence. | YES |

**Total: 8-11 weeks calendar time, roughly 5.5-8.5 person-weeks of focused effort.**

## Phase 0 kill criteria

The spike is **2 weeks, hard time-box**. Reviewer flagged that the original criteria mixed measurable and subjective bars. Tightened version below — every criterion has an explicit threshold:

1. **Tree mapping is operational.** A prototype mapping (`LoroMap` over scalar `parent_id`+`position` with app-layer invariant maintenance, OR `LoroTree` if it's stable enough) supports all six required ops: create, move, delete, restore, purge, reparent. **Threshold: zero correctness failures** on a directly-ported subset of `merge/tests.rs` covering tree ops.
2. **Merge parity matches diffy on >=95% of the corpus.** Run all 53 test functions in `merge/tests.rs` through both engines. Count: (a) cases where results are *byte-identical*, (b) cases where Loro produces fewer conflict copies than diffy with content correctness preserved, (c) cases where Loro produces a *different but equally-valid* CRDT-correct result, (d) cases where Loro is wrong. **Thresholds: (a)+(b) >= 95%; (c) acceptable but each case documented; (d) must be 0.** If (d) > 0, kill.
3. **Op-log import is bounded.** Replay a 100K-op log into a fresh Loro doc. **Thresholds (revised, with stated rationale): under 10 min wall-clock and under 2 GB peak heap on the developer's reference machine.** Rationale: the user's actual workspace is the relevant baseline (currently bounded; verify pre-spike). 100K is a 6-month-of-heavy-use proxy. If the user's actual op-log is smaller, scale these thresholds proportionally.

**Additional kill conditions surfaced by reviewer:**

1. **Loro library status check.** Confirm Loro is at a usable pre-1.0 version (>= 0.x with stable LoroMap+LoroText), license is acceptable, and the maintainers have a documented serialization-format-stability stance for the version range we'd consume. **If serialization format can change between minor versions without an upgrade path for old payloads, kill** — that's a data-durability red line.
2. **`LoroTree` evaluation.** The plan's per-space-doc design uses `LoroMap` + scalar parent_id, but if `LoroTree` is stable and faster, reconsider. If `LoroTree` is "experimental" only, document the decision and stay with the LoroMap approach.

If any kill criterion fires: archive the prototype crate as `pending/PEND-09-spike-archive.tar.gz`, document the failing criterion in this file, return PEND-09 to "deferred" state in REVIEW-LATER.md, communicate the verdict.

## What the user sees after the migration

- **No more conflict copies.** Concurrent edits to different words / blocks merge automatically.
- **Cross-device convergence is faster** (Loro batches are typically smaller than current op-batches).
- **Same offline-first behavior.** Sync still happens on local WiFi when devices meet. Offline editing works identically.
- The conflict resolution UI disappears. (If users miss it as an "awareness" feature, Phase 4 adds a recent-merges log/notification.)

## What stays unchanged

- Sync transport: mDNS + WebSocket + TLS + TOFU pinning. No iroh.
- `op_log` schema: same shape, opaque `loro_batch` payload type.
- Materializer architecture: still maintains derived caches (FTS, agenda, tag inheritance, link graph). The Loro doc is the new source of truth for block content; the materializer reads from it on apply.
- Block tree storage in `blocks` table: kept as a query-optimized projection of the Loro state. Reads still go through SQL.
- All UI: editor, slash commands, agenda, FTS, properties — unchanged behavior, unchanged code.
- Snapshot + compaction: schema may add a `loro_doc_bytes` column to `log_snapshots` to seed new devices fast (TBD in Phase 2).

## Risks

| Risk | Mitigation |
| --- | --- |
| **Loro is pre-1.0** — API breaking changes during the migration window | Spike measures stability. Pin a specific minor version. Watch upstream releases. Budget half a day in each phase for upstream version bumps. |
| **Loro serialization format changes between versions** ⚠️ data-durability risk | Spike must validate format stability across minor versions. Add `loro_version` field to every op-log payload row. If the format breaks compatibility, the op log is unreadable on upgrade — this is a kill criterion (item 4) for a reason. |
| **Op-log → Loro import bug causes silent data loss** | Phase 1 shadow mode runs parity checks for weeks; database backups before Phase 2 cutover; the cutover is reversible if shadow-mode parity stays clean |
| **Loro perf cliff at certain doc sizes** | Phase 0 spike measures import + steady-state perf at 100K ops; Phase 1 measures on real user databases |
| **User loses awareness of concurrent edits** (today the conflict copy is a "look, two of you edited this" signal) | Optional Phase 4: recent-merges log; or a one-time "auto-merged your edit" toast. Probably unnecessary given the user's offline-occasional sync pattern |
| **Snapshot format change breaks recovery on legacy snapshots** | The snapshot format change is additive — old snapshots still loadable. The old `merge/` engine must remain in the binary as a fallback for **at least one full release after Phase 2 cutover** — explicit window. |
| **Block tree invariant maintenance bugs** (two siblings with same position, cycle) | App-layer validation on every Loro apply; same as today's invariant maintenance |
| **Materializer assumes `is_conflict` exists during Phase 1-2** | Phase 1 keeps the column; Phase 3 drops it. The 612 references get cleaned phase-by-phase, not all at once |
| **Materializer hot-path read cost from Loro doc** | Spike measures: in-memory Loro handle vs serialize-each-apply. If reads regress >10% vs current SQL-table reads, redesign the read path before Phase 1 (e.g., keep SQL caches as the materializer's read source, with Loro as the truth-of-state for sync only). |
| **Existing `is_conflict=1` rows in production** | Phase 2 migration includes a one-shot pass: convert each existing conflict copy into a Loro merge result (keeping the user-preferred winner if known, or both content versions concatenated as a reviewable record). Document the conversion rule before cutover. |
| **Op-type dispatcher breaks when every op_type=='loro_batch'** | Add `original_op_type: Option<OpType>` (or equivalent) to the loro_batch payload metadata so the materializer dispatcher can still route to the right handler. Or: rewrite the dispatcher to extract op-shape from Loro's batch metadata. Spike must pick one. |
| **Test corpus may be insufficient to catch CRDT-specific bugs** | Augment `merge/tests.rs` with proptest-generated random concurrent op streams during the spike (`proptest` is already a dev-dep). |
| **`OpTransfer` opaque payload prevents debugging** | Add a `payload_version` field on the wire so future clients can decode the format. Don't make the payload truly opaque — keep it structured + versioned. |
| **Tree-op conflict resolution semantics are loss-prone under LWW** (two devices reparent the same block to different parents → one device's intent is silently dropped) | Spike evaluated `LoroTree` (Day 5 — same LWW one-parent-wins state-level semantics as LoroMap+scalar). Phase 1 stays on `LoroMap` + scalar parent_id; the LWW resolution rule (property + move) is documented in [`PEND-09-lww-resolution-rule.md`](./PEND-09-lww-resolution-rule.md). Optional "remote-overrode-your-move" awareness log is logged as Phase-4 polish. |
| **Per-space doc size grows unbounded with usage** | Spike measures doc size at 10K and 100K blocks per space. If load time on app launch exceeds (e.g.) 500ms at 100K, switch to per-page-doc granularity OR split-load the space doc lazily. Decide before Phase 1. |

## Files affected (high level, by phase)

**Phase 0 — Spike (new code, no production impact):**

- New crate: `src-tauri/crates/loro-spike/` (Rust workspace member). Self-contained: depends on `loro 0.x`, exposes a CLI that takes a path to `notes.db` and runs the parity tests. (Archived in Phase-2 day-8 — see git tag `pend-09/spike-archive`; the spike's notes/report live at `pending/PEND-09-SPIKE-{NOTES,REPORT}.md`.)

**Phase 1 — Shadow:**

- `src-tauri/Cargo.toml` — add `loro = "0.x"` (post-spike-confirmed version)
- `src-tauri/src/loro/` — new module: `LoroEngine` struct, `apply_op()`, `export_batch()`, `import_batch()`
- `src-tauri/src/merge/mod.rs` — wrap diffy result + Loro result; log mismatches; return diffy as authoritative
- Tests: `src-tauri/src/merge/parity_tests.rs` (continuous parity sampling)

**Phase 2 — Cutover:**

- `src-tauri/migrations/0042_loro_doc_state.sql` — add a `loro_doc_state` table per space (snapshot of latest Loro doc bytes)
- `src-tauri/src/recovery/` — add Loro import path on first boot post-upgrade (one-time replay)
- `src-tauri/src/sync_protocol/` — `OpTransfer` payload becomes opaque (no behavior change, just doc cleanup)
- `src-tauri/src/merge/mod.rs` — Loro becomes authoritative; diffy kept as commented fallback for one release

**Phase 3 — Cleanup:**

- Delete `src-tauri/src/merge/{apply,detect,resolve,types}.rs`
- New migration `0043_drop_is_conflict.sql` — drop column from `blocks`
- Sweep: every recursive CTE filter `AND is_conflict = 0` removed (~293 SQL sites)
- Delete `ActiveBlockId` newtype if MAINT-113 progress was the only consumer
- 559 `is_conflict` references cleaned by codemod + manual review

**Phase 4 — UX:**

- `src/components/ConflictList*.tsx` — delete or repurpose into "recent merges" indicator
- Frontend tests + e2e specs for conflict UX deleted

## Total cost

Reviewer pushed back on the original timeline as optimistic for a solo maintainer. Revised estimate below.

- **Phase 0 — Spike:** 2-2.5 weeks, hard time-box. Includes Loro version + serialization stability validation, prototype, parity benchmarks against `merge/tests.rs` (53 functions), proptest-augmented corpus, payload-size + import-time measurements.
- **Phase 1 — Shadow:** 3-4 weeks. Dual-write logic, parity logging, weeks of production parity sampling. Debugging CRDT divergence under real workloads is non-trivial; not all surprises are foreseeable.
- **Phase 2 — Cutover:** 3-4 weeks. Legacy-import path is the highest-risk milestone; needs verification testing + database backup + reversal rehearsal. "Reversal" beyond Phase 1 takes a few days of work, not "trivial."
- **Phase 3 — Cleanup:** 2-3 weeks. 612 references (not 559); codemod + manual review of every site. Tedious but mechanical.
- **Phase 4 — UX (optional):** 1 week.

**Revised calendar: 11-15 weeks (3-4 months) for a solo maintainer. Effort: 7-11 person-weeks focused engineering + ongoing test maintenance.**

This is an aggressive but doable schedule. Build in a 2-3 week buffer that's invisible inside individual phase windows but visible in the overall plan: if Phase 0 reveals an unexpected Loro limitation, the buffer absorbs it without slipping cutover. If unused, ship faster.

## Total impact

- **-4,163 LOC** (`merge/`, verified)
- **-293 SQL filter sites** + **-612 total `is_conflict` references** swept across the codebase (reviewer-verified count)
- **-1 column** (`is_conflict`)
- **MAINT-113 closed** entirely (newtype rescue no longer needed once the column is gone)
- **Conflict UX gone** (no longer a thing the user has to handle)
- **Better merge results** (character-level, not line-level)
- **+1 dependency** (`loro` — pre-1.0, monitor format stability)
- **+1 module** (`src-tauri/src/loro/`)
- **+1-2 migrations** (`0042_loro_doc_state.sql`, `0043_drop_is_conflict.sql`)

Net: **substantial simplification** over a 3-4 month window, with explicit kill switches in week 2 and again at end of shadow mode.

## Total risk

**High but bounded.** Reversible up through Phase 1 with **a few days of work** (rip out Loro engine, parity logging, dual-write — not "trivial," but cheap relative to the full migration). Phase 2 reversible only with significant effort (un-import Loro state, restore is_conflict workflow, etc.) — practically equivalent to a one-way door once a release ships with Loro authoritative. Phase 3 is irreversible by design. The kill criteria + shadow-mode parity sampling are the safety net; the actual gates are end-of-Phase-0 (spike report) and end-of-Phase-1 (shadow-mode statistics).

## Decision points

- **End of Phase 0 (week 2)** — go/no-go on Phases 1-3. User decides based on the spike report (kill criteria above).
- **End of Phase 1** — final go/no-go on cutover. User decides based on shadow-mode parity statistics (e.g., "Loro and diffy agreed on 99.x% of merges over N weeks, mismatches were all explained, no data-loss class").
- **No other gates.** Once cutover ships, Phases 3 + 4 follow on whatever cadence makes sense.

## Open questions (honest list)

1. **What's Loro's current API stability?** Spike answers this. Verify the latest minor on first commit and pin. If pre-1.0 churn risk is severe, Phase 0 kill criterion 4 fires.
2. **Is Loro's binary serialization format stable across minor versions?** Critical durability question. If a 0.5 → 0.6 upgrade can break old payloads, you can't ship — kill criterion 4. Mitigation: `loro_version` field in every op-log payload + an in-binary import path for each older format.
3. **Per-space doc vs per-page doc?** Per-space is recommended above. A 10K-block space's Loro doc could be ~100MB — would per-page be cheaper to load? Spike measures load times at 10K and 100K blocks.
4. **Where does the Loro doc actually live?** Three options: (a) in-memory only, rehydrated from op_log on boot; (b) `loro_doc_state` table, periodically snapshotted; (c) per-space file in app data dir. **Recommendation: (b)** — keeps everything in `notes.db`, simplifies backups.
5. **How do conflicts on `parent_id` resolve?** If two devices reparent the same block to different parents, Loro's LWW gives one winner — but the loser's intent is gone. Spike must evaluate `LoroTree` (if stable enough). If staying on LWW: define + document explicit resolution rules + consider a "remote-overrode-your-move" awareness log.
6. **Materializer's read path from Loro?** In-memory handle (memory overhead) vs serialize/deserialize on each apply (CPU overhead). Spike measures both; if both are >10% slower than today's SQL reads, re-architect to keep SQL as the read cache and Loro as the source-of-truth for sync only.
7. **What's the dispatcher's path with op_type='loro_batch'?** Today's dispatcher routes by op_type. Either add `original_op_type` field to the payload (spike picks pattern) OR route by extracting op shape from Loro's batch metadata.
8. **Existing `is_conflict=1` blocks in production data** — what becomes of them in Phase 2? Decide: delete vs concat-into-merge-result vs keep as "legacy" markers. Document the rule before cutover.
9. **What's the actual user op-log volume today?** The 100K-op kill threshold is a proxy for 6-months-of-heavy-use; the real number for your data may be smaller. Verify against your `notes.db` pre-spike to size the threshold realistically.
10. **What about the 4 hot-path properties promoted to native columns** (`todo_state`, `priority`, `due_date`, `scheduled_date`)? They stay as native columns (cache layer), populated from Loro state. Dual-write becomes "Loro is source; column is derived" — cleaner than today.
11. **What about file attachments?** Out of scope here — they're not part of `merge/`. Sync stays as-is on the file-transfer path.
12. **Test corpus size enough?** `merge/tests.rs` has 53 test functions covering most known cases, but Spike must augment with proptest-generated random op streams to catch CRDT-specific edge cases.
