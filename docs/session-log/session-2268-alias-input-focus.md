# Session 2268 — Add alias leaves focus in the new-alias input

#5663's real-backend run failed `page-alias-undo.e2e.ts` with "element click
intercepted" on the new-alias input. The failure screenshot showed the cause.
The input was empty, and the "Page actions" tooltip was showing because focus
sat on the kebab.

**Cause.** Choosing Page actions → Add alias mounts the input in the same
render that closes the menu, and the input never takes focus. When the menu's
content unmounts after its fade-out, its `onCloseAutoFocus` finds focus on
`<body>` and returns it to the kebab. A keyboard user had to Tab back to the
input before typing. The spec clicked the input while the menu was still
fading out over it, so its click was intercepted. The menu is a non-modal
Popover, so nothing modal blocks the click; the fading content covers the
input.

**Fix.** The input has `autoFocus`. That is the mechanism the Edit as
Markdown row already relies on: the menu's guard keeps any focus that is not
on `<body>`. The header's own Edit button benefits too, because it unmounts
on click.

The kebab's other rows that open an editor (Add tag, Add property, Insert
emoji, Outline) already land focus in their own popover or dialog. None
changed.

**Tests.** `e2e/page-alias-add.spec.ts` covers the mouse, keyboard and touch
paths. Each asserts `toBeFocused()`, types, presses Enter and checks the
badge. Without `autoFocus` all three failed at `toBeFocused()`. A vitest test
pins the mount-time focus. `page-alias-undo.e2e.ts` needs no change: with
focus already in the input, `focusForTyping` skips its click.

Gates: related vitest, `npm run typecheck`, oxlint and oxfmt, and the new
spec plus the page-header, tag and property specs at `--repeat-each=5
--retries=0`.
