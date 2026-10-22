# Session 2840 — review notes from #6017, #6028, #6030, #6036 and #6037

The non-blocking notes from this sweep's merged PRs, each verified before it was built.

**Fixed:**
- **#6036, CodeQL alert 288.** `enmlTableCell` escaped every `|` without looking at the backslashes before it. Turndown escapes text backslashes, but not inline code's, so `<code>a\|b</code>` came out as `` `a\\|b` `` and the table parser split the cell at the pipe. The rule now adds a backslash only where the run before the pipe is odd. The test parses the result with the app's table parser. A code cell keeps one extra backslash, because the parser unescapes `\|` before it reads the code span.
- **#6037's sibling: toolbar Turn into → Code kept a bulleted block's bullet.** `TurnIntoMenu` now passes its `blockId` to `CodeLanguageSelector`, which clears the list style after the toggle, as #6037 does for callouts. Page mode does not mount this picker. Changing only a code block's language writes no style.
- **#6030.** `page-save.test.ts` never asserted the `edited` set, so removing `result.edited.add` survived mutation. It now asserts `edited` for a text edit and for a create.
- **#6028.** `PageModeEditor`'s `cursorBlock` repeated `caretOf`. It is now `caretOf(editor)?.blockId ?? null`, with identical behavior.
- **#6036's mutation survivors.** Two tests: a rootless note imports through the HTML fallback, and a `<th>` header cell stays on one line with its pipe escaped.

**Dropped, with what was checked:**
- **The other #6036 survivors** on changed lines are equivalent: rule names, regex variants Turndown never meets, the empty-content returns the HTML path also yields, and optional chaining.
- **#6017's `agenda-sort` survivors** in `groupByPriority` are equivalent. #6017 never touched `date-utils.ts`; its last change is #5484.
- **#6037's reviewer suggested writing `'none'` instead of `listStyleForBlockType('callout')`.** Declined: the helper is where a block type's list style is decided, and `handleTurnInto` calls it the same way.
- **#6028's lingering `placeOnFocus` listener.** No failure was traced.
- **Three Playwright specs red in this container** (`block-line-break.spec.ts` iPhone "New line", two `diagram-legibility.spec.ts` label widths). They are green in CI on every PR this sweep, so they are environmental.

Reviewed separately; the builder was killed by a container restart and continued by a second one.

Shown red:
- the old pipe rule (the code cell split in two);
- `setListStyle` skipped (`expected 'bullet' to be 'none'`, and the e2e's `Received: "bullet"`);
- `result.edited.add` removed;
- the HTML fallback broken;
- the `<th>` filter dropped.

Suites run: vitest over the enex and jex importers, `src/editor/page-mode` and `src/components/editor-toolbar`; typecheck; lint; `prek` manual stage; 15 Playwright specs on the toolbar, turn-into, callout, page-mode, menu and list-style surfaces.

Left for a product call: block-mode slash `/code`, `/quote` and `/h1`–`/h6` keep a list style, unlike Turn into.
