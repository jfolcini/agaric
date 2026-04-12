/**
 * TipTap extension: external URL links.
 *
 * Wraps @tiptap/extension-link with app-specific defaults:
 * - autolink: detect bare URLs as the user types
 * - linkOnPaste: pasting a URL over selected text creates a link
 * - openOnClick: false — links open on Ctrl+Click (default browser behavior)
 * - Mod-k keyboard shortcut: dispatches a custom DOM event so the React
 *   FormattingToolbar can open the link edit popover.
 * - Paste-to-link: pasting a bare URL with empty selection inserts a linked
 *   text node instead of plain text (F-40).
 *
 * Rendered as `<a>` tags with external link styling.
 * Serialized as `[text](url)` in our Markdown subset.
 */

import Link from '@tiptap/extension-link'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { configKeyToTipTap, getShortcutKeys } from '@/lib/keyboard-config'

/**
 * Validate that `text` is an absolute HTTP(S) URL.
 *
 * Exported for testability — also used by the `validate` config option
 * and the custom paste handler.
 */
export function isValidHttpUrl(text: string): boolean {
  try {
    const u = new URL(text.trim())
    return /^https?:$/.test(u.protocol)
  } catch {
    return false
  }
}

const pastePluginKey = new PluginKey('externalLinkPaste')

export const ExternalLink = Link.extend({
  addKeyboardShortcuts() {
    return {
      [configKeyToTipTap(getShortcutKeys('linkPopover'))]: () => {
        // Dispatch a custom event on the editor DOM element.
        // FormattingToolbar listens for this and opens the link popover.
        this.editor.view.dom.dispatchEvent(new CustomEvent('open-link-popover'))
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() ?? []
    const linkType = this.editor.schema.marks.link
    if (!linkType) return parentPlugins

    parentPlugins.push(
      new Plugin({
        key: pastePluginKey,
        props: {
          handlePaste: (view, event) => {
            // Only act when there is no selection (cursor only).
            if (!view.state.selection.empty) return false

            const clipboardText = event.clipboardData?.getData('text/plain')
            if (!clipboardText) return false

            const url = clipboardText.trim()
            if (!isValidHttpUrl(url)) return false

            // Insert the URL as a text node with the link mark applied.
            const mark = linkType.create({ href: url })
            const node = view.state.schema.text(url, [mark])
            const tr = view.state.tr.replaceSelectionWith(node, false)
            view.dispatch(tr)
            return true
          },
        },
      }),
    )

    return parentPlugins
  },
}).configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  validate: (url: string) => isValidHttpUrl(url),
  HTMLAttributes: {
    class: 'external-link',
    rel: 'noopener noreferrer',
  },
})
