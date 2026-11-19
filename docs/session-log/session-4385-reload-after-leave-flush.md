# Session 4385 — a page reopened while its leave was still writing reads again

`e2e/block-line-break.spec.ts:286` ("a task line, a #name and a key:: value line split off with Enter commit on one leave") failed now and then on the bridge: the split-off row had no tag chip after the page was reopened. Its error context showed the row as `call the plumber #splitcall status:: done`, the text from before the leave committed anything.

**Cause, in the product:** leaving a block commits its task marker, `key:: value` lines and typed tags, and those writes land only after their IPCs answer (`commitTyped`, `src/stores/unmount-flush.ts`). Leaving the page and coming back mounts a new store whose load can read before they land. #6958 patched one case: once the tag rewrite was saved, the live store took it if it still showed the text the rewrite replaced (`adoptLateWrite`). A load that read before the property strip, or before the typed text itself, showed an older text, so nothing matched and the row kept the stale snapshot until something reloaded the page. A first attempt here that also reloaded a store still loading closed one more window and left this one; :286 still failed 2 of 60.

**Fix:** each such leave registers its outcome by page (`trackPageFlush`, `src/stores/page-blocks.ts`). A load whose snapshot may predate one (a flush pending when it started, or one started while it read) reads again once they have all settled. It does not wait for them before reading: a flush may itself load. `adoptLateWrite` is gone.

**Shown red:**
- `e2e/hash-tag-typing.spec.ts`, a new test: every `edit_block` waits until the reopened page has read its blocks, so that read predates the typed text and the rewrite. Red on the bridge against main (2 of 2, at the chip). The mock passes it either way, so the file joins `REAL_BACKEND_SPECS`; its other tests pass there unchanged.
- `src/stores/__tests__/page-blocks.page-flush.test.tsx`: removing the re-read reddens the flush-pending and flush-during-read tests; dropping the started-during-read check reddens the second alone. Its pair, a flush landed before the load began, reads once; a mutant that always re-reads loops until the worker runs out of memory.

**Ran:** :286 ninety times on the bridge; `block-line-break` and `hash-tag-typing` three times each on the bridge, and on the mock; vitest over `src/components`, `src/hooks`, `src/stores`, `src/editor` and `src/lib` (`EditableBlock.test.tsx`'s `page-blocks` mock gains `trackPageFlush`); `npm run typecheck`, oxlint and oxfmt on the touched files.
