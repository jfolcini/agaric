## Session 1146 — Maintainer arch set completion (2026-07-03)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-03 |
| **Subagents** | ~14 build/review + 4 plan/design (opus throughout; every change reviewed one tier up, per the exhausted-Fable-credits policy) |
| **Issues addressed** | #2313 #2320 #2248 (b1) #2250/#2325 (Stage 1+2) #2326 — the maintainer-specified arch set |
| **PRs merged** | #2339 #2340 #2341 #2342 #2343 #2345 #2346 (7) |
| **#2344 chain** | #2347 (edit) · #2349 (create prereq) · #2353 (create) · #2351 (move prereq) · #2354 (move) · #2352 (delete) · #2350 (CI: sqruff pin) — completes the #2325 collapse |
| **Also** | #2355 (deps: cmov 0.5.4, RUSTSEC/Dependabot #27) |
| **Follow-ups remaining** | #2248 b2 (`SpaceId` newtype) + c (`SearchFilter`); #2325 multi-root batch delete + undo/redo are permanent exceptions |

**Summary:** Cleared the maintainer's explicit architecture set (#2326 #2325 #2320 #2313 #2250 #2248) end-to-end. One backend build worker at a time (serial, to avoid OOM/target-lock contention while sharing the machine), frontend fanned out. Every non-trivial change went build → adversarial review (re-ran gates, re-read cited source, ran falsification probes) → full pre-push gate. Also promoted a tacit editor footgun from session-log lore into `AGENTS.md` at the maintainer's request.

**Architecture (the set):**
- **#2320 query row alias** — replaced the last hand-rolled SQL surgery (`retarget_alias` `b.`→`{alias}.` byte-rewrite) with compile-time alias threading through the `Projection` trait; kept `compile()`/`compile_expr()` signatures stable so ~30 external call sites were untouched. SQL byte-identical (golden + nested-alias tests). `BacklinkProjection`'s ignored-`_alias` invariant proven safe in review.
- **#2250/#2325 apply-path collapse** — **Stage 1** (safety net): symmetric `set_property` `EngineMissingTarget` guard + a `b5_local_command_path_matches_remote` parity proptest (asserts zero `sql_only` fallbacks → engine-path-pinned) + fallback-doc tightening. **Stage 2**: introduced `apply_op_projected(advance_cursor: bool)` and routed `apply_op` (REMOTE) + the `PreOpState::None` LOCAL sites (AddTag/RemoveTag/SetProperty/DeleteProperty) through it — byte-identical. **Deliberately did NOT collapse** Create/Edit/Move/Delete: their LOCAL command paths do divergent/superset count+link maintenance vs `apply_op_tx` (Move's outbound-target `inbound_link_count` + the #2200 same-parent-reorder skip; create/edit eager-vs-deferred link reindex; delete's `descendants_affected`/`next_delete_ms` cohort machinery). Verified per-op that each STOP is a real behavioral divergence, not avoidance. Extended B5 to tags + added a `delete_restore_local_matches_remote` fixture. Remainder tracked in **#2344**.
- **#2326 hydrate-on-space-assignment** — hydrate a page's block subtree (nodes + properties + tags) into the per-space Loro engine at `SetProperty(space)` time, so create-then-`SetProperty(space)` subtrees take the engine path live instead of the `EngineMissingTarget` sql_only fallback. Fits existing abstractions (no new op/queue/sync-message). The full seed is correctness-required (the engine becomes the authoritative CRDT sync source); no duplicate-node hazard because these blocks were never in any prior engine export.
- **#2248 SpaceScope (b1 final)** — migrated `list_blocks` (highest caller count) from bare `space_id: String` to `scope: SpaceScope` + `require_active()`, completing the b1 filter group. Defense-in-depth against the `''`→cross-space-leak footgun (FE short-circuit → `requireActiveScope` throw → `require_active()` rejects Global → serde rejects `Active("")`). b2 (`SpaceId` newtype) + c (`SearchFilter`) remain on-issue.

**Frontend:** **#2313** — re-parse pending `priority:` queries when the vocabulary store hydrates (key `SearchPanel` memos on `usePriorityLevels()`), fixing the boot-race spurious-invalid-chip.

**Docs:** promoted the **ProseMirror `instanceof` module-copy footgun** (always-false across module copies; broke the bubble menu) into `AGENTS.md` anti-patterns + `docs/architecture/editor-and-content.md`.

**#2344 — apply-path collapse COMPLETED (follow-on to #2325, same session).** Routed every remaining single-op LOCAL command path through `apply_op_projected`, so LOCAL and REMOTE can no longer silently diverge. Sliced as a chain of small, individually-reviewed PRs:

- **EditBlock** (#2347) — clean swap (link reindex + count recompute now in-tx like REMOTE), cross-page link-parity conformance test.
- **Create** — needed a prerequisite: **#2349** made `apply_op_tx`'s Create arm stamp `page_id`/`space_id` in-tx *before* the count recompute (previously NULL in-tx → transiently wrong-low counts on the sync path), then the routing swap **#2353** removed the now-redundant LOCAL stamp + recompute.
- **Move** — prerequisite **#2351** unified the REMOTE Move-arm maintenance (shared `rederive_page_and_space_ids` for page_id+space_id, outbound-target `inbound_link_count`, and the #2200 same-parent-reorder skip); routing swap **#2354** removed the LOCAL copy. **This fixed a latent REMOTE bug**: cross-space moves got *zero* `space_id` maintenance (after #2200 dropped `RebuildPageIds`), leaving stale space attribution, plus stale outbound link counts.
- **Delete** (#2352) — no prerequisite; the equivalence was already proven by the `delete_restore_local_matches_remote` fixture. The one new wire: the command now runs the post-commit `dispatch_delete_descendants` engine fan-out (LOCAL delete never drove the engine before). Companion: gate the saturation probe on `rows_affected >= 99`.
- **CI fix #2350** (mid-run): pinned `sqruff@0.38.0` — its unpinned latest (0.39, needs rustc 1.96 vs the 1.95 pin) started reding every PR's lint.

Permanent exceptions (unchanged): undo/redo reverse-SQL and the multi-root combined-cascade batch delete.

**Key insight:** forcing LOCAL≡REMOTE surfaced *real latent REMOTE correctness bugs* (Create's transient wrong-low counts, Move's missing cross-space `space_id` maintenance) — the collapse was a correctness win, not just a refactor. All changes verified convergence-safe: `page_id`/`space_id`/`pages_cache.*` are SQL-derived cache columns, absent from the op-log/engine/sync surface, so unifying *when* they're computed can't cause two-device divergence.

**Lessons learned:**
1. **A "full collapse" premise can be false for a subset of ops.** #2325's assumption that the LOCAL/REMOTE paths differ only by cursor-advance holds only for `PreOpState::None` ops; create/edit/move/delete legitimately do more/different in-command maintenance. The right move was a partial collapse + a tracked follow-up, not forcing a divergent one.
2. **`.sqlx` regen must use a fresh migration-only temp DB.** Regenerating against a long-lived `dev.db` produced spurious 6-delete/2-add churn (schema/type-inference drift); a `mktemp` DB + `sqlx migrate run` + `cargo sqlx prepare` yields the deterministic diff CI expects. (A restructure that removes `query!` macros legitimately deletes their `.sqlx` entries — verify with `prepare --check`.)
3. **The pre-push hook is path-aware** — a frontend-only diff skips the Rust clippy/nextest stages, so frontend pushes never OOM-contend with a concurrent backend build. Only backend-vs-backend heavy ops need serializing.
4. **Transient `Connection closed by remote host` push failures** happen after the hook passes; the ref simply didn't land — verify `git ls-remote` and retry (not a hook failure).
5. **Parity tests can be vacuous by construction** — B5's content strategy never emits `[[ULID]]` tokens, so its `block_links` comparison was always-empty; edit-link parity needed a dedicated fixture with real cross-page link content.
6. **Server-side "Update branch" (`gh api PUT …/update-branch`) creates a merge commit with no DCO sign-off** → the PR's `dco` check reds. For a squash-merge target it's cosmetic (the squash erases it), but prefer a **local rebase + force-push** for a clean single DCO-signed, up-to-date commit.
7. **A stacked routing swap can surface a dead re-export only after its sibling merges** — `recompute_pages_cache_counts_for_pages` had two callers (create + move); removing the second (once the first merged into the rebase base) turned the re-export unused → clippy `-D warnings` caught it at push. Rebase onto the sibling before final verification.
8. **An upstream tool bumping its MSRV reds every PR** — `sqruff` 0.39 needing rustc 1.96 vs the repo's 1.95 pin broke the shared lint job; pin the tool version (a dedicated CI PR off main clears the inherited red for everyone).

**Commit plan:** per-issue PRs, all merged/merging; the #2344 chain completes the #2325 apply-path collapse. This log is the capstone.
