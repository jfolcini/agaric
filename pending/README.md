# `pending/` — planned tasks

> **These are plans, not commits.** Scoped, time-estimated work with explicit cost / impact / risk. Each one is independently approve-able — pick what you want, when you want.
>
> **Convention:** when a task is done (or rejected), delete its plan file. `git log` + `SESSION-LOG.md` are the audit trail. The index below mirrors what's actually in `pending/` — no historical "Resolved" rows.

## Index

| ID | Title | Cost | Status |
| --- | --- | --- | --- |
| PEND-09 | CRDT migration (Loro), merge-layer only | L (11-15 weeks) | ready as a **planned spike + multi-phase migration** |
| PEND-10 | iroh transport adoption (replaces mDNS+WebSocket+TLS+TOFU stack) | L (14-19 weeks) | ready as a **planned spike + multi-phase migration** (iroh post-1.0 status is the headline kill criterion) |
| PEND-38 | Import progress streaming (`Channel<T>` Tier 3) | L restructure + S emission | deferred — needs `import_markdown` parse/apply split with per-block savepoints before channel work has UX value |
| agenda-loadmore-cursor-namespace-2026-05-13 | Agenda load-more cursor-namespace mismatch | S | latent bug flagged during sql-audit H3 review; pre-existing; fix is small but its own commit |
| agenda-sort-sql-pushdown-2026-05-13 | Agenda sort/group SQL pushdown (original H4) | M | deferred — JS sort on ≤200 items is sub-ms; SQL ORDER BY requires compound-cursor reshape |

## Recommended order

**Mid-tier** — useful but more invasive:

- PEND-38 (import progress) — gated on import-pipeline restructure; pursue when imports become a UX paper-cut or when someone is touching `import_markdown` for unrelated reasons

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
