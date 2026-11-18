# Session 4239 — background sync stops raising toasts (#6870)

#6870: editing on the Linux AppImage while the Android app synced filled the phone with toasts that covered the page until each was closed by hand. The video and the log zips were not readable from the session, so the cause comes from the code: the sender starts a sync round about 2 s after the typing stops (`LOCAL_EDIT_DEBOUNCE`), and every round that changed blocks raised its own "Synced N changes from device" toast, the one sync toast without a sonner `id`. A `sync:local_text_kept` report raised one never-expiring toast per page title.

A first pass deduped the toast and summed its count. On review with the maintainer the rule became: a toast answers what the user just did, or says what they must know now; ongoing state is the status indicators'. Stated in `notify.ts`.

- **Background sync is silent.** `sync:complete` reloads and moves "last synced", and raises no toast or announcement. "Back online" is gone. A failure is toasted only for a sync the user pressed: `useSyncTrigger` holds the peer in `pressedSyncPeers` (exported by `useSyncEvents`, which the trigger already imports) for the length of its pressed session, and `useSyncEvents` toasts a `sync:error` only for a held peer. The trigger's own failure toasts (a session that ends without a report, a timeout, `listPeerRefs` failing) need `userInitiated` too, which retired the #4305 once-per-streak memory: a press is always answered, a tick never. Settings' *Sync now* and *Sync all* answer in the device list, as before.
- **The failure toast names the device** (`peerDisplayName`), not the first 12 characters of its id.
- **Sync state stays on the Sync button**, which already had the green, amber and red dot. A red dot on a phone's menu button, for the Sync button inside the closed drawer, was built and then dropped at the maintainer's call: the Sync button is the one place sync state lives, so a phone shows a background failure once the drawer is open.
- **Kept-in-Trash**: one lasting toast that names a single page (cut to 40 characters with the new `clampText`) or counts several, and *Open Trash* (the Trash lists newest first). A report that lands while it is up adds to the count.
- **Mirror warnings**: one toast for the type, naming a file and its first warning (both cut) or counting files.
- **Rename notice**: *Open History*.

sonner's action button closes a toast without calling `onDismiss` or `onAutoClose`, so the kept-in-Trash action resets its count itself.

The e2e flake hunt, on the since-dropped phone spec, found one in a shared helper: on a phone, `openSettingsTab` picks the section from a Radix Select, which scrolls the open list to align the selected item, and under load the option tap lands before it settles (2 of 32 at the iPhone 13's 3× ratio under full CPU load; the list was left open on General). The helper fix goes in the next PR.

The bug reached a user, which normally means an `e2e-tauri/` spec. A two-device version would have to make a real session fail on command; the mock lane drives the same frontend paths with the press held open and the clock paused, so every toast assertion is deterministic.

## What ran

- `npx vitest related --run` over the changed source: 1129 files green after the plural-form fix the catalog guard asked for.
- Each new or changed assertion shown red by a mutation of the code it covers, restored by a `trap` (19 unit mutations: the pressed gate, the changes toast back, scheduled failures toasting, pressed add and delete, the run-level gate, "Back online" back, the id for the name, the Trash action's reset and navigation, title, path and count handling in both reworked toasts, and the History action).
- Playwright `sync-events`, `sync-happy-paths`, `sync-refresh`: green. Shown red with the pressed gate removed (three specs, toast count 1) and with the changes toast restored. 20 repeats of the changed specs on 8 workers under full CPU load: green, apart from the dropped phone spec's `openSettingsTab` flake above.
- `npm run typecheck`, `npm run typecheck:e2e`, `oxlint` and `oxfmt --check` on the changed files: clean.
