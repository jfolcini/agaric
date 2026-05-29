## Session 878 — oxlint warning burndown, batch 2 (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator-only |
| **Items closed** | — |
| **Items modified** | `#188` (batch 2 of N) |
| **Tests added** | — |
| **Files touched** | 2 |

**Summary:** Second oxlint burndown increment (#188). Ratcheted `unicorn/prefer-string-starts-ends-with` from `warn` to `error`. Only one of the rule's three candidate sites was actually a violation — oxlint cannot convert the two `\b` word-boundary regexes (`/^Bold\b/`, `/^External link\b/`), so it never flagged them; only the pure-literal `/^Inline code \(/` was. Converted that one to `text.startsWith('Inline code (')`.

**Files touched (this session):**
- `.oxlintrc.json` — `unicorn/prefer-string-starts-ends-with` `warn` → `error`.
- `src/components/__tests__/SelectionBubbleMenu.test.tsx` — `/^Inline code \(/.test(text)` → `text.startsWith('Inline code (')`.

**Verification:**
- `npx oxlint` — exit 0 (rule now errors with zero violations; the `\b` regexes are not flagged, so no change needed there).
- `npx oxfmt --check` — exit 0.
- `npx vitest run SelectionBubbleMenu` — 39 pass.

**Process notes:** Confirmed via `oxlint --format=json` that only the literal-prefix regex was a violation before touching code — avoids the trap of "fixing" the `\b` regexes with a `startsWith` that would silently broaden the match. Remaining #188 rules (`no-this-alias`, `no-thenable`, `react/no-children-prop`, jsx-a11y clusters) need per-site judgment; #188 stays open.

**Commit plan:** single commit / pushed.
