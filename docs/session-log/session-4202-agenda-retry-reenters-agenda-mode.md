# Session 4202 — the agenda projection spec re-enters Agenda mode when it retries

`e2e-tauri/agenda-projected-repeat.e2e.ts` "lists the coming week of projected occurrences in Agenda mode, up to each bound" failed on #6805's real-backend lane (run 43691475299): `[data-testid="agenda-view"]` never existed within 60 s. #6805 touches no agenda code.

Mechanism: a test bug in the spec's retry branch. The test enters Agenda mode with the Journal's "Agenda view" tab, then polls the projected rows. When the first read is stale (the agenda cache rebuild has not landed), it remounts the view with `navigateTo('Pages')` and `navigateTo('Journal')` and waits for the agenda view. The sidebar's Journal item switches an Agenda-mode journal back to Daily (`AppSidebar.tsx`, `if (journalMode === 'agenda') setJournalMode('daily')`), so the remount shows the daily view and the wait can only time out. The branch runs only when the first read loses the race, hence intermittent. The ENOTEMPTY vault cleanup and `Not found: block` lines elsewhere in that shard came from other workers.

Fix: after `navigateTo('Journal')` the retry branch clicks the "Agenda view" tab again, as the test does on the way in.

Shown in CI on #6807, since this box has no tauri-driver: a temporary commit forced one pass through the retry branch. On the old code the spec failed with the original error (`agenda-view` still not existing after 60000ms); with the fix and the forcing it passed. The forcing was then removed.
