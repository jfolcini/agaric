## Session 1146 — Maintainer arch set completion (2026-07-03)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-03 |
| **Subagents** | ~14 build/review + 4 plan/design (opus throughout; every change reviewed one tier up, per the exhausted-Fable-credits policy) |
| **Issues addressed** | #2313 #2320 #2248 (b1) #2250/#2325 (Stage 1+2) #2326 — the maintainer-specified arch set |
| **PRs merged** | #2339 #2340 #2341 #2342 #2343 #2345 #2346 (7) |
| **PRs open** | #2347 (#2344 slice 1) |
| **Follow-ups filed** | #2344 (finish the apply-path collapse for the maintenance-divergent ops) |

**Summary:** Cleared the maintainer's explicit architecture set (#2326 #2325 #2320 #2313 #2250 #2248) end-to-end. One backend build worker at a time (serial, to avoid OOM/target-lock contention while sharing the machine), frontend fanned out. Every non-trivial change went build → adversarial review (re-ran gates, re-read cited source, ran falsification probes) → full pre-push gate. Also promoted a tacit editor footgun from session-log lore into `AGENTS.md` at the maintainer's request.

**Architecture (the set):**
- **#2320 query row alias** — replaced the last hand-rolled SQL surgery (`retarget_alias` `b.`→`{alias}.` byte-rewrite) with compile-time alias threading through the `Projection` trait; kept `compile()`/`compile_expr()` signatures stable so ~30 external call sites were untouched. SQL byte-identical (golden + nested-alias tests). `BacklinkProjection`'s ignored-`_alias` invariant proven safe in review.
- **#2250/#2325 apply-path collapse** — **Stage 1** (safety net): symmetric `set_property` `EngineMissingTarget` guard + a `b5_local_command_path_matches_remote` parity proptest (asserts zero `sql_only` fallbacks → engine-path-pinned) + fallback-doc tightening. **Stage 2**: introduced `apply_op_projected(advance_cursor: bool)` and routed `apply_op` (REMOTE) + the `PreOpState::None` LOCAL sites (AddTag/RemoveTag/SetProperty/DeleteProperty) through it — byte-identical. **Deliberately did NOT collapse** Create/Edit/Move/Delete: their LOCAL command paths do divergent/superset count+link maintenance vs `apply_op_tx` (Move's outbound-target `inbound_link_count` + the #2200 same-parent-reorder skip; create/edit eager-vs-deferred link reindex; delete's `descendants_affected`/`next_delete_ms` cohort machinery). Verified per-op that each STOP is a real behavioral divergence, not avoidance. Extended B5 to tags + added a `delete_restore_local_matches_remote` fixture. Remainder tracked in **#2344**.
- **#2326 hydrate-on-space-assignment** — hydrate a page's block subtree (nodes + properties + tags) into the per-space Loro engine at `SetProperty(space)` time, so create-then-`SetProperty(space)` subtrees take the engine path live instead of the `EngineMissingTarget` sql_only fallback. Fits existing abstractions (no new op/queue/sync-message). The full seed is correctness-required (the engine becomes the authoritative CRDT sync source); no duplicate-node hazard because these blocks were never in any prior engine export.
- **#2248 SpaceScope (b1 final)** — migrated `list_blocks` (highest caller count) from bare `space_id: String` to `scope: SpaceScope` + `require_active()`, completing the b1 filter group. Defense-in-depth against the `''`→cross-space-leak footgun (FE short-circuit → `requireActiveScope` throw → `require_active()` rejects Global → serde rejects `Active("")`). b2 (`SpaceId` newtype) + c (`SearchFilter`) remain on-issue.

**Frontend:** **#2313** — re-parse pending `priority:` queries when the vocabulary store hydrates (key `SearchPanel` memos on `usePriorityLevels()`), fixing the boot-race spurious-invalid-chip.

**Docs:** promoted the **ProseMirror `instanceof` module-copy footgun** (always-false across module copies; broke the bubble menu) into `AGENTS.md` anti-patterns + `docs/architecture/editor-and-content.md`.

**#2344 slice 1 (open, #2347):** routed LOCAL `edit_block_inner` through `apply_op_projected(false)` so its link reindex + count recompute run in-tx like REMOTE; guarded by a dedicated cross-page link-parity conformance test. Create/Move/Delete slices remain.

**Lessons learned:**
1. **A "full collapse" premise can be false for a subset of ops.** #2325's assumption that the LOCAL/REMOTE paths differ only by cursor-advance holds only for `PreOpState::None` ops; create/edit/move/delete legitimately do more/different in-command maintenance. The right move was a partial collapse + a tracked follow-up, not forcing a divergent one.
2. **`.sqlx` regen must use a fresh migration-only temp DB.** Regenerating against a long-lived `dev.db` produced spurious 6-delete/2-add churn (schema/type-inference drift); a `mktemp` DB + `sqlx migrate run` + `cargo sqlx prepare` yields the deterministic diff CI expects. (A restructure that removes `query!` macros legitimately deletes their `.sqlx` entries — verify with `prepare --check`.)
3. **The pre-push hook is path-aware** — a frontend-only diff skips the Rust clippy/nextest stages, so frontend pushes never OOM-contend with a concurrent backend build. Only backend-vs-backend heavy ops need serializing.
4. **Transient `Connection closed by remote host` push failures** happen after the hook passes; the ref simply didn't land — verify `git ls-remote` and retry (not a hook failure).
5. **Parity tests can be vacuous by construction** — B5's content strategy never emits `[[ULID]]` tokens, so its `block_links` comparison was always-empty; edit-link parity needed a dedicated fixture with real cross-page link content.

**Commit plan:** per-issue PRs (7 merged, #2347 open); this log is the capstone.
