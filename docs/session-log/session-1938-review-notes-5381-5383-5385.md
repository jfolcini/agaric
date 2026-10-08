# Session 1938 — review notes from #5381, #5383 and #5385

The non-blocking reviewer notes from this sweep's merges, in one PR.

- #5381 (indent guides removed): `src/index.css` (the `.embed-container`
  comment) and `docs/features/tags-and-links.md` said an embedded subtree
  does not continue the host page's indent guides; those guides are gone, so
  both now say indentation.
- #5383 (MCP config snippets): a test comment in `AgentAccessTab.test.tsx`
  still said the read-write config copy was out of scope; deleted.
- #5385 (journal Delete page): `expectTodayEmpty` flushed timers twice before
  re-checking the empty day. One flush is enough. Checked by putting the
  auto-create's old dependencies back on a copy of `useJournalAutoCreate.ts`:
  with one flush, both #5358 cases still go red. Restored and
  `cmp`-checked.

Verified: `JournalPage.integration.test.tsx` and `AgentAccessTab.test.tsx`
pass.
