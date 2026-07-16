/**
 * Unit tests for `toggleCodeBlockSafely` (T1 / #1022).
 *
 * The helper centralises the `focus('end')` workaround for tiptap 3.23.6's
 * `deleteSelection` regression (PR ueberdosis/tiptap#7848): after toggling a
 * code block on an emptied doc the selection collapses outside the node, so
 * we re-anchor to doc-end. Because the roving editor hosts ONE block per
 * instance, doc-end ≡ end-of-toggled-node.
 *
 * These tests pin the exact command chain and ordering with a minimal mock
 * editor — TipTap internals (what `toggleCodeBlock` actually mutates) are left
 * to TipTap's own suite.
 */

import { Editor } from '@tiptap/core'
import CodeBlock from '@tiptap/extension-code-block'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { describe, expect, it } from 'vitest'

import { toggleCodeBlockSafely } from '@/editor/toggle-code-block-safely'

/**
 * Minimal chainable editor stub. Every chain method records its name (and any
 * args) into `calls` and returns the proxy, so we can assert the exact chain
 * and ordering a single `toggleCodeBlockSafely` call produced.
 *
 * `childCount` models `editor.state.doc.childCount` — the re-anchor guard
 * (finding 46) only applies `focus('end')` on single-node docs.
 */
function makeMockEditor(childCount = 1) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const chainProxy: Record<string, unknown> = {
    focus: (...args: unknown[]) => {
      calls.push({ method: 'focus', args })
      return chainProxy
    },
    toggleCodeBlock: (...args: unknown[]) => {
      calls.push({ method: 'toggleCodeBlock', args })
      return chainProxy
    },
    run: (...args: unknown[]) => {
      calls.push({ method: 'run', args })
      return true
    },
  }
  const editor = {
    chain: () => chainProxy,
    state: { doc: { childCount } },
  } as unknown as Editor
  return { editor, calls }
}

/** Real TipTap editor attached to the DOM (mirrors use-block-keyboard tests). */
function makeRealEditor(content: Record<string, unknown>) {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [Document, Paragraph, Text, CodeBlock],
    content,
  })
  const cleanup = () => {
    editor.destroy()
    element.remove()
  }
  return { editor, cleanup }
}

describe('toggleCodeBlockSafely', () => {
  it('chains exactly focus() → toggleCodeBlock() → focus("end") → run()', () => {
    const { editor, calls } = makeMockEditor()

    toggleCodeBlockSafely(editor)

    expect(calls.map((c) => c.method)).toEqual(['focus', 'toggleCodeBlock', 'focus', 'run'])
  })

  it('the first focus() takes no argument; the re-anchoring focus uses "end"', () => {
    const { editor, calls } = makeMockEditor()

    toggleCodeBlockSafely(editor)

    // Two focus calls: the initial one (no arg) and the post-toggle re-anchor.
    const focusCalls = calls.filter((c) => c.method === 'focus')
    expect(focusCalls).toHaveLength(2)
    expect(focusCalls[0]?.args).toEqual([])
    expect(focusCalls[1]?.args).toEqual(['end'])
  })

  it('passes no attributes to toggleCodeBlock when none are given', () => {
    const { editor, calls } = makeMockEditor()

    toggleCodeBlockSafely(editor)

    const toggle = calls.find((c) => c.method === 'toggleCodeBlock')
    // `undefined` (a bare attributes arg) — TipTap treats this as "no attrs".
    expect(toggle?.args).toEqual([undefined])
  })

  it('passes the language attribute through to toggleCodeBlock', () => {
    const { editor, calls } = makeMockEditor()

    toggleCodeBlockSafely(editor, { language: 'typescript' })

    const toggle = calls.find((c) => c.method === 'toggleCodeBlock')
    expect(toggle?.args).toEqual([{ language: 'typescript' }])
  })

  it('re-anchors AFTER toggling (focus("end") follows toggleCodeBlock)', () => {
    // The whole point of the helper: the cursor must land inside the freshly
    // toggled node. Assert the re-anchor focus comes strictly after the toggle.
    const { editor, calls } = makeMockEditor()

    toggleCodeBlockSafely(editor, { language: 'rust' })

    const toggleIdx = calls.findIndex((c) => c.method === 'toggleCodeBlock')
    const reanchorIdx = calls.findIndex(
      (c, i) => c.method === 'focus' && i > toggleIdx && c.args[0] === 'end',
    )
    const runIdx = calls.findIndex((c) => c.method === 'run')
    expect(toggleIdx).toBeGreaterThanOrEqual(0)
    expect(reanchorIdx).toBeGreaterThan(toggleIdx)
    expect(runIdx).toBeGreaterThan(reanchorIdx)
  })

  it('does not call run() until the chain is fully built (run is last)', () => {
    const { editor, calls } = makeMockEditor()

    toggleCodeBlockSafely(editor)

    expect(calls.at(-1)?.method).toBe('run')
    expect(calls.filter((c) => c.method === 'run')).toHaveLength(1)
  })

  // Finding 46 — `focus('end')` is doc-absolute, so it is only sound when the
  // doc holds a single top-level node (doc-end ≡ end-of-toggled-node). A
  // roving doc can transiently hold several paragraphs (plain-text paste with
  // blank lines, split on blur): re-anchoring there yanks the caret out of
  // the new code block into the LAST node, so subsequent typing lands in the
  // trailing paragraph as prose.
  describe('multi-node docs (finding 46)', () => {
    it('skips the focus("end") re-anchor when the doc has multiple children', () => {
      const { editor, calls } = makeMockEditor(2)

      toggleCodeBlockSafely(editor)

      expect(calls.map((c) => c.method)).toEqual(['focus', 'toggleCodeBlock', 'run'])
    })

    it('leaves the caret inside the new code block when the doc holds multiple paragraphs', () => {
      const { editor, cleanup } = makeRealEditor({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'bravo' }] },
        ],
      })
      try {
        // Caret inside the FIRST paragraph ('al|pha').
        editor.commands.setTextSelection(3)

        toggleCodeBlockSafely(editor)

        const { $from } = editor.state.selection
        expect($from.parent.type.name).toBe('codeBlock')
        expect($from.parent.textContent).toBe('alpha')

        // Typing lands in the code fence, not appended to trailing prose.
        editor.commands.insertContent('typed')
        expect(editor.state.doc.firstChild?.type.name).toBe('codeBlock')
        expect(editor.state.doc.firstChild?.textContent).toContain('typed')
        expect(editor.state.doc.lastChild?.textContent).toBe('bravo')
      } finally {
        cleanup()
      }
    })

    it('still re-anchors into the code block on a single-node doc (upstream regression pin)', () => {
      const { editor, cleanup } = makeRealEditor({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'solo' }] }],
      })
      try {
        editor.commands.setTextSelection(3)

        toggleCodeBlockSafely(editor)

        const { $from, empty } = editor.state.selection
        expect($from.parent.type.name).toBe('codeBlock')
        // Doc-end re-anchor: caret sits at the END of the (only) code block.
        expect(empty).toBe(true)
        expect($from.parentOffset).toBe($from.parent.content.size)
      } finally {
        cleanup()
      }
    })
  })
})
