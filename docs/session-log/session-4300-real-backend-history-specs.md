# Session 4300 — five history spec files join the real-backend project

Stage 2 of #6529, the history area, which held four of the six failures from the 14 Nov bridge run that had not been looked into. Six files were tried on a locally built `bridge`. Five join `REAL_BACKEND_SPECS`: `block-history-sheet`, `history-keyboard-controls`, `history-keyboard`, `history-page-scope` and `history-revert`. None of the failures was a backend bug. Each came from one of two things: the real backend writes the seed through its own commands, so its op log holds the seed's creates and property writes, with no backdated rows; or the real backend's diff is word-level.

- **`block-history-sheet`** expected 2 rows and got 3: the third was the seed block's own `create_block`. Now it counts the Edit rows, still exactly two, and still asserts that the other block's edit is absent.
- **`history-page-scope`** expected 3 rows and got 11: the page's seed history. Now it counts A's two edits, and still asserts that B's edit is absent and that the restore reverts exactly one op.
- **`history-keyboard`** required the whole log to fit on one page. The seed's ops overflow it, so End goes to the last loaded row, which is what End does.
- **`history-revert`** used `getByText(/selected/)`. While the confirm dialog was still open it matched three elements, and the strict-mode error fired at once instead of waiting. It now targets the `N selected` badge.
- **`history-advanced`** › diff toggle: the real diff splits a change into several `<ins>` / `<del>` runs, while the mock emits one. Now it compares the runs' characters without whitespace. The fix is in, but the file **stays off the list**: its compaction test needs ops older than 90 days. Only the mock's seed has backdated op-log rows, and a command always stamps "now". That is not the mock's injector, so it was not tagged `@mock-only`; whether such a test may be tagged is a question for the maintainer.

Ran: the five joining files on the bridge twice (18 passed each run) and on the mock; `history-advanced` on both (on the bridge only its compaction test fails).
