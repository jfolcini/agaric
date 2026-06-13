/**
 * Tests for the `underline` mark extension (T2 / #1023).
 *
 * `underline` is a keystroke-hot-path mark registered in `use-roving-editor.ts`.
 * It has no idiomatic Markdown delimiter, so it is stored as `<u>…</u>` HTML.
 * This extension governs only the in-editor behaviour:
 *   - the configurable Ctrl+U keyboard shortcut (routed via `configKeyToTipTap`)
 *   - the two `parseHTML` branches (`<u>` tag + `text-decoration: underline`)
 *   - the `<u>` `renderHTML` serialization round-trip.
 */

import { getSchema } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import type { MarkType, Node as PmNode } from '@tiptap/pm/model'
import { DOMParser as PMDOMParser, DOMSerializer } from '@tiptap/pm/model'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  configKeyToTipTap,
  getShortcutKeys,
  resetAllShortcuts,
  setCustomShortcut,
} from '../../lib/keyboard-config'
import { Underline } from '../extensions/underline'

const schema = getSchema([Document, Paragraph, Text, Underline])
const markType = schema.marks['underline'] as unknown as MarkType

afterEach(() => {
  resetAllShortcuts()
  vi.clearAllMocks()
})

describe('Underline extension — identity', () => {
  it('is a Mark named "underline"', () => {
    expect(Underline.type).toBe('mark')
    expect(Underline.name).toBe('underline')
  })

  it('exists in the schema as a mark', () => {
    expect(markType).toBeDefined()
  })
})

describe('Underline extension — keyboard shortcut routing', () => {
  function callShortcuts(): Record<string, () => unknown> {
    // Invoke `addKeyboardShortcuts` against a stub `this` exposing the editor's
    // command surface so we can both read the registered key and verify the
    // handler dispatches `toggleUnderline`.
    const toggleUnderline = vi.fn(() => true)
    const addKb = Underline.config.addKeyboardShortcuts as
      | ((this: unknown) => Record<string, () => unknown>)
      | undefined
    expect(addKb).toBeDefined()
    const map = (addKb as (this: unknown) => Record<string, () => unknown>).call({
      editor: { commands: { toggleUnderline } },
      name: 'underline',
    })
    return Object.assign(map, { __toggle: toggleUnderline } as Record<string, unknown>)
  }

  it('registers the default Ctrl+U binding in TipTap "Mod-u" form', () => {
    const map = callShortcuts()
    const expectedKey = configKeyToTipTap(getShortcutKeys('underline'))
    expect(expectedKey).toBe('Mod-u')
    expect(map[expectedKey]).toBeDefined()
    expect(typeof map[expectedKey]).toBe('function')
  })

  it('the bound handler dispatches editor.commands.toggleUnderline', () => {
    const map = callShortcuts()
    const key = configKeyToTipTap(getShortcutKeys('underline'))
    map[key]?.()
    expect(
      (map as unknown as { __toggle: ReturnType<typeof vi.fn> }).__toggle,
    ).toHaveBeenCalledOnce()
  })

  it('follows a user rebind of the underline shortcut (live getShortcutKeys read)', () => {
    setCustomShortcut('underline', 'Ctrl + Shift + U')
    const map = callShortcuts()
    const key = configKeyToTipTap(getShortcutKeys('underline'))
    expect(key).toBe('Mod-Shift-u')
    expect(map[key]).toBeDefined()
  })
})

describe('Underline extension — parseHTML branches', () => {
  function parseHtml(html: string): PmNode {
    const dom = document.createElement('div')
    dom.innerHTML = html
    return PMDOMParser.fromSchema(schema).parse(dom)
  }

  function firstTextHasUnderline(doc: PmNode): boolean {
    let found = false
    doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === 'underline')) {
        found = true
      }
    })
    return found
  }

  it('parses a literal <u> tag into the underline mark', () => {
    expect(firstTextHasUnderline(parseHtml('<p><u>under</u></p>'))).toBe(true)
  })

  it('parses text-decoration: underline style into the underline mark (style regex)', () => {
    expect(
      firstTextHasUnderline(
        parseHtml('<p><span style="text-decoration: underline">styled</span></p>'),
      ),
    ).toBe(true)
  })

  it('does NOT apply the mark for an unrelated text-decoration (line-through)', () => {
    expect(
      firstTextHasUnderline(
        parseHtml('<p><span style="text-decoration: line-through">struck</span></p>'),
      ),
    ).toBe(false)
  })

  it('does NOT apply the mark for plain text with no decoration', () => {
    expect(firstTextHasUnderline(parseHtml('<p>plain</p>'))).toBe(false)
  })
})

describe('Underline extension — renderHTML round-trip', () => {
  it('serializes an underlined text node back to a <u> element', () => {
    const para = schema.nodes['paragraph']?.createAndFill(null, [
      schema.text('round', [markType.create()]),
    ])
    expect(para).not.toBeNull()
    const fragmentDom = DOMSerializer.fromSchema(schema).serializeFragment(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      (para as PmNode).content,
    )
    const wrapper = document.createElement('div')
    wrapper.appendChild(fragmentDom)
    expect(wrapper.querySelector('u')).not.toBeNull()
    expect(wrapper.querySelector('u')?.textContent).toBe('round')
  })

  it('round-trips <u> through parse → serialize without dropping the mark', () => {
    const dom = document.createElement('div')
    dom.innerHTML = '<p><u>keep</u></p>'
    const doc = PMDOMParser.fromSchema(schema).parse(dom)
    const out = DOMSerializer.fromSchema(schema).serializeFragment(doc.content)
    const wrapper = document.createElement('div')
    wrapper.appendChild(out)
    expect(wrapper.querySelector('u')?.textContent).toBe('keep')
  })
})
