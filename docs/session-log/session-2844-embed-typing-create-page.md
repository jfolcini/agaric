# Session 2844 — typing `![[` makes an embed, and the palette offers Create page

#5691's Obsidian parity item "Embeds and creating pages".

- **`![[` in an empty block makes an embed.**
  - Picking a page from the `[[` picker after a `!` turns the block into `{{embed [[ULID]]}}`; so does the picker's *Create page* row, which creates the page first. One change in `BlockLinkPicker` covers block mode, the journal views and page mode, which share the picker.
  - It applies only when the `!` starts the block and nothing follows the caret. `parseEmbedToken` reads an embed only as a block's whole content, so `Hello![[`, `\![[` or `![[` typed before other text stays a link. Otherwise the block would show raw `{{embed …}}` markup.
  - A typed `|label` is dropped, as Obsidian's note embed ignores its alias.
  - One Ctrl+Z restores the typed `![[…`.
- **A palette search that matches nothing offers *Create page "query"*.** It opens the New page dialog with the query as the title, the one dialog every new-page entry point opens (#5637). Enter on such a query now picks it instead of opening the search view.
- **The palette's no-results status row moved out of the listbox.** axe rejects a `role="status"` inside a listbox; this branch's test was the first scan of that state. It sits in the same place on screen.

Reviewed separately. The builder had the embed apply wherever a `!` preceded `[[`; the reviewer limited it to an empty block and replaced the test that asserted the mid-text form.

Shown red:
- the `!` check disabled (three unit tests, and both editor e2e tests);
- the paragraph-start and paragraph-end checks each removed;
- the palette row opening no dialog;
- the status row back inside the list (axe `aria-required-children`).

Suites run:
- vitest over the changed tests, `src/editor/__tests__`, `src/editor/page-mode`, `src/components/common` and `src/__tests__`;
- typecheck, lint, `prek` (the manual stage too);
- 148 Playwright tests over embeds, the palette, the New page dialog, pickers, page mode and `background-tabs`.

Left as is: typing the whole `![[Name]]` without the picker still makes a link (`!` plus `[[ULID]]`), through the `[[…]]` input rule; it is close to #6033's syntax question.
