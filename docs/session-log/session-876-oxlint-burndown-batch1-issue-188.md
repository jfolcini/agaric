## Session 876 — oxlint warning burndown, batch 1 (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator-only |
| **Items closed** | — |
| **Items modified** | `#188` (batch 1 of N) |
| **Tests added** | — (lint-policy ratchet; existing tests cover the touched code) |
| **Files touched** | 5 |

**Summary:** First burndown of the oxlint warnings deferred during the OXC migration (#88 → tracked by #188). Fixed every violation of three low-risk, unambiguously-mechanical rules and ratcheted them from `warn` back to `error` in `.oxlintrc.json`: `unicorn/no-new-array` (3), `unicorn/no-useless-fallback-in-spread` (1), `eslint/no-unused-vars` (1).

**Files touched (this session):**
- `.oxlintrc.json` — 3 rules `warn` → `error`.
- `src/lib/template-utils.ts` — 2× `new Array(n)` → `Array.from(...)` (one `.fill(0)`, one sparse pre-sized array later index-filled then `.filter`ed — verified semantically identical).
- `src/components/DiffDisplay.tsx` — `new Array(n).fill(null)` → `Array.from(..., () => null)`.
- `src/__tests__/helpers/axe.ts` — `{...(options?.rules ?? {})}` → `{...options?.rules}`.
- `src/components/journal/JournalCalendarDropdown.tsx` — destructure-to-exclude param `day` → `day: _day`.

**Verification:**
- `npx oxlint` — exit 0 (the 3 ratcheted rules now error with zero violations; only the still-deferred warnings remain).
- `npx oxfmt --check` — exit 0.
- `npx vitest run` (affected files) — 63 passed.
- pre-commit hook — oxlint + oxfmt + tsc pass.

**Process notes:** Scoped batch 1 to rules whose every site was zero-semantic-risk. Deliberately left for later batches (need judgment / per-site care): `unicorn/prefer-string-starts-ends-with` (the 3 sites use `\b` word boundaries, so `startsWith` would subtly differ), `typescript/no-this-alias` (TipTap node-view `this` capture), `unicorn/no-thenable` + `react/no-children-prop` (likely intentional test mocks), and the larger jsx-a11y clusters. #188 stays open.

**Commit plan:** single commit / pushed.
