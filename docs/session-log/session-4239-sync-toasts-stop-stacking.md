# Session 4239 — sync toasts stop stacking (#6870)

#6870: editing on the Linux AppImage while the Android app synced filled the phone with toasts that covered the page until each was closed by hand. The video and the log zips were not readable from the session, so the cause comes from the code.

The sender starts a sync round about 2 s after the typing stops (`LOCAL_EDIT_DEBOUNCE`), and every round that changed blocks raised its own "Synced N changes from device" toast: the only sync toast without a sonner `id`. A `sync:local_text_kept` report raised one never-expiring toast per page title, which also fits "had to close them all".

The rule now stated in `notify.ts`: a toast the user did not just ask for passes a fixed `id` per source, so a burst updates one toast in place; a toast that answers the user's own action passes none. Applied to:

- `useSyncEvents`: `id: 'sync-changes'`, and the count adds up while the toast is on screen, reset by sonner's `onAutoClose` / `onDismiss`. A round that cannot count makes it "Synced changes from device" until the toast closes. sonner restarts a toast's lifetime when it is updated, so the toast closes about 4 s after the last round.
- `useSyncLocalTextKept`: one toast naming every kept page, and a later report adds its titles while the toast is up.
- `useMirrorIngestEvents`: one warning toast per file, so an autosaving external editor updates it.
- `useSyncTrigger`'s "Back online": a fixed `id`, so the code matches the rule.

sonner 2.0.8 (the latest) shows a new toast for an `id` whose previous toast closed (`wasDismissed` in `ToastState.create`), so a fixed id is safe to reuse.

Not changed: sonner pauses every timer while the stack is expanded, which it enters on `mouseenter`. A phone's tap leaves the hover where it landed, so touching a stack of toasts may freeze it. Headless Playwright could not show it: after a tap it moves its virtual mouse away and fires `mouseleave`. sonner collapses the stack at one toast, so with the stacking gone this should not matter; fix it only if it is still seen.

The bug reached a user, which normally means an `e2e-tauri/` spec. A two-device version can fail only if two real sync rounds land inside one 4 s toast lifetime, so on a slow runner it would pass with the fix reverted or fail with it in place. The end-to-end check went to `e2e/sync-events.spec.ts` instead, under a paused `page.clock`, so the toast's lifetime passes only when the spec advances the clock.

## What ran

- `npx vitest run` on the four hook test files: green. Shuffled with four seeds: green. Each new assertion shown red by a mutation of the code it covers (no `id`, no sum, no reset on auto-close, no reset on dismiss, no sticky unknown count, no title accumulation, no title reset, no mirror `id`, no back-online `id`), each restored by a `trap`.
- `e2e/sync-events.spec.ts`: the new spec red with the `id` removed (two toasts after the second round) and red with the auto-close reset removed ("Synced 6 changes" after the toast closed); green with the fix. `--repeat-each=30 --workers=8` with all four cores busy: 30/30.
- Every Playwright spec that fires `sync:complete` (`sync-refresh`, `reload-keeps-editor`, `page-mode`, `in-page-find`, `link-chip-lifecycle`, `pages-reopen`, `spaces-happy-paths`, `sync-last-synced`, `sync-happy-paths`, `sync-events`): 103 passed.
- `npm run typecheck`, `oxlint` and `oxfmt --check` on the changed files: clean.
