## Session 925 — GFM underscore emphasis (#211) (2026-05-31)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-31 |
| **Subagents** | 1 build + 1 review + 1 finalize |
| **Items closed** | #211 |
| **Items modified** | — |
| **Tests added** | +18 (frontend) / +0 (backend) |
| **Files touched** | 3 |

**Summary:** Added CommonMark underscore-variant emphasis to the hand-rolled markdown parser — `_italic_`→italic, `__bold__`→bold — with the CommonMark flanking / word-boundary rule so intraword underscores (`snake_case`, `a_b_c`, `a__b__c`) stay literal. The serializer was left untouched, so underscore input round-trips to the canonical asterisk form (GFM-equivalent storage). Closes the last open item of #211.

**Files touched (this session):**
- `src/editor/markdown-parse.ts` (+74 / -36)
- `src/editor/__tests__/markdown-parse.test.ts` (+89)
- `docs/session-log/session-925-gfm-underscore-emphasis-211.md` (new)

**Verification:**
- `npx vitest run src/editor` — all editor tests pass (960 run, 0 failed).
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full checks pass.

**Process notes:** `__dunder__` (space/line-flanked) DOES emphasise under strict CommonMark, identical to `__bold__`; only word-flanked underscores stay literal. Switching the word-char test to Unicode `\p{L}\p{N}` fixed `中_x_中` (the old `[A-Za-z0-9]` would have wrongly emphasised it). The 3 finalize-session regression tests (`_ italic _` literal, `(_x_)` punctuation-flanked, `_foo*` cross-delimiter literal) all matched the implementation's correct CommonMark output with no expectation adjustments.

**Commit plan:** single commit, pushed, PR opened.
