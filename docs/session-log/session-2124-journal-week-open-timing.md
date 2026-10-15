# Session 2124 — Journal week open timed at 100K

#5421's last acceptance item: time a journal week open at the 100K tier, and
bundle its reads into one call only if the week misses 200 ms.

Traced from `WeeklyView` and `DaySection`, a week open sends:
- once per week: `list_journal_pages_in_range` for the month grid,
  `count_agenda_batch_by_source` for the seven days, and
  `count_backlinks_batch` for the days that have a page;
- per mounted day: `load_page_subtree`, then `get_batch_properties` and
  `list_attachments_batch` for the rows on screen, and `batch_resolve` for
  link targets not yet cached.

The issue's "about 31 IPCs" is the most a week can send, not the usual
count. `WeeklyView` lazy-mounts the days near the viewport, `batch_resolve`
runs only for uncached targets, and week mode renders no Due or Done panel.

`interactive_slo` gains `journal week open (7 days) @ 100K`. It runs all of
those reads one after another for seven seeded journal days, an upper bound
since the frontend sends them concurrently. Its untimed probe asserts each
result exactly. The `bench-slo` run on this branch measured 28.26 ms against
the 200 ms budget, so nothing is bundled.

Ran: clippy on the bench target, and the dispatched `bench-slo` run (its
only failure was main's `LastOpened` 20k-page gate, which #5578 fixes).
