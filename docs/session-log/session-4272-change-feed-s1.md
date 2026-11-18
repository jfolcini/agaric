# Session 4272 — change feed, slice S1: the backend emits one event per burst of local commits

Slice S1 of #6545, built to the design note on the issue and the maintainer's decisions (approach C, the Mutex pending set, five coarse domains).

## What shipped

- **`ChangeFeed`** (`agaric-engine/src/materializer/change_feed.rs`) holds a pending set of domains and block ids, a write counter and a `Notify`. `Materializer::dispatch_commit` records every commit's ops into it after enqueueing their tasks. This is the one path every local commit takes: commands, MCP, the mirror, post-sync repairs, and boot replay. Inbound sync apply never calls it.
- **`domains_for_op`** sits next to `invalidations_for_op` and is exhaustive on `OpType`. A property write on `space` or `template` also names `structure` and `names`, because a space move or a template toggle changes the Pages list, the pickers and the graph.
- **`change_feed::run`** (app crate) is spawned in `spawn_background_tasks`. It waits for a commit, settles the background queue, then takes the pending set. It resolves the pages with `resolve_changed_page_ids` and emits `blocks:changed` with `domains` and `local_command: true`.
  - A commit recorded during the settle forces one more settle before the take (`take_if_quiet`), so no event goes out ahead of its own rebuilds.
  - While the #2935 lifecycle debounce is armed, the feed does not settle. A settle would fire the debounce at once, which means one full cache rebuild per delete commit in a burst instead of one per burst. The debounce loop wakes the feed after it fires.
- **`BlocksChangedEvent`** gains the serde-default `domains` and `local_command`. The existing producers send `null` and `false`. Bindings are regenerated.
- **The frontend listener** returns early on `local_command`, so behaviour is unchanged until S2a maps domains to invalidations.

## Decisions and traps

- The builder first hooked `dispatch_background` too, as the design note named it. It has no production caller, so the hook and its test were deleted.
- The review found the debounce interaction above. Without the fix, S1 would have paid that cost in production with no consumer.
- The headless app (the Playwright bridge) does not run the feed. The conformance harness listens only to `block:properties-changed`. S2a decides whether `HeadlessApp` should run it.
- Post-sync placement and repairs get a feed event on top of the `blocks:changed` that `SpacePlacementSink` already sends. Harmless while the listener ignores it.

## What ran

- Red first: the integration tests in `tests/command_integration/change_feed.rs`.
  - The event comes after the rebuild: red when the settle is removed.
  - Three commits make one event: red when the pending set stops accumulating, and when it emits per page.
  - A delete waits out its debounce: red when the armed check is removed, and when the debounce's wake is removed.
  - The `domains_for_op` rows were red per changed arm.
- Each falsification ran as one restore-on-exit shell command.
- The `useSyncEvents` early return was falsified in vitest.
- Targeted nextest over change_feed, dispatch, debounce, lifecycle, view_notify, conformance, read_after_write, specta, commit_fan_out, command_tx, placement and tools_rw: 514 passed.
- The change_feed integration tests ran 10 times in a row with no retries, all green.
- `cargo clippy --workspace --all-targets -- -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `npm run typecheck`, and `npx vitest run src/hooks/__tests__/useSyncEvents.test.ts`.
- The full workspace suite was not run here; CI's is the check.
