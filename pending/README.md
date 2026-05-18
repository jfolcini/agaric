# `pending/` — planned tasks

> **These are plans, not commits.** Scoped, time-estimated work with explicit cost / impact / risk. Each one is independently approve-able — pick what you want, when you want.
>
> **Convention:** when a task is done (or rejected), delete its plan file. `git log` + `SESSION-LOG.md` are the audit trail. The index below mirrors what's actually in `pending/` — no historical "Resolved" rows.

## Index

| ID | Title | Cost | Status |
| --- | --- | --- | --- |
| PEND-10 | iroh transport adoption (replaces mDNS+WebSocket+TLS+TOFU stack) | L (14-19 weeks) | ready as a **planned spike + multi-phase migration** (iroh wire-format stability + v1.0 minor-version churn policy is the headline kill criterion) |
| PEND-36 | Publish Agaric on Google Play Store (AAB build job + privacy policy URL + Play Console paperwork + 14-day closed test) | S (~1 day eng) + M-L (process, mostly waiting) | engineering work scoped; 3 maintainer decisions open (D1-D3); separate paperwork path |
| PEND-49 | OpenSSF Best Practices **Passing → Silver** roadmap (Passing achieved 2026-05-17; 14 unmet Silver criteria triaged into 5 buckets — only ~4 need engineering work, the rest are auto-meet / deliberate non-policy / upstream-blocked) | ~10-20 person-hours for cheap wins + L multi-week (`PEND-48` reproducible builds is the tentpole) | catalogued; 3 open questions (pursue Silver at all? platform sequencing? review cadence enforcement?) |
| PEND-56 | **Pages view foundation — density rows + extended sort modes.** New `list_pages_with_metadata` sibling IPC adds per-page metadata columns (last-modified, inbound-link count, child-block count, has-property flags); cursor v1 → v2 for new keysets; sort dropdown extends from 3 to 7 modes; density toggle (compact / regular / expanded) gated by a `pageBrowser.densityV1` flag. Foundation for PEND-57 / PEND-58. | M-L (~22 h) | scoped; 5 open Qs |
| PEND-57 | **Pages view — multi-select + bulk operations + saved views.** Reuses `useListMultiSelect` + `BatchActionToolbar` verbatim. Five new `*_by_ids` RW commands (bulk trash / tag / untag / move-to-space / set-property), each one `BEGIN IMMEDIATE` + `MAX_BATCH_BLOCK_IDS=1000` + single op-log seq range → one activity-feed entry per bulk op with `additionalOpRefs`. Saved views in localStorage v1 (schemaVersion-guarded; backend graduation deferred). | M-L (~17-22 h) | scoped; 5 open Qs |
| PEND-58 | **Pages view — compound filters; shared `FilterPrimitive` extraction with Search.** One backend enum + per-surface `Projection` trait + static `ALLOWED_KEYS` set. Pages gains grooming facets (`orphan:` / `stub:` / `has-no-inbound-links:` / `last-edited:bucket`); shares `tag:` / `path:` / `has-property:` / `last-edited:` / `space:` / `priority:` with Search. Chip-only UI (no inline parser in the Pages input); extends PEND-54's parser registry. | M-L (~16-23 h) | scoped; 5 open Qs |
| PEND-59 | **Adopt cmdk + migrate SearchablePopover.** Foundation for the multi-mode palette future. Add cmdk dep, ship a thin Agaric wrapper at `src/components/ui/command.tsx`, migrate `BacklinkFilterBuilder` + `FilterHelperPopover` callers, delete `SearchablePopover` (193 LOC retired). Came out of the post-autonomous-loop review session. | S-M (~8-11 h) | scoped; 3 open Qs |
| PEND-60 | **Caret-anchored autocomplete on cmdk.** Ships the popover PEND-54 deferred. When typing `tag:` / `state:` / `prop:` etc., a popover anchors next to the caret showing value suggestions. Depends on PEND-59. | M (~6-8 h) | scoped; 3 open Qs |
| PEND-61 | **Refactor Cmd+K palette to cmdk + multi-mode growth + `search_blocks_partitioned` IPC.** Replace hand-rolled PEND-51 palette with a cmdk shell; opens the door for Linear-style multi-mode (search / commands / nav / spaces / agents). Backend gains `search_blocks_partitioned` (one FTS scan instead of two). Depends on PEND-59. | M-L (~10-14 h) | scoped; 3 open Qs |
| PEND-62 | **Unified mobile search UX (one icon, scope toggle).** Collapses PEND-50 + 51 + 52 into one mobile sheet with `In this page` / `Across all pages` segments, context-aware default. Pure-touch users finally get in-page find. Depends on PEND-59, PEND-61. | M (~9-12 h) | scoped; 4 open Qs |
| PEND-66 | **Replace `document.execCommand` in palette page-link insertion.** Tracking PEND. PEND-51 uses deprecated `execCommand('insertText')` because it preserves undo. No action until browsers actually remove support; revisit quarterly. | (watch-and-act) | 2 open Qs |
| design-system-perf-review-2026-05-09 | Tier 1.3 (lazy-load the TipTap stack from JournalPage's static path) + Tier 2.6 follow-up (windowing for BlockListRenderer + BlockTree). | M-L | two open items |

Single-task plans live in `REVIEW-LATER.md` instead of as standalone files.

## Recommended order

**Strategic** — independent decisions with multi-phase timelines:

- PEND-10 (iroh transport adoption) — 14-19 weeks. Start with 3-week time-boxed Phase 0 spike. Headline kill criterion: iroh v1.0 wire-format stability + minor-version churn policy.
- PEND-36 (Play Store publishing) — ~1 day engineering + multi-week process/paperwork. Has 3 maintainer decisions (D1-D3) that gate the engineering.
- PEND-49 (OpenSSF Silver roadmap) — Passing achieved 2026-05-17. ~10-20 person-hours for cheap wins (form update + assurance case + security review); `PEND-48` reproducible builds is the multi-week tentpole. Read the 3 open questions before scheduling — answering "should the maintainer pursue Silver at all while solo?" determines whether anything past the form update is worth doing.

**Search overhaul — SHIPPED (2026-05-17/18).** PEND-50 / 51 / 52 / 53 / 54 / 55 all landed in six autonomous-loop cycles. See `pending/NOTES-AUTONOMOUS-2026-05-17.md` for the per-cycle decision log + review-worthy deviations.

**Search post-review follow-ups (PEND-59 → 66).** The post-autonomous review session decided to adopt cmdk and fix six smaller gaps. PEND-63 + 64 + 65 (the small backend cycle) **shipped 2026-05-18**. Remaining: **PEND-59** (cmdk foundation) unblocks PEND-60 (caret autocomplete), PEND-61 (palette refactor + `search_blocks_partitioned` IPC), and PEND-62 (mobile unified search). **PEND-66** is watch-and-act. Ship PEND-59 then 60 + 61 in series; PEND-62 last because it depends on both.

**Pages view overhaul (three plans, ship in series):** PEND-56 (density + sort + per-page metadata IPC) is the foundation; PEND-57 (bulk ops + saved views) overlays a selection layer on the density rows; PEND-58 (compound filters) shares `FilterPrimitive` primitives with PEND-54 at the backend while diverging on vocabulary and projection per surface. Total: ~7-10 focused days. PEND-58's Phase 1 (`FilterPrimitive` extraction) **also unblocks PEND-54's `SearchFilter` cleanup** — schedule the two together if Search and Pages filters are both on the roadmap.

## Workflow notes

- Each plan is self-contained. Read its file before starting.
- Reviewer corrections are folded into the body of each file with reviewer attribution where they surfaced a real bug.
- Cost / Impact / Risk live near the bottom of each plan. Review those three before deciding to schedule.
- When a task is done, **delete its file from `pending/`** (matching the REVIEW-LATER.md convention of "delete on completion, no historical record"). Land the work in a normal commit; the git history (and `SESSION-LOG.md`) are the audit trail.
- If a task is started but not finished, leave the file in place and add a short status note at the top.
- Tasks that get rejected: also delete the file. Don't keep "rejected" plans around; that's documentation rot.
- The README index above mirrors what's actually in `pending/`. If you add or remove a plan file, update the index in the same commit.
