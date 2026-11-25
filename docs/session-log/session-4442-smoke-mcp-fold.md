# Session 4442 — the MCP smoke spec takes in the agent specs

#6926 section C, row 4: `mcp-settings-channel.e2e.ts` keeps the server its `before` turns on from Settings, and the real-binary-only MCP specs fold into it as `it`s. `mcp-agent-token.e2e.ts` stays alone: it is the bundled `agaric-mcp` sidecar.

**Folded**, after the three Settings tests, each with an agent of its own from `startReadWriteAgent`; its `mcp_set_enabled` call meets a server already on, and the tests pass on it:

- `mcp-create-tag-picker` (#6049), `history-agent-badge` (#6535), `mcp-write-burst-responsive`, and `meeting-attachments` test 2 (`add_meeting`'s files play and seek, #5364), as tests.
- `attachment-mcp-attach` (#5410) as a nested `describe` with its `before` and its two player tests. Mocha runs a suite's own tests before its child suites, so it runs last.

They come after the revert test because that test picks the first session header in the feed, which is its own only while no later session has two undoable actions.

**Dropped as duplicates**, `meeting-attachments` tests 1 and 3, per #6926 section B: `e2e/meeting-attachments.spec.ts` (on `REAL_BACKEND_SPECS`) "from a template, with its files, reached through the link and again after leaving" and "the open journal shows the link, and the dialog remembers the template". Two reads go with them: WDIO test 1 re-read the source block's link after leaving that page, and test 3 re-read the journal's link after leaving the journal. The bridge twins read the link right after the dialog closes and re-read the meeting page, not the link's block.

**Ran:** `just e2e-real e2e-tauri/mcp-settings-channel.e2e.ts` under `WDIO_SKIP_TAURI_BUILD=1` (see session 4400 for why): green. To see that all nine tests run, the attach test's duration bound was broken once (`toBeLessThan(0)`): the 7 tests before it passed and both attach tests failed on that assertion; restored. Also `npm run typecheck:e2e-tauri` and oxlint over `e2e-tauri/`. `spec-durations.json` gets an estimate for the merged spec until CI measures it.

**Resumed 2026-11-25** (#6926 paused on 2026-11-19, now resumed): rebased from `3f6aad8` onto `main` at `0e4f8ba`. Only `spec-durations.json` had moved on `main` (the S1 sync specs removed); the rebase merged it without a conflict. The log was renumbered from 4401, which `main` had passed. No deleted spec is still named outside the session logs. CI's real-binary lane runs the changed spec on this PR.
