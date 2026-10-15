# Session 2092 — Pages: seek a path glob's literal head on the title index

#5426 item 2. `PagesTreeSection` lists a page's children with the path glob
`<title>/*`. `PagesProjection::compile_path_glob` compiled every glob to
`LOWER(title) GLOB ?` over `pages_cache`, a full scan, run twice on a first page
(fetch and COUNT). The new `interactive_slo` probe (`Notes/*` among 100K pages)
measured 13.45 ms against a 10 ms budget before the change.

A pattern with a literal head before its first `*`, `?` or `[` now also bounds
`title COLLATE NOCASE` to `[head, head with its last char bumped)`, a range seek
on `idx_pages_cache_title_nocase`. `prepare_globs`, `LOWER()` and NOCASE all
fold ASCII only, so every title the GLOB matches lies inside the range: the
range is a necessary condition and the result set is unchanged. A pattern with
no literal head, or whose last head char cannot be bumped, keeps the GLOB alone.
The old body stays as a `#[cfg(test)]` scan oracle.

Tests:
- A parity test runs the range and the scan oracle over a mixed corpus,
  include and exclude, across brace, class, `?`, accented, uppercase and
  DEL-ending patterns.
- A unit test pins the exact bounds.
- An EXPLAIN test pins the index on the real composed IPC SQL.
- Two conformance vectors (`PROJ*`, `Café*`) run on both the backend and the
  TypeScript side.

Falsified on copies in the lane:
- dropping `COLLATE NOCASE` from the range turned four tests red: the EXPLAIN,
  parity, exclude and conformance tests;
- dropping the bump turned five red, the bounds and parity tests among them.

The review found the claim "only the alias differs" in
`docs/architecture/filters.md` and two test comments, now corrected.

Not changed: a one-letter head that matches most pages walks the index plus a
row lookup per hit and can be slower than the scan. `PagesTreeSection` always
sends a full title as the head.

Suites run:
- nextest on the glob, `list_pages_with_metadata`, pages-metadata, filters,
  query and conformance subsets;
- clippy and `cargo doc` with the CI lint flags, after merging `main`;
- the `bench-slo` lane before and after.
