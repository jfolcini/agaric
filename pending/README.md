# `pending/` — planned tasks

> **These are plans, not commits.** Scoped, time-estimated work with explicit cost / impact / risk. Each one is independently approve-able — pick what you want, when you want.
>
> **Convention:** when a task is done (or rejected), delete its plan file. `git log` + `SESSION-LOG.md` are the audit trail. The index below mirrors what's actually in `pending/` — no historical "Resolved" rows.

## Index

| ID | Title | Cost | Status |
| --- | --- | --- | --- |
| PEND-10 | iroh transport adoption (replaces mDNS+WebSocket+TLS+TOFU stack) | L (14-19 weeks) | ready as a **planned spike + multi-phase migration** (iroh post-1.0 status is the headline kill criterion) |
| search-dialog-replace-view-2026-05-14 | Replace the full-takeover Search view with a Cmd+K-style dialog (drops view-replace context loss + ~700 lines of UI) | M-L (2-3 days) | **DRAFT — needs more discussion**; 8 open questions flagged inline |
| design-system-perf-review-2026-05-09 | Open: Tier 1.3 (lazy-load the TipTap stack from JournalPage's static path); Tier 2.6 follow-up (windowing for BlockListRenderer + BlockTree); one doc-drift item (AGENTS.md import-boundary automation). | M-L | partial-shipped, plan stays for follow-up |
| PEND-37 | Local dev feedback-loop speed-up (mold linker, target/debug cleanup, vitest env, workflow notes) | S | partial-shipped (L2 + L3 + L3-fix + CI siblings landed; vitest 169 s → 68.93 s, all 9874 green); L1 activation + L4/L5 outstanding |
| PEND-39 | CI parallelism overhaul (vitest + Playwright sharding, split `_validate.yml`, shared rust-cache) | M (~1-2 days, mostly YAML) | partial-shipped (C1, C2, C4 landed); C3, C5, C6, C8 want one coherent design |
| PEND-40 | Supply-chain hardening follow-ups (SLSA build provenance, `--locked` audit sweep, `cosign verify`, threat-model doc, unify cargo-audit/deny accept-lists) | S-M (~6-10 h) | partial-shipped (SHA-pin all actions + Dependabot, `npm audit signatures`, `cargo audit` hook, `.nsprc` expiry, `npx --yes` removed); 5 stretch items outstanding |

Single-task plans live in `REVIEW-LATER.md` instead of as standalone files. Session 745's cleanup moved five (PEND-38 import progress, agenda-sort-sql-pushdown tombstone, design-system-maintainability's lone FormattingToolbar item, sql-review's deferred M-8 snapshot streaming, and the tauri-2.11 dependabot bump) over per the "0/1 tasks → consolidate" rule.

## Recommended order

**Spaces enforcement bundle status:**

- PEND-18 (`SpaceId` newtype + `SpaceScope` enum) — shipped session 678.
- PEND-12 (build.rs codegen for space-filter SQL) — REJECTED session 679. The Phase 0 spike confirmed sqlx 0.8.6 `query!()` rejects `include_str!(concat!(env!("OUT_DIR"), …))` (parser requires a `LitStr`, not a macro-invocation token tree; upstream sqlx#3388 open with no fix). Plan deleted; fallback (drift-detection parity test) tracked under MAINT-172 in REVIEW-LATER.md, sized to mirror PEND-28a H1 Option 2's pattern (session 677).
- PEND-15 (hard space separation, no cross-space links) — **SHIPPED session 679 (all 5 phases).** Plan file deleted. Audit confirms 0 cross-space violations. Three write-time enforcement points (edit_block content scan, set_property ref-type validation, add_tag space check), two cache-filter paths (block_links + block_tag_refs), frontend broken-link cleanup. Path A (tags space-scoped).

- PEND-09 (CRDT migration via Loro) — **SHIPPED Sessions 697-700.** Loro-native sync, conflict layer fully retired, migration tag `pend-09/spike-archive`. Plan file deleted; saga lives in `SESSION-LOG.md` Sessions 697-700.

**Strategic** — independent decisions with multi-phase timelines:

- PEND-10 (iroh transport adoption) — 14-19 weeks. Start with 3-week time-boxed Phase 0 spike. Headline kill criterion: iroh's current version + wire-format stability stance. Now that PEND-09 has shipped, PEND-10 is the next strategic item; pursue it standalone.

## Workflow notes

- Each plan is self-contained. Read its file before starting.
- Reviewer corrections are folded into the body of each file with reviewer attribution where they surfaced a real bug.
- Cost / Impact / Risk live near the bottom of each plan. Review those three before deciding to schedule.
- When a task is done, **delete its file from `pending/`** (matching the REVIEW-LATER.md convention of "delete on completion, no historical record"). Land the work in a normal commit; the git history (and `SESSION-LOG.md`) are the audit trail.
- If a task is started but not finished, leave the file in place and add a short status note at the top.
- Tasks that get rejected: also delete the file. Don't keep "rejected" plans around; that's documentation rot.
- The README index above mirrors what's actually in `pending/`. If you add or remove a plan file, update the index in the same commit.
