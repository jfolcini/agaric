# Session 4493 — review notes from the PRs merged on 2026-11-25 and 2026-11-26

**Ask.** Read every PR merged in the 24 hours to 08:30 on 2026-11-26 (#7046 to #7116, 64 PRs), and find the reviewer's non-blocking notes that no later PR addressed.

**Already handled.**
- Through #7077: session 4444 (#7079), and #7054 for #7051's notes.
- #7078, #7080, #7083, #7091, #7092, #7097, #7099 and #7107: session 4487 (#7113).
- #7075's `cap.fallback` note: declined on the PR, with a trace through loro's import path.
- Fixed before their PRs merged:
  - #7084: `dueDateColor`'s docstring is within 100 columns.
  - #7085: a typed `Ctrl` draws as `Control` on macOS, not as ⌘.
  - #7090: the `#2639` comments left in TrashView, HistoryView and `usePageBrowserData` are about `staleTime` and the error card, which still exist; none is about the removed toast.

**Fixed here.**
- **#7101:** MeetingDialog destructures `useDialogOrSheet('dialog')` directly, as PageSourceConflictDialog does.
- **#7103:** DateChip's `children` doc now says the text form, with no `onClick`, drops the other props, `aria-label` included. Spreading them onto the span would not help: ARIA does not name a plain span by its `aria-label`. Every caller that passes `children` also passes `onClick`.

**Checked and left.**
- **#7085, delete `shortcutHint` and call `getShortcutKeys` directly:**
  - Tried first, and CI's vitest went red in `keyboard-config-rebindable-drift.test.ts`: "`deleteBlock` is marked rebindable: false but IS consumed through the config".
  - That scan counts a literal `getShortcutKeys('id')` as the binding being consumed. The context menu's `deleteBlock` hint only shows the binding, and the wrapper keeps that read out of the scan.
  - The wrapper stays, and its doc comment now says why.
- **#7116, inline `stamped_tombstone`:** `replay_accepted_slots_individually` has about 65 code lines in its body. The query and the decode would take it past `clippy::too_many_lines`' threshold of 70, so the helper stays.
- **#7081, `space-y-2` on the desktop `ViewHeaderOutletSlot`:** a no-op while one view portals one root. The reviewer accepted keeping it to say that each child is ruled separately, and #7117, still open, is editing `App.tsx`.
- **#7090, LinkedReferences with no toast when collapsed:**
  - The panel opens expanded on every page, so a failed first load shows its inline error.
  - Only a refetch that fails while the user has collapsed the panel waits until they expand it again.
- **#7100, the removed `--no-warnings`:** Node 24.22.3 loads `node:sqlite` with no ExperimentalWarning.
- **#7054, the pre-push `npm-audit` hook waiting through its retries:**
  - Session 4428 called this moot, because the backoff went back to 20 s. #7098 has since widened it to 5, 15, 60 and 120 s.
  - So a push that changes `package.json` or the lockfile, and fails the audit for a real advisory, now waits about 3½ minutes before it fails.
  - Left as it is: the same wait is what clears the registry's bad answer, on a laptop as in CI, and only that kind of push pays it.

**Ran.**
- `npx vitest run` over the drift test and the tests of the changed and restored components: 263 passed.
- `npm run typecheck`, and oxlint and oxfmt on the changed files.
- There is no new test, because nothing changes behaviour.
