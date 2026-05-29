## Session 891 — oxlint prefer-tag-over-role → error: #188 COMPLETE (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 6 build (+ orchestrator recovery/review) |
| **Items closed** | `#188` |
| **Items modified** | batch-issues skill |
| **Tests added** | +0 (role classification; assertions unchanged) |
| **Files touched** | ~70 |

**Summary:** Final #188 burndown cluster. Classified all 115 `jsx-a11y/prefer-tag-over-role`
sites and restored the rule to `error` — **completing #188** (all 17 migration-demoted rules are
now back at `error`; only the intentional `eslint/complexity` + `eslint/no-console` warns remain).
Most sites were **disable-with-reason** (intentional ARIA widget/grid roles on styled non-semantic
elements where the suggested native tag would break the widget or CSS-grid layout: `gridcell`/`row`
calendar+list views, custom `listbox`/`option` comboboxes, Radix `dialog`s, `group`s, SVG-container
`img`s); a handful were clean swaps (`role="region"`→`<section>`, sr-only `role="status"`→`<output>`).
Ran 6 build subagents in parallel in the main tree with git commands explicitly forbidden (per the
session-889 stash lesson), concurrently with the #110-bootstrap Rust track in an isolated worktree.

**Recovery / lessons applied:**
- After `oxfmt --write` on the batch, 6 sites regressed: oxfmt reflowed multi-attribute tags so
  `role=` landed on its own line, detaching the `oxlint-disable-next-line` (prefer-tag-over-role
  anchors at the `role=` line, not the opening tag). Fixed by wrapping those 6 elements in block
  `/* oxlint-disable … */ … /* oxlint-enable … */` pairs (survives oxfmt). Re-ran oxlint post-format.
- A `role="status"`→`<output>` swap in `marks/mermaid.tsx` broke 2 tests that query the literal
  `[role="status"]` attribute (implicit role ≠ attribute selector); reverted to `<div role="status">`
  + block disable.
- These three lessons were added to `.claude/skills/batch-issues/SKILL.md` (Common Pitfalls) per
  maintainer request, shipped in this PR.

**Verification:**
- `npx oxlint` — 0 errors; `prefer-tag-over-role` reports zero violations; only 5 intentional `complexity` warns remain.
- `npx tsc -b` — no errors.
- `npx vitest run` — **full suite: 10921 tests pass** (run as the arbiter; caught + fixed the mermaid + 6 detached-disable regressions before commit).

**Commit plan:** single commit (prefer-tag fixes + skill update + this log), pushed, PR with `Closes #188`.
