# Session 4307 — the mock seeds Personal and Work, as the backend does

Decided by the maintainer on 2026-11-18, for #6529's `@spaces` area: the backend's first boot makes two spaces, Personal and Work (`agaric-engine/src/spaces.rs`). The mock seeded only Personal, with Work behind a `localStorage['__mockWorkSpace']` opt-in. Specs that made a space called "Work" therefore got two of them on the bridge.

What changed:

- `seedWorkSpace` (`src/lib/tauri-mock/seed.ts`) seeds Work on every seed, under `SEED_IDS.SPACE_WORK`, with the backend's `accent-blue` accent. The opt-in and its `setItem` calls (seven specs, three vitest files) are gone.
- Tests that assumed one space now use the seeded Work: `SpacesTab.test.tsx` (no assertion changed), `seed-commands.test.ts` (the replay starts from a vault holding both spaces), and the specs `spaces-management`, `deep-link`, `delete-page-tabs`, `tags-lifecycle` and `link-chip-lifecycle`. The spec about creating a space now creates "Side project".
- Changed assertions:
  - `spaces-management`'s delete test: the old test only checked that Delete is disabled on the sole space. It now deletes the empty Work, then asserts that Personal's Delete stays disabled with no pages-held hint, which only the last-space guard explains. Shown red by forcing `isLastSpace={false}`.
  - `import-export`'s vault restore lists `['Personal', 'Travel/x', 'Work']`.
  - `seed-commands` counts 2 blocks left, not 1.
- `delete-page-tabs`, `spaces-management` and `tags-lifecycle` join `REAL_BACKEND_SPECS`. `deep-link` stays off: its Agent-access test reads MCP state that the bridge does not register.
- From #6922's review: `phone-views` drops `baseText: null` from its `edit_block` call.

Noticed, not investigated: `spaces-management`'s journal test needed a visit to Settings before the first switch to Work. Without it, the return to Work fetched no journal page.

Ran:
- Full mock lane before the rebase: 2059 passed. Of 20 failures, 15 are diagram, camera, microphone and scrollbar tests that fail on `main` in this container too. The other 5 were fixed here.
- After rebasing onto `main`: the changed spec files on the mock (89 passed), the touched vitest folders (102 files), and typecheck.
- On a freshly built bridge, the joining and Work-dependent spaces specs three times over: 90 of 90 passed.
