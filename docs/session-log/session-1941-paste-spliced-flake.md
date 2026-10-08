# Session 1941 — paste-spliced e2e flake (test race, not product)

`e2e/paste-spliced-5160.spec.ts` failed on its first try most of the time
(7 of 12 locally, twice in a row in CI on #5381) and passed on retry. The
paste landed one or two characters right of where the test put the caret.

The DOM caret was always right; ProseMirror's copy of it lagged. The spec
placed the caret with `End` and five `ArrowLeft` presses, which the browser
moves natively; ProseMirror reads a native caret move only on the next
`selectionchange` (prosemirror-view `onSelectionChange`), which Chrome fires
0.3–14 ms later and may coalesce. The synthetic `paste` was dispatched in the
very next call, and `pasteSplice` (`html-paste.ts`) splits at
`view.state.selection`, still the old position. Instrumented runs showed the
DOM offset at 6 every time and ProseMirror's at 7, 8 or 9.

Not a product bug: a person can't paste within milliseconds of moving the
caret. Other specs already avoid the pattern.

What changed: `caretMidBlock` places the caret with the existing
`selectEditorRange`, which sets the range and dispatches `selectionchange`
itself. The helper's doc comment blamed the React 19 scheduler for dropped
Shift+Arrow presses; it now states the measured mechanism.

Verified: `--retries=0 --repeat-each=6` before, 7 failed of 12;
`--repeat-each=12` after, 24 passed of 24.
