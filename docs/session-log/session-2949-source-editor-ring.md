# Session 2949 — the Edit as Markdown frame rings toolbar and text

The maintainer reported that the focus ring of *Edit as Markdown* did not wrap its toolbar and was not uniform on all sides.

**Cause:** the border, the shadow and the 3 px `focus-visible` ring were on the ProseMirror element alone (`BUFFER_CLASS`), and the formatting toolbar sat above that box, outside it. The toolbar is `sticky top-0 z-10 bg-background`, so its opaque background painted over the top edge of the ring, which left the top thinner than the sides.

**Convention followed:** block mode's `.block-editor` is one rounded box holding both the toolbar and the text, and `ToolbarFrame` is already drawn as that box's header (`rounded-t-md border-b`). GitHub's and GitLab's comment editors work the same way: one bordered frame around the header and the text area, a hairline between them, and focus anywhere inside rings the whole frame. In this app a composite control rings on `focus-within` with the same opaque 3 px token (`PropertyChip`).

**Change:** `PageSourceEditor` wraps the lazy buffer in a frame (`BUFFER_FRAME_CLASS`) that carries the border, the shadow and a `focus-within` ring. The text keeps only its padding, font and height. The classes stay in `PageSourceEditor`, where the existing comment keeps them so the lazy buffer's chunk imports no design-system module. The frame sits inside the `Suspense`, so the loading fallback is not framed.

**Checked by eye:** Playwright Chromium screenshots at 1024×768, light and dark, with the text focused and with a toolbar button focused. The ring is the same width on every side and encloses the toolbar.

**Suites:**
- a new `page-source-edit.spec.ts` test: the element painting the 3 px ring holds the whole toolbar, both with the text focused and with a toolbar button focused. It was shown red with the ring moved back onto the text;
- the PageSourceEditor, PageSourceToolbar and PageEditor tests (168 of 168);
- `page-source-edit` and `page-source-ulid-tokens` in Playwright (26 of 26);
- typecheck and oxlint.
