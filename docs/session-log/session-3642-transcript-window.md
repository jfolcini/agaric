# Session 3642 — windowing a transcript's rows

The twelfth PR of #5364 slice 2. A recording's transcript mounts only the rows near the view, rather than all of them: a two-hour meeting has about 1,500.

## The change

- `TranscriptRows` in `TranscriptAttachment.tsx` windows the rows with `@tanstack/react-virtual`.
  - The transcript has no scroll box of its own. It sits in the page's scroll, so the virtualizer uses the nearest scrolling ancestor (`scrollParentY`).
  - It offsets the rows by the list's position in that scroller, as `AgendaResults` does, and re-measures with a `ResizeObserver` when anything above the list changes height.
  - Rows are measured, so a row that wraps keeps its real height.
- Every row mounts in two cases:
  - **While find-in-page is open** (`useInPageFindStore.open`). The app's find walks the rendered DOM, so it can't see unmounted rows. Opening find mounts the rest; closing it windows again.
  - **When no ancestor scrolls,** because then nothing can tell which rows show.
- Unchanged:
  - collapse and expand;
  - the timestamp button that seeks;
  - the current-row highlight, on the rows that are mounted;
  - the memoised rows, so a `timeupdate` still re-renders only two of them.
  - Nothing scrolled the current row into view before this change, and nothing does now.
- What changes for copy and select: a selection can only cover mounted rows. To copy a whole transcript, the attachment itself is the file.
- Tried first: `content-visibility: auto` on the rows. It cut style and layout at CPU ×4 from 706 [652–764] ms to 256 [217–289] ms, but not the ~500 ms of script that renders 1,500 rows. The worst frame stayed inside main's band, so it was dropped.

## Tests

- New file `TranscriptAttachment.window.test.tsx`, with the shared `mockReactVirtual` double:
  - a window of rows;
  - every row while find is open, and the window again once it closes;
  - a seek from a windowed row;
  - axe.
- Red on main: three fail. Two fail on "expected 1500 to be less than 100", and axe times out over 1,500 rows.
- Breaking the find fallback (`&&` to `||`) reds the find test: 30 rows, not 1,500.
- The existing `TranscriptAttachment` tests pass unchanged.

## The #6426 journey

The maintainer approved two edits to `perf: opening a two-hour transcript`:
- **It times the click until the first row appears,** not the body's first child. The windowed list commits empty before it finds its scroller. The plain-Markdown fallback still stops the clock, so a transcript that doesn't parse reds on the mounted count rather than hanging. Shown red by breaking `TIMESTAMP` in `transcript.ts`: "expected > 0, received 0".
- **It checks that some rows mount, but fewer than all of them,** where it used to count all 1,500.

## Measured

Headless Chromium on the mock, `AGARIC_PERF_REPEATS=7`, median [min–max]. "Before" is main's component under the edited journey; on main, the first row and the list arrive in the same commit.

| CPU | | open, ms | worst frame, ms | commits | peak DOM nodes |
|---|---|---|---|---|---|
| ×1 | main | 102 [85–181] | 205 [194–296] | 16 [15–17] | 9,549 [9,539–9,549] |
| ×1 | windowed | 29 [28–36] | 129 [110–246] | 18 [15–19] | 776 [767–777] |
| ×4 | main | 478 [395–544] | 1,006 [821–1,112] | 18 [15–22] | 9,539 [9,539–9,548] |
| ×4 | windowed | 153 [120–217] | 650 [471–1,125] | 20 [17–23] | 776 [762–776] |

- **Open time and peak DOM nodes:** both drop at both CPU settings, well outside the noise band. 38 rows mount instead of 1,500.
- **Worst frame:** the median falls at both settings, but the bands overlap: the ×4 windowed maximum, 1,125, is above main's minimum. So the worst-frame drop isn't shown beyond noise.
