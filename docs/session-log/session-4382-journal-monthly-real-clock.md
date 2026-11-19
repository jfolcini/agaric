# Session 4382 — journal-monthly dates its days from the real clock

`e2e/journal-monthly.spec.ts` went red on the bridge on 19 Nov, 4 of 4: Monthly mode counted 3 agenda items on 26 Nov where the test expects 2. Slice 14 (#6985) put it on `REAL_BACKEND_SPECS`.

**Cause:** the spec pinned the browser clock to 14 Oct and seeded fixed November days. `page.clock` moves only the browser; the backend dates its seed from the real today, and "Design new dashboard" is due a week out. On 19 Nov that is 26 Nov, one of the seeded days. On 18 Nov it was 25 Nov, so the spec passed when it joined the list.

**Fix:** no clock pin. The seeded days are the 12th and 26th of next month and the empty day the 19th, dated from the real clock. Next month, because the current month's journal pages are cached at boot and a page created over IPC is not merged into that cache. From the 8th on, because the seed's latest task is due a week from today, which never lands past the 7th of next month. The expected month, day names and date display are formatted from the same dates.

**Shown red:** the original spec, 4 of 4 on 19 Nov on the bridge.

**Ran:** the spec on the bridge (6 of 6, three repeats) and on the mock (6 of 6); `npm run typecheck`, oxlint and oxfmt on the file.
