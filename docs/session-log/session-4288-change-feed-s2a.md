# Session 4288 — change feed, slice S2a: the frontend refetches by domain, and `watchLocalWrites` goes

Slice S2a of #6545, built on S1 (#6897, merged). It also folds in S1's two non-blocking review notes.

## What shipped

- **Domain map.** `src/hooks/derived-caches.ts` maps each `ChangeDomain` to the helpers it covers, and `invalidateDerivedCaches()` is the all-domains case.
  - The Pages list is in every domain, not only `structure` and `names` as the design note had it. Its rows show the page's task state, dates, property flags and last-modified time.
- **Listener.** The `blocks:changed` listener in `useSyncEvents` drops a `local_command` event's domains and reloads no page store. Every other producer (MCP, the mirror, post-sync) takes the path it took before.
- **Deleted:** `watchLocalWrites` and `local-write-watch.ts`.
  - `isReadOnlyCommand` is still needed. It moved to `src/lib/tauri-mock/change-feed.ts`, where the mock uses it to decide which commands emit and where `conformance-coverage.test.ts` imports it.
  - Its Rust-signature check (#3332) stays.
- **Mock.** After a successful command that can write notes, the mock emits the feed's event with every domain, on the next task. Commands answered in the same task share one event. It emits from `answer()`, so the TS conformance harness, which calls `dispatch()`, never sees it.
- **`HeadlessApp::boot`** (the Playwright bridge) runs the feed and aborts it on drop. The conformance transport (`HeadlessApp::new`) does not run it.
- **Settings › Rebuild** now resets the derived caches. It rewrites `pages_cache` without appending an op, so the feed sends nothing. `watchLocalWrites` used to cover it.
- **Bookmarks.** A bookmark write re-reads the list once it commits. A `names` event read before the write committed would otherwise put back the old list. The write's own event carries only `properties`, which never re-reads bookmarks. S2a made this reachable from purely local use, because a local `names` event now arrives after the settle.
- **S1 notes:** the comment on the debounce's feed wake now says both debounce instances wake it.

## Decisions and traps

- **Mock specs.** The mock cannot tell a spec's raw `__TAURI_INTERNALS__.invoke` "peer" write from a local command, so it sends the feed's event for it. `e2e/sync-refresh.spec.ts` and `pages-reopen.spec.ts` now say so. The `sync:complete` path alone is pinned by `useSyncEvents.test.ts` and `e2e-tauri/sync-refresh.e2e.ts`.
- **Cost per typing commit.** Reads in the 1.5 s after one `edit_block`, measured on the mock:

  | | Page editor | Journal |
  |---|---|---|
  | Before | 4 | 2 |
  | Mock sending `[structure]`, as the real backend does for a content edit | 4 | 3 (adds the journal's day-to-page map) |
  | Mock sending every domain | 12 | 11 (mock lane only) |

  The issue's baseline was 3 and 1. Not measured on the real backend.
- **Two flakes.** `e2e/property-types-happy-paths.spec.ts` "sorts the References panel numerically" and `e2e/slash-commands-coverage.spec.ts` "Slash structural inserts" fail under load on `origin/main` at the same rate as on this branch.

## What ran

- **vitest red first:** `derived-caches.test.ts`, `useSyncEvents.test.ts`, `event-bus.test.ts`, `IntegrityCheckSection.test.tsx`, and the new bookmark test in `useStarredPages.test.tsx`.
- **Falsified, one restore-on-exit command each:** every domain arm, the listener's call and its return, the mock's emit, refusal, read and coalescing paths, the Rebuild reset, and the bookmark re-read.
- **Rust:** `headless_bridge::a_local_write_pushes_the_change_feeds_event`, red without the spawn. nextest `change_feed | headless | conformance` and clippy are clean.
- **Mock lane:** the Pages, bookmark, perf, IPC-recording, sync, journal, page and property specs.
- **`e2e-tauri/pages-list-local-write.e2e.ts`** (in `SPECS_WITH_A_SLOW_MATERIALIZER`) passes locally with `just e2e-real`, against an app prebuilt with `npm run tauri -- build --debug --no-bundle` and run under `WDIO_SKIP_TAURI_BUILD=1`, because wdio's in-process build fails in this container. It goes red at its own assertion when the feed's emit is suppressed.
- **CI's first run failed `e2e/toolbar-controls.spec.ts` "a width preset marks itself pressed".** The mock's all-domain event after the `image_width` write refetched the attachment batch, and `StaticBlock` unmounted every block's attachments while it loaded. The image remounted and its hover toolbar went with it. The real backend has the same flaw for any `attachments` event, and the feed now sends that domain for every delete, restore and attachment op. `StaticBlock` now keeps the rows it holds during a refetch. A new vitest goes red without the fix.
