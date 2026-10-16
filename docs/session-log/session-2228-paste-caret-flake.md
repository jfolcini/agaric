# Session 2228 — The task-paste spec places its caret without arrow keys

`e2e/paste-task-over-content-1514.spec.ts`'s mid-text case failed its first
attempt in about 70 CI Playwright jobs between 2026-10-07 and 10-16, and both
attempts once on main. The retry hid it. The pasted task landed a few
characters off (`hello w- [x] doneorld`).

**Cause.** A test race, the one `e66126293` fixed in the sibling
`paste-spliced-5160` spec. The test moved the caret with `ArrowLeft` presses
and pasted straight after. The browser moves that caret natively, and
ProseMirror reads it only on the next `selectionchange`, which fires a moment
later. Its paste handler inserts at the selection it last read. A person
cannot paste that fast, so the app is not at fault.

**Fix.** The caret is placed with `selectEditorRange`, which dispatches the
`selectionchange` itself, and the typed-text check is an exact `toHaveText`.

**Runs** (`--repeat-each=30 --retries=0`):
- before, 2 workers: 4 of 90 failed, all in that case;
- after, 2 workers: 90 passed;
- after, 4 workers under load: 90 passed.

The other paste specs reach their caret with `Enter`, which ProseMirror
handles itself, and the remaining editor `ArrowLeft` uses already wait for
the caret before acting.
