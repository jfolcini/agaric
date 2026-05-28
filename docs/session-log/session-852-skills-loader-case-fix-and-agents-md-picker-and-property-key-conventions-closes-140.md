## Session 852 — skills loader case fix + AGENTS.md picker/property-key conventions (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only |
| **Items closed** | #140 (MAINT-192 — 2 AGENTS.md additions) |
| **Items modified** | — |
| **Tests added** | 0 (doc-only) |
| **Files touched** | 8 |

**Summary:** Two doc-only threads on one branch. (1) Project skills in `.claude/skills/*/` were not being picked up by Claude Code's skill loader because the per-skill manifest file was named `skill.md` (lowercase) and the `name:` frontmatter was Title Case — both contrary to the loader's expectations. Renamed all five manifests to `SKILL.md` and normalised each `name:` to the kebab-case folder slug; the `/reload-skills` count went from 13 → 18 confirming all five are now loaded. Two live doc references to the old lowercase path (`AGENTS.md`, `docs/session-log/README.md`) updated; archived session log files left untouched per their append-only rule. (2) Closes #140 — added two positive Mandatory-patterns entries to `AGENTS.md`: a pointer to the `useDebouncedCallback` hook (`src/hooks/useDebouncedCallback.ts`) and its 300 ms convention so new picker/filter components don't reinvent the debouncing lifecycle, and a pointer to the two canonical property-key filter sets (`INTERNAL_PROPERTY_KEYS` and `NON_DELETABLE_PROPERTIES`) with a note that the latter mirrors `is_builtin_property_key` in `src-tauri/src/op.rs` and must move together.

**Files touched (this session):**
- `.claude/skills/batch-issues/skill.md` → `.claude/skills/batch-issues/SKILL.md` (rename + frontmatter)
- `.claude/skills/debug-issue/skill.md` → `.claude/skills/debug-issue/SKILL.md` (rename + frontmatter)
- `.claude/skills/explore-codebase/skill.md` → `.claude/skills/explore-codebase/SKILL.md` (rename + frontmatter)
- `.claude/skills/refactor-safely/skill.md` → `.claude/skills/refactor-safely/SKILL.md` (rename + frontmatter)
- `.claude/skills/review-changes/skill.md` → `.claude/skills/review-changes/SKILL.md` (rename + frontmatter)
- `AGENTS.md` (+11, -1 — Mandatory-patterns additions for picker debouncing + property-key sets, plus the link to `batch-issues/SKILL.md` updated)
- `docs/session-log/README.md` (+1, -1 — link updated)
- `docs/session-log/session-852-…md` (new — this log)

**Verification:**
- `/reload-skills` reports 18 skills available after the rename (was 13). All five project skills (`batch-issues`, `debug-issue`, `explore-codebase`, `refactor-safely`, `review-changes`) appear in the in-session registry.
- `/batch-issues` body loads correctly from the renamed file.
- pre-commit hook — markdownlint / typos / lychee on the touched docs.
- pre-push hook — full prek pass.

**Process notes:** The skills loader case mismatch was found by user inspection (`/skills` showed nothing despite `/reload-skills` reporting 13 available — the two surfaces look at different sources). The fix is the kind of guardrail a tiny pre-commit hook could regress-proof (fail if `.claude/skills/*/skill.md` lowercase reappears); not in scope for this session but a candidate follow-up issue if it re-occurs.

**Commit plan:** two commits on branch `chore/skills-loader-and-agents-md-additions`, opened as one PR. Commit 1 = skill rename + frontmatter + live-doc path updates. Commit 2 = AGENTS.md additions closing #140 + session log.
