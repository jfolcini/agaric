// ---------------------------------------------------------------------------
// Real-backend: a block's gutter controls (grip, chevron, task checkbox) centre
// on the first line of its text, in page mode and in block mode, at the medium
// and large font sizes. The maintainer saw them sit higher than the text in the
// desktop app; WebKitGTK's font metrics are not Chromium's, so the measurement
// runs here as well as in `e2e/gutter-alignment.spec.ts`, its per-PR pair
// against the mock, which says what is left out and why.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { ACTION_TIMEOUT, invoke, openPageTitled, runScopedMarker, waitForAppReady } from './helpers'
import { PAGE_MODE, chooseEditMode, pageModeCaret } from './page-mode'

const TITLE = runScopedMarker('wdio-gutter-align')
const ROWS = 6

interface Rows {
  focused: string
  unfocused: string
  plain: string
  heading: string
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
    content: TITLE,
    spaceId: space,
  })
  const focused = await create(pageId, `[[${target}]]`)
  const unfocused = await create(pageId, `[[${target}]]`)
  const plain = await create(pageId, 'Plain parent')
  await create(plain, 'child')
  const heading = await create(pageId, '## Heading parent')
  await create(heading, 'child')
  for (const blockId of [focused, unfocused]) {
    await invoke('set_todo_state', { blockId, state: 'TODO' })
  }
  return { focused, unfocused, plain, heading }
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

describe('gutter controls centre on the first line of the text @editor @pages', () => {
  let rows: Rows

  it('in block mode, at the medium and large font sizes', async () => {
    await waitForAppReady()
    rows = await seed()
    await openPageTitled(TITLE)
    await chooseEditMode('Blocks')
    await browser.waitUntil(
      async () => (await $$('[data-testid="sortable-block"]').getElements()).length === ROWS,
      { timeout: ACTION_TIMEOUT, timeoutMsg: `the page never showed its ${ROWS} blocks` },
    )
    const cases = [
      [rows.unfocused, ['grip', 'checkbox']],
      [rows.plain, ['grip', 'chevron', 'checkbox']],
      [rows.heading, ['grip', 'chevron', 'checkbox']],
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
