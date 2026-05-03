# `pending/` — planned tasks from the 2026-05-03 architectural review

Origin: a deep architectural review session run with five parallel investigation subagents, followed by per-task planning subagents and per-task reviewer subagents (planner + reviewer pairs). Each plan was independently audited for hallucinations, exaggeration, and unverified claims; corrections were folded back into the final plan files.

> **These are plans, not commits.** They describe scoped, time-estimated work with explicit cost / impact / risk. Each one is independently approve-able — pick what you want, when you want.

## Index

| ID | Title | Cost | Status |
|---|---|---|---|
| PEND-01 | Rename `MDNS_SERVICE_NAME` `BlockNotes` → `Agaric` | trivial | ✅ done this session |
| PEND-02 | Rename "CQRS hybrid model" → "event sourcing with materialized views" | S | ready (gated on AGENTS.md edit approval) |
| PEND-03 | Materializer silent-drop fix for global cache rebuilds | M (4-7h) | ready (revised after reviewer found a SQL constraint bug + 7 enum variants needed, not 1) |
| PEND-04 | Threat-model audit — prune stale crypto docs | S (~1h) | ready (reviewer confirmed: HKDF/ChaCha already removed in MAINT-110, only docs are stale; identified 5 specific stale locations) |
| PEND-05 | Projected-agenda parity test (cached vs on-the-fly) | S (1-2h) | ready (revised: range extended to >365d to expose the horizon drift the reviewer caught) |
| PEND-06 | Tauri 2 `Channel<T>` adoption for streaming progress | M-L (10-19h) | ready (revised: reviewer caught the `TransferringFiles` state hallucination, Tier 2 cost +2-4h) |
| PEND-07 | `STRICT` tables policy for new migrations | S (~1h) | ready |
| PEND-08 | `tauri.ts` ↔ `bindings.ts` parity pre-commit hook | S (1-2h) | ready (verified: 101 commands, 96 wrappers, 5 unwrapped MCP/GCal commands) |
| PEND-09 | CRDT migration (Loro), merge-layer only | L (3-4 months) | ready as a **planned spike + multi-phase migration** (revised after reviewer caught a 612-vs-559 reference count, optimistic timeline, missing risks; timeline now 11-15 weeks) |
| PEND-10 | iroh transport adoption (replaces mDNS+WebSocket+TLS+TOFU stack) | L (3.5-5 months) | ready as a **planned spike + multi-phase migration** (revised after reviewer caught LOC undercount of ~87% — actual delete is ~14.6k LOC including test files, not ~7.8k; timeline 14-19 weeks; 13 risks + 13 open questions; iroh post-1.0 status is the headline kill criterion) |

## Recommended order

**Quick wins first** — schedule when convenient, no dependencies:
1. PEND-01 (already done)
2. PEND-02 (CQRS rename) — gated on AGENTS.md approval
3. PEND-04 (stale crypto docs) — pure docs, ~1h
4. PEND-07 (STRICT tables policy) — pure policy + small hook, ~1h
5. PEND-08 (parity hook) — small script + prek entry, 1-2h
6. PEND-05 (agenda parity test) — single test addition, 1-2h

**Mid-tier** — useful but more invasive:

7. PEND-03 (silent-drop fix) — schema migration + materializer changes, 4-7h
8. PEND-06 (Channel<T> adoption) — Tier 1 sync progress first (~6-10h), Tier 2 file transfer later (~6-9h)

**Strategic** — each is a separate decision with its own multi-phase timeline:

9. PEND-09 (CRDT migration via Loro) — start with the 2-week time-boxed Phase 0 spike. Do not commit to Phases 1+ before the spike report. Total: 11-15 weeks.
10. PEND-10 (iroh transport adoption) — start with the 3-week time-boxed Phase 0 spike. The headline kill criterion is iroh's actual current version + wire-format stability stance — answer that before committing to Phases 1+. Total: 14-19 weeks.

**Recommended sequencing of the two strategic items:** iroh first, CRDT after. Rationale (also in PEND-10 §"Sequencing with PEND-09"): debugging a new transport while the merge engine is the well-tested diffy is easier than debugging both at once; CRDT migration then runs against a known-stable transport. Combined calendar, sequential: ~28-36 weeks of focused engineering — most of a year for a solo maintainer. **Don't pursue both in parallel.**

## Workflow notes

- Each plan is self-contained. Read its file before starting.
- Reviewer corrections are folded into the body of each file (with reviewer attribution where it surfaced a real bug — e.g. PEND-03's SQL constraint, PEND-05's horizon-drift gap, PEND-06's `TransferringFiles` hallucination, PEND-09's reference-count undercount).
- Cost / Impact / Risk live near the bottom of each plan. Review those three before deciding to schedule.
- When a task is done, **delete its file from `pending/`** (matching the REVIEW-LATER.md convention of "delete on completion, no historical record"). Land the work in a normal commit; the git history is the audit trail.
- If a task is started but not finished, leave the file in place and add a short status note at the top.
- Tasks that get rejected: also delete the file. Don't keep "rejected" plans around; that's documentation rot.
