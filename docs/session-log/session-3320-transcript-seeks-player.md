# Session 3320 — a transcript seeks its recording's player

Slice S3 of #5410's build plan, built by the orchestrator session and finished
here. A `.transcript.md` attachment on a block with audio is parsed into
segments (`[mm:ss]` or `[h:mm:ss]` at the start of a paragraph, followed by a
space or the paragraph's end); each timestamp is a button that seeks the
block's player, and the segment under the playhead is marked `aria-current`.
A block's attachments render as player, summary (expanded), transcript
(collapsed), then the rest. A transcript drives the block's only audio file,
or the one sharing its stem; otherwise it is plain Markdown.

Decisions: the timestamp label is shown as written and the speaker stays in
the segment's Markdown, as the maintainer asked; the transcript is read on
first expand and is not capped, since a cap would cut off late timestamps.
A seek before the player knows its length is held, so the unknown-duration
rewind cannot lose it. A media error falls back to the file chip.

`transcript.ts` and `recording-attachments.ts` are enrolled in Stryker:
100% and 98.46% (the survivor differs only for a file named `.ogg`).

Ran: the full vitest suite, typecheck, lint, the manual hooks, and the 161
Playwright specs `just e2e-related` selected. `diagram-legibility.spec.ts`
failed here by 0.00006 px with a headless shell one build behind
Playwright's; the branch touches no diagram code. WebdriverIO was not run.
