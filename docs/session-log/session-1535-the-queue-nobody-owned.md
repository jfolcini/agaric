# Session 1535 — The queue nobody owned

The picker-trailing-space test from #4721 reddened `validate / vitest` on unrelated PRs at roughly one run in ten (#4742). The issue narrowed it to "the plugin is open under the key the test holds, but the captured command is missing" and left two candidate mechanisms open: the mock did not apply, or the key identities diverged.

The first premise was off. `PluginKey.getState` is `state[this.key]`, a string lookup; passing it says nothing about object identity, so it could not separate the two. The instrumentation the issue asked for did: a counter on the mock's `Suggestion` wrapper, reported in the assertion message. 2 of 40 runs failed, both with `suggestionCalls: 0, size: 0` — the mock had not applied at all for that build, and the real plugin ran. One of the two hit the back-to-back tag test, so "always the create path" was a sampling artifact.

The mechanism is in vitest's mocker. `vi.doMock` and `vi.doUnmock` only push onto a static `pendingIds` queue; the queue is drained lazily by whichever module fetch next sees it non-empty, and every concurrent fetch that does so snapshots the groups and runs `unmock` then `mock` in turn. The test loaded its editor stack with a `Promise.all` of ten imports, so ten drains ran at once, and a sibling's `unmock` could land after this test's `mock`, emptying the registry for the instant `picker-plugin` fetched `@tiptap/suggestion`. The `unmock` came from `afterEach`, which is why the first test in a file never fails.

The fix is deletion: one hoisted `vi.mock` for the file, static imports, no `resetModules` or `doUnmock`, so the queue is never non-empty after the first fetch. Shown to fail with the wrapper's capture removed (7/7 red), restored, `cmp` clean. 40 runs of the rewritten file: 0 failures, against 2/40 before.

Shipped: fix for #4742.
