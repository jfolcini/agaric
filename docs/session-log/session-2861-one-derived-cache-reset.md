# Session 2861 — one reset for every derived cache (#6049, frontend half)

Sync and MCP (`reloadChangedPageStores`), import (`useImportRunner`) and undo/redo (`refreshAfterUndoRedo`) each reset their own hand-kept subset of the caches derived from block data. `src/stores/AGENTS.md` forbids exactly that. Before this change:
- import skipped the block-property counter, the name caches and the Pages list;
- undo skipped the link graph, the Pages list and the journal's day map;
- none of the three reset the attachment lists.

**Change.** A new `invalidateDerivedCaches()` (`src/hooks/derived-caches.ts`) drops all seven caches, attachments included, and the three callers use it. It sits in the hooks tier because `invalidatePageBrowserData` lives there. Each caller still does its own page-store reload, resolve preload and space refresh.

**The issue's user-facing claim did not reproduce.** The claim was that a synced attachment stays missing on the open page.
- **Real backend:** an attachment change marks its block as changed (`collect_block_id_keys`, `BLOCK_ATTACHMENTS_ROOT` arm), and `resolve_changed_page_ids` maps it to its page.
- **Block mode:** the page store's `load()` sets `loading`. `BlockTree` then renders its skeleton, which unmounts `BatchAttachmentsProvider`, so it remounts and refetches.
- **Page mode:** `PageModeEditor` re-reads the page.

So the two attachment end-to-end tests written for it stayed green with the fix reverted, and they were deleted. Only a sync that names a different page leaves an attachment list stale, and now that is reset too.

Not done here: MCP `create_tag` emits no `blocks:changed` (`mcp/tools_rw.rs`, `handle_create_tag`), so a tag an agent creates is still missing from the `#` picker until the next sync event. That is the issue's Rust half.

**Shown red:**
- the attachment reset removed from `invalidateDerivedCaches`;
- each of the three callers' calls made a no-op. The no-op runs also reddened the existing name-cache and rename tests.

**Suites run:**
- vitest over `src/hooks`, `src/stores`, `src/__tests__` and `useImportRunner`: 3434 passed;
- Playwright over `sync-refresh`, `sync-events`, `import-export` and `undo-redo-blocks`: 34 passed;
- typecheck, lint and `typecheck:e2e-tauri`;
- the import-cycle and layering checks.
