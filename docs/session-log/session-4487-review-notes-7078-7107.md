# Session 4487 — review notes from the PRs merged on 2026-11-25 and overnight

One follow-up for the non-blocking notes left on #7078, #7080, #7083, #7091, #7092, #7097, #7099 and #7107. Each note was checked against the code first. Two were dropped.

**Applied.**
- **#7091:** the sync scheduler holds a forked peer inside `record_failure_and_take_report`, which takes the failure's code. `SyncScheduler::hold()` is gone. The hold is now set under the lock that books the failure, so a rebind can no longer land between the two and drop it. The flag still clears only with the entry.
- **#7107:**
  - `break_durability_barrier` builds its trigger from `DURABLE_BARRIERS_KEY`.
  - `the_barrier_connection_syncs_its_commits_and_the_pool_does_not` now also pins that the barrier commits through its own FULL connection. A trigger refuses the barrier row under any lower `synchronous`. Before, a barrier that committed through the pool left all three durability tests green.
- **#7097:**
  - `TagExpr` drops the serde and specta derives and `#[serde(tag, content)]`. Nothing serializes it, and `bindings.ts` never named it.
  - The queries doc and the mock's `TagExprNode` comment no longer claim a shared wire shape.
  - The mock tags handler's header no longer names the removed tag-expr query.
- **#7092:** the colour picker commits no move that ends on the current colour, as its text field already did. The reviewer's example, a click without a drag, commits nothing in react-colorful. A drag back to the start did commit.
- **#7091 docs:** TROUBLESHOOTING and the import/export page carry the "can overwrite the other device's copy" clause that `sync.md` and the feature map got. In `sync.md`, "Do that, on the restored device" follows the messages it refers to.
- **#7083:**
  - The `e2e-tauri-apt-cache` job stays, since the specs job restores what it warms. Its comment gives the reason that still holds: a PR's run cannot save the cache, and the key moves with the runner image.
  - The liveness script drops its "~17 min" figure.
  - `consumer.rs` names the bridge's seam.
- **#7078:** `mirror-outbound.e2e.ts` reads the mirror status through its `status()` helper everywhere.
- **#7080:** `page-mode-reveal.e2e.ts`'s `caretIntoBold` was `caretInto('bold', 2)`.
- **#7099:** `require-npm.sh`'s examples use the placeholder `npm@X.Y.Z`.

**Dropped.**
- One `useTagResolution` call over the included and excluded tag names (#7097). The hook merges ids across names, so the caller would have to split them again by name. That means more code and test churn to save one parallel IPC.
- The mock `evalTagQuery`'s "unused" `cmd` parameter (#7097). It is used in the error message.

**Recorded, no change.** #7060's review said jiff 0.2 costs compile time. That premise was wrong: jiff is an optional lock-only entry and is never built.

**Ran.**
- The hold fold went red four ways:
  - with the hold removed, 4 tests failed on their predicted assertions;
  - with the `PeerHistoryFork` arm dropped, its no-retry assertion failed;
  - with a hold on any code, the "dialled again" assertion failed.
- The durability pin went red with the barrier on the pool's settings.
- The colour-picker test went red before its fix.
- Full suites:
  - `agaric-store`: 1599 passed;
  - `agaric-sync`: 1082 passed;
  - the tauri mock's vitest suite and the picker, TagList and useTagColors tests: 1633 passed.
- `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check` and `npm run typecheck`.
- `prek run` on every changed file.
- The two edited e2e-tauri specs need the real binary. CI's `e2e-tauri-gate` runs them.
