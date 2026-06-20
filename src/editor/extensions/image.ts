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

import { isValidHttpUrl } from './external-link'
import { ImageNodeView } from './ImageNodeView'

/**
 * Schemes the app legitimately mounts as `<img src>` besides http(s). These
 * mirror the "local" srcs `external-image-policy` (`shouldLoadExternalImage`)
 * loads directly: in-app attachments (`asset:` / `tauri:`), inline/pasted data
 * (`data:` / `blob:`), and the Tauri asset host. Any other explicit scheme
 * (e.g. `javascript:`, `ftp:`) is rejected so the input rule won't mint a node
 * for a hostile/garbage src — symmetric with how the link rule gates on
 * `isValidHttpUrl`. `attachment:` is the internal ref for a pasted/dropped image
 * stored as an attachment (#1434); it resolves to the attachment's bytes at
 * render time and is always a trusted local src.
 */
const SAFE_IMAGE_SCHEMES = ['data:', 'blob:', 'asset:', 'tauri:', 'attachment:']

/**
 * Whether `src` is an acceptable image source for node creation. Accepts a
 * valid http(s) URL (same predicate the link path uses), a known-safe local
 * scheme (`data:`/`blob:`/`asset:`/`tauri:`), or a scheme-less relative path
 * (e.g. `c.png`, `./img/x.png`) — i.e. anything WITHOUT an explicit unknown
 * scheme. A src carrying any other explicit `scheme:` (`javascript:`, `ftp:`, …)
 * is rejected.
 */
export function isValidImageSrc(src: string): boolean {
  const trimmed = src.trim()
  if (trimmed === '') return false
  if (isValidHttpUrl(trimmed)) return true
  const lower = trimmed.toLowerCase()
  if (SAFE_IMAGE_SCHEMES.some((scheme) => lower.startsWith(scheme))) return true
  // Reject anything else that carries an explicit `scheme:` prefix; a leading
  // segment of `[a-z][a-z0-9+.-]*:` is a URI scheme (e.g. `javascript:`). No
  // such prefix ⇒ a relative path, which is a legitimate local src.
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
}

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
          // Gate src like the link rule gates on `isValidHttpUrl` (#1587): an
          // invalid/garbage/hostile-scheme src no-ops the rule, leaving the
          // literal `![alt](src)` text instead of minting an image node whose
          // src flows unvalidated into `<img src>`.
          if (!isValidImageSrc(src)) return
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
