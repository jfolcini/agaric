# Session 4399 — five WDIO specs run on the bridge, and two spec bugs the mock hid

#6926 slice W1.

**Ported, then deleted from `e2e-tauri/`.** Each is now a Playwright test on `REAL_BACKEND_SPECS`, shown red on the bridge by breaking the code it covers, and passing 10 repeats or more.
- **`attachment-paste-feed`** → `attachment-paste-roundtrip.spec.ts`. A pasted PDF shows in its block's attachment row without navigation. It goes red without `recordAttachmentInvalidation` in `DOMAIN_INVALIDATIONS` (`src/hooks/derived-caches.ts`).
- **`link-it-linked-refs`** → a new `link-it-linked-refs.spec.ts`, with `slowMaterializerMs`, which is a worker option, so it can't share a file. After "Link it", the note shows in Linked References. It goes red without `recordGraphStructureChange`.
- **`property-options-feed`** → `property-unfit-marks.spec.ts`.
  - The scenario: adding an option back clears a block's doesn't-fit mark.
  - The WDIO header named the change feed alone, but the page header also writes the saved definitions into the shared query (#6946). Either path alone keeps the test green, and breaking both reddens it. The test's comment says so.
- **`restore-bookmark-feed`** → `trash-page-cascade.spec.ts`. A bookmarked page restored from Trash is back in Bookmarks. It goes red without `invalidateNameCaches`.
- **`ref-property-title-follows-rename`** → `rename-invalidation.spec.ts`.
  - MCP doesn't run on the bridge, so the agent's write is an `edit_block` followed by the `blocks:changed` payload that an MCP write sends (`mcp/view_notify.rs`).
  - It goes red with `useRefTitle` reading the resolve store once instead of subscribing.

**Kept: `trash-bulk-noncanonical-ids`.** It needs a lowercase block id in the vault's `notes.db`.
- No command stores one.
- The bridge protocol has no raw-SQL operation, and a spec can't learn the open vault's path.
- Porting it would need new bridge infrastructure.

**Spec bugs that the mock's loose commands hid:**
- **`page-name-lowest-id-6278`:** its `import_markdown` call gains the required `dialect`. On the bridge it still fails, because the real import merges a second "Foo" into the existing page (#6277). Two pages with one name can't be made through the real commands, so the file stays unlisted.
- **`typing-popups-stay-still`:** the real `create_property_def` refuses to declare `owner` a `ref` while a text value is stored under it. The ref picker's test sets up exactly that, so that one test is `@mock-only` and the file is listed. The mock accepting that declaration is the divergence.

**Also:**
- `wdio.conf.ts`'s `SPECS_WITH_A_SLOW_MATERIALIZER` is now empty. The mechanism stays while `e2e-tauri/AGENTS.md` describes it.
- `unlinked-references.spec.ts`'s header no longer says Linked References can't refresh after "Link it".

**Ran:**
- The ported specs on the bridge: whole files, with the 4 change-feed tests 40/40 and the ref-title test 10/10.
- `typing-popups` 2/2 on the bridge, and its `@mock-only` test with `page-name` 3/3 on the mock.
- `npm run typecheck`, oxlint, oxfmt, `node --test scripts/e2e-related.test.mjs` (17), `npx vitest run e2e-tauri` (52), knip, and the doc-code-paths check.
