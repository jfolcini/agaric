# `pending/` — planned tasks

> **These are plans, not commits.** Scoped, time-estimated work with explicit cost / impact / risk. Each one is independently approve-able — pick what you want, when you want.
>
> **Convention:** when a task is done (or rejected), delete its plan file. `git log` + `SESSION-LOG.md` are the audit trail. The index below mirrors what's actually in `pending/` — no historical "Resolved" rows.

## Index

| ID | Title | Cost | Status |
| --- | --- | --- | --- |
| PEND-10 | iroh transport adoption (replaces mDNS+WebSocket+TLS+TOFU stack) | L (14-19 weeks) | ready as a **planned spike + multi-phase migration** (iroh post-1.0 status is the headline kill criterion) |
| PEND-38 | Import progress streaming (`Channel<T>` Tier 3) | L restructure + S emission | deferred — needs `import_markdown` parse/apply split with per-block savepoints before channel work has UX value |
| agenda-sort-sql-pushdown-2026-05-13 | Agenda sort/group SQL pushdown (original H4) | M | deferred — JS sort on ≤200 items is sub-ms; SQL ORDER BY requires compound-cursor reshape |
| tauri-2.11-migration-2026-05-13 | Dependabot bump 2.10.3 → 2.11.1 — `tauri-specta::collect_commands!` symbol scheme broke between 2.10 and 2.11. | S–M | **blocked** on upstream `tauri-specta` RC matching tauri 2.11 macro layout |
| search-dialog-replace-view-2026-05-14 | Replace the full-takeover Search view with a Cmd+K-style dialog (drops view-replace context loss + ~700 lines of UI) | M-L (2-3 days) | **DRAFT — needs more discussion**; 8 open questions flagged inline |
| design-system-maintainability-2026-05-09 | Audit: drift around the edges (Phases 1-3). Phase 1 (mechanical cleanup) mostly shipped — 1d (text-[10px] decision) needs a design pass; Phase 2 (badge consolidation, asChild polymorphism, MetricCard / SectionGroupHeader / FormField extractions) + Phase 3 (structural) still open. | M-L | partial-shipped, plan stays for follow-up |
| design-system-perf-review-2026-05-09 | Audit: store fan-out + critical-path bytes. Tier 1 (5 items: `useResolveStore` double-subscribe, `page-blocks.blocksById` rebuild, eager preloaded `editor`/`LinkPreviewTooltip` chunks, `BlockListItem.memo` defeats, `SortableBlockWrapper` not memoized) entirely open. Tier 2/3 mostly shipped. | M-L | partial-shipped, plan stays for follow-up |
| design-system-ux-review-2026-05-09 | Audit: cross-screen composition + doc/code drift. Tier 1 items 4-7 + 11 (badge consolidation, FeaturePageHeader, settings heading style, filter UI consolidation, ConfirmDialog merge) + Tier 2 D2/D4 + structural Tier 3 (component decomposition, FeatureErrorBoundary in-view, list-primitive zoo) still open. | M-L | partial-shipped, plan stays for follow-up |

## Recommended order

**Mid-tier** — useful but more invasive:

- PEND-38 (import progress) — gated on import-pipeline restructure; pursue when imports become a UX paper-cut or when someone is touching `import_markdown` for unrelated reasons

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
