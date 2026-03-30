/**
 * TipTap extension: external URL links.
 *
 * Wraps @tiptap/extension-link with app-specific defaults:
 * - autolink: detect bare URLs as the user types
 * - linkOnPaste: pasting a URL over selected text creates a link
 * - openOnClick: false — links open on Ctrl+Click (default browser behavior)
 *
 * Rendered as `<a>` tags with external link styling.
 * Serialized as `[text](url)` in our Markdown subset.
 */

import Link from '@tiptap/extension-link'

export const ExternalLink = Link.configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  HTMLAttributes: {
    class: 'external-link',
    rel: 'noopener noreferrer',
  },
})
