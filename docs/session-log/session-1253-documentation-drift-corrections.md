## Session 1253 — Documentation drift corrections (2026-08-04)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-04 |
| **Subagents** | 2 build + 2 review (+1 discovery) |
| **Items closed** | #3307 |
| **Items modified** | — |
| **Tests added** | +0 frontend / +0 backend |
| **Files touched** | 7 |

**Summary:** Contributor-facing UX, UI-map, feature, and comparison documentation now
matches the shipped keyboard scopes, picker architecture, journal modes, configurable
priority model, and complete task-state cycle. Repeated picker and journal catalogs were
replaced with links to their canonical feature documentation where practical.

**Files touched (this session):**
- `COMPARISON.md` (+5/-5)
- `docs/FEATURE-MAP.md` (+2/-2)
- `docs/UI-MAP.md` (+5/-14)
- `docs/UX.md` (+14/-5)
- `docs/features/journal-and-agenda.md` (+10/-3)
- `docs/features/pickers-and-slash.md` (+1/-1)
- `docs/session-log/session-1253-documentation-drift-corrections.md` (new)

**Verification:**
- `npx markdownlint-cli2` on all six changed documentation files — passed.
- `node scripts/check-md-link-targets.mjs` — 646 tracked Markdown files passed.
- `node scripts/check-doc-code-paths.mjs` — passed.
- `typos` on all six changed documentation files — passed.
- `git diff --check` — passed.

**Process notes:** Independent review caught that the canonical Journal and picker feature
pages retained related stale claims after the overview docs linked to them. The final
wording distinguishes content scoping from the calendar picker's availability, qualifies
fixed structural shortcuts and default-only priority bindings, and avoids brittle icon or
source-path shorthand.

**Commit plan:** single commit, pushed.
