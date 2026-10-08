# Session 1921 — image resize (#4712)

#4712 asked for image resize. A size is document content: it must sync
and survive a reload. The issue left the storage open between a markdown
syntax extension and block properties. Crop and rotate were split out of
scope, and a `max-w-full` default already existed.

## Decision: the width rides in the alt, Obsidian's way

`![alt|300](url)` is a 300 px image, and Obsidian's `|300x200` reads as a
300 px width. Every layer below the renderer already carries the alt as
an opaque string: the TS parser's `unescapeImageAlt`, the serializer's
`escapeImageAlt` (which does not escape `|`), the Rust importer and sync.
So nothing below the renderer changed. The markdown keeps its
`![alt](url)` shape, and Obsidian vaults that already use the syntax now
render sized.

Block properties were the other option. They would need a key that
survives editing the block, and an image index does not.

## Shipped

- `src/lib/image-alt-size.ts` has `parseImageAlt` / `formatImageAlt`.
- `GatedImage` takes a width and a handle slot. The handle shows only
  beside a real `<img>`, never on the withheld or broken placeholder.
- `CollapsibleImage` and the static renderer show the stripped alt, so a
  screen reader never hears `|300`.
- `ImageResizeHandle` (new) sits on the editor's image corner. It resizes
  by pointer drag or by keyboard (`role="slider"`; arrows step 10 px,
  Shift steps 50 px). Home or a double-click restores the natural size.
- `ImageNodeView` commits once per gesture and skips a write that would
  leave the alt unchanged, since that would be an empty undo step.

Two things the code shape depends on:

- **Keys go through a `document` capture listener.** `use-block-keyboard`
  listens in the capture phase on the editor's parent. A TipTap node view
  dispatches React events from its portal below that, so even a React
  capture handler ran after ArrowLeft had already moved to the previous
  block. MathNodeView solves this the same way. A real-Chromium check
  found the bug after the unit tests had passed; the tests now mount
  through a portal and were red against the first version.
- **`aria-valuemax` is the editor's width.** Without it ARIA's default of
  100 clamps `aria-valuenow`. The CDP accessibility tree reported 100 for
  a 300 px image.

Touch events stop at the handle. Without that, a leftward drag reaches
the block row's swipe gesture, which deletes the block. This was checked
under iPhone emulation.

## Not done

- With the Tab-indent preference off, Tabbing from the editor onto the
  #4711 collapse toggle unmounts the editor and drops focus to `<body>`.
  That is pre-existing and outside this change.
- A drag past the editor edge stores the dragged width, which is then
  drawn capped at the block width. That follows from resizing from what
  the reader sees, and the next resize starts from the drawn width.
- Not run on WebKit (Tauri on macOS and Linux).

## Verified

- Full vitest run, in 3 shards: 871 files, 20 574 passed, 51 skipped,
  1 expected-fail, 0 failed. `npm run typecheck` is clean, as are oxlint
  and oxfmt on the changed files. `prek run --files` passes on all 15
  changed and new files.
- `e2e/image-resize.spec.ts` passes in Chromium. It drags, keeps typing
  after the drag, uses ArrowRight, saves, and checks the static image is
  210 px wide.
- Falsified on copies (restored, checked with `cmp`):
  - 64 mutants across the helper, the renderers, the node view and the
    handle, all killed.
  - The e2e goes red when the key listener stops taking keys first, and
    when the pointerdown is no longer cancelled.
