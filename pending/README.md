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
| PEND-50 | **Foundation — page-grouped result rendering + match highlighting.** Replaces flat result list with VSCode-style page-grouped trees; FTS5 `snippet()`-driven highlighting + result count. Preserves legacy `+ Page` / `+ Tag` chips (PEND-54 replaces them later). Foundation for PEND-51 / 54 / 55 / 53. | S-M (~9-12 h) | scoped; 3 open Qs |
| PEND-51 | **Cmd+K palette.** Second search surface; top-N page-grouped results, no filters/toggles, escalation footer. Fuzzy ranking + `[[page]]` autocomplete + ~80 ms debounce. Mobile Sheet. Shares `<SearchResultGroup>` with PEND-50. | M (~1-1.5 days) | scoped; all 8 draft Qs baked in |
| PEND-52 | **In-page find (`Ctrl+F`).** ProseMirror-Decoration toolbar overlaying the editor; `F3` / `Shift+F3` nav. **Reclaims `Ctrl+F`** for in-page find; rebinds find-in-files view to `Ctrl+Shift+F` (coordinated with PEND-50). Frontend-only. | M (~10-13 h) | scoped; 3 open Qs |
| PEND-53 | **Property / metadata filters.** Extends PEND-54's filter framework with `state:` / `priority:` / `due:` / `scheduled:` / `prop:key=value` tokens + structured autocomplete + SQL sub-selects on `block_properties` + typed-column predicates. | M (~14-22 h) | scoped; 4 open Qs |
| PEND-54 | **Inline filter syntax framework + glob/tag filters.** Replaces legacy chips with parsed-AST chip projections; `+ Filter ▾` helper popover + caret autocomplete. Extensible token registry (PEND-53 inherits). Glob via SQLite native `GLOB`. | M-L (~13.5-17.5 h) | scoped; 3 open Qs |
| PEND-55 | **Toggle row + search history.** `Aa Ab\| .*` toggles next to input; Rust post-FTS regex filter via `regex` crate (linear-time + `size_limit`). History: localStorage, 20 entries, `↑`/`↓` recall when empty. | M (~11-15 h) | scoped; 4 open Qs |
| design-system-perf-review-2026-05-09 | Tier 1.3 (lazy-load the TipTap stack from JournalPage's static path) + Tier 2.6 follow-up (windowing for BlockListRenderer + BlockTree). | M-L | two open items |

Single-task plans live in `REVIEW-LATER.md` instead of as standalone files.

## Recommended order

**Strategic** — independent decisions with multi-phase timelines:

- PEND-10 (iroh transport adoption) — 14-19 weeks. Start with 3-week time-boxed Phase 0 spike. Headline kill criterion: iroh v1.0 wire-format stability + minor-version churn policy.
- PEND-36 (Play Store publishing) — ~1 day engineering + multi-week process/paperwork. Has 3 maintainer decisions (D1-D3) that gate the engineering.
- PEND-49 (OpenSSF Silver roadmap) — Passing achieved 2026-05-17. ~10-20 person-hours for cheap wins (form update + assurance case + security review); `PEND-48` reproducible builds is the multi-week tentpole. Read the 3 open questions before scheduling — answering "should the maintainer pursue Silver at all while solo?" determines whether anything past the form update is worth doing.

**Search overhaul (six plans):** PEND-50 (foundation: IPC struct migration + grouped renderer) is the dependency root. After PEND-50, PEND-51 (Cmd+K palette) / PEND-52 (in-page find) / PEND-55 (toggles + history) are independent and can ship in any order. PEND-54 (inline filter syntax) also depends on PEND-50; PEND-53 (property filters) depends on PEND-54. Total: ~5-7 focused days. Read the audit-derived notes in each plan before scheduling — several critical fixes (UTF-16 offsets, value_text column, AppError prefix protocol, ProseMirror Decoration apply semantics) need to land verbatim.

## Workflow notes

- Each plan is self-contained. Read its file before starting.
- Reviewer corrections are folded into the body of each file with reviewer attribution where they surfaced a real bug.
- Cost / Impact / Risk live near the bottom of each plan. Review those three before deciding to schedule.
- When a task is done, **delete its file from `pending/`** (matching the REVIEW-LATER.md convention of "delete on completion, no historical record"). Land the work in a normal commit; the git history (and `SESSION-LOG.md`) are the audit trail.
- If a task is started but not finished, leave the file in place and add a short status note at the top.
- Tasks that get rejected: also delete the file. Don't keep "rejected" plans around; that's documentation rot.
- The README index above mirrors what's actually in `pending/`. If you add or remove a plan file, update the index in the same commit.
