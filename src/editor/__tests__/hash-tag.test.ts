/**
 * #5160 D8 / N7: `#` in the block editor. The picker `#` opens, the tag a
 * typed `#name` makes, `#[[multi word]]`, and what stays text. The typed rule
 * reads names with `scanNameTokens`, so the vector rows that pin import and
 * paste pin it too.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { Editor } from '@tiptap/core'
import Code from '@tiptap/extension-code'
import CodeBlock from '@tiptap/extension-code-block'
import Document from '@tiptap/extension-document'
import Heading from '@tiptap/extension-heading'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import type { PluginKey } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AtTagPicker,
  atTagPickerPluginKey,
  completedTag,
  hashTagPickerPluginKey,
} from '@/editor/extensions/at-tag-picker'
import { BlockLink } from '@/editor/extensions/block-link'
import { BlockLinkPicker, blockLinkPickerPluginKey } from '@/editor/extensions/block-link-picker'
import { TagRef } from '@/editor/extensions/tag-ref'
import type { PickerItem } from '@/editor/SuggestionList'
import { logger } from '@/lib/logger'
import { scanNameTokens } from '@/lib/name-tokens'

// The popup is SuggestionList's, tested there. Here a picker's last props
// stand in for it: `command(item)` is what a tap, click or Enter on a row runs.
const rendered = vi.hoisted(() => ({
  props: new Map<unknown, { command: (item: PickerItem) => void; query: string }>(),
}))
vi.mock('@/editor/suggestion-renderer', () => ({
  createSuggestionRenderer: (_label: string, pluginKey: unknown) => ({
    onStart: (props: { command: (item: PickerItem) => void; query: string }) => {
      rendered.props.set(pluginKey, props)
    },
    onUpdate: (props: { command: (item: PickerItem) => void; query: string }) => {
      rendered.props.set(pluginKey, props)
    },
    onKeyDown: () => false,
    onExit: () => {
      rendered.props.delete(pluginKey)
    },
  }),
  cleanupOrphanedPopups: () => 0,
}))

const TAGS: PickerItem[] = [
  { id: 'TAG_PROJECT', label: 'Project' },
  { id: 'TAG_WORK', label: 'work' },
  { id: 'TAG_MULTI', label: 'Multi Word' },
]

let editor: Editor | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
  rendered.props.clear()
})

interface SetupOptions {
  items?: (query: string) => Promise<PickerItem[]>
  withCreate?: boolean
  block?: 'paragraph' | 'codeBlock'
  marks?: Array<{ type: string }>
}

function setup(text = '', options: SetupOptions = {}) {
  const tagItems = vi.fn(
    options.items ??
      (async (query: string) =>
        TAGS.filter((tag) => tag.label.toLowerCase().includes(query.toLowerCase()))),
  )
  const createTag = vi.fn(async (name: string) => `NEW_${name}`)
  const createPage = vi.fn(async (label: string) => `PAGE_${label}`)
  const pageItems = vi.fn(async (_query: string): Promise<PickerItem[]> => [])
  const node = text
    ? [{ type: 'text', text, ...(options.marks ? { marks: options.marks } : {}) }]
    : []
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      Code,
      CodeBlock,
      Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
      TagRef.configure({ resolveName: (id) => id }),
      BlockLink.configure({ resolveTitle: (id) => id }),
      AtTagPicker.configure(
        options.withCreate === false
          ? { items: tagItems }
          : { items: tagItems, onCreate: createTag },
      ),
      BlockLinkPicker.configure({ items: pageItems, onCreate: createPage }),
    ],
    content: { type: 'doc', content: [{ type: options.block ?? 'paragraph', content: node }] },
  })
  editor.commands.focus('end')
  return { editor, tagItems, createTag, createPage, pageItems }
}

/** Type `s` one character at a time through `handleTextInput`, as keystrokes do. */
function type(ed: Editor, s: string): void {
  const { view } = ed
  for (const ch of s) {
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    )
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to))
  }
}

function pressEnter(ed: Editor): boolean {
  const { view } = ed
  return (
    view.someProp('handleKeyDown', (f) =>
      f(view, new KeyboardEvent('keydown', { key: 'Enter' })),
    ) ?? false
  )
}

/** The first block's inline content: text as itself, a tag chip as `#id`, a link as `[[id]]`. */
function inline(ed: Editor): string[] {
  const out: string[] = []
  let afterText = false
  ed.state.doc.firstChild?.forEach((node) => {
    const id = node.attrs['id'] as string
    if (node.isText) out.push((afterText ? (out.pop() ?? '') : '') + (node.text ?? ''))
    else out.push(node.type.name === 'tag_ref' ? `#${id}` : `[[${id}]]`)
    afterText = node.isText
  })
  return out
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const pickerOpen = (ed: Editor, key: PluginKey = hashTagPickerPluginKey): boolean =>
  (key.getState(ed.state) as { active?: boolean } | undefined)?.active === true

describe('typing #name and a space or punctuation makes the tag (#5160 D8)', () => {
  it('resolves an existing tag case-insensitively and keeps the space after it', async () => {
    const { editor: ed, createTag } = setup()
    type(ed, '#project ')
    await vi.waitFor(() => expect(inline(ed)).toEqual(['#TAG_PROJECT', ' ']))
    expect(createTag).not.toHaveBeenCalled()
    // The caret is after the space, so typing goes on after the tag.
    type(ed, 'next')
    expect(inline(ed)).toEqual(['#TAG_PROJECT', ' next'])
  })

  it('creates the tag when none has the name', async () => {
    const { editor: ed, createTag } = setup('see ')
    type(ed, '#brandnew ')
    await vi.waitFor(() => expect(inline(ed)).toEqual(['see ', '#NEW_brandnew', ' ']))
    expect(createTag).toHaveBeenCalledTimes(1)
    expect(createTag).toHaveBeenCalledWith('brandnew')
    type(ed, 'x')
    expect(inline(ed)).toEqual(['see ', '#NEW_brandnew', ' x'])
  })

  it.each(['.', ',', '!', '?', ';', ')', ':'])(
    'punctuation %s ends the name and stays',
    async (p) => {
      const { editor: ed } = setup('see ')
      type(ed, `#work${p}`)
      await vi.waitFor(() => expect(inline(ed)).toEqual(['see ', '#TAG_WORK', p]))
    },
  )

  it('reads the name by the shared rule: `#v1.2` is the tag v1, `#Q&A` the tag Q', async () => {
    const { editor: ed, createTag } = setup()
    type(ed, '#v1.2 #Q&A ')
    await vi.waitFor(() => expect(inline(ed)).toEqual(['#NEW_v1', '.2 ', '#NEW_Q', '&A ']))
    expect(createTag.mock.calls).toEqual([['v1'], ['Q']])
  })

  it('keeps a combining mark in the name', async () => {
    const { editor: ed, createTag } = setup()
    type(ed, '#cafe\u0301 ')
    await vi.waitFor(() => expect(inline(ed)).toEqual(['#NEW_cafe\u0301', ' ']))
    expect(createTag).toHaveBeenCalledWith('cafe\u0301')
  })

  it('puts the typed text back when the lookup fails, the caret after the terminator', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const { editor: ed, createTag } = setup('', {
      items: () => Promise.reject(new Error('lookup failed')),
    })
    type(ed, '#project ')
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'AtTagPicker',
        'Failed to resolve tag via input rule, falling back to plain text',
        { text: 'project' },
        expect.any(Error),
      ),
    )
    await settle()
    expect(inline(ed)).toEqual(['#project '])
    expect(createTag).not.toHaveBeenCalled()
    type(ed, 'x')
    expect(inline(ed)).toEqual(['#project x'])
    warn.mockRestore()
  })

  it('puts the typed text back when there is no match and no create', async () => {
    // `#[[…]]` opens no picker, so the one lookup is the typed rule's.
    const { editor: ed, tagItems } = setup('', { withCreate: false })
    type(ed, '#[[no such]]')
    await vi.waitFor(() => expect(tagItems.mock.calls).toEqual([['no such']]))
    await settle()
    expect(inline(ed)).toEqual(['#[[no such]]'])
    type(ed, 'x')
    expect(inline(ed)).toEqual(['#[[no such]]x'])
  })

  it('puts `#name` back before its terminator when there is no match and no create', async () => {
    const { editor: ed } = setup('', { withCreate: false })
    type(ed, '#nosuch.')
    await settle()
    expect(inline(ed)).toEqual(['#nosuch.'])
    type(ed, 'x')
    expect(inline(ed)).toEqual(['#nosuch.x'])
  })

  it('makes the tag when an IME composition commits `#name `, keeping the space', async () => {
    const { editor: ed } = setup('see ')
    // A composition writes the text to the document without `handleTextInput`;
    // TipTap runs the input rules once it ends.
    ed.view.dispatch(ed.state.tr.insertText('#project '))
    ed.view.someProp('handleDOMEvents', (handlers) => {
      handlers.compositionend?.(ed.view, new Event('compositionend') as CompositionEvent)
    })
    await vi.waitFor(() => expect(inline(ed)).toEqual(['see ', '#TAG_PROJECT', ' ']))
    type(ed, 'x')
    expect(inline(ed)).toEqual(['see ', '#TAG_PROJECT', ' x'])
  })

  it('replaces a selection the terminator is typed over', async () => {
    const { editor: ed } = setup('#projectold')
    ed.commands.setTextSelection({ from: 9, to: 12 })
    type(ed, ' ')
    await vi.waitFor(() => expect(inline(ed)).toEqual(['#TAG_PROJECT', ' ']))
    type(ed, 'x')
    expect(inline(ed)).toEqual(['#TAG_PROJECT', ' x'])
  })

  it('leaves Enter to the picker or the block', async () => {
    const { editor: ed, createTag } = setup()
    type(ed, '#project')
    pressEnter(ed)
    await settle()
    expect(inline(ed)).toEqual(['#project'])
    expect(createTag).not.toHaveBeenCalled()
  })
})

describe('#[[multi word]] makes the tag (#5160 N7)', () => {
  it('creates the tag `multi word`, with no stray bracket and no page', async () => {
    const { editor: ed, createTag, createPage } = setup('see ')
    type(ed, '#[[deep work]]')
    await vi.waitFor(() => expect(inline(ed)).toEqual(['see ', '#NEW_deep work']))
    expect(createTag.mock.calls).toEqual([['deep work']])
    expect(createPage).not.toHaveBeenCalled()
  })

  it('resolves an existing tag by its whole name, case-insensitively', async () => {
    const { editor: ed, createTag } = setup()
    type(ed, '#[[multi word]] ')
    await vi.waitFor(() => expect(inline(ed)).toEqual(['#TAG_MULTI', ' ']))
    expect(createTag).not.toHaveBeenCalled()
  })

  it('does not open the [[ page picker after a #', () => {
    const { editor: ed } = setup()
    type(ed, '#[[deep')
    expect(pickerOpen(ed, blockLinkPickerPluginKey)).toBe(false)
    expect(pickerOpen(ed)).toBe(false)
  })

  it('still opens the [[ page picker and links [[Page]] without a #', async () => {
    const { editor: ed, createPage, createTag } = setup('see ')
    type(ed, '[[deep')
    expect(pickerOpen(ed, blockLinkPickerPluginKey)).toBe(true)
    type(ed, ' work]]')
    await vi.waitFor(() => expect(inline(ed)).toEqual(['see ', '[[PAGE_deep work]]']))
    expect(createPage).toHaveBeenCalledWith('deep work')
    expect(createTag).not.toHaveBeenCalled()
  })
})

describe('what stays text (#5160 D8)', () => {
  it.each([
    ['an issue number', 'fixes #42 '],
    ['a # after a word character', 'a#b '],
    ['a scheme-less URL fragment', 'x.com/#install '],
    ['a URL fragment', 'see https://x.dev/#setup '],
    ['a link destination', '[docs](#setup)'],
    ['a link destination still being typed', '[docs](#v1.2'],
    ['an HTML entity', 'it&#39;s &#x27; '],
    ['an escaped hash', '\\#tag '],
    ['a # in an inline-code span still being typed', '`#endif '],
    ['a # in a [[link]] still being typed', '[[Project #alpha,'],
    ['a Logseq priority', '[#A] '],
    ['an escaped #[[x]]', '\\#[[x]]'],
  ])('%s: %s', async (_name, typed) => {
    const { editor: ed, tagItems, createTag, createPage } = setup()
    type(ed, typed)
    await settle()
    expect(inline(ed)).toEqual([typed])
    expect(tagItems).not.toHaveBeenCalled()
    expect(createTag).not.toHaveBeenCalled()
    expect(createPage).not.toHaveBeenCalled()
  })

  it('a # in a code block', async () => {
    const { editor: ed, tagItems, createTag } = setup('x ', { block: 'codeBlock' })
    type(ed, '#endif')
    expect(pickerOpen(ed)).toBe(false)
    type(ed, ' ')
    await settle()
    expect(ed.state.doc.firstChild?.textContent).toBe('x #endif ')
    expect(tagItems).not.toHaveBeenCalled()
    expect(createTag).not.toHaveBeenCalled()
  })

  it('a # in inline code', async () => {
    const { editor: ed, tagItems, createTag } = setup('run ', { marks: [{ type: 'code' }] })
    type(ed, '#endif')
    expect(pickerOpen(ed)).toBe(false)
    type(ed, ' ')
    await settle()
    expect(inline(ed)).toEqual(['run #endif '])
    // The typing stayed inside the code mark, so this is the inline-code case.
    expect(ed.state.doc.firstChild?.lastChild?.marks.map((m) => m.type.name)).toEqual(['code'])
    expect(tagItems).not.toHaveBeenCalled()
    expect(createTag).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3, 6])('%d # and a space at block start still make a heading', async (level) => {
    const { editor: ed, tagItems } = setup()
    type(ed, `${'#'.repeat(level)} Title`)
    await settle()
    const block = ed.state.doc.firstChild
    expect(block?.type.name).toBe('heading')
    expect(block?.attrs['level']).toBe(level)
    expect(block?.textContent).toBe('Title')
    expect(tagItems).not.toHaveBeenCalled()
  })
})

describe('the # picker (#5160 D8)', () => {
  it.each([
    ['at block start', '', '#pro'],
    ['after a space', 'see ', '#pro'],
    ['after a no-break space', 'see\u00A0', '#pro'],
  ])('opens %s, searching the name', async (_name, before, typed) => {
    const { editor: ed, tagItems } = setup(before)
    type(ed, typed)
    expect(pickerOpen(ed)).toBe(true)
    await vi.waitFor(() => expect(tagItems).toHaveBeenCalledWith('pro'))
  })

  it.each([
    ['after a word character', 'a#pro'],
    ['after a slash', 'x.com/#pro'],
    ['after an ampersand', '&#pro'],
    ['after a backslash', '\\#pro'],
    ['on a bare #', '#'],
    ['on a # run', '###'],
    ['on an issue number', '#42'],
    ['in an inline-code span being typed', '`run #pro'],
    ['in a [[link]] being typed', '[[Project #pro'],
  ])('stays shut %s', async (_name, typed) => {
    const { editor: ed, tagItems } = setup()
    type(ed, typed)
    expect(pickerOpen(ed)).toBe(false)
    await settle()
    expect(tagItems).not.toHaveBeenCalled()
  })

  it('closes on punctuation, where the typed tag takes over', async () => {
    const { editor: ed } = setup()
    type(ed, '#work')
    expect(pickerOpen(ed)).toBe(true)
    type(ed, '.')
    expect(pickerOpen(ed)).toBe(false)
    await vi.waitFor(() => expect(inline(ed)).toEqual(['#TAG_WORK', '.']))
  })

  it('picks an existing tag: the chip replaces the typed #query', async () => {
    const { editor: ed } = setup('see ')
    type(ed, '#pro')
    await vi.waitFor(() => expect(rendered.props.get(hashTagPickerPluginKey)).toBeDefined())
    rendered.props.get(hashTagPickerPluginKey)?.command({ id: 'TAG_PROJECT', label: 'Project' })
    expect(inline(ed)).toEqual(['see ', '#TAG_PROJECT'])
  })

  it('creates the tag from the create row', async () => {
    const { editor: ed, createTag } = setup()
    type(ed, '#fresh')
    await vi.waitFor(() => expect(rendered.props.get(hashTagPickerPluginKey)).toBeDefined())
    rendered.props
      .get(hashTagPickerPluginKey)
      ?.command({ id: '__create__', label: 'fresh', isCreate: true })
    await vi.waitFor(() => expect(inline(ed)).toEqual(['#NEW_fresh']))
    expect(createTag).toHaveBeenCalledWith('fresh')
  })

  it('keeps text typed during the create after the tag, and the caret after that text', async () => {
    let finishCreate = (): void => {}
    const { editor: ed, createTag } = setup('see ')
    createTag.mockImplementation(
      (name) => new Promise((resolve) => (finishCreate = () => resolve(`NEW_${name}`))),
    )
    type(ed, '#fresh')
    await vi.waitFor(() => expect(rendered.props.get(hashTagPickerPluginKey)).toBeDefined())
    rendered.props
      .get(hashTagPickerPluginKey)
      ?.command({ id: '__create__', label: 'fresh', isCreate: true })
    type(ed, ' and')
    finishCreate()
    await vi.waitFor(() => expect(inline(ed)).toEqual(['see ', '#NEW_fresh', ' and']))
    type(ed, 'x')
    expect(inline(ed)).toEqual(['see ', '#NEW_fresh', ' andx'])
  })

  it('puts #query back before text typed during a failed create, the caret after that text', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    let failCreate = (): void => {}
    const { editor: ed, createTag } = setup('see ')
    createTag.mockImplementation(
      () => new Promise((_resolve, reject) => (failCreate = () => reject(new Error('down')))),
    )
    type(ed, '#fresh')
    await vi.waitFor(() => expect(rendered.props.get(hashTagPickerPluginKey)).toBeDefined())
    rendered.props
      .get(hashTagPickerPluginKey)
      ?.command({ id: '__create__', label: 'fresh', isCreate: true })
    type(ed, ' and')
    failCreate()
    await vi.waitFor(() => expect(inline(ed)).toEqual(['see #fresh and']))
    type(ed, 'x')
    expect(inline(ed)).toEqual(['see #fresh andx'])
    error.mockRestore()
  })

  it('leaves the @ picker working', async () => {
    const { editor: ed, tagItems } = setup('see ')
    type(ed, '@pro')
    expect(pickerOpen(ed, atTagPickerPluginKey)).toBe(true)
    expect(pickerOpen(ed)).toBe(false)
    await vi.waitFor(() => expect(tagItems).toHaveBeenCalledWith('pro'))
  })
})

describe('completedTag', () => {
  it('returns the name, the token as typed and the terminator after it', () => {
    expect(completedTag('see #project,')).toEqual({
      name: 'project',
      typed: '#project',
      terminator: ',',
    })
    expect(completedTag('#[[deep work]]')).toEqual({
      name: 'deep work',
      typed: '#[[deep work]]',
      terminator: '',
    })
  })

  it('returns null while the name is still being typed, and for Enter', () => {
    expect(completedTag('#project')).toBeNull()
    expect(completedTag('#project-')).toBeNull()
    expect(completedTag('#project\n')).toBeNull()
    expect(completedTag('#[[deep work]')).toBeNull()
    expect(completedTag('')).toBeNull()
  })

  it('takes a whole code point as the terminator', () => {
    expect(completedTag('#go\u{1F680}')).toEqual({
      name: 'go',
      typed: '#go',
      terminator: '\u{1F680}',
    })
  })
})

// ── One rule: the typed tags are the tags import and paste read ──────────

interface VectorRow {
  name: string
  input: string
  isCode?: boolean
}

const vectors = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'conformance',
      'reference-tokens.vectors.json',
    ),
    'utf8',
  ),
) as { nameRuleCases: VectorRow[]; cases: VectorRow[] }

/** The tag names typing `input` and then a space makes, one keystroke at a time. */
function typedTagNames(input: string): string[] {
  const names = new Set<string>()
  let text = ''
  for (const ch of `${input} `) {
    text += ch
    const tag = completedTag(text)
    if (tag) names.add(tag.name)
  }
  return [...names].toSorted()
}

const scannedTagNames = (input: string): string[] =>
  [...new Set(scanNameTokens(input).flatMap((t) => (t.kind === 'tag' ? [t.name] : [])))].toSorted()

describe('the typed rule agrees with the shared name rule (#5160 D8)', () => {
  const rows = [...vectors.nameRuleCases, ...vectors.cases.filter((row) => !row.isCode)]
  it.each(rows.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    expect(typedTagNames(row.input)).toEqual(scannedTagNames(row.input))
  })

  it('covers a scheme-less URL row', () => {
    expect(rows.some((row) => row.input.includes('x.com/#install'))).toBe(true)
  })
})
