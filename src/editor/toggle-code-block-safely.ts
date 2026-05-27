import type { Editor } from '@tiptap/react'

/**
 * Shared "toggle code block" chain used by the keyboard shortcut, toolbar
 * buttons, language picker, and slash command. Centralised so the
 * `focus('end')` workaround for tiptap 3.23.6's `deleteSelection`
 * regression (PR ueberdosis/tiptap#7848) lives in exactly one place.
 *
 * The regression: after `deleteSelection` on an emptied doc, the
 * selection collapses to position 0 — outside the first node. The
 * subsequent `toggleCodeBlock` creates the code block but the cursor
 * stays outside it, so the next keystroke / `insertContent` lands in a
 * fresh paragraph above the empty code block instead of inside it.
 *
 * Re-anchoring with `focus('end')` is sound for the roving editor
 * because each editor instance hosts ONE block at a time, so doc-end
 * ≡ end-of-toggled-node.
 *
 * Lives in its own module (rather than alongside the `CodeBlockWithShortcut`
 * extension in `use-roving-editor.ts`) so consumer modules — toolbar,
 * slash-command, etc. — can import the helper without pulling in the
 * full set of TipTap extensions and the `Extension` re-export from
 * `@tiptap/react` that lives in `use-roving-editor.ts`. Tests that
 * mock `@tiptap/react` minimally then don't need to mirror that whole
 * surface.
 *
 * Remove when upstream tiptap restores selection-after-delete to land
 * inside the post-delete node, or when we move to a multi-block editor
 * (where doc-end is no longer the toggled node's end).
 */
export function toggleCodeBlockSafely(editor: Editor, attributes?: { language: string }): void {
  editor.chain().focus().toggleCodeBlock(attributes).focus('end').run()
}
