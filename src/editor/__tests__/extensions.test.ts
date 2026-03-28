import { getSchema } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { describe, expect, it } from 'vitest'
import { BlockLink } from '../extensions/block-link'
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
