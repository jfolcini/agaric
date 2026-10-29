// ---------------------------------------------------------------------------
// Real-backend Edit as Markdown in the Document dialect (#5691 G3).
//
// The buffer writes a page line by line: a plain block as its own paragraph, a
// list block with its marker, a task as `- [ ]`, a plain block under a list
// block as a `+` item, property lines at a block's text column, a blank line
// between blocks but neighbouring list lines. Here a page of every kind is
// saved from the buffer, opened again, and saved with nothing the page holds
// changed (an extra blank line only): the backend reads back the tree it
// wrote, so the save appends no op and leaves no Undo, and the page re-read is
// the same. Then one restyle, `-` to `1.`, saves as a numbered block. Every
// save goes through the commands' Tauri wrappers with `dialect: document`;
// the mock-backed twin is `e2e/page-source-edit.spec.ts`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  clickPageSourceButton,
  invoke,
  navigateTo,
  openNewPage,
  openPageSource,
  pageSourceLines,
  reopenPageByTitle,
  runScopedMarker,
  type SourceLine,
  setPageSourceLines,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const MARKER = runScopedMarker('wdio-document')
const LONE = 'lone bullet'

interface BlockRow {
  id: string
  parent_id: string | null
  position: number | null
  content: string | null
  todo_state: string | null
  priority: string | null
  space_id: string | null
}

interface PropertyRow {
  key: string
  value_text: string | null
  value_num: number | null
  value_date: string | null
  value_ref: string | null
  value_bool: boolean | null
}

/** The page's lines below the typed block, one of each kind. */
const KINDS: string[] = [
  '',
  '## Plan',
  '',
  'Intro line one',
  'intro line two',
  '',
  '- bullet item',
  '  + plain child',
  `- ${LONE}`,
  '1. first step',
  '2. second step',
  '- [ ] call the bank',
  '  priority:: 1',
  '- [x] done already',
  '',
  '> a quote',
  '',
  '```sh',
  'echo hi',
  '```',
  '',
  'parent paragraph',
  '',
  '  child paragraph',
  '',
]

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await $(`[data-testid="block-static"]*=${MARKER}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Save the open buffer, and wait for it to close. */
async function save(source: WebdriverIO.Element): Promise<void> {
  await clickPageSourceButton('Save')
  await source.waitForExist({
    reverse: true,
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'Save did not close the buffer',
  })
}

/** The page's blocks depth-first, each with its depth, its columns and its properties, as the backend holds them. */
async function storedTree(pageId: string, spaceId: string) {
  const { blocks } = await invoke<{ blocks: BlockRow[] }>('load_page_subtree', {
    rootBlockId: pageId,
    scope: { kind: 'active', space_id: spaceId },
  })
  const properties = await invoke<Record<string, PropertyRow[]>>('get_batch_properties', {
    blockIds: blocks.map((block) => block.id),
  })
  const tree: Array<BlockRow & { depth: number; properties: PropertyRow[] }> = []
  const walk = (parentId: string, depth: number): void => {
    const children = blocks
      .filter((block) => block.parent_id === parentId)
      .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))
    for (const block of children) {
      const rows = (properties[block.id] ?? []).toSorted((a, b) => a.key.localeCompare(b.key))
      tree.push({ ...block, depth, properties: rows })
      walk(block.id, depth + 1)
    }
  }
  walk(pageId, 0)
  return tree
}

/** What a block of the tree is, as the buffer writes it: its depth, text, list style, task and priority. */
function kindOf(block: BlockRow & { depth: number; properties: PropertyRow[] }) {
  const style = block.properties.find((row) => row.key === 'listStyle')?.value_text ?? null
  return [block.depth, block.content, style, block.todo_state, block.priority]
}

/** Whether a save's report shows, with a button labelled `button` when given. */
function savedReportShown(button?: string): Promise<boolean> {
  return browser.execute(
    (label: string | null) =>
      [...document.querySelectorAll('[data-sonner-toast]')]
        .filter((toast) => (toast.textContent ?? '').includes('Markdown saved'))
        .some(
          (toast) =>
            label === null ||
            [...toast.querySelectorAll('button')].some((b) => b.textContent === label),
        ),
    button ?? null,
  )
}

/** The page's history, newest first: what it holds says which ops a save appended. */
async function history(pageId: string, spaceId: string): Promise<unknown[]> {
  const page = await invoke<{ items: unknown[] }>('list_page_history', {
    pageId,
    opTypeFilter: null,
    scope: { kind: 'active', space_id: spaceId },
    cursor: null,
    limit: 50,
  })
  return page.items
}

describe('Agaric real-backend Edit as Markdown, Document dialect (#5691) @editor @pages @markdown', () => {
  it('a page of every kind of block saves back unchanged, and a `-` restyled `1.` saves numbered', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(MARKER)
    // The sidebar click blurs and commits the block.
    await reopenTheNewPage()

    const build = await openPageSource([MARKER])
    const marker = (await pageSourceLines()).find((line) => line.text.includes(MARKER))
    if (marker?.id == null) throw new Error('the buffer holds no line for the typed block')
    await setPageSourceLines([
      { text: MARKER, id: marker.id },
      ...KINDS.map((text): SourceLine => ({ text, id: null })),
    ])
    await save(build)
    await reopenTheNewPage()

    const { parent_id: pageId } = await invoke<BlockRow>('get_block', { blockId: marker.id })
    if (pageId === null) throw new Error('the typed block has no page')
    const { space_id: spaceId } = await invoke<BlockRow>('get_block', { blockId: pageId })
    if (spaceId === null) throw new Error('the page has no space')
    const built = await storedTree(pageId, spaceId)
    expect(built.map(kindOf)).toEqual([
      [0, MARKER, null, null, null],
      [0, '## Plan', null, null, null],
      [0, 'Intro line one\nintro line two', null, null, null],
      [0, 'bullet item', 'bullet', null, null],
      [1, 'plain child', null, null, null],
      [0, LONE, 'bullet', null, null],
      [0, 'first step', 'ordered', null, null],
      [0, 'second step', 'ordered', null, null],
      [0, 'call the bank', null, 'TODO', '1'],
      [0, 'done already', null, 'DONE', null],
      [0, '> a quote', null, null, null],
      [0, '```sh\necho hi\n```', null, null, null],
      [0, 'parent paragraph', null, null, null],
      [1, 'child paragraph', null, null, null],
    ])

    // Nothing the page holds changes: one more blank line under the heading.
    // The build's report, which offers Undo, goes first, so the report read
    // below is this save's.
    await browser.waitUntil(async () => !(await savedReportShown()), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the first save’s report never went',
    })
    const before = await history(pageId, spaceId)
    const unchanged = await openPageSource([MARKER, LONE])
    const lines = await pageSourceLines()
    const heading = lines.findIndex((line) => line.text === '## Plan')
    expect(heading).toBeGreaterThan(-1)
    await setPageSourceLines([
      ...lines.slice(0, heading + 1),
      { text: '', id: null },
      ...lines.slice(heading + 1),
    ])
    await save(unchanged)
    await waitForToast('Markdown saved')
    expect(await savedReportShown('Undo')).toBe(false)
    await reopenTheNewPage()
    expect(await storedTree(pageId, spaceId)).toEqual(built)
    expect(await history(pageId, spaceId)).toEqual(before)

    // One restyle: the lone bullet's `-` becomes `1.`.
    const restyle = await openPageSource([MARKER, LONE])
    await setPageSourceLines(
      (await pageSourceLines()).map(({ text, id }) => ({
        id,
        text: text === `- ${LONE}` ? `1. ${LONE}` : text,
      })),
    )
    await save(restyle)
    await reopenTheNewPage()
    const restyled = await storedTree(pageId, spaceId)
    expect(restyled.map(kindOf)).toEqual(
      built.map(kindOf).map((kind) => (kind[1] === LONE ? [0, LONE, 'ordered', null, null] : kind)),
    )
    // The buffer numbers the run the restyle joined by its place in it.
    const reread = await openPageSource([MARKER, LONE])
    const texts = (await pageSourceLines()).map((line) => line.text)
    const lone = texts.indexOf(`1. ${LONE}`)
    expect(texts.slice(lone, lone + 3)).toEqual([`1. ${LONE}`, '2. first step', '3. second step'])
    // An unchanged buffer closes on Cancel without asking.
    await clickPageSourceButton('Cancel')
    await reread.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
  })
})
