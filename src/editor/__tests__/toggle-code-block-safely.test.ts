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

import type { Editor } from '@tiptap/react'
import { describe, expect, it } from 'vitest'

import { toggleCodeBlockSafely } from '../toggle-code-block-safely'

/**
 * Minimal chainable editor stub. Every chain method records its name (and any
 * args) into `calls` and returns the proxy, so we can assert the exact chain
 * and ordering a single `toggleCodeBlockSafely` call produced.
 */
function makeMockEditor() {
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
  const editor = { chain: () => chainProxy } as unknown as Editor
  return { editor, calls }
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
})
