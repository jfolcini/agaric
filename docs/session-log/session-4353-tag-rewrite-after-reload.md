# Session 4353 — a #name made a tag after the page reopened shows as the tag (#6953)

Typing `#newtagname`, leaving the block and moving straight to another view and back left the row showing `#newtagname` as text, though the stored content held `#[ULID]`. The tag commit (`commitTypedTags`) saves the text, creates the tag, then rewrites the name to the ref with the page store's `edit`. Leaving the page unmounts that store and the reopen reads the page into a new one. When creating the tag outlasts that, the rewrite updates only the unmounted store, and nothing refreshes the new one. The real backend over the Playwright bridge exposed it; the mock answered in the same tick.

## What shipped

- `adoptLateWrite` (`src/stores/page-blocks.ts`) puts a saved text into the page's live store when that store still shows the text the write replaced; otherwise it leaves the store alone, so a newer edit is never clobbered. The tag step of `commitTyped` (`src/stores/unmount-flush.ts`) calls it once the rewrite is saved. In the store that made the write, the text already matches, so the call does nothing there. `withContent` is exported from the reducers for it.
- `e2e/hash-tag-typing.spec.ts` gains a test that delays only `create_block` (by wrapping `__TAURI_INTERNALS__.invoke` in the page), leaves the block, reopens the page at once and expects the tag chip. The wrap works on the bridge too.
- Page mode's tag commit (`page-tags.ts`) has its own path and was not changed.

## What ran

- The new test red with the `adoptLateWrite` call removed (no chip; the row shows the text), green with it. Falsified in one shell command with a trap restore.
- Mock-lane specs over tags, chips, inline properties and latency: 16 files, 145 tests. vitest over `src/stores`, `src/components/block-tree`, `useEditorBlur` and page mode. Typecheck, oxlint, oxfmt, store layering and the import-cycle check.
- Not run: the whole Playwright and WebdriverIO lanes, which `just e2e-related` selects for `unmount-flush.ts`; CI runs them.
