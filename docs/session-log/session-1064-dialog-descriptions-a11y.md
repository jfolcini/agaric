## Session 1064 — Radix dialog descriptions a11y (#1505) (2026-06-18)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-18 |
| **Subagents** | 1 audit (Explore) + 1 review |
| **Items closed** | `#1505` |
| **Items modified** | `#1504` (CI red fixed: BlockTree vitest cascade) |
| **Tests added** | guard in test-setup (suite-wide) + 8 fixture opt-outs |
| **Files touched** | 6 (this issue) + 1 (PR #1504 fix) |

**Summary:** Closed the a11y gap where Radix dialog/sheet/alert surfaces logged
"Missing `Description`" 95× across the vitest suite. Added accessible (sr-only)
descriptions to the three production offenders (CommandPalette, EmojiPickerDialog's
mobile Sheet + desktop Dialog), opted the 8 bare-primitive `sheet.test.tsx` infra
fixtures out via `aria-describedby={undefined}`, and added a `console.warn` guard in
`test-setup.ts` that fails any test rendering a dialog without a description so the
regression cannot creep back. Also fixed the inherited CI red on PR #1504 (a
`unicorn/prefer-add-event-listener` lint-fix changed `handleAttach` to
`addEventListener`, breaking the `/attach` tests that fired via `.onchange` and
cascading 58 stack-overflow failures).

**Files touched (this session):**
- `src/components/common/CommandPalette.tsx` (+1/-1) — render `<Description>` from useDialogOrSheet parts.
- `src/components/EmojiPicker/EmojiPickerDialog.tsx` (+8/-2) — SheetDescription (mobile) + DialogDescription (desktop).
- `src/components/ui/__tests__/sheet.test.tsx` (+8/-8) — `aria-describedby={undefined}` opt-out on 8 infra fixtures.
- `src/lib/i18n/references.ts` (+1) — `palette.dialogDescription`.
- `src/lib/i18n/editor.ts` (+1) — `emojiPicker.dialogDescription`.
- `src/test-setup.ts` (+28) — suite-wide missing-description regression guard.
- `src/components/editor/__tests__/BlockTree.test.tsx` (PR #1504 branch) — dispatch real `change` event for /attach.

**Verification:**
- `npx vitest run` — 579 files, 13288 tests, all passing with the guard active (0 missing-description warnings).
- Negative control: removing one fixture opt-out makes the guard fail that test with the #1505 message; restored.
- `npx tsc -b --noEmit` — clean.
- pre-commit / pre-push hooks — pass.

**Process notes:** Used an Explore agent for a complete render-level audit of all 42
Content surfaces (production + test) before adding the all-or-nothing guard — the guard
is only safe once every offender is fixed. The full-suite run with the guard active is
itself the completeness check.

**Commit plan:** single commit per branch (PR #1505 fix; PR #1504 red-fix on its own branch).
