# Session 4253 — embedded rows draw their checkbox and chips (#6747)

An embed rendered each row's text alone, so a page of tasks embedded elsewhere showed no state and could not be ticked. Now an embedded row draws the task checkbox, the list marker and `BlockMetadataRow` (priority, due, scheduled, repeat and property chips), all from the components the block's own row uses.

Decisions:

- The checkbox calls `useBlockProperties().handleToggleTodo`. `EmbeddedBlockTree` sits inside the source page's `PageBlockStoreProvider`, so the tick writes through the store of the page that owns the block, and `mirrorToSiblings` moves every other mounted view of that page. It needs no unlock: it changes no text and no structure.
- The chips are read-only through a `readOnly` prop on `BlockMetadataRow`, threaded to the priority badge, the date chips, the `+N` pill and `InlinePropertyChip` (whose `PropertyChip` already drew spans when given no handlers). A chip with nothing to do is no longer a button, so the row has one tab-reachable control, the checkbox.
- The host tree's `BatchPropertiesProvider` holds the host page's ids, not the embed's, so the embed mounts its own over its rows (at most `EMBED_MOUNT_LIMIT`), invalidated by `useScopedBlockPropertyEvents` scoped to those rows. One `get_batch_properties` per embed.
- Attachments stay out, as the issue scoped.
- `TaggedBlockChildren` (a tagged block's children on its tag's page, #5679) draws through `EmbeddedBlockTree` inside the owning page's provider, so its rows gain the same checkbox and chips. That is the twin path, kept on purpose.

The two existing embed vitest suites and `TaggedItemsSection.test.tsx` gained a `get_batch_properties` stub, since the embed now issues that read; no assertion changed there. One existing e2e assertion changed: `embed-render-states.spec.ts` *a page embed renders the page's top-level blocks* matched each row's whole text (`'Weekly standup notes'`); the seeded Meetings rows carry properties, which now draw as chips, so it matches the leading text (`/^Weekly standup notes/`).

## What ran

- `npx vitest run src/components/editor/__tests__/ src/components/properties`: red first on all six cases of `EmbedRowChrome.test.tsx`, then green; falsified by stubbing out the toggle (the tick case reddens) and by passing `readOnly={false}` (the read-only case reddens).
- `e2e/embed-task-tick.spec.ts`: green, and red with the toggle stubbed out.
- `bash scripts/test-related-ts.sh --range origin/main...HEAD`: green once `TaggedItemsSection.test.tsx` had its stub.
- The other embed e2e specs, `page-mode.spec.ts` and `typed-anchor-links-6033.spec.ts`: green.
- `npm run typecheck`, oxlint, oxfmt, `node --test scripts/e2e-related.test.mjs`.
