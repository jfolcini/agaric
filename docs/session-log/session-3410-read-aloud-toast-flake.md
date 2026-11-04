# Session 3410 — The Read aloud spec waits for the replaced toast to leave

`e2e/read-aloud.spec.ts` "a reading started during another one keeps its
toast and reads on" failed on #6307's `playwright (3)` shard. That PR touches
no speech code. The failure was a strict-mode violation: the *Reading aloud…*
locator resolved to 2 toasts.

Since #6294 each reading has its own toast id. Replacing a reading dismisses
the old toast, and sonner marks it removed on a `requestAnimationFrame`. The
new toast mounts on a `setTimeout(0)`, which can come first. For a moment
both toasts are in the DOM, and both are live. An in-page MutationObserver
saw two unremoved toasts at once in 1 of 5 runs. So filtering out
`data-removed="true"` toasts, the first idea, was not enough.

The spec now holds the first reading's toast element and waits for it to
leave the DOM before it counts toasts. That is deterministic: if the old
toast never left (dismissal dropped from `finish`), the wait fails at that
line. Under CDP 8× CPU throttling at `--repeat-each` with 4 workers, the old
spec failed 1 of 60 runs and the new one 0 of 40. Unthrottled load did not
reproduce it in 110 runs. The whole spec at `--repeat-each=5 --workers=4`:
35 passed.

The container had been replaced and lacked Playwright's
`chromium_headless_shell-1248`; `npx playwright install
chromium-headless-shell` restored it.
