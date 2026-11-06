# Session 3640 — opening a two-hour transcript

The eleventh PR of #5364 slice 2, tests only. It's the rewritten perf box: measure opening a two-hour transcript.

- `perf: opening a two-hour transcript (#5364)` in `e2e/perf.spec.ts`, opt-in under `AGARIC_PERF=1` like the file's other timings.
  - Each repeat seeds a fresh vault with an audio file and a generated transcript on one block: 1,500 `[h:mm:ss] **Speaker:** …` segments over two hours, 135 KiB.
  - It opens the page and times the click on *Transcript* until the rows are in the DOM, with that click's commits, worst frame and peak DOM nodes.
  - `AGARIC_PERF_SEGMENTS` changes the size.
- A transcript under a recording is never capped: `MARKDOWN_PREVIEW_CHAR_CAP` belongs to `MarkdownAttachment`. So the open mounts every segment at once.
- Measured here: headless Chromium on the mock, 3 repeats, median [min–max], over two runs per setting.

  | CPU | open, ms | worst frame, ms | commits | peak DOM nodes |
  |---|---|---|---|---|
  | ×1 | 91 [86–99], 95 [87–103] | 183 [177–277], 191 [177–244] | 16 [12–17], 16 [13–20] | 9,549 |
  | ×4 | 547 [464–603], 493 [486–493] | 1,030 [881–1,158], 915 [904–1,103] | 16 [16–17], 21 [20–22] | 9,539–9,548 |

- Direction: the rows reach the DOM quickly, but the frame that lays them out and paints them is long. At ×4 it's about a second, outside the noise band of either run. That's the cost a fix such as windowing the rows would target, and it's its own proposal. This PR sets no threshold.
- Red: with the transcript parser's timestamp pattern broken, the transcript renders as plain Markdown and the journey failed its segment count (expected 1500, got 0). The wait targets the body's content rather than the 1,500th row, so a transcript that doesn't parse reds instead of hanging.
