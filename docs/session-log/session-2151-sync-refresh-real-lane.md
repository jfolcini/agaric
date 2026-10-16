# Session 2151 — the sync-refresh regressions on the real backend

#5365's last sync item that is not blocked. `e2e/sync-refresh.spec.ts` pins four regressions where a peer's write did not refresh an open view (#5256, #5258, #5242, #5255). In that spec the "peer" is a mock invoke plus an emitted `sync:complete`. Testing invariant 4 puts a bug that reached a user in `e2e-tauri/` too, so `e2e-tauri/sync-refresh.e2e.ts` replays them through a real pull from the headless peer.

**Cases.** Each one leaves a view open, has the peer write once, and waits in that view:
- **#5256:** the peer marks a TODO due today DONE, and the open journal's Done panel lists it while the Due panel does not. The same holds for an overdue TODO and Unfinished tasks. The Done half proves the pull reached the view, so the "gone" half cannot pass on a stale screen.
- **#5258:** with Pages open, the peer creates one page and renames another. The list shows both new titles and not the old one. In the week view, the peer writes an empty day's page, and that day stops offering "No blocks for".
- **#5242:** the app opens the peer's page in two tabs. After the peer renames it, the header and the tab bar show the new title only.
- **#5255:** `tag:#marigold` settles on "No results". The peer creates the tag and applies it, and the result appears without a new search.

**Triggering the pull.** The app pulls when the sidebar's Sync button is pressed, not through "Sync now" in Settings. Leaving the view would remount it and hide the very refresh under test.
- Each wait presses Sync again between reads, because a sync already in flight can answer `wait_pulled` before it carries the write.
- A pull never remounts the view, and once the write has landed further pulls change nothing, so the repeats cannot fake a pass.

**Peer commands**, each with a parse test, all through the app's own command functions:
- `create_in_space`: `create_block_inner_with_space`, for pages and tags in the Personal space;
- `set_todo_state`;
- `set_due_date`;
- `add_tag`.

`openSyncSettings`, `openPairing` and `peerRow` moved from `sync-two-device.e2e.ts` into `sync-peer.ts`, with a new `setPeerAddress`, so both specs share them.

Not run here: the real lane needs tauri-driver, so the PR's real-backend job is this spec's first run. For each case, the product change it should catch is reverting that regression's refresh call in `useSyncEvents.ts`, `UnfinishedTasks.tsx` or `useTagResolution.ts`.

Ran:
- `cargo nextest run -p agaric-diagnostics` (43 tests);
- clippy;
- `cargo fmt --check`;
- `npm run typecheck` and `npm run typecheck:e2e-tauri`;
- `npx vitest run e2e-tauri` (42 tests);
- `oxlint`;
- `oxfmt`.

Renaming each new command's field turns its parse test red.
