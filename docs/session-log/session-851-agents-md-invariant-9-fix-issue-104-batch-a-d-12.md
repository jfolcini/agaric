## Session 851 — AGENTS.md Invariant #9 fix + pending/ folder retirement + batch-issues skill (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | 2 (parallel: IDEAS.md → issues, REVIEW-LATER.md → issues) |
| **Items closed** | #104 (D-12 ships; Batch B already shipped in #115 → issue fully resolved) |
| **Items created** | 33 GitHub issues (#123–#155, gaps where racing creates landed elsewhere): 11 `idea`-labelled from IDEAS.md, 22 `enhancement`/`bug`-labelled from REVIEW-LATER.md |
| **Items dropped (tombstones)** | 8 — PERF-19, PERF-20, L-61, MAINT-168, AGENDA-SQL, CI-R11, OSSF-1 (dup of #80), OSSF-4 (time-based auto-recovery) |
| **Tests added** | 0 (docs / process only) |
| **Files touched** | 9 (1 modified, 4 added, 4 deleted) |

**Summary:** Three intertwined changes landing in one PR. (1) Ship Batch A / D-12 of issue #104 — the load-bearing AGENTS.md Invariant #9 correction: `verify_active(pool, &BlockId)` documented as `deleted_at IS NULL AND is_conflict = 0`, but the `is_conflict` column was dropped in `migrations/0058_pend_09_drop_is_conflict.sql` and the actual Rust function (`src-tauri/src/ulid.rs:317-339`) only checks `deleted_at`. With Batch B (PR #115) already merged, #104 is fully resolved. (2) Retire the `pending/` folder entirely — the migration from `pending/PEND-NN-*.md` files to GitHub issues started 2026-05-27 (sessions 841-845) and finishes here: IDEAS.md and REVIEW-LATER.md were the last two files. Two parallel subagents created 33 issues (11 with new `idea` label, 22 with existing `enhancement`/`bug` labels), 8 deliberate-non-fix tombstones were dropped (git history is the audit trail), and the folder is now gone. (3) Convert `PROMPT.md` into a slash-invocable skill at `.claude/skills/batch-issues/skill.md` so the 7-step plan→build→test→review→merge→log→commit workflow is reachable as `/batch-issues` while keeping the canonical content in one place.

**Issues created — IDEAS.md → `idea` label (11):**
- #123 saved searches (find-in-files)
- #124 search-and-replace across blocks
- #125 `[[page]]` autocomplete inline in the editor
- #127 semantic / AI-augmented search
- #130 emoji picker + emoji support
- #131 mobile search — recent searches in empty state
- #132 mobile search — voice input button
- #133 mobile search — pull-to-dismiss bottom sheet
- #135 mobile search — long-press scope-pin
- #136 mobile search — scope chip in input
- #137 mobile search — haptic feedback

**Issues created — REVIEW-LATER.md → `enhancement`/`bug` (22):**
- #126 FEAT-3p9: per-space GCal + OS notifications
- #128 PEND-38: import progress streaming over `Channel<T>`
- #129 SQL-M-8: snapshot restore streaming (Android-conditional)
- #134 FEAT-5g: GCal Android OAuth + background connector (DEFERRED design sketch)
- #138 FEAT-11: adopt `tauri-plugin-notification`
- #139 MAINT-172: space-filter SQL fragment inlined across 13+ files
- #140 MAINT-192: 2 AGENTS.md additions (now ready — maintainer authorized AGENTS.md edits this session)
- #141 MAINT-208: defer 3 `block_on` startup calls (Android boot perf, conditional)
- #142 MAINT-209: gcal connector channel + agenda fetch hygiene (speculative)
- #143 MAINT-227: gcal OAuth — migrate `tauri-plugin-shell::open` (deprecated) → `tauri-plugin-opener`
- #144 OSSF-2: Scorecard Code-Review score = 0 (solo-maintainer ruleset)
- #145 OSSF-3: Scorecard Vulnerabilities score = 0 (gtk3 RUSTSEC advisories via wry/tauri)
- #146 PEND-48: verify reproducible builds end-to-end (Bestpractices Silver tier)
- #147 CI-R3: Windows code signing via SignPath.io OSS
- #148 CI-R15: Vitest pool A/B benchmark (forks vs threads)
- #149 CI-R16: SKIP_CI_VERIFY reason-string / safe-glob guard
- #150 TEST-PROPTEST-B: property-test coverage Tier B (DB-bound)
- #151 CR-A11Y: search/settings a11y polish + popover/menu semantics (`bug`)
- #152 CR-DSL-QUOTE: quoted filter values with spaces in search DSL (`bug`)
- #153 CR-PERF: exit-save timeout / snapshot mutex / breadcrumb re-fetch
- #154 CR-UX: search touch toggle-mode explanation + runtime-verify items
- #155 CR-E2E-TAURI: Tauri-driven e2e harness

**Tombstones dropped (NOT migrated — git history is the audit trail):**
- PERF-19, PERF-20 — "Decision: Defer — keep tracked as a deliberate non-fix"
- L-61 — "DELIBERATE — no action"
- MAINT-168 — "Decision: Defer — documented design note"
- AGENDA-SQL — "Filed as a tombstone so a future contributor doesn't re-derive the blocker"
- CI-R11 — "strict no-go for current cycle per maintainer decision"
- OSSF-1 — already lives as issue #80 (Silver-tier roadmap); skipped as duplicate
- OSSF-4 — "until then no action; auto-recovers in 90 days"

**Files touched (this session):**
- `AGENTS.md` (D-12: drop `AND is_conflict = 0` from Invariant #9; repoint workflow link from `PROMPT.md` to the new skill)
- `.claude/skills/batch-issues/skill.md` (new — the 7-step workflow as an invocable skill)
- `PROMPT.md` (deleted — content lives in the skill now)
- `pending/IDEAS.md` (deleted — content migrated to issues)
- `pending/REVIEW-LATER.md` (deleted — actionable items migrated; deliberate-non-fix tombstones dropped)
- `pending/README.md` (deleted — was just an index pointing at the two retired files)
- `docs/session-log/README.md` (repoint PROMPT.md ref → batch-issues skill)
- `docs/session-log/session-851-agents-md-invariant-9-fix-issue-104-batch-a-d-12.md` (new — this file)
- `scripts/check-doc-code-paths.mjs` (remove `pending` from `PATH_PREFIX_RE`; drop `PROMPT.md` from `DOC_ROOTS`)
- Doc-reference sweep (per maintainer direction: docs must not reference `pending/` or issue tracker URLs):
  - `GOVERNANCE.md` — rewrite §"How decisions are made" backlog pointer
  - `docs/ARCHITECTURE.md` — "Backlog" bullet rewritten
  - `docs/FEATURE-MAP.md` — companion-docs line + Roadmap section rewritten
  - `docs/architecture/ci-and-tooling.md` — drop `CI-R3`/`CI-R11` issue pointers
  - `docs/architecture/threat-model.md` — drop `CI-R3`/`CI-R11`/`OSSF-3`/`FEAT-3p9` pointers
  - `docs/architecture/integrations.md` — drop FEAT-3p9 pointer
  - `docs/architecture/operations.md` — drop iroh `#78` pointer + Roadmap section pointer
  - `docs/architecture/tooling.md` — drop zizmor deferred-policy pointer
  - `docs/architecture/rejected.md` — drop iroh `#78` pointer
  - `docs/features/spaces.md` — drop FEAT-3p9 pointer
  - `docs/security/README.md` — drop Silver-roadmap `#80` pointer

**Verification:**
- Spot-checked `src-tauri/src/ulid.rs:317-339` and `src-tauri/migrations/0058_pend_09_drop_is_conflict.sql` to confirm the column was dropped and `verify_active` checks only `deleted_at`.
- `rg "is_conflict" src-tauri/src/` returns zero matches — no live callers of the dropped column.
- All 33 created issues confirmed via the URL returned by `gh issue create`.
- pre-commit hook — staged-file checks pass.
- pre-push hook — push-staged checks pass.

**Process notes:**
- **Parallel subagents for non-overlapping issue creation:** Two `general-purpose` subagents ran concurrently (one per source file). Issue numbers came back non-contiguous because their `gh issue create` calls interleaved; that's expected and harmless — the numbers don't carry meaning beyond uniqueness.
- **`pending/` retirement closes a multi-session arc.** Future ideation and small-ticket tracking go straight to GitHub issues.
- **PROMPT.md → skill conversion:** PROMPT.md's content was the project's workflow doc, but it was being treated as canonical state by sessions. Moving it to `.claude/skills/batch-issues/skill.md` makes it invocable (`/batch-issues`) and frames it correctly — it's an executable workflow, not a doc.
- **Docs no longer reference `pending/` or the issue tracker.** Per maintainer direction, architecture docs and feature docs describe current state only; tracking happens in the issue tracker but isn't linked from doc prose. The doc-vs-code-paths hook now reflects that (no longer scans for `pending/` prefixes).

**Commit plan:** two commits on topic branch `issue-104-agents-md-invariant9-fix` (branched fresh from up-to-date `main`):
1. `feat(skills): add batch-issues skill — migrate PROMPT.md to invocable form`
2. `chore: ship #104 D-12 (AGENTS.md Invariant #9) + retire pending/ folder (Closes #104)`

PR against `main`. Commit (2) includes `Closes #104` so GitHub auto-closes the issue when this lands.
