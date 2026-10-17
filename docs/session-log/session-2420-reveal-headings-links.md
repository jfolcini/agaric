# Session 2420 — The Markdown reveal for headings and links, with the URL field cut

#5689, branch `claude/5689-reveal-headings-links` (`ec1575ca0`), read against
the maintainer's bar: finished quality or cut. Headings and the link brackets
hold up. The inline URL field did not on touch, so it is cut: a link's
`](url)` is now plain revealed marker text, like `**`, and its URL is edited
only through the link popover (`Ctrl+K`, or the selection bubble's link
button on touch).

**Change.** Under the existing per-device setting (off by default):
- A heading shows its `#` run while the caret is in it. Backspace after the run, or Delete before it, lowers the level (level 1 becomes a paragraph). A `#` typed left of the run raises it. Each change is its own undo step.
- A link shows its brackets and URL while the caret is in its label. A bare URL shows nothing, by the serializer's own rule (`writesBareUrl`, now shared). Deleting a bracket unlinks the label.
- Chips stay chips.

The reveal runs at priority 1001, and every handler declines with the setting off.

**Cut: the URL field.** It was finished on desktop and unfinished on touch,
and the fixes it needed (a 44 px target, a bubble that does not cover it, the
blur chain when `commit()` replaces it inside its own `focusout`, its document
listeners when a transaction removes it while focused) would have added more
code to a second way of doing what the link popover already does. A
read-only `](url)` on coarse pointers only was rejected: it adds a platform
branch. With the field gone, `](url)` is crossed by the arrows through stored
marks like any other closing marker, and Backspace past it or Delete before it
unlinks the label in one undo step. Gone with it: the `<input>` widget, its
key, pointer and focus handling, `normalizeUrl` in the reveal, its CSS, the
"Link URL" string, the right-click fix below, and the field's unit, property
and Playwright tests.

**Fixed:**
- **Revealed syntax drew left of a list marker.** At the start of a numbered
  or bullet block the heading's `## `, a link's `[` and bold's `**` came
  before the `1.`, and `## 1. Title` became `1. ## Title` on ArrowLeft. The
  list marker's widget `side` is now below every side the reveal uses
  (`list-marker-decoration.ts`). Inline marks had the same flaw since #5699.
- **One vacuous test.** "a click at a closing bold marker in a heading leaves
  the # run where it is" asserted only the drawn text, which the mutation it
  names does not change. It asserts the caret's side now.
- **Unpinned behaviour, now pinned**, each shown red by mutating the code:
  `deleteContentForward`, the `beforeinput` handler declining what is not its
  own (Android Backspace needs ProseMirror's handler to run), and a plain
  caret after lowering to a paragraph.
- **New since the cut**, each shown red: the arrows crossing `](url)` and
  Backspace past it unlinking (unit and Playwright), `Ctrl+K` on a revealed
  link editing its URL with the new `](url)` drawn (red when a range
  selection reveals nothing), and a long URL wrapping inside the line on a
  Pixel 7 profile at 390 px (red when the marker sets `word-break` and
  `overflow-wrap` to `normal`).

**Found, not fixed:**
- Inherited from #5699, not from this branch: with the preference off the
  plugin still calls `posAtCoords` on every mousedown and dispatches an empty
  transaction after every composition.
- On a phone the touch bubble (#3276) opens over the lines a long `](url)`
  wraps to. It covers read-only text now, not a control.

**Checked:**
- Every handler the reveal runs at priority 1001 declines with the preference
  off. The editor specs with it off: 390 passed, 1 failed, 2 skipped (the
  one, `keyboard-shortcuts` "?" panel, passes 5 of 5 alone, as before the
  cut).
- Headings 1 to 6, a heading lowered to a paragraph whose text starts with
  `#`, and hrefs with `)`, `(`, spaces, quotes and `\` round-trip through the
  serializer and parser (checked before the cut, through the field).
- A heading's `#` typed right of the run or at a paragraph start still opens
  the tag picker; left of the run it raises the level.
- The property test at 3,000 runs passes; it needs `--testTimeout`, since
  vitest's 20 s default is about what 3,000 runs take.
- A long URL wraps because the editor sets `word-break: break-word`, which the
  marker inherits. A `white-space` on the marker's class does nothing:
  TipTap's `[contenteditable=false] { white-space: normal }` wins.
- Mutation scores before the cut: `markdown-reveal.ts` 92.3% and
  `revealed-markers.ts` 93.8%. Not re-run since.
- Not run: the `e2e-tauri` lane (WebKitGTK; its link step now only draws the
  brackets and checks nothing leaked), an Android pass for headings and
  links, and any perf harness (nothing in `revealDecorations` walks beyond
  the selection).

**Traps:**
- A link's `](url)` widget key carries the href, but a mutation that drops
  the text from the key leaves the drawn URL correct after a `Ctrl+K` edit:
  ProseMirror redraws a widget whose neighbouring text node is replaced,
  whatever the key says, so no test can pin that part of the key.
- `origin/main` moves while a branch is reviewed: read the session-number
  window from it again before committing.
