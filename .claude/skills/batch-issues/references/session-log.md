# Session log — template & conventions

Create one file per session at `docs/session-log/session-NNN-<slug>.md`. `NNN` is the
next session number (zero-padded to 3 digits); `<slug>` is a short kebab-case derivation
of the title. **One file per session, never appended to.** See
`docs/session-log/README.md` for naming + discovery conventions.

## Plan-issue bookkeeping

- If the session fully resolves a plan, the commit message must include `Closes #NN`
  (GitHub auto-closes the issue when the commit lands on `main`).
- If the session resolves part of a plan, post a status comment on the issue summarizing
  what shipped and what remains — don't close it.
- Reviewer corrections that surface during the session belong as comments on the issue,
  not edits to the body.

**Keep docs/FEATURE-MAP.md in sync:** if the session added commands, components, hooks,
stores, or database tables, update the relevant section.

## Template

The `## Session N — …` heading is the first line of the file; do not add a separate H1.

```text
## Session N — <short title> (YYYY-MM-DD)

| Metadata | Value |
|----------|-------|
| **Date** | YYYY-MM-DD |
| **Subagents** | <count> build + <count> review (or "orchestrator-only") |
| **Items closed** | <ID list — issue `#NN`, or "—"> |
| **Items modified** | <ID list, or "—"> |
| **Tests added** | +N (frontend) / +M (backend) |
| **Files touched** | <count> |

**Summary:** <2-3 sentence high-level outcome>

**Files touched (this session):**
- `path/to/file.ext` (LOC delta)
- ...

**Verification:**
- `cd src-tauri && cargo nextest run` — N tests run, N passed.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**Process notes:** <optional, only when worth capturing>

**Lessons learned (for future sessions):** <optional, only when applicable>

**Commit plan:** single commit / split / not pushed / pushed.
```

Do NOT add a trailing `---` separator — the file ends at the commit-plan line.

Apply this template to NEW sessions. Sessions 801–846 already migrated to per-session
files; sessions 1–800 remain in the two archive files (`docs/session-log/2024-2025.md`,
`docs/session-log/2026-sessions-401-800.md`) — frozen historical records, never edited.
