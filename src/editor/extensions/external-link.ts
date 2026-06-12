/**
 * TipTap extension: external URL links.
 *
 * Wraps @tiptap/extension-link with app-specific defaults:
 * - autolink: detect bare URLs as the user types
 * - linkOnPaste: pasting a URL over selected text creates a link
 * - openOnClick: false — a plain click places the caret (to edit the link);
 *   Ctrl/Cmd+Click opens the URL via the `handleClick` plugin prop (#924).
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
import { logger } from '@/lib/logger'
import { openUrl } from '@/lib/open-url'
import { fetchLinkMetadata } from '@/lib/tauri'

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
        const { from, to } = this.editor.state.selection
        this.editor.view.dom.dispatchEvent(
          new CustomEvent('open-link-popover', {
            bubbles: true,
            detail: { from, to },
          }),
        )
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() ?? []
    const linkType = this.editor.schema.marks['link']
    if (!linkType) return parentPlugins

    parentPlugins.push(
      new Plugin({
        key: pastePluginKey,
        props: {
          // #924 — open an external link while editing. `openOnClick:false`
          // means a plain click places the caret (so the user can edit the
          // link text); a Ctrl/Cmd+Click opens it — the behaviour the docstring
          // claimed but never actually wired (the base Link extension registers
          // NO click handler when openOnClick is false).
          handleClick: (_view, _pos, event) => {
            if (!event.ctrlKey && !event.metaKey) return false
            const anchor = (event.target as HTMLElement | null)?.closest(
              'a.external-link',
            ) as HTMLAnchorElement | null
            const href = anchor?.getAttribute('href')
            if (!href) return false
            event.preventDefault()
            void openUrl(href).catch((err: unknown) => {
              logger.warn('ExternalLink', 'openUrl failed', { href }, err)
            })
            return true
          },
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
            tr.removeStoredMark(linkType)
            view.dispatch(tr)

            // Fire-and-forget: prefetch metadata for the pasted URL (UX-165)
            fetchLinkMetadata(url).catch((err: unknown) => {
              logger.warn('ExternalLink', 'link metadata prefetch failed', { url }, err)
            })

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
    'data-testid': 'external-link',
    rel: 'noopener noreferrer',
  },
})
