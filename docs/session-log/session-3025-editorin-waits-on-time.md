# Session 3025 — Page mode's test fixture waits for the editor on time, not on a turn count

Set out to stop a vitest flake that failed shard 2 on two PRs in a row (#6163, #6164) and once more in local runs: `PageEditor.page-mode-source.test.tsx` › "opens on no block when the page is shown again, after another page".

**The cause:**
- `editorIn` (`src/editor/page-mode/__tests__/page-node-view-fixtures.tsx`) polled for page mode's editor over 50 `setTimeout(0)` turns, then threw `page mode editor not mounted`. Under CI load, the mount took more turns than that.
- The same test's last assertion, that no block holds focus, ran as soon as the editor existed. Page mode places its caret through TipTap's `focus`, which focuses a frame later, so a reopen that wrongly took focus could pass unseen.

**The fix:**
- `editorIn` waits with `waitFor`, on time, using the setup's `asyncUtilTimeout`.
- It then waits one animation frame, past the opening's caret placement.
- Every caller's focus assertion now sees the focus the opening took, or that it took none. No assertion changed.

**Reproduced first:**
- 60 extra turns before page mode marked itself open gave CI's exact message with the old fixture, and passed 20 of 20 runs with the new one.
- Making the reopen take focus fails the negative assertion with the new fixture.

**Suites:** every `editorIn` caller (the page-mode dirs, `PageEditor.footer-switch` and `PageEditor.page-mode-source`). That is 253 tests, run three times, plus the builder's 29-file run (831 tests). The flaky file alone passed 20 of 20.

**A second cause, found while repeating.** `PageEditor` offers `onEditModeChange` and `onEditSource` to the header only once `get_block` says the page is not a tag's page. The tests waited for the block tree, then called the optional callback, which does nothing before that answer. Page mode then never opened, and `editorIn` threw the same message. `PageEditor.footer-switch` showed the same race as `page-source-mode` never appearing. Both files now wait for the callback before calling it, at two sites and four sites. A 30 ms delay on the `get_block` answer reproduced six failures across the two files; with the waits, both pass 11 of 11 under that delay. A user cannot hit this: neither control renders before the answer.
