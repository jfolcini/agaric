import { renderHook, waitFor } from '@testing-library/react'
import { type Editor, getSchema } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'

import { CALLOUT_TYPES } from '@/components/RichContentRenderer/context'
import { loadEmojiDataset } from '@/editor/emoji-data'
import {
  MARKDOWN_REFERENCE,
  MARKDOWN_REFERENCE_GROUPS,
  type MarkdownReferenceEntry,
  markdownReferenceGroupKey,
  markdownReferenceKey,
} from '@/editor/markdown-reference'
import { parse, serialize } from '@/editor/markdown-serializer'
import { pageModeExtensions } from '@/editor/page-mode/page-mode-extensions'
import { frontMatterProperties } from '@/editor/source-buffer-blocks'
import { useRovingEditor } from '@/editor/use-roving-editor'
import { parseEmbedToken } from '@/lib/embed-token'
import { markdownReference } from '@/lib/i18n/markdown-reference'
import { parseInlineProperties } from '@/lib/inline-property-parse'
import { parseQueryExpression } from '@/lib/query-utils'
import { TASK_STATES } from '@/lib/task-states'

/** The schema types that are structure, not syntax a user types. */
const NOT_SYNTAX: Record<string, string> = {
  doc: 'root',
  pageBlock: 'wrapper',
  paragraph: 'plain',
  text: 'plain',
  listItem: 'list',
  tableRow: 'table',
  tableCell: 'table',
}

interface PMJson {
  type: string
  attrs?: Readonly<Record<string, unknown>>
  marks?: readonly PMJson[] | undefined
  content?: readonly PMJson[] | undefined
}

/** Every type the JSON holds, and `type.attr` for each attribute it sets. */
function producedTypes(node: PMJson, out = new Set<string>()): Set<string> {
  out.add(node.type)
  for (const [attr, value] of Object.entries(node.attrs ?? {})) {
    if (value != null) out.add(`${node.type}.${attr}`)
  }
  for (const child of [...(node.marks ?? []), ...(node.content ?? [])]) producedTypes(child, out)
  return out
}

function storedOf(entry: MarkdownReferenceEntry): string {
  return entry.stored ?? entry.typed
}

const blockParsed = MARKDOWN_REFERENCE.filter((entry) => entry.readBy !== 'frontMatter')

const readBy = (kind: MarkdownReferenceEntry['readBy']) =>
  MARKDOWN_REFERENCE.filter((entry) => entry.readBy === kind).map((e) => [e.id, e] as const)

const noItems = () => []

function schemaTypes(schema: Schema): string[] {
  return [...Object.keys(schema.nodes), ...Object.keys(schema.marks)]
}

describe('the Markdown reference', () => {
  it.each(blockParsed.map((entry) => [entry.id, entry] as const))(
    '%s parses to what it covers and round-trips',
    (_id, entry) => {
      const markdown = storedOf(entry)
      const doc = parse(markdown)
      expect([...producedTypes(doc)]).toEqual(expect.arrayContaining([...entry.covers]))
      expect(serialize(doc)).toBe(markdown)
    },
  )

  it.each(readBy('property'))('%s is a property line the save commits', (_id, entry) => {
    const [key, value] = entry.typed.split(':: ')
    expect(parseInlineProperties(entry.typed)).toEqual([{ key, value, lineIndex: 0 }])
  })

  it.each(readBy('frontMatter'))('%s is front matter Edit as Markdown reads', (_id, entry) => {
    const lines = entry.typed.split('\n')
    expect(frontMatterProperties(lines)).toHaveLength(lines.length - 2)
  })

  it.each(readBy('embed'))('%s is an embed token', (_id, entry) => {
    expect(parseEmbedToken(storedOf(entry))).not.toBeNull()
  })

  it.each(readBy('query'))('%s is a query block', (_id, entry) => {
    const stored = storedOf(entry)
    expect(stored.startsWith('{{query ') && stored.endsWith('}}')).toBe(true)
    expect(parseQueryExpression(stored.slice('{{query '.length, -'}}'.length)).type).not.toBe(
      'unknown',
    )
  })

  it.each(readBy('emoji'))('%s is the emoji its shortcode types', async (_id, entry) => {
    const dataset = await loadEmojiDataset()
    expect(dataset.byShortcode.get(entry.typed.slice(1, -1))).toBe(entry.stored)
  })

  it('documents every mark and node of both editors’ schemas', async () => {
    const roving = renderHook(() => useRovingEditor())
    await waitFor(() => expect(roving.result.current.editor).not.toBeNull())
    const blockMode = schemaTypes((roving.result.current.editor as Editor).schema)
    roving.unmount()
    const pageMode = schemaTypes(
      getSchema(
        pageModeExtensions({
          resolveTagName: (id) => id,
          resolveBlockTitle: (id) => id,
          resolveBlockStatus: () => 'active',
          resolveTagStatus: () => 'active',
          searchTags: noItems,
          searchPages: noItems,
          searchBlockRefs: noItems,
          onCreatePage: () => Promise.resolve(''),
          onCreateTag: () => Promise.resolve(''),
          onNavigate: () => {},
          onTagClick: () => {},
          placeholder: '',
        }),
      ),
    )
    const covered = new Set(MARKDOWN_REFERENCE.flatMap((entry) => entry.covers))
    const typesCovered = new Set([...covered].map((cover) => cover.split('.')[0]))
    const undocumented = [...new Set([...blockMode, ...pageMode])].filter(
      (type) => !typesCovered.has(type) && !Object.hasOwn(NOT_SYNTAX, type),
    )
    expect(undocumented).toEqual([])
  })

  it('documents every task state and callout type', () => {
    const states = new Set<unknown>()
    for (const entry of blockParsed) {
      for (const block of parse(storedOf(entry)).content ?? []) {
        if (block.type === 'paragraph') states.add(block.attrs?.todoState)
      }
    }
    expect(TASK_STATES.filter((state) => !states.has(state))).toEqual([])
    const callout = markdownReference[markdownReferenceKey('callout', 'description')] ?? ''
    expect(CALLOUT_TYPES.filter((type) => !callout.includes(type.toUpperCase()))).toEqual([])
  })

  it('has an English title and description for every entry, a heading for every group, and no other strings', () => {
    const keys = [
      ...MARKDOWN_REFERENCE_GROUPS.map(markdownReferenceGroupKey),
      ...MARKDOWN_REFERENCE.flatMap((entry) => [
        markdownReferenceKey(entry.id, 'title'),
        markdownReferenceKey(entry.id, 'description'),
      ]),
    ]
    expect(keys.filter((key) => !markdownReference[key]?.trim())).toEqual([])
    expect(Object.keys(markdownReference).toSorted()).toEqual(keys.toSorted())
  })

  it('has unique ids and puts every group to use', () => {
    const ids = MARKDOWN_REFERENCE.map((entry) => entry.id)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
    const used = new Set(MARKDOWN_REFERENCE.map((entry) => entry.group))
    expect(MARKDOWN_REFERENCE_GROUPS.filter((group) => !used.has(group))).toEqual([])
  })
})
