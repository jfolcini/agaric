# Session 2240 — Two flaky Rust tests

CI's nextest profile retries twice, and a CI survey found two tests that
passed only on a retry (`FLAKY 2/3`).

- **`the_freshness_window_is_two_resync_intervals_4120`** (`agaric-sync`):
  `left: 2 right: 1`. The fixture computes a stamp's age from `now_ms()`, and
  `peer_pulled_from_us_recently` reads the clock again before its
  `<= window_ms` check. In the arm at exactly 120 000 ms, a millisecond tick
  between the two reads put the stamp outside the window. The arm is now
  119 000 ms, so the edge is pinned a second either side, as the 121 000 ms
  arm already does. Keeping the exact edge would need an injectable clock in
  a production signature. A 2 ms sleep after the fixture reproduced the CI
  failure on the old arm and passed on the new one, and the test then passed
  300 of 300 runs.
- **`search_tag_matches_attached_inline_and_inherited_tags_5398`**
  (`agaric` MCP): a result repeated across `limit: 1` pages. The cursor is
  bm25 rank plus id, and in a corpus this small any `fts_blocks` change
  between pages moves every rank. `mk_space` built its own `Materializer` and
  never drained it, so the space page's index row could land mid-loop. It was
  missing at the loop's start in 18 of 100 runs. `mk_space` now settles its
  materializer. Stress runs: 4 of 300 failed before, 0 of 300 after.

**Not changed:** the same rank shift can reach users. In a small vault, an
index change between two "Load more" fetches can repeat a search result (a
row with no text) or skip one (a row with text).
