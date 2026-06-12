# Session 1019 — Remove silent slash-command auto-execute (#924 finding 8)

Part of the "fix all UX backlog" pass (2026-06-12).

## Shipped

- **#924 f8 — drop the un-cued 200ms slash auto-execute.** When a `/query` (≥4 chars) matched
  exactly one command, a 200ms timer silently ran it — firing a command out from under a user
  who paused or hovered. Removed the auto-fire entirely (the `AUTO_EXEC_DELAY_MS` timer + its
  custom render-lifecycle wrapper + all the clearTimeout cleanup): slash commands now run only
  on an explicit Enter/click, matching Notion/Logseq. Filtering, the popup, Enter/click
  selection, and Escape dismiss are unchanged (handled by the Suggestion plugin / SuggestionList).

## Tests

Rewrote the auto-exec test suite: a single ≥4-char match does NOT run after 5s, an idle pause
does NOT run, explicit selection delegates to onCommand. 1033 editor unit tests green; `tsc -b`
clean. `e2e/slash-commands.spec.ts` (13 specs) green — it already used explicit Enter/click.

(Follow-up: harmless stale comments referencing the removed timer remain in helpers.ts,
picker-plugin.ts, query-blocks.spec.ts, templates.spec.ts — scrub opportunistically.)
