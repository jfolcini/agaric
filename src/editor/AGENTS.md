# Editor (TipTap / ProseMirror)

> Invariant 4 and the editor-portal rules are in the root [AGENTS.md](../../AGENTS.md); the content model and blur chain are in [`docs/architecture/editor-and-content.md`](../../docs/architecture/editor-and-content.md).

## Moving or reusing the roving editor

Embeds, zoom, dialogs and anything that blurs on purpose race the focus-leave cleanup in `useEditorBlur` and the empty-block cleanup. Before building one:

- List every callback bound to the host block (save, split, Enter, Escape, cleanup, undo) and decide for each where it lands while the editor is elsewhere.
- Keep the editor mounted with `data-editor-portal` on the overlay root, or, when the blur is wanted, exempt the block in `preserveEmptyBlockIds` (`useBlockDialogs.ts`). Register synchronously at the point of intent, before the first `await` or `startTransition`: a flag committed later lets the cleanup run first and delete the block.
- Define the Escape exit up front, and check it does not swallow an open picker's own Escape.

## Node views

- A control inside a node view (`MathNodeView.tsx`, `ImageResizeHandle.tsx`) is inside ProseMirror's DOM: keydown and `beforeinput` reach ProseMirror and move or merge blocks, a React `onKeyDown` may never fire once propagation stops, and focusing the control blurs the editor unless its root carries `data-editor-portal`.
- jsdom shows none of that. Cover keydown, `beforeinput`, Tab / Shift+Tab out and focus-out in a Playwright spec (`math-katex.spec.ts`, `image-resize.spec.ts`).

## Tests

- Type through `view.someProp('handleTextInput', …)`, as `hash-tag.test.ts` does. TipTap runs input rules for `insertContent` in a deferred `setTimeout`, which fires after the assertion or after teardown.

## Serializer

- An escape added in `markdown-serialize.ts` needs its decode in `markdown-parse/`, testing the same shape the serializer tested (trimmed line, line start, cell). Seed the literal shape into `markdown-roundtrip.property.test.ts`; random generation rarely produces it.
