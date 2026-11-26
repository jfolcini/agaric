// ---------------------------------------------------------------------------
// "Show Markdown syntax around the cursor" in page mode on the real backend
// (#5974).
//
// With the preference on, page mode draws a mark's `**` markers beside the
// caret as widgets. ProseMirror reads WebKitGTK's contenteditable DOM back
// into the one page document as the user types, so this WebView is where a
// marker could leak into a block's saved text, and where Backspace after a
// marker at a block's start could join the block into the one above instead
// of removing the mark. Type a bold word at the start of a second block,
// delete its opening marker with Backspace, leave the page and come back: the
// stored blocks are still two, the first untouched, the second's text with the
// bold gone and no marker.
//
// The same preference in the block editor (#5689): type with the markers
// drawn, change a heading's level through its `#` run, draw a link's brackets
// and URL, and the syntax beside a page link chip (#5974), a widget next to a
// contenteditable=false atom where WebKitGTK places the caret and the typed
// text; after a round trip the stored blocks hold the formatting, the level,
// the link and the text right of the chip, and no marker.
//
// Two WebKitGTK geometry checks share the file. One click on a link chip in the
// block just below the edited one follows the link (#5723, #5807): the desktop
// formatting toolbar sits above the edited text, and had the block left edit
// mode on the press, the chip would move up by the toolbar's height and the
// release would land beside it (Chromium twin: `e2e/editor-lifecycle.spec.ts`).
// And a block's gutter controls centre on the first line of its text in both
// modes at the medium and large font sizes, as WebKitGTK's font metrics are
// not Chromium's (`e2e/gutter-alignment.spec.ts` is the mock pair). The gutter
// suite sets the font size for the rest of the WebView's life, so it runs last.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  importMarkdownPage,
  invoke,
  navigateTo,
  openJournalBlockEditor,
  openNewPage,
  openPageTitled,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  typeVerified,
  waitForAppReady,
} from './helpers'
import {
  PAGE_MODE,
  chooseEditMode,
  pageModeBlocks,
  pageModeCaret,
  typeInPageMode,
} from './page-mode'

const FIRST = runScopedMarker('wdio-pmr-first')
const SECOND = runScopedMarker('wdio-pmr-second')
const MARKERS = '[data-testid="md-reveal-marker"]'

const MARKER = runScopedMarker('wdio-reveal')
const HEADING = runScopedMarker('wdio-level')
const LINKED = runScopedMarker('wdio-url')
const CHIPPED = runScopedMarker('wdio-chip')
const HREF = 'https://example.com'
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const TYPED = `${MARKER} **bold** and *it* end`
const SHOWN = `${MARKER} bold and it end`

const SOURCE = runScopedMarker('wdio-chip-source')
const TARGET = runScopedMarker('wdio-chip-target')
const EDITED = runScopedMarker('wdio-chip-edited')
const CHIP_TYPED = runScopedMarker('wdio-chip-typed')

const GUTTER_TITLE = runScopedMarker('wdio-gutter-align')
const GUTTER_ROWS = 10

interface Rows {
  focused: string
  unfocused: string
  plain: string
  heading: string
  h1: string
  h6: string
}

async function turnRevealOn(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-editor')
  await tab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await tab.click()
  const toggle = $('#reveal-markdown-toggle')
  await toggle.waitForClickable({ timeout: ACTION_TIMEOUT })
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
  await browser.waitUntil(async () => (await toggle.getAttribute('aria-checked')) === 'true', {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'the "Show Markdown syntax around the cursor" switch never turned on',
  })
}

async function waitForMarkers(count: number, when: string): Promise<void> {
  await browser.waitUntil(async () => (await $$(MARKERS).getElements()).length === count, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `${when}, the page did not draw ${count} Markdown markers`,
  })
}

function boldCount(): Promise<number> {
  return browser.execute(
    (selector: string) => document.querySelectorAll(`${selector} strong`).length,
    PAGE_MODE,
  )
}

/**
 * The editor's text with its bold, italic, heading level and links written
 * back as Markdown, so `typeVerified` can compare it with the keys typed.
 * Drawn markers are widgets, not text, so they are left out; a marker that
 * leaked into the text stays in.
 */
async function typedMarkdown(selector: string): Promise<string> {
  return browser.execute((sel: string) => {
    const copy = document.querySelector(sel)?.cloneNode(true) as HTMLElement | undefined
    if (!copy) return ''
    for (const marker of copy.querySelectorAll('[data-testid="md-reveal-marker"]')) marker.remove()
    for (const bold of copy.querySelectorAll('strong')) bold.textContent = `**${bold.textContent}**`
    for (const italic of copy.querySelectorAll('em')) italic.textContent = `*${italic.textContent}*`
    for (const link of copy.querySelectorAll('a')) {
      link.textContent = `[${link.textContent}](${link.getAttribute('href')})`
    }
    for (const heading of copy.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      heading.textContent = `${'#'.repeat(Number(heading.tagName.slice(1)))} ${heading.textContent}`
    }
    return copy.textContent ?? ''
  }, selector)
}

/** Put the caret `offset` characters into the text node that reads `text`, through the editor's own API. */
async function caretInto(text: string, offset: number): Promise<void> {
  await browser.execute(
    (sel: string, wanted: string, by: number) => {
      interface TextNode {
        isText: boolean
        text?: string
      }
      const el = document.querySelector(sel) as HTMLElement & {
        editor: {
          state: { doc: { descendants: (f: (node: TextNode, pos: number) => void) => void } }
          commands: { setTextSelection: (pos: number) => boolean }
        }
      }
      let at = -1
      el.editor.state.doc.descendants((node, pos) => {
        if (at < 0 && node.isText && node.text === wanted) at = pos + by
      })
      el.editor.commands.setTextSelection(at)
    },
    EDITOR,
    text,
    offset,
  )
}

async function pageTitle(): Promise<string> {
  return $('[aria-label="Page title"]').getText()
}

async function seed(): Promise<Rows> {
  const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
  const space = (spaces.find((s) => s.name === 'Personal') ?? spaces[0])?.id
  const create = async (parentId: string, content: string): Promise<string> =>
    (
      await invoke<{ id: string }>('create_block', {
        blockType: 'content',
        content,
        parentId,
        index: null,
        scope: { kind: 'active', space_id: space },
        blockId: null,
      })
    ).id
  const target = await invoke<string>('create_page_in_space', {
    parentId: null,
    content: runScopedMarker('wdio-gutter-target'),
    spaceId: space,
  })
  const pageId = await invoke<string>('create_page_in_space', {
    parentId: null,
    content: GUTTER_TITLE,
    spaceId: space,
  })
  const focused = await create(pageId, `[[${target}]]`)
  const unfocused = await create(pageId, `[[${target}]]`)
  const plain = await create(pageId, 'Plain parent')
  await create(plain, 'child')
  const heading = await create(pageId, '## Heading parent')
  await create(heading, 'child')
  const h1 = await create(pageId, '# Heading one')
  await create(h1, 'child')
  const h6 = await create(pageId, '###### Heading six')
  await create(h6, 'child')
  for (const blockId of [focused, unfocused]) {
    await invoke('set_todo_state', { blockId, state: 'TODO' })
  }
  return { focused, unfocused, plain, heading, h1, h6 }
}

function setFontSize(size: string): Promise<void> {
  return browser.execute(
    (px: string) => document.documentElement.style.setProperty('--agaric-font-size', px),
    size,
  )
}

/**
 * Each control's vertical centre minus the centre of the first line of the
 * row's text, in px. Page mode's one grip sits outside the row.
 */
function offsets(row: string, mode: 'block' | 'page'): Promise<Record<string, number>> {
  return browser.execute(
    (selector: string, editingMode: string) => {
      const el = document.querySelector(selector)
      if (el === null) throw new Error(`no row ${selector}`)
      const middle = (box: DOMRect): number => box.top + box.height / 2
      const text = el.querySelector(
        '.page-block-content, .ProseMirror, [data-testid="block-static"]',
      )
      if (text === null) throw new Error('no text')
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
      })
      const first = walker.nextNode()
      if (first === null) throw new Error('no text node')
      const range = document.createRange()
      range.selectNodeContents(first)
      const line = range.getClientRects()[0]
      if (line === undefined) throw new Error('no line box')
      const own = (sel: string): Element | undefined =>
        [...el.querySelectorAll(sel)].find(
          (control) => control.closest('[data-page-block], [data-testid="sortable-block"]') === el,
        )
      const controls: Record<string, Element | null | undefined> = {
        grip:
          editingMode === 'page'
            ? document.querySelector('[data-page-grip] svg')
            : own('[data-testid="drag-handle"] svg'),
        chevron: own('[data-testid="collapse-toggle"] svg'),
        checkbox: own('.task-checkbox'),
      }
      const out: Record<string, number> = {}
      for (const [name, control] of Object.entries(controls)) {
        if (control) out[name] = middle(control.getBoundingClientRect()) - middle(line)
      }
      return out
    },
    row,
    mode,
  )
}

function expectCentred(
  found: Record<string, number>,
  expected: readonly string[],
  what: string,
): void {
  expect(Object.keys(found).toSorted()).toEqual([...expected].toSorted())
  for (const [name, offset] of Object.entries(found)) {
    if (Math.abs(offset) > 1)
      throw new Error(`${what}: the ${name} is ${offset}px off the first line`)
  }
}

describe('Markdown syntax revealed around the cursor in page mode on the real backend (#5974) @editor @markdown @pages', () => {
  it('Backspace after a marker at a block’s start removes the bold without a join, and it is saved', async () => {
    await waitForAppReady()
    await turnRevealOn()
    await openNewPage()
    await typeMarkerVerified(FIRST)
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')

    // A second block, whose text opens with a bold word.
    await pageModeCaret(0, 'end')
    await browser.keys(['Enter'])
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 2, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Enter did not make a second block',
    })
    await typeInPageMode(`**bold** ${SECOND}`, 1, `bold ${SECOND}`)
    expect(await boldCount()).toBe(1)

    // The caret at the second block's start is inside the bold: both markers show.
    await pageModeCaret(1, 0)
    await waitForMarkers(2, 'with the caret in the bold word')
    await browser.keys(['Backspace'])
    await browser.waitUntil(async () => (await boldCount()) === 0, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Backspace after the opening marker did not remove the bold',
    })
    const blocks = await pageModeBlocks()
    expect(blocks.map((block) => block.text)).toEqual([FIRST, `bold ${SECOND}`])

    // Away and back: the backend holds two blocks, the second without the bold or any marker.
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    const second = blockStaticByMarker(SECOND)
    await second.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(second).toHaveText(`bold ${SECOND}`)
    await expect(second.$('strong')).not.toExist()
    await blockStaticByMarker(FIRST).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(blockStaticByMarker(FIRST)).toHaveText(FIRST)
  })

  it('saves bold and italic typed with the markers drawn, and no marker', async () => {
    await waitForAppReady()
    await turnRevealOn()
    await navigateTo('Journal')

    await openJournalBlockEditor()
    await typeVerified(EDITOR, TYPED, typedMarkdown, 'block editor')
    const editor = $(EDITOR)
    await expect(editor.$('strong')).toHaveText('bold')
    await expect(editor.$('em')).toHaveText('it')

    // The preference is live in this WebView: the caret in the bold word draws its markers.
    await caretInto('bold', 2)
    await browser.waitUntil(
      async () => (await $$('[data-testid="md-reveal-marker"]').getElements()).length === 2,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the caret in bold text drew no Markdown markers' },
    )
    await browser.keys(['Escape'])

    await navigateTo('Pages')
    await navigateTo('Journal')
    const stored = blockStaticByMarker(MARKER)
    await stored.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(stored).toHaveText(SHOWN)
    await expect(stored.$('strong')).toHaveText('bold')
    await expect(stored.$('em')).toHaveText('it')
  })

  it('saves a heading level changed through its # run and a link whose syntax was drawn', async () => {
    await waitForAppReady()
    await turnRevealOn()
    await navigateTo('Journal')

    // `## HEADING heading`, then left of its `#` run, where `#` raises it to level 3.
    await openJournalBlockEditor()
    await typeVerified(EDITOR, `## ${HEADING} heading`, typedMarkdown, 'block editor')
    await $(EDITOR).$('h2').waitForExist({ timeout: ACTION_TIMEOUT })
    await caretInto(`${HEADING} heading`, 0)
    await browser.keys(['ArrowLeft'])
    await browser.keys(['#'])
    await $(EDITOR).$('h3').waitForExist({
      timeout: ACTION_TIMEOUT,
      timeoutMsg: '# typed left of the heading’s # run did not raise it to level 3',
    })
    await browser.keys(['Escape'])

    // A link, then the caret in its label, which draws its brackets and URL.
    await openJournalBlockEditor()
    await typeVerified(EDITOR, `${LINKED} see [label](${HREF}) end`, typedMarkdown, 'block editor')
    await caretInto('label', 2)
    await browser.waitUntil(
      async () => (await $$('[data-testid="md-reveal-marker"]').getElements()).length === 2,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the caret in a link label drew no brackets' },
    )
    await browser.keys(['Escape'])

    await navigateTo('Pages')
    await navigateTo('Journal')
    const heading = blockStaticByMarker(HEADING)
    await heading.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(heading.$('h3')).toHaveText(`${HEADING} heading`)
    const linked = blockStaticByMarker(LINKED)
    await linked.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await linked.getText()).not.toContain('](')
    await expect(linked.$('[data-testid="external-link"]')).toHaveAttribute('data-href', HREF)
  })

  it('draws a page link chip’s syntax, and text typed right of the chip is saved after its token', async () => {
    await waitForAppReady()
    await turnRevealOn()
    const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
    const space = spaces.find((s) => s.name === 'Personal') ?? spaces[0]
    const target = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: runScopedMarker('wdio-target'),
      spaceId: space?.id,
    })
    await navigateTo('Journal')

    await openJournalBlockEditor()
    await typeVerified(EDITOR, `${CHIPPED} see`, typedMarkdown, 'block editor')
    // The chip goes in at the end of the text, with the caret right of it.
    await browser.execute(
      (sel: string, id: string) => {
        const el = document.querySelector(sel) as HTMLElement & {
          editor: { chain: () => { insertBlockLink: (id: string) => { run: () => boolean } } }
        }
        el.editor.chain().insertBlockLink(id).run()
      },
      EDITOR,
      target,
    )
    await browser.waitUntil(
      async () => (await $$('[data-testid="md-reveal-chip-marker"]').getElements()).length === 2,
      {
        timeout: ACTION_TIMEOUT,
        timeoutMsg: 'the caret beside a page link chip drew no `[[` `]]`',
      },
    )
    const drawn = await $$('[data-testid="md-reveal-chip-marker"]').map((el) => el.getText())
    expect(drawn).toEqual(['[[', ']]'])
    await browser.keys(['x'])
    await browser.keys(['Escape'])

    await navigateTo('Pages')
    await navigateTo('Journal')
    const stored = blockStaticByMarker(CHIPPED)
    await stored.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const blockId = await stored.getAttribute('data-block-id')
    const { content } = await invoke<{ content: string }>('get_block', { blockId })
    expect(content).toContain(`[[${target}]]`)
    expect(content.replace(`[[${target}]]`, '')).toBe(`${CHIPPED} seex`)
  })

  it('one click on a link chip in the block below the edited one follows it (#5807)', async () => {
    await waitForAppReady()
    expect(await importMarkdownPage(SOURCE, `${EDITED}\n\nsee [[${TARGET}]]\n`)).toContain(
      '2 blocks',
    )
    await reopenPageByTitle(SOURCE)

    const edited = $(`[data-testid="block-static"]*=${EDITED}`)
    await edited.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const editedId = await edited.getAttribute('data-block-id')
    await edited.click()
    await $('[data-testid="block-editor"] [contenteditable="true"]').waitForDisplayed({
      timeout: ACTION_TIMEOUT,
    })
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
    await typeMarkerVerified(CHIP_TYPED)
    await $('[data-testid="formatting-toolbar"]').waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // While the first block is edited, the only static block is the one below.
    const chip = $('[data-testid="block-static"] [data-testid="block-link-chip"]')
    await chip.waitForClickable({ timeout: ACTION_TIMEOUT })
    await chip.click()

    await browser.waitUntil(async () => (await pageTitle()) === TARGET, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `one click on the chip did not open ${TARGET}`,
    })

    // The press saved the edit before the link was followed.
    await reopenPageByTitle(SOURCE)
    const saved = $(`[data-testid="block-static"][data-block-id="${editedId}"]`)
    await saved.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await browser.waitUntil(async () => (await saved.getText()) === CHIP_TYPED, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the edited block does not read ${CHIP_TYPED} after the round trip`,
    })
  })

  describe('gutter controls centre on the first line of the text', () => {
    let rows: Rows

    before(async () => {
      await waitForAppReady()
      rows = await seed()
      await openPageTitled(GUTTER_TITLE)
    })

    it('in block mode, at the medium and large font sizes', async () => {
      await chooseEditMode('Blocks')
      await browser.waitUntil(
        async () =>
          (await $$('[data-testid="sortable-block"]').getElements()).length === GUTTER_ROWS,
        { timeout: ACTION_TIMEOUT, timeoutMsg: `the page never showed its ${GUTTER_ROWS} blocks` },
      )
      const cases = [
        [rows.unfocused, ['grip', 'checkbox']],
        [rows.plain, ['grip', 'chevron']],
        [rows.heading, ['grip', 'chevron']],
        [rows.h1, ['grip', 'chevron']],
        [rows.h6, ['grip', 'chevron']],
      ] as const
      for (const size of ['16px', '18px']) {
        await setFontSize(size)
        for (const [id, controls] of cases) {
          const row = `[data-testid="sortable-block"][data-block-id="${id}"]`
          await $(row).moveTo()
          expectCentred(await offsets(row, 'block'), controls, `block mode, ${size}`)
        }
      }
    })

    it('in page mode, with the cursor in a link showing its source', async () => {
      await chooseEditMode('Page')
      await pageModeCaret(0, 1)
      const row = (id: string) => `${PAGE_MODE} [data-page-block-id="${id}"]`
      await browser.waitUntil(async () => (await $(row(rows.focused)).getText()).includes('[['), {
        timeout: ACTION_TIMEOUT,
        timeoutMsg: 'the link the cursor is in never showed its source',
      })
      const cases = [
        [rows.focused, ['grip', 'checkbox']],
        [rows.unfocused, ['grip', 'checkbox']],
        [rows.plain, ['grip', 'chevron']],
        [rows.heading, ['grip', 'chevron']],
        [rows.h1, ['grip', 'chevron']],
        [rows.h6, ['grip', 'chevron']],
      ] as const
      for (const size of ['16px', '18px']) {
        await setFontSize(size)
        for (const [id, controls] of cases) {
          // Off the row first, so the grip moves when the pointer reaches it.
          await $('[aria-label="Page title"]').moveTo()
          await $(row(id)).moveTo()
          await browser.waitUntil(
            async () => (await $(row(id)).getAttribute('data-page-grip-on')) !== null,
            {
              timeout: ACTION_TIMEOUT,
              timeoutMsg: 'the grip never moved to the row under the pointer',
            },
          )
          expectCentred(await offsets(row(id), 'page'), controls, `page mode, ${size}`)
        }
      }
    })
  })
})
