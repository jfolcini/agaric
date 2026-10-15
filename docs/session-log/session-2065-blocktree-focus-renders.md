# Session 2065 — BlockTree: a focus move re-renders only the trees it touches

#5447 asked whether every mounted `BlockTree` re-renders on each focus
change. It did: each tree subscribed to the global `focusedBlockId` and
`selectedBlockIds` through one `useShallow` selector, and `setFocused` writes
a fresh selection array, so the week view's seven trees all re-rendered on
every keystroke that moved focus.

Each tree now subscribes to the focused id only while its own page store
holds that block (otherwise `null`), and to the selection filtered to its own
ids. Every consumer of the two values was traced: the roving editor's
unmount, draft commit on a cross-day move, `rovingBlockIsForeign`, empty-block
cleanup, the placeholder and the selection highlight all behave as before.
The four shortcut listeners that act on the global state (select-all and
clear, Shift+Arrow extend, Ctrl+Space toggle, copy/cut/paste) read it from the
store when the key is pressed instead of at render; they also stop
re-registering on every focus change.

Measured with a `<Profiler>` per tree in vitest: a move within one day went
from seven trees to one, a cross-day move to two, a selection to one. The
maintainer accepted the render counts as the issue's measurement; no
wall-clock run, as the shared box was busy. Left for follow-ups: every row of
the focused tree still re-renders per move (the `BlockActions` bag changes),
and two week-view bugs that predate this, found in review: a cross-day copy
copies only one day, and "Add block" on an empty day needs a second click.

Suites run: full vitest in shards, `npm run typecheck`, `npm run lint`, and
the week-view, selection, keyboard and editing Playwright specs on a fresh
e2e build; each new test shown red against the old selector or a
render-time read on a copy.
