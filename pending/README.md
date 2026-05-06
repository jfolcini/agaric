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
| PEND-30 | Frontend maintainability review — JS / TS findings | trivial (L-3) + M-L (D-1..D-4 if taken later) | partial — L-3 (portal selector migration) deferred; D-1..D-4 decomposition opportunities tracked for future passes |

## Recommended order

**Quick wins first** — schedule when convenient, low / no dependencies:

- PEND-30 (D-1..D-4 decomposition) — opportunistic, low priority

**Mid-tier** — useful but more invasive:

- PEND-06 (`Channel<T>` adoption) — Tier 1 sync progress first, Tier 2 file transfer later
- PEND-30 (D-1..D-4 decomposition) — opportunistic, low priority

**Spaces enforcement bundle status:**

- PEND-18 (`SpaceId` newtype + `SpaceScope` enum) — shipped session 678.
- PEND-12 (build.rs codegen for space-filter SQL) — REJECTED session 679. The Phase 0 spike confirmed sqlx 0.8.6 `query!()` rejects `include_str!(concat!(env!("OUT_DIR"), …))` (parser requires a `LitStr`, not a macro-invocation token tree; upstream sqlx#3388 open with no fix). Plan deleted; fallback (drift-detection parity test) tracked under MAINT-172 in REVIEW-LATER.md, sized to mirror PEND-28a H1 Option 2's pattern (session 677).
- PEND-15 (hard space separation, no cross-space links) — **SHIPPED session 679 (all 5 phases).** Plan file deleted. Audit confirms 0 cross-space violations. Three write-time enforcement points (edit_block content scan, set_property ref-type validation, add_tag space check), two cache-filter paths (block_links + block_tag_refs), frontend broken-link cleanup. Path A (tags space-scoped).

**Strategic** — independent decisions with multi-phase timelines:

- PEND-09 (CRDT migration via Loro) — 11-15 weeks. Start with 2-week time-boxed Phase 0 spike. Don't commit to Phases 1+ before the spike report. **Phase 2 cutover gated on PEND-15 Phase 1 completion (done — PEND-15 shipped session 679).**
- PEND-10 (iroh transport adoption) — 14-19 weeks. Start with 3-week time-boxed Phase 0 spike. Headline kill criterion: iroh's current version + wire-format stability stance.

**Recommended sequencing of the strategic duo:** PEND-09 (CRDT, transport unchanged) → PEND-10 (iroh, post-CRDT). Combined calendar, sequential: **~25-34 weeks of focused engineering**. **Don't pursue more than one strategic item in parallel.**

## Workflow notes

- Each plan is self-contained. Read its file before starting.
- Reviewer corrections are folded into the body of each file with reviewer attribution where they surfaced a real bug.
- Cost / Impact / Risk live near the bottom of each plan. Review those three before deciding to schedule.
- When a task is done, **delete its file from `pending/`** (matching the REVIEW-LATER.md convention of "delete on completion, no historical record"). Land the work in a normal commit; the git history (and `SESSION-LOG.md`) are the audit trail.
- If a task is started but not finished, leave the file in place and add a short status note at the top.
- Tasks that get rejected: also delete the file. Don't keep "rejected" plans around; that's documentation rot.
- The README index above mirrors what's actually in `pending/`. If you add or remove a plan file, update the index in the same commit.
