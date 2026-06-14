/**
 * TipTap extension: underline inline mark (#211 P2-5).
 *
 * There is no idiomatic Markdown delimiter for underline, so the app stores
 * the mark as paired `<u>…</u>` HTML tags (see `markdown-parse.ts` /
 * `markdown-serialize.ts`). This extension governs only the in-editor mark
 * behaviour: the `<u>` DOM rendering, the toggle commands, and the
 * configurable `Ctrl+U` shortcut (mirrors the other `*WithShortcut` marks in
 * `use-roving-editor.ts`).
 */

import { Mark, mergeAttributes } from '@tiptap/core'

import { tipTapShortcutMap } from '@/lib/keyboard-config'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    underline: {
      setUnderline: () => ReturnType
      toggleUnderline: () => ReturnType
      unsetUnderline: () => ReturnType
    }
  }
}

export const Underline = Mark.create({
  name: 'underline',

  parseHTML() {
    return [
      { tag: 'u' },
      {
        style: 'text-decoration',
        consuming: false,
        getAttrs: (style) => (typeof style === 'string' && /underline/.test(style) ? {} : false),
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['u', mergeAttributes(HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setUnderline:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleUnderline:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetUnderline:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    }
  },

  addKeyboardShortcuts() {
    return tipTapShortcutMap('underline', () => this.editor.commands.toggleUnderline())
  },
})
