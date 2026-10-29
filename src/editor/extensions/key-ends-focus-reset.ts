/**
 * For 200 ms after a focus, ProseMirror takes a caret that moves to the
 * document's start for Chrome resetting the selection on focus, and puts its
 * own selection back (`DOMObserver.flush`, timed from the view's private
 * `input.lastFocus`). A key pressed since the focus moved it there: Ctrl+Home
 * just after the selection bubble's Bold hands focus back was undone. So a
 * keydown in the editor ends that window.
 */

import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

type ViewInput = EditorView & { input: { lastFocus: number } }

export const KeyEndsFocusReset = Extension.create({
  name: 'keyEndsFocusReset',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            keydown(view) {
              ;(view as ViewInput).input.lastFocus = 0
              return false
            },
          },
        },
      }),
    ]
  },
})
