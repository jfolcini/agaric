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
 * Re-anchoring with `focus('end')` is sound only while the roving doc
 * holds a SINGLE top-level node (then doc-end ≡ end-of-toggled-node).
 * The doc can transiently hold several paragraphs — a plain-text paste
 * with blank lines parses to a multi-paragraph doc that the blur path
 * splits into sibling blocks (`shouldSplitOnBlur`/`splitBlock`) — and
 * there `focus('end')` would yank the caret out of the new code block
 * into the LAST node. The re-anchor is therefore gated on
 * `doc.childCount === 1`, the state the upstream regression actually
 * produces.
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
  const chain = editor.chain().focus().toggleCodeBlock(attributes)
  // Single-node doc: doc-end is the toggled node's end, so the workaround is
  // safe. Multi-node doc: skip it — toggleCodeBlock keeps the caret inside
  // the toggled node, and re-anchoring would move it into the last node.
  // Chain-recording editor stubs in component tests don't model `state`;
  // they keep the historical single-node chain shape (same fallback pattern
  // as use-block-keyboard's structural probes for test doubles).
  if ((editor.state?.doc?.childCount ?? 1) === 1) {
    chain.focus('end')
  }
  chain.run()
}
