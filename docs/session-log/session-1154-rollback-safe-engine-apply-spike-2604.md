## Session 1154 — Rollback-safe engine apply: staging primitive + per-op checkpoint bench (#2604) (2026-07-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-15 |
| **Subagents** | orchestrator-authored (single high-risk write-path item; no parallel split) |
| **Items advanced** | `#2604` (gating design question resolved; implementation is follow-up) |
| **Items closed** | — |
| **Tests added** | +3 backend (staging) |
| **Files touched** | 5 |

**Summary:** #2604 makes the in-memory Loro engine apply
transactional-by-construction (stage on a checkpoint/fork, promote only after SQL
COMMIT) to eliminate the engine-ahead-of-SQL divergence #2603 pins. The issue's
**gating design question** is the per-op checkpoint cost, and it flags a lighter
"undo-delta" fallback if a full fork is too costly. Rather than have a subagent
silently guess the mechanism on an L-sized (2–3 week) high-risk write-path change
with four open design questions, this session resolves the gate with data:

1. `LoroEngine::fork_staging()` — the staging building block. Forks the per-space
   doc AND re-pins the fork's peer id to the source's, closing a correctness
   landmine the issue doesn't mention: `LoroDoc::fork` assigns a *different*
   PeerID, so a naive fork-then-promote-delta would inject ops under a foreign
   peer, breaking the `device_id → peer_id` contract (`peer_id_from_device_id`)
   that sync + the #792 fork guards rest on.
2. `benches/engine_checkpoint_bench.rs` — measures `fork_only`, `stage_op`
   (fork+apply+export-delta), `promote_import`, and `snapshot_export` per op at
   100/1K/10K/100K (the Acceptance "bench at 100/1K/10K/100K"). All routines run
   on throwaway forks so the fixture is immutable and iterations are independent.
3. `docs/architecture/rollback-safe-engine-apply.md` — the design note comparing
   full-fork staging (A) vs. capture-delta/replay-inverse (B) vs. per-op snapshot
   (C), with the measured table and the fork-vs-undo-delta recommendation.

No production write-path behaviour changed this session — the promote-on-commit
wiring into `CommandTx::commit_and_dispatch` is the follow-up, gated on the
mechanism this bench selects.

**Files touched (this session):**
- `src-tauri/src/loro/engine/staging.rs` (new — `fork_staging` + 3 tests)
- `src-tauri/src/loro/engine/mod.rs` (+3 LOC — register the `staging` module)
- `src-tauri/benches/engine_checkpoint_bench.rs` (new)
- `src-tauri/Cargo.toml` (+4 LOC — `[[bench]]` entry)
- `docs/architecture/rollback-safe-engine-apply.md` (new — design note)

**Verification:**
- `cargo test --lib staging::tests` — 3 passed (isolate-until-promote, peer-id
  re-pin, discard-by-drop).
- `ENGINE_CHECKPOINT_FULL=1 cargo bench --bench engine_checkpoint_bench` — full
  100/1K/10K/100K table (numbers folded into the design note + the #2604 comment).
- Bench `--test` smoke gate (default scales) — runs clean; the fixture is a pure
  in-memory engine, so there is no raw-SQL schema-drift surface.

**Process notes:**
- Doc-only design surface + a new bench + a self-contained engine primitive; no
  `docs/FEATURE-MAP.md` change (no new command/component/hook/store/table).
- Applied batch-issues "where applicable": this L/high-risk item with open design
  questions is not parallel-splittable and should not be guessed at — so the
  session ships the gating measurement + design as its own PR and leaves the
  write-path surgery as a scoped follow-up, per the skill's "resolve open design
  questions before building" and "file/surface rather than silently guess" rules.
