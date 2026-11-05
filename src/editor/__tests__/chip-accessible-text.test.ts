/**
 * #5745 S3 — the roving editor's chips speak the words they show, as the
 * static chips do (`RichContentRenderer/marks/__tests__/accessible-text`), so
 * a block reads the same to a screen reader whether it is focused or not.
 */
import { Editor, type JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it } from 'vitest'

import { BlockLink } from '@/editor/extensions/block-link'
import { BlockRef } from '@/editor/extensions/block-ref'
import { TagRef } from '@/editor/extensions/tag-ref'

const PAGE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const TAG_ID = '01CRZ3NDEKTSV4RRFFQ69G5FAV'
const BLOCK_ID = '01NRZ3NDEKTSV4RRFFQ69G5FAV'
const FULL_ULID = /[0-9A-HJKMNP-TV-Z]{26}/

let editor: Editor | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
})

interface Resolvers {
  title?: (id: string) => string
  status?: (id: string) => 'active' | 'deleted'
  tag?: (id: string) => string
  content?: (id: string) => string
}

function mount(inline: JSONContent, resolvers: Resolvers = {}): HTMLElement {
  const element = document.createElement('div')
  document.body.append(element)
  editor = new Editor({
    element,
    extensions: [
      Document,
      Paragraph,
      Text,
      BlockLink.configure({
        ...(resolvers.title ? { resolveTitle: resolvers.title } : {}),
        ...(resolvers.status ? { resolveStatus: resolvers.status } : {}),
      }),
      TagRef.configure(resolvers.tag ? { resolveName: resolvers.tag } : {}),
      BlockRef.configure(resolvers.content ? { resolveContent: resolvers.content } : {}),
    ],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [inline] }] },
  })
  const chip = element.querySelector<HTMLElement>('[data-testid$="-chip"]')
  if (chip === null) throw new Error(`no chip rendered for ${JSON.stringify(inline)}`)
  return chip
}

function expectSpeaksWhatItShows(chip: HTMLElement, shown: string): void {
  expect(chip.textContent).toBe(shown)
  const spoken = chip.getAttribute('aria-label') ?? chip.textContent
  expect(spoken.slice(0, shown.length)).toBe(shown)
  expect(spoken).not.toMatch(FULL_ULID)
}

const link = (label: string | null = null): JSONContent => ({
  type: 'block_link',
  attrs: { id: PAGE_ID, label },
})

describe('editor chips speak what they show', () => {
  it('a page link reads its title', () => {
    expectSpeaksWhatItShows(mount(link(), { title: () => 'Roadmap' }), 'Roadmap')
  })

  it('a labelled page link reads its label', () => {
    expectSpeaksWhatItShows(mount(link('My label'), { title: () => 'Roadmap' }), 'My label')
  })

  it('a deleted labelled page link reads its label, then what a click does', () => {
    const chip = mount(link('My label'), { title: () => 'Roadmap', status: () => 'deleted' })
    expectSpeaksWhatItShows(chip, 'My label')
  })

  it('an unresolved page link reads the id prefix it shows', () => {
    expectSpeaksWhatItShows(mount(link()), `[[${PAGE_ID.slice(0, 8)}...]]`)
  })

  it('a tag reads its name', () => {
    const tag = { type: 'tag_ref', attrs: { id: TAG_ID } }
    expectSpeaksWhatItShows(mount(tag, { tag: () => '#work' }), '#work')
  })

  it('an unresolved tag reads the id prefix it shows', () => {
    expectSpeaksWhatItShows(
      mount({ type: 'tag_ref', attrs: { id: TAG_ID } }),
      `#${TAG_ID.slice(0, 8)}...`,
    )
  })

  it('a block ref reads its title', () => {
    const ref = { type: 'block_ref', attrs: { id: BLOCK_ID } }
    expectSpeaksWhatItShows(mount(ref, { content: () => 'Call the bank' }), 'Call the bank')
  })
})
