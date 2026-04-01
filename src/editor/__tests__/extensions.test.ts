import { getSchema } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { describe, expect, it, vi } from 'vitest'
import { AtTagPicker } from '../extensions/at-tag-picker'
import { BlockLink } from '../extensions/block-link'
import { BlockLinkPicker } from '../extensions/block-link-picker'
import { ExternalLink } from '../extensions/external-link'
import { SlashCommand } from '../extensions/slash-command'
import { TagRef } from '../extensions/tag-ref'

// Build a ProseMirror schema from our extensions to inspect their specs.
const schema = getSchema([
  Document,
  Paragraph,
  Text,
  TagRef.configure({ resolveName: (id: string) => `tag:${id}` }),
  BlockLink.configure({ resolveTitle: (id: string) => `page:${id}` }),
])

// -- TagRef -------------------------------------------------------------------

describe('TagRef extension', () => {
  const nodeType = schema.nodes.tag_ref

  it('exists in the schema', () => {
    expect(nodeType).toBeDefined()
  })

  it('is inline', () => {
    expect(nodeType.isInline).toBe(true)
  })

  it('is an atom (non-editable, cursor skips over it)', () => {
    expect(nodeType.isAtom).toBe(true)
  })

  it('belongs to the "inline" group', () => {
    expect(nodeType.spec.group).toBe('inline')
  })

  it('has an id attribute', () => {
    expect(nodeType.spec.attrs).toBeDefined()
    expect(nodeType.spec.attrs?.id).toBeDefined()
  })

  it('id attribute defaults to null', () => {
    expect(nodeType.spec.attrs?.id.default).toBeNull()
  })

  it('renders as a span with data-type="tag-ref"', () => {
    const spec = nodeType.spec.toDOM
    expect(spec).toBeDefined()
    // Create a node and check renderHTML output
    const node = nodeType.create({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })
    const domSpec = nodeType.spec.toDOM?.(node)
    expect(domSpec).toBeDefined()
    // toDOM returns a DOMOutputSpec array: [tagName, attrs, content]
    expect(Array.isArray(domSpec)).toBe(true)
    const arr = domSpec as unknown as unknown[]
    expect(arr[0]).toBe('span')
    // Attributes should include data-type and data-id
    const attrs = arr[1] as Record<string, string>
    expect(attrs['data-type']).toBe('tag-ref')
    expect(attrs['data-id']).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(attrs.contenteditable).toBe('false')
    expect(attrs.class).toBe('tag-ref-chip')
  })

  it('parses from span[data-type="tag-ref"]', () => {
    const parseRules = nodeType.spec.parseDOM
    expect(parseRules).toBeDefined()
    expect(parseRules?.length).toBeGreaterThan(0)
    expect(parseRules?.[0].tag).toBe('span[data-type="tag-ref"]')
  })
})

// -- BlockLink ----------------------------------------------------------------

describe('BlockLink extension', () => {
  const nodeType = schema.nodes.block_link

  it('exists in the schema', () => {
    expect(nodeType).toBeDefined()
  })

  it('is inline', () => {
    expect(nodeType.isInline).toBe(true)
  })

  it('is an atom (non-editable, cursor skips over it)', () => {
    expect(nodeType.isAtom).toBe(true)
  })

  it('belongs to the "inline" group', () => {
    expect(nodeType.spec.group).toBe('inline')
  })

  it('has an id attribute', () => {
    expect(nodeType.spec.attrs).toBeDefined()
    expect(nodeType.spec.attrs?.id).toBeDefined()
  })

  it('id attribute defaults to null', () => {
    expect(nodeType.spec.attrs?.id.default).toBeNull()
  })

  it('renders as a span with data-type="block-link"', () => {
    const node = nodeType.create({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })
    const domSpec = nodeType.spec.toDOM?.(node)
    expect(domSpec).toBeDefined()
    expect(Array.isArray(domSpec)).toBe(true)
    const arr = domSpec as unknown as unknown[]
    expect(arr[0]).toBe('span')
    const attrs = arr[1] as Record<string, string>
    expect(attrs['data-type']).toBe('block-link')
    expect(attrs['data-id']).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(attrs.contenteditable).toBe('false')
    expect(attrs.class).toBe('block-link-chip')
  })

  it('parses from span[data-type="block-link"]', () => {
    const parseRules = nodeType.spec.parseDOM
    expect(parseRules).toBeDefined()
    expect(parseRules?.length).toBeGreaterThan(0)
    expect(parseRules?.[0].tag).toBe('span[data-type="block-link"]')
  })
})

// -- Cross-extension schema ---------------------------------------------------

describe('Schema integration', () => {
  it('tag_ref can be content of paragraph', () => {
    // Paragraph allows inline content — tag_ref is inline group
    const tagNode = schema.nodes.tag_ref.create({ id: 'TEST00000000000000000000' })
    // Should not throw when creating a paragraph with tag_ref content
    const para = schema.nodes.paragraph.create(null, tagNode)
    expect(para.content.childCount).toBe(1)
    expect(para.content.child(0).type.name).toBe('tag_ref')
  })

  it('block_link can be content of paragraph', () => {
    const linkNode = schema.nodes.block_link.create({ id: 'TEST00000000000000000000' })
    const para = schema.nodes.paragraph.create(null, linkNode)
    expect(para.content.childCount).toBe(1)
    expect(para.content.child(0).type.name).toBe('block_link')
  })

  it('tag_ref and block_link can coexist with text in a paragraph', () => {
    const nodes = [
      schema.text('before '),
      schema.nodes.tag_ref.create({ id: 'TAG00000000000000000000000' }),
      schema.text(' and '),
      schema.nodes.block_link.create({ id: 'LINK0000000000000000000000' }),
      schema.text(' after'),
    ]
    const para = schema.nodes.paragraph.create(null, nodes)
    expect(para.content.childCount).toBe(5)
  })
})

// -- BlockLinkPicker ----------------------------------------------------------

describe('BlockLinkPicker extension', () => {
  it('has the correct extension name', () => {
    const ext = BlockLinkPicker.configure({ items: async () => [] })
    expect(ext.name).toBe('blockLinkPicker')
  })

  it('is an Extension type (not Node or Mark)', () => {
    expect(BlockLinkPicker.type).toBe('extension')
  })

  it('accepts items option with a custom callback', () => {
    const mockItems = vi.fn().mockReturnValue([])
    const ext = BlockLinkPicker.configure({ items: mockItems })
    expect(ext.options.items).toBe(mockItems)
  })

  it('accepts optional onCreate callback', () => {
    const mockCreate = vi.fn().mockResolvedValue('NEW_ULID')
    const ext = BlockLinkPicker.configure({
      items: async () => [],
      onCreate: mockCreate,
    })
    expect(ext.options.onCreate).toBe(mockCreate)
  })

  it('provides default items option that returns empty array', () => {
    const ext = BlockLinkPicker.configure({})
    expect(ext.options.items).toBeDefined()
    expect(typeof ext.options.items).toBe('function')
    expect(ext.options.items('')).toEqual([])
  })

  it('has onCreate undefined by default', () => {
    const ext = BlockLinkPicker.configure({})
    expect(ext.options.onCreate).toBeUndefined()
  })
})

// -- SlashCommand -------------------------------------------------------------

describe('SlashCommand extension', () => {
  it('has the correct extension name', () => {
    const ext = SlashCommand.configure({ items: async () => [], onCommand: vi.fn() })
    expect(ext.name).toBe('slashCommand')
  })

  it('is an Extension type (not Node or Mark)', () => {
    expect(SlashCommand.type).toBe('extension')
  })

  it('accepts items option with a custom callback', () => {
    const mockItems = vi.fn().mockReturnValue([])
    const ext = SlashCommand.configure({ items: mockItems, onCommand: vi.fn() })
    expect(ext.options.items).toBe(mockItems)
  })

  it('accepts onCommand callback', () => {
    const mockOnCommand = vi.fn()
    const ext = SlashCommand.configure({ items: async () => [], onCommand: mockOnCommand })
    expect(ext.options.onCommand).toBe(mockOnCommand)
  })

  it('provides default items option that returns empty array', () => {
    const ext = SlashCommand.configure({})
    expect(ext.options.items).toBeDefined()
    expect(typeof ext.options.items).toBe('function')
    expect(ext.options.items('')).toEqual([])
  })

  it('provides default onCommand as a no-op function', () => {
    const ext = SlashCommand.configure({})
    expect(ext.options.onCommand).toBeDefined()
    expect(typeof ext.options.onCommand).toBe('function')
  })
})

// -- AtTagPicker --------------------------------------------------------------

describe('AtTagPicker extension', () => {
  it('has the correct extension name', () => {
    const ext = AtTagPicker.configure({ items: async () => [] })
    expect(ext.name).toBe('atTagPicker')
  })

  it('is an Extension type (not Node or Mark)', () => {
    expect(AtTagPicker.type).toBe('extension')
  })

  it('accepts items option with a custom callback', () => {
    const mockItems = vi.fn().mockReturnValue([])
    const ext = AtTagPicker.configure({ items: mockItems })
    expect(ext.options.items).toBe(mockItems)
  })

  it('provides default items option that returns empty array', () => {
    const ext = AtTagPicker.configure({})
    expect(ext.options.items).toBeDefined()
    expect(typeof ext.options.items).toBe('function')
    expect(ext.options.items('')).toEqual([])
  })
})

// -- ExternalLink -------------------------------------------------------------

describe('ExternalLink extension', () => {
  it('has the correct extension name (inherits from Link)', () => {
    expect(ExternalLink.name).toBe('link')
  })

  it('is a Mark type', () => {
    expect(ExternalLink.type).toBe('mark')
  })

  it('has autolink enabled', () => {
    expect(ExternalLink.options.autolink).toBe(true)
  })

  it('has openOnClick disabled', () => {
    expect(ExternalLink.options.openOnClick).toBe(false)
  })

  it('has linkOnPaste enabled', () => {
    expect(ExternalLink.options.linkOnPaste).toBe(true)
  })

  it('has external-link CSS class in HTMLAttributes', () => {
    expect(ExternalLink.options.HTMLAttributes).toBeDefined()
    expect(ExternalLink.options.HTMLAttributes.class).toBe('external-link')
  })

  it('has noopener noreferrer rel attribute', () => {
    expect(ExternalLink.options.HTMLAttributes.rel).toBe('noopener noreferrer')
  })
})
