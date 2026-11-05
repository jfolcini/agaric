# Session 3485 — the menu sheet keeps its rows while closing

Set out to fix #6347: `page-source-edit.spec.ts` "Cancel on the toolbar asks first when the buffer changed" (390 px phone) timed out once on CI in `moveSelection`, called from `caretAtEnd`.

The issue's theory (a DOM caret on a wrapped line that `posAtDOM` maps one off) was wrong. The CI artifact's `error-context.md` showed the page Outline sheet open with its Close button focused, over the buffer, so the `ArrowRight` went to that dialog and the caret wait could never hold. Outline opens only from the page kebab's "Open outline" row, so a click landed on that row.

What was measured at 390×844 with touch: the kebab bottom sheet holds 14 rows. Choosing "Edit as Markdown" closes it and turns source mode on in the same render, so the closing sheet drops its "Edit as page" and "Edit as Markdown" rows and shrinks while it slides away. That moved "Open outline" to y 356–400, under `caretAtEnd`'s triple-click point (y 371). One probe also showed the buffer taking focus before the closing sheet had left the DOM. Playwright's hit-target interceptor checks only the first event of an action, so the later clicks of a triple-click go to whatever is under the point by then.

Not reproduced end to end: CPU stress, CDP CPU throttling (4×, 6×, 10×) and a sheet animation stretched to 2 s all stayed green, because the closing sheet's overlay covers the point and Playwright waits it out. The coordinator chose to fix the product cause instead, since a real finger can mis-tap a row the same way.

Shipped: `MenuSheet` renders the rows it showed while open until it has left (every phone action sheet), and a spec in the 390 px describe that samples the sheet's rows, by offset from its top, on every frame from the click until it unmounts. Against the old `MenuSheet` it is red 3/3 on the expected diff (the two edit-mode rows gone, "Delete page" moved up); with the fix it is green. `openSourceMode` also waits for the "Page actions" menu to be gone before it returns, which on its own has no red.

Ran: the 390 px describe ×5, every `@mobile` Playwright spec, vitest for `MenuSheet` and its consumers, `npm run typecheck`. `diagram-legibility.spec.ts` fails two tests here and on `origin/main` alike (a label measures 10.99994 against `>= 11`), most likely because this box's Chromium is build 1243 where Playwright 1.64.1 expects 1248.
