# Session 3336 — typing-triggered pickers stay still

The maintainer reported that the `[[` picker redraws on every keystroke. Three causes, all in the shared `suggestion-renderer.ts` that every editor picker uses (`[[`, `#`, `@`, `/`, `((`, `:`, `::`, `{{`, and the Edit-as-Markdown buffer's `[[`, `#`, `((`):

- It anchored to the caret (`coordsAtPos(range.to)`), so the popup slid right with each character.
- It re-ran `flip` on each update, so near the bottom the side and the edge moved as results changed.
- `@tiptap/suggestion` now calls `onUpdate` with `items: []` and `loading: true` before every fetch. The list swapped to its empty state, then back, and the remounted `.suggestion-list` replayed its entry animation.

The rule now:

- The popup is anchored to the trigger (`range.from`) and the lines up to the caret.
- Its side is chosen once, at open, by the room for the list's full height. Above the line, its bottom edge is pinned with CSS `bottom`, so results never pull it off the line.
- It is hidden until its first results arrive, and keeps showing the previous results while the next ones load.
- The entry animation plays once, on the popup's child when it is revealed.
- `autoUpdate` re-places it only for scroll, resize or the editor resizing or moving, never per keystroke.
- The placement maths is the pure `src/editor/suggestion-placement.ts`.

`e2e/suggestion-popup-stability.spec.ts` samples the popup every animation frame while typing. Before the fix:

- `[[`: the left edge drifted 44.7 px over six keys.
- `/`: 50.6 px.
- Near the bottom: 316 px sideways, and 20 px on the bottom edge.

After: 0 px on each. The mock answers within one frame, so the empty-state flash shows only with IPC slowed to 100 ms. In that case, 42 sampled frames showed the empty state with the keep-previous branch removed, and 0 with it. The renderer's old positioning tests pinned `computePosition` middleware, caret anchoring and per-keystroke rAF coalescing, the behaviour the maintainer asked to change. They were replaced by tests of the new rule.

Falsified, one mutation each:
- anchor back on the caret: 3 e2e cases and the anchor unit test went red;
- `top` pinned when above: the bottom case went red at 20 px;
- the side re-chosen on every layout change: the stays-above unit test went red;
- the keep-previous branch removed: the slow-backend case and two unit tests went red.

The audit's other hits ship separately: the command palette re-centres as results change, and the ref-property value picker re-flips. The search panel's inline autocomplete was measured still: anchored at the token start, with stale results kept while loading.

Ran: vitest over `src/editor`, `npm run typecheck`, and the new spec on Playwright (desktop, plus a Pixel 7 check by hand).
