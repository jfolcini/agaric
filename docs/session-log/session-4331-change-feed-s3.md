# Session 4331 — change feed, slice S3: the property event is sent once

Slice S3, the last, of #6545, after S1 (#6897), S2a (#6919) and S2b (#6932). `block:properties-changed` no longer goes out a second time with `after_rebuild` once `settle_background()` has run. The change feed's `properties` event follows every property write after the same settle and bumps the same global counter. Maintainer decision 5 on #6545 asked for this.

## What shipped

- **`emit_property_changed_events`** (`commands/properties.rs`) sends each event once, with no spawned settle, and no longer takes the materializer.
- **The conformance IPC harness** records every property event again.
- **`property-change-dispatch.ts`** drops the `after_rebuild` field and `readsRebuiltViews`. The global counter in `block-property-events.ts` was the only target that heard the repeat, and the feed's `properties` arm calls the same `recordBlockPropertyChange`.
- **`useBatchCounts`** keeps its second read, on the property counter. A date write with no edit carries only `properties`, and that counter is the only thing that refetches the counts after one.
- **#6932's two non-blocking notes:**
  - the prefetch-expiry comment copied to five restore sites is gone, because `graph-structure-events.ts` and `notifyUndoNewAction` keep the reason;
  - the `useUndoShortcuts` docblock is shorter.

## Decisions and traps

- **The design note said `agenda-count-after-write.e2e.ts` reddens when the feed's `properties` arm is dropped. It does not.** The spec's `/due` write lands in the same burst as the block's edit, so the event also carries `structure`, whose graph counter refetches `useBatchCounts` too.
  - Dropping both arms reddens it at its own assertion, which shows the feed alone now carries the agenda refresh.
  - The property-only chain is pinned link by link in unit tests:
    - `set_due_date` sends one `properties` event after the rebuild (S1's `change_feed.rs`);
    - `domains_for_op` maps it to `properties`;
    - `derived-caches.test.ts` maps `properties` to the counter;
    - `useBatchCounts` refetches on that counter.
  - No e2e-tauri spec makes a date write with no edit.
- **Deleted tests:** `property_events_go_out_again_once_the_caches_are_rebuilt_6567` and "hears the after-rebuild repeat on the global counter only". Both pinned only the repeat. The immediate send stays pinned by the conformance fixtures, and "the agenda row is there when the event arrives" by S1's feed test.

## What ran

- nextest `properties | conformance | read_after_write | change_feed | agenda`: 398 passed.
- clippy with `-D warnings`: clean.
- `SQLX_OFFLINE=true cargo check --workspace --all-targets`: clean.
- vitest `src/lib src/hooks`: 9937 passed.
- `npm run typecheck`: clean.
- e2e-tauri on the real backend, built locally:
  - `agenda-count-after-write` green with the repeat removed; red only with both the `properties` and `structure` arms dropped.
  - `due-date-agenda`, `agenda-projected-repeat`, `page-mode-priority-dates`, `page-mode-properties`, `page-mode-tasks` and `reminder-due-task` green.
