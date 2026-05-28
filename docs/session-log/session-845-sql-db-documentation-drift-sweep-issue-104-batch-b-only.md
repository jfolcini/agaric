## Session 845 — SQL/DB documentation drift sweep (issue #104, Batch B only) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only + 1 review subagent (technical) |
| **Items closed** | — (issue #104 partially shipped; D-12 deferred to maintainer) |
| **Items modified** | #104 (10-of-12 fixes shipped as Batch B; D-12 needs maintainer approval to touch `AGENTS.md`; D-13 auto-resolved by D-1) |
| **Tests added** | 0 (docs only) |
| **Files touched** | 5 |

**Summary:** Shipped Batch B of issue #104 — 10 code-vs-doc drift fixes across the 5 architecture docs. Each rewrite was spot-checked against its cited source on `main` before applying. D-12 (the `AGENTS.md:75` `verify_active` claim that still mentions the dropped `is_conflict` column) is **deferred** because `AGENTS.md:5` explicitly forbids changes "without explicit user approval. Ever." — the PR description calls this out so the maintainer can apply that one-line edit themselves. D-13 (a contradiction between `data-and-events.md:140` and `queries.md:43` about which cache holds `#[ULID]` refs) is auto-resolved by D-1 — `queries.md` was already correct, fixing `data-and-events.md` aligns them.

Per-fix breakdown:

- **D-1** (`data-and-events.md:140`) — `block_links` cache row claimed it captured `#[ULID]` tokens; the regex `ULID_LINK_RE` in `src-tauri/src/cache/mod.rs:67-69` matches only `[[ULID]]` and `((ULID))`. `#[ULID]` goes to `block_tag_refs` via the separate `TAG_REF_RE`.
- **D-2** (`data-and-events.md:64`) — PRAGMA list extended to include the five performance pragmas that `db.rs:432-443` actually sets (`wal_autocheckpoint`, `journal_size_limit`, `cache_size`, `mmap_size`, `temp_store`).
- **D-3** (`data-and-events.md:70`) — "Triggers" sentence now mentions both `check_block_type_insert` / `check_block_type_update` (migration 0005) alongside the op_log append-only trigger.
- **D-4** (`crdt-and-recovery.md:35`) — Bullet for `reparent_orphan_conflict_copies` deleted (grep confirms zero callsites in `src-tauri/src/`).
- **D-6** (`crdt-and-recovery.md:51-54`) — "What's in a snapshot" no longer lists Loro engine state (`SnapshotTables` is SQL-only per `snapshot/types.rs:103-113`); added a one-paragraph caveat explaining that Loro state lives in `loro_doc_state` and is restored by the engine's own load path.
- **D-7** (`crdt-and-recovery.md:60-65`) — Snapshot-write narrative rewritten to reflect M-69's single-tx fold (`snapshot/create.rs:234-257`). Boot recovery's pending-snapshot delete (step 1) is still motivated as the SQLite-layer crash-window guard.
- **D-8** (`sync-and-network.md:71`) — `SnapshotOffer { size_bytes, up_to_hash }` → `SnapshotOffer { size_bytes }` per `sync_protocol/types.rs:177`; clarified that `up_to_hash` is advanced separately during apply.
- **D-9** (`sync-and-network.md:47`) — "compile-time assertion" → `#[test]` (pointer to `recv_timeout_invariant::recv_timeout_exceeds_handshake_timeout`) with a note on why it's not `const_assert!` (`Duration::from_secs` const-fn limits).
- **D-10** (`operations.md:63`) — Stale "PropertyRowEditor decomposition — done." done-marker removed from the forward-looking roadmap list.
- **D-11** (`pages-view.md:143-148`) — Measured-latency table replaced with a prose pointer to `src-tauri/benches/interactive_slo.rs`; obeys [[feedback_no_doc_counts]].

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (work was a `plan`-labelled GitHub issue, not REVIEW-LATER).
- **Previously resolved:** 1350+ → 1350+ across 844 → 845 sessions.

**Files touched (this session):**
- `docs/architecture/data-and-events.md` (+3, -3 — D-1 / D-2 / D-3)
- `docs/architecture/crdt-and-recovery.md` (+5, -7 — D-4 / D-6 / D-7)
- `docs/architecture/sync-and-network.md` (+2, -2 — D-8 / D-9)
- `docs/architecture/operations.md` (+0, -1 — D-10)
- `docs/architecture/pages-view.md` (+1, -8 — D-11)

**Verification:**
- `prek run --files <touched>` — markdownlint / lychee / typos / doc-citations / markdown-link-targets all pass.
- Each rewrite spot-checked against its cited source file on `main` before applying.
- Technical review subagent — LGTM across correctness / conventions / link-integrity / no-drift-introduced.

**Process notes:** `AGENTS.md:5`'s prohibition ("No changes to this file (AGENTS.md) without explicit user approval. Ever.") forced D-12 (the load-bearing `verify_active(pool, &BlockId)` invariant correction) into the maintainer-only bucket — surfaced in the PR description rather than guessing. Same pattern applied to issue #104's split into Batch A (AGENTS.md, maintainer-only) and Batch B (architecture docs, autonomous-safe).

**Commit plan:** single commit on topic branch `issue-104-sql-db-docs-drift-sweep`; PR against `main`. Does NOT close #104 — leaves it open with a comment noting Batch B shipped and D-12 still owed.
