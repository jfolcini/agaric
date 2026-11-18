# Session 4352 — Escape during a paste no longer deletes the paste's anchor (#6952)

Pasting `- a\n- b` into an empty block and pressing Escape before `paste_blocks` answered lost `a`. Escape's empty-block cleanup (`deleteBlockIfLeakedEmpty`) saw the anchor still blank and deleted it; the paste's first item was going to land in that block. The real backend over the Playwright bridge exposed it; the mock answered in the same tick.

## What shipped

- `pasteIntoBlock` registers the whole paste, from its first line, as a pending save of the anchor block (`trackPendingSave`, now exported from `src/stores/unmount-flush.ts`). The cleanup already awaits `settlePendingSaves` before deciding, and after the paste the anchor carries the first item, so it is kept. Registration happens synchronously at the paste, before the first `await`, as `src/editor/AGENTS.md` asks.
- `e2e/block-paste-outline.spec.ts` gains a test that delays only `paste_blocks` (by wrapping `__TAURI_INTERNALS__.invoke` in the page), presses Escape right after the paste, and reads both items back after a reopen. A uniform `__setMockLatency` does not show the race: the cleanup's metadata probe then answers no sooner than the paste. The wrap works on the bridge too, so the test is not `@mock-only`.

## What ran

- The new test red with the registration removed (the paste fails on the soft-deleted anchor, no "Pasted 2 blocks" toast), green with it; falsified in one shell command with a trap restore.
- The paste, empty-block and latency specs (17 files, 69 tests) on the mock lane; vitest over `src/stores` cleanup and flush tests and `src/components/block-tree`; typecheck, oxlint, oxfmt.
- Not run: the whole Playwright and WebdriverIO lanes, which `just e2e-related` selects for `unmount-flush.ts`; CI runs them.
