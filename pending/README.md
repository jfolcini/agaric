# `pending/` — planned tasks

> **These are plans, not commits.** Scoped, time-estimated work with explicit cost / impact / risk. Each one is independently approve-able — pick what you want, when you want.
>
> **Convention:** when a task is done (or rejected), delete its plan file. `git log` + `SESSION-LOG.md` are the audit trail. The index below mirrors what's actually in `pending/` — no historical "Resolved" rows.

## Index

| ID | Title | Cost | Status |
| --- | --- | --- | --- |
| PEND-10 | iroh transport adoption (replaces mDNS+WebSocket+TLS+TOFU stack) | L (14-19 weeks) | ready as a **planned spike + multi-phase migration** (iroh wire-format stability + v1.0 minor-version churn policy is the headline kill criterion) |
| PEND-36 | Publish Agaric on Google Play Store (AAB build job + privacy policy URL + Play Console paperwork + 14-day closed test) | S (~1 day eng) + M-L (process, mostly waiting) | engineering work scoped; 4 maintainer decisions open (D1-D4); separate paperwork path |
| search-dialog-replace-view-2026-05-14 | Replace the full-takeover Search view with a Cmd+K-style dialog (drops view-replace context loss + ~700 lines of UI) | M-L (2-3 days) | **DRAFT — needs more discussion**; 8 open questions flagged inline |
| design-system-perf-review-2026-05-09 | Tier 1.3 (lazy-load the TipTap stack from JournalPage's static path) + Tier 2.6 follow-up (windowing for BlockListRenderer + BlockTree). | M-L | two open items |

Single-task plans live in `REVIEW-LATER.md` instead of as standalone files.

## Recommended order

**Strategic** — independent decisions with multi-phase timelines:

- PEND-10 (iroh transport adoption) — 14-19 weeks. Start with 3-week time-boxed Phase 0 spike. Headline kill criterion: iroh v1.0 wire-format stability + minor-version churn policy.
- PEND-36 (Play Store publishing) — ~1 day engineering + multi-week process/paperwork. Has 4 maintainer decisions (D1-D4) that gate the engineering.

## Workflow notes

- Each plan is self-contained. Read its file before starting.
- Reviewer corrections are folded into the body of each file with reviewer attribution where they surfaced a real bug.
- Cost / Impact / Risk live near the bottom of each plan. Review those three before deciding to schedule.
- When a task is done, **delete its file from `pending/`** (matching the REVIEW-LATER.md convention of "delete on completion, no historical record"). Land the work in a normal commit; the git history (and `SESSION-LOG.md`) are the audit trail.
- If a task is started but not finished, leave the file in place and add a short status note at the top.
- Tasks that get rejected: also delete the file. Don't keep "rejected" plans around; that's documentation rot.
- The README index above mirrors what's actually in `pending/`. If you add or remove a plan file, update the index in the same commit.
