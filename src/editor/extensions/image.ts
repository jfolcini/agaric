/**
 * TipTap extension: `image` node (#1434).
 *
 * An atomic INLINE node for a markdown `![alt](url)` image. `attrs.src` holds
 * the image URL and `attrs.alt` the alt text. Rendered via a React node view
 * (`ImageNodeView`) that draws an `<img>` with a broken-image fallback. The node
 * round-trips through the markdown serializer (`![alt](url)`).
 *
 * No `@tiptap/extension-image` dependency is used — this is a small custom node
 * so the slice adds zero new dependencies. SCOPE: `![alt](url)` parse/serialize
 * + render only; binary paste/drag-drop → attachment and attachment-path export
 * are explicit FOLLOW-UPs handled elsewhere.
 */

import { InputRule, mergeAttributes, Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'

import { ImageNodeView } from './ImageNodeView'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    image: {
      insertImage: (attrs: { src: string; alt?: string }) => ReturnType
    }
  }
}

export const Image = Node.create({
  name: 'image',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (el) => el.getAttribute('src') ?? '',
        renderHTML: (attrs) => ({ src: attrs['src'] as string }),
      },
      alt: {
        default: '',
        parseHTML: (el) => el.getAttribute('alt') ?? '',
        renderHTML: (attrs) => ({ alt: attrs['alt'] as string }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'img[src]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView)
  },

  // Typing `![alt](url)` (closing `)` is the just-typed char) converts to an
  // image atom — mirrors the markdown parse rule so an image authored in the
  // editor serializes to `![alt](url)` and round-trips (without this, the typed
  // text is escaped on blur and stays literal, like a `[text](url)` link). A
  // custom InputRule (not nodeInputRule) is used so the whole `![…](…)` run is
  // consumed and replaced by the atom. The alt forbids `]` and the url forbids
  // `)` so the match stops at the first closer (matching `scanImage`'s
  // balanced-but-shallow shape for the typed-input case).
  addInputRules() {
    const type = this.type
    return [
      new InputRule({
        find: /!\[([^\]]*)\]\(([^)]+)\)$/,
        handler: ({ state, range, match }) => {
          const alt = match[1] ?? ''
          const src = match[2] ?? ''
          state.tr.replaceWith(range.from, range.to, type.create({ alt, src }))
        },
      }),
    ]
  },

  addCommands() {
    return {
      insertImage:
        (attrs: { src: string; alt?: string }) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { src: attrs.src, alt: attrs.alt ?? '' },
          }),
    }
  },
})
