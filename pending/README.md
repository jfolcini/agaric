# `pending/` — planned tasks

> **These are plans, not commits.** Scoped, time-estimated work with explicit cost / impact / risk. Each one is independently approve-able — pick what you want, when you want.
>
> **Convention:** when a task is done (or rejected), delete its plan file. `git log` + `SESSION-LOG.md` are the audit trail. The index below mirrors what's actually in `pending/` — no historical "Resolved" rows.

## Index

| ID | Title | Cost | Status |
| --- | --- | --- | --- |
| PEND-06 | Tauri 2 `Channel<T>` adoption for streaming progress | M-L (10-19h) | ready (Tier 1 sync progress first ~6-10h, Tier 2 file transfer later ~6-9h) |
| PEND-09 | CRDT migration (Loro), merge-layer only | L (11-15 weeks) | ready as a **planned spike + multi-phase migration** |
| PEND-10 | iroh transport adoption (replaces mDNS+WebSocket+TLS+TOFU stack) | L (14-19 weeks) | ready as a **planned spike + multi-phase migration** (iroh post-1.0 status is the headline kill criterion) |
| PEND-12 | build.rs codegen for space-filter SQL fragment (unblocks MAINT-172) | M (7-11h) | ready — PEND-18 prerequisite shipped (session 678); now safe to schedule |
| PEND-15 | Hard space separation — no cross-space links | L (7-12 weeks) | ready — **Phase 1 MUST land before PEND-09 Phase 2 cutover** (avoids CRDT engine producing fresh cross-space refs that one-shot severance would never see) |
| PEND-29 | Frontend robustness review — second pass | trivial (B-1 only remaining) | partial — **B-1 (BulletList Option A) needs product decision** (Option A remove vs Option B implement) before it can land |
| PEND-30 | Frontend maintainability review — JS / TS findings | trivial (L-3) + M-L (D-1..D-4 if taken later) | partial — L-3 (portal selector migration) deferred; D-1..D-4 decomposition opportunities tracked for future passes |

## Recommended order

**Quick wins first** — schedule when convenient, low / no dependencies:

- PEND-29 B-1 — blocked on product decision

**Mid-tier** — useful but more invasive:

- PEND-06 (`Channel<T>` adoption) — Tier 1 sync progress first, Tier 2 file transfer later
- PEND-30 (D-1..D-4 decomposition) — opportunistic, low priority

**Spaces enforcement bundle** — sequential, NOT parallel (touch the same `_inner` signatures):

- PEND-12 (build.rs codegen for space-filter SQL, unblocks MAINT-172) — 7-11h. Has a Phase 0 `include_str!`+sqlx spike. PEND-18 prerequisite landed in session 678.

**Strategic** — independent decisions with multi-phase timelines:

- PEND-15 (hard space separation, no cross-space links) — 7-12 weeks. **Phase 1 MUST land before PEND-09 Phase 2 cutover**.
- PEND-09 (CRDT migration via Loro) — 11-15 weeks. Start with 2-week time-boxed Phase 0 spike. Don't commit to Phases 1+ before the spike report. **Phase 2 cutover gated on PEND-15 Phase 1 completion.**
- PEND-10 (iroh transport adoption) — 14-19 weeks. Start with 3-week time-boxed Phase 0 spike. Headline kill criterion: iroh's current version + wire-format stability stance.

**Recommended sequencing of the strategic trio:** PEND-15 Phase 1 → PEND-09 (CRDT, transport unchanged) → PEND-10 (iroh, post-CRDT). Combined calendar, sequential: **~30-40 weeks of focused engineering** — most of a year for a solo maintainer. **Don't pursue more than one strategic item in parallel.**

## Workflow notes

- Each plan is self-contained. Read its file before starting.
- Reviewer corrections are folded into the body of each file with reviewer attribution where they surfaced a real bug.
- Cost / Impact / Risk live near the bottom of each plan. Review those three before deciding to schedule.
- When a task is done, **delete its file from `pending/`** (matching the REVIEW-LATER.md convention of "delete on completion, no historical record"). Land the work in a normal commit; the git history (and `SESSION-LOG.md`) are the audit trail.
- If a task is started but not finished, leave the file in place and add a short status note at the top.
- Tasks that get rejected: also delete the file. Don't keep "rejected" plans around; that's documentation rot.
- The README index above mirrors what's actually in `pending/`. If you add or remove a plan file, update the index in the same commit.
