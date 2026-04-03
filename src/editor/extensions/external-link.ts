/**
 * TipTap extension: external URL links.
 *
 * Wraps @tiptap/extension-link with app-specific defaults:
 * - autolink: detect bare URLs as the user types
 * - linkOnPaste: pasting a URL over selected text creates a link
 * - openOnClick: false — links open on Ctrl+Click (default browser behavior)
 * - Mod-k keyboard shortcut: dispatches a custom DOM event so the React
 *   FormattingToolbar can open the link edit popover.
 *
 * Rendered as `<a>` tags with external link styling.
 * Serialized as `[text](url)` in our Markdown subset.
 */

import Link from '@tiptap/extension-link'

export const ExternalLink = Link.extend({
  addKeyboardShortcuts() {
    return {
      'Mod-k': () => {
        // Dispatch a custom event on the editor DOM element.
        // FormattingToolbar listens for this and opens the link popover.
        this.editor.view.dom.dispatchEvent(new CustomEvent('open-link-popover'))
        return true
      },
    }
  },
}).configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  validate: (url: string) => {
    try {
      const u = new URL(url)
      return /^https?:$/.test(u.protocol)
    } catch {
      return false
    }
  },
  HTMLAttributes: {
    class: 'external-link',
    rel: 'noopener noreferrer',
  },
})
