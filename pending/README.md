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
| PEND-50 | **Find-in-files surface (Ctrl+F view).** VSCode-style page-name glob filters (SQL-side via SQLite `GLOB`) + `Aa` / `Ab\|` / `.*` toggles (Rust post-filter on FTS candidates) + page-grouped result rendering + docs expansion. Paired with PEND-51. | M (Phase 0 ~2-3 h shared `<SearchResultGroup>` + Phase 1 ~5-8 h glob filters + Phase 2 ~6-10 h toggle row) | scoped; 5 open questions (bare-token substring default, regex result highlighting, persisted toggle state, saved searches scope, `?`-button placement) |
| PEND-51 | **Navigation surface (Cmd+K palette).** Adds a Cmd+K dialog as a second search surface coexisting with the Ctrl+F view; top-N page-grouped results, no filters, no toggles, escalation footer to PEND-50's view. Mobile: Sheet. Paired with PEND-50 (shares Phase 0 render component). | M (~1-1.5 days; Phase 0 shared with PEND-50) | scoped; all 8 original draft questions answered + baked in |
| design-system-perf-review-2026-05-09 | Tier 1.3 (lazy-load the TipTap stack from JournalPage's static path) + Tier 2.6 follow-up (windowing for BlockListRenderer + BlockTree). | M-L | two open items |

Single-task plans live in `REVIEW-LATER.md` instead of as standalone files.

## Recommended order

**Strategic** — independent decisions with multi-phase timelines:

- PEND-10 (iroh transport adoption) — 14-19 weeks. Start with 3-week time-boxed Phase 0 spike. Headline kill criterion: iroh v1.0 wire-format stability + minor-version churn policy.
- PEND-36 (Play Store publishing) — ~1 day engineering + multi-week process/paperwork. Has 3 maintainer decisions (D1-D3) that gate the engineering.
- PEND-49 (OpenSSF Silver roadmap) — Passing achieved 2026-05-17. ~10-20 person-hours for cheap wins (form update + assurance case + security review); `PEND-48` reproducible builds is the multi-week tentpole. Read the 3 open questions before scheduling — answering "should the maintainer pursue Silver at all while solo?" determines whether anything past the form update is worth doing.

## Workflow notes

- Each plan is self-contained. Read its file before starting.
- Reviewer corrections are folded into the body of each file with reviewer attribution where they surfaced a real bug.
- Cost / Impact / Risk live near the bottom of each plan. Review those three before deciding to schedule.
- When a task is done, **delete its file from `pending/`** (matching the REVIEW-LATER.md convention of "delete on completion, no historical record"). Land the work in a normal commit; the git history (and `SESSION-LOG.md`) are the audit trail.
- If a task is started but not finished, leave the file in place and add a short status note at the top.
- Tasks that get rejected: also delete the file. Don't keep "rejected" plans around; that's documentation rot.
- The README index above mirrors what's actually in `pending/`. If you add or remove a plan file, update the index in the same commit.
