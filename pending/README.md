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
| PEND-57 | **Pages view — multi-select + bulk operations + saved views.** Reuses `useListMultiSelect` + `BatchActionToolbar` verbatim. Five new `*_by_ids` RW commands (bulk trash / tag / untag / move-to-space / set-property), each one `BEGIN IMMEDIATE` + `MAX_BATCH_BLOCK_IDS=1000` + single op-log seq range → one activity-feed entry per bulk op with `additionalOpRefs`. Saved views in localStorage v1 (schemaVersion-guarded; backend graduation deferred). | M-L (~17-22 h) | scoped; 5 open Qs |
| PEND-58g | **Search view — deep-review round 2 (consolidated plan of record).** Verified findings (7 specialists + 3 anti-hallucination verifiers) for the whole search view, after the PEND-58f hardening shipped. ~50 confirmed items across SQL/FTS, backend, frontend, DSL, UX/a11y, docs, and e2e. Top clusters: regex-mode silently drops structural filters; the FE-3 virtualization keyboard-nav regressions; the toggle/`has_more` pagination contract; the FilterHelperPopover surface. | M-L | catalogued + verified; nothing started |
| PEND-66 | **Replace `document.execCommand` in palette page-link insertion.** Tracking PEND. PEND-51 uses deprecated `execCommand('insertText')` because it preserves undo. No action until browsers actually remove support; revisit quarterly. | (watch-and-act) | 2 open Qs |
| PEND-68 | **Dedicated star/delete page actions + quick-nav in the recent strip.** (A) Extract a shared `PageQuickActions` (star + delete) and wire it into the page editor header (dedicated delete, not just kebab) and journal day headers (neither today), with a confirmed + undoable soft-delete. (B) Turn `RecentPagesStrip` into a two-zone `QuickAccessBar` — sticky destination chips (Pages/Tags/Graph/Search → `setView`, `aria-current`) + the existing scrollable recents — segmented per best-practice. FE-only; no schema migrations, no new always-on commands. | M (~10-14 h) | scoped; 5 open Qs |
| design-system-perf-review-2026-05-09 | Tier 1.3 (lazy-load the TipTap stack from JournalPage's static path) + Tier 2.6 follow-up (windowing for BlockListRenderer + BlockTree). | M-L | two open items |

Single-task plans live in `REVIEW-LATER.md` instead of as standalone files.

## Recommended order

**Strategic** — independent decisions with multi-phase timelines:

- PEND-10 (iroh transport adoption) — 14-19 weeks. Start with 3-week time-boxed Phase 0 spike. Headline kill criterion: iroh v1.0 wire-format stability + minor-version churn policy.
- PEND-36 (Play Store publishing) — ~1 day engineering + multi-week process/paperwork. Has 3 maintainer decisions (D1-D3) that gate the engineering.
- PEND-49 (OpenSSF Silver roadmap) — Passing achieved 2026-05-17. ~10-20 person-hours for cheap wins (form update + assurance case + security review); `PEND-48` reproducible builds is the multi-week tentpole. Read the 3 open questions before scheduling — answering "should the maintainer pursue Silver at all while solo?" determines whether anything past the form update is worth doing.

**Search overhaul — SHIPPED (2026-05-17/18).** PEND-50 / 51 / 52 / 53 / 54 / 55 all landed in six autonomous-loop cycles. See `pending/NOTES-AUTONOMOUS-2026-05-17.md` for the per-cycle decision log + review-worthy deviations.

**Search overhaul — shipped + hardened.** PEND-60 (caret autocomplete) shipped 2026-05-18; PEND-61 / PEND-67 / **PEND-62 (mobile unified search)** shipped 2026-05-19 via the cmdk PR. The PEND-58f hardening (deep-review round 1 + the FE-2/FE-3/FE-9/FE-10 performance trilogy) shipped 2026-05-23 on `pend-58f-search-view-hardening`. **Remaining search work:** **PEND-58g** (deep-review round 2 — the consolidated plan of record), and **PEND-66** (watch-and-act on `execCommand` deprecation, no immediate action).

**Pages view overhaul:** PEND-56 (density + sort + per-page metadata IPC) and PEND-58 (compound filters; shared `FilterPrimitive` extraction) both **shipped** (their plan files were deleted on completion). Remaining: **PEND-57** (bulk ops + saved views — overlays a selection layer on the density rows). PEND-58d's hardening shipped; its lone deferred item (fold-`<mark>` highlight bounding) moved to `REVIEW-LATER.md` as `PAGES-FOLD-MARK`.

## Workflow notes

- Each plan is self-contained. Read its file before starting.
- Reviewer corrections are folded into the body of each file with reviewer attribution where they surfaced a real bug.
- Cost / Impact / Risk live near the bottom of each plan. Review those three before deciding to schedule.
- When a task is done, **delete its file from `pending/`** (matching the REVIEW-LATER.md convention of "delete on completion, no historical record"). Land the work in a normal commit; the git history (and `SESSION-LOG.md`) are the audit trail.
- If a task is started but not finished, leave the file in place and add a short status note at the top.
- Tasks that get rejected: also delete the file. Don't keep "rejected" plans around; that's documentation rot.
- The README index above mirrors what's actually in `pending/`. If you add or remove a plan file, update the index in the same commit.
