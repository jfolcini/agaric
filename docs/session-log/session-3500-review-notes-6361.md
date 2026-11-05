# Session 3500 — review notes from #6361

#6361 fixed #6347 at its cause: `MenuSheet` keeps the rows it showed while open until it has left, so the closing page menu no longer moves "Open outline" under the next tap. It also made `openSourceMode` in `e2e/page-source-edit.spec.ts` wait for the "Page actions" menu to be gone before returning. That wait had no red of its own, and with the sheet fixed it guards nothing the fix does not already prevent, so the reviewer's note was to drop it and this PR does.

Ran: the 390 px phone describe ×3 without the wait, green.
