# Session 3006 — Page mode's bubble menus (#5691)

Set out to give page mode GitLab-style bubble menus (#5691, the maintainer's decision of 2026-10-28), with the image bubble in both modes.

**Shipped:**
- **Page-mode bubbles,** for what the cursor rests in. Each reuses block mode's own pieces, words and icons:
  - a link: *External link* (block mode's `LinkEditPopover`, as Ctrl+K opens it), *Open link* and *Remove*;
  - a table: *Table*, the unchanged `TableOpsSelector`;
  - a code block: its language (the unchanged `CodeLanguageSelector`) and *Copy code*.
- **One image bubble,** shared by block mode and page mode:
  - alt text through `formatImageAlt`, which keeps the width;
  - Open, full screen in the app's `ImageLightbox`, reading the bytes for an `attachment:` image;
  - Remove.
- **`bubbleMenuClass`** is defined once in `toolbar-config.ts`.

**Decisions and traps:**
- **Waiting for the release.** A bubble that appears under a mouse press ends the drag selection: the reveal spec's "mouse drag that starts in bold, a link…" failed 2 of 3 runs. So the link, table and code bubbles wait for the release.
  - The press also ends on `dragstart` and `contextmenu`, as `useEditorBlur` and `markdown-reveal` end one. WebKitGTK ends a native drag with no `pointerup`, which left the bubbles hidden until the next click. The review caught this.
- **`ImageLightbox` carries `data-editor-portal`.** Without it, block mode leaves the block when the lightbox takes focus, and the lightbox closes at once.
- **The alt-text editor is a portalled popover,** not a field in the bubble. Block mode's key handler sits around the bubble, and took a field's Enter as "split block".
- **English keys only.** The `es` catalog translates one namespace per translation PR. The builder's partial Spanish page and editor files went back out, and the agents' brief now says so.
- **Rebase.** It was rebased onto the toolbar (#6148) and the document look (#6151). The only conflicts were the docs lines, merged to keep both.

**Possibly open, not reproduced:** block mode's capturing keydown listener could take Enter on a focused bubble button as a block key. This is already true of `SelectionBubbleMenu`, and is noted for the follow-up.

**Suites, after the rebase:**
- vitest over `src/editor/page-mode`, `src/components/editor-toolbar`, `src/lib/i18n` and `src/components/rendering` (1,484 tests), typecheck and lint;
- Playwright: `page-mode-bubbles`, `page-mode-look`, `page-mode-toolbar`, `page-mode-reveal` and `image-lightbox` (28).
- In review, before the rebase: vitest over `src/editor/page-mode`, `src/components/editor-toolbar`, `src/components/editor`, `src/components/rendering` and `src/lib/i18n` (2,923 tests), the manual hooks, and the image and table specs.
