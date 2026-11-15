// ---------------------------------------------------------------------------
// Real-backend copies of a list value (#6741).
//
// A property whose definition holds several values stores its items as one
// list. Duplicate copies a block through the Document buffer, where a list is
// one `key:: a, "b, c", [[Title]]` line read back by the property layer
// (`PropertyLines`), and `/template` copies a template's blocks as rows
// (`create_blocks_batch`). Either copy losing the list, flattening it into
// text, or keeping a ref item as its title instead of its block id, shows only
// with the real backend in the loop.
//
// The definitions and values are set up through the commands; Duplicate and
// the template insert are driven through the UI, and every copy is read back
// after leaving the page and coming back.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  blockStaticsByMarker,
  invoke,
  openNewPage,
  reopenPageHolding,
  runScopedMarker,
  switcherLabel,
  waitForAppReady,
  waitForToast,
} from './helpers'

const MARK = runScopedMarker('wdio-list-copy')
const KEYS = MARK.replaceAll('-', '')
const STAGES = `${KEYS}stages`
const LINKS = `${KEYS}links`
const DUP_TITLE = `${MARK} duplicate`
const DUP_BLOCK = `${MARK}-dup-block`
const TEMPLATE_TITLE = `${MARK} template`
const TEMPLATE_BLOCK = `${MARK}-template-block`
const DEST_TITLE = `${MARK} destination`
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

/** The text list's items: one holds a comma, which the buffer line must quote. */
const STAGE_ITEMS = ['draft', 'review, final']

interface ListRow {
  key: string
  value_text: string | null
  value_list?: Array<string | number> | null
}

const scope = (spaceId: string) => ({ kind: 'active', space_id: spaceId })

/** The active space's id, by the name its switcher shows. */
async function activeSpaceId(): Promise<string> {
  const name = await switcherLabel()
  const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
  const id = spaces.find((space) => space.name === name)?.id
  if (id === undefined) throw new Error(`no space named ${name} in ${JSON.stringify(spaces)}`)
  return id
}

async function addBlock(spaceId: string, parentId: string, content: string): Promise<string> {
  const block = await invoke<{ id: string }>('create_block', {
    blockType: 'content',
    content,
    parentId,
    index: null,
    scope: scope(spaceId),
    blockId: null,
  })
  return block.id
}

async function setList(blockId: string, key: string, items: Array<string | number>) {
  await invoke('set_property', {
    blockId,
    key,
    value: {
      value_text: null,
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
      value_list: items,
    },
  })
}

/**
 * The two list definitions, a target page for the ref list, and `content`
 * holding both lists on a new page titled `title`. Resolves the page's id and
 * the target's.
 */
async function seedListBlock(
  spaceId: string,
  title: string,
  content: string,
): Promise<{ pageId: string; targetId: string }> {
  // One vault serves the file's two cases: each has its own target page.
  for (const [key, valueType] of [
    [STAGES, 'text'],
    [LINKS, 'ref'],
  ]) {
    await invoke('create_property_def', { spaceId, key, valueType, options: null, multiple: true })
  }
  const targetId = await invoke<string>('create_page_in_space', {
    parentId: null,
    content: `${title} target`,
    spaceId,
  })
  const pageId = await invoke<string>('create_page_in_space', {
    parentId: null,
    content: title,
    spaceId,
  })
  const blockId = await addBlock(spaceId, pageId, content)
  await setList(blockId, STAGES, STAGE_ITEMS)
  await setList(blockId, LINKS, [targetId])
  return { pageId, targetId }
}

/** The ids of the rows holding `marker`, read in one command. */
function rowIdsHolding(marker: string): Promise<string[]> {
  return browser.execute(
    (m: string) =>
      [...document.querySelectorAll('[data-testid="sortable-block"]')]
        .filter((row) => row.textContent?.includes(m))
        .map((row) => row.getAttribute('data-block-id') ?? ''),
    marker,
  )
}

/** Block `id`'s two lists, as the backend holds them. */
async function listsOf(id: string): Promise<Record<string, unknown>> {
  const rows = await invoke<ListRow[]>('get_properties', { blockId: id })
  const listOf = (key: string) => rows.find((row) => row.key === key)?.value_list ?? null
  return { [STAGES]: listOf(STAGES), [LINKS]: listOf(LINKS) }
}

describe('Agaric real-backend list values copied by Duplicate and templates (#6741) @editor @pages', () => {
  it('a duplicated block holds the same lists, its ref list by block id', async () => {
    await waitForAppReady()
    const spaceId = await activeSpaceId()
    const { targetId } = await seedListBlock(spaceId, DUP_TITLE, DUP_BLOCK)
    await reopenPageHolding(DUP_TITLE, DUP_BLOCK)

    await blockStaticByMarker(DUP_BLOCK).click()
    await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.keys(['Control', 'Shift', 'j'])
    // The original keeps the editor, so the copy is the only static row.
    await browser.waitUntil(async () => (await blockStaticsByMarker(DUP_BLOCK)).length === 1, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Ctrl+Shift+J did not render a copy of the block',
    })
    await browser.keys(['Escape'])
    await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

    await reopenPageHolding(DUP_TITLE, DUP_BLOCK)
    let ids: string[] = []
    await browser.waitUntil(
      async () => {
        ids = await rowIdsHolding(DUP_BLOCK)
        return ids.length === 2
      },
      {
        timeout: NAV_TIMEOUT,
        timeoutMsg: 'the re-opened page does not hold the block and its copy',
      },
    )
    for (const id of ids) {
      expect(await listsOf(id)).toEqual({ [STAGES]: STAGE_ITEMS, [LINKS]: [targetId] })
    }
  })

  it('a template block holding the lists is inserted holding them', async () => {
    await waitForAppReady()
    const spaceId = await activeSpaceId()
    const { pageId, targetId } = await seedListBlock(spaceId, TEMPLATE_TITLE, TEMPLATE_BLOCK)
    await invoke('set_property', {
      blockId: pageId,
      key: 'template',
      value: {
        value_text: 'true',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })

    await openNewPage(DEST_TITLE)
    await $(EDITOR).click()
    await browser.keys('/template'.split(''))
    const item = $('[data-testid="suggestion-item"]*=Insert block template')
    await item.waitForClickable({ timeout: ACTION_TIMEOUT })
    await item.click()
    const picked = $('[role="dialog"]').$(`button*=${TEMPLATE_TITLE}`)
    await picked.waitForClickable({ timeout: ACTION_TIMEOUT })
    await picked.click()
    await waitForToast('Template inserted')

    await reopenPageHolding(DEST_TITLE, TEMPLATE_BLOCK)
    let ids: string[] = []
    await browser.waitUntil(
      async () => {
        ids = await rowIdsHolding(TEMPLATE_BLOCK)
        return ids.length === 1
      },
      { timeout: NAV_TIMEOUT, timeoutMsg: 'the destination does not hold the inserted block' },
    )
    expect(await listsOf(ids[0] as string)).toEqual({ [STAGES]: STAGE_ITEMS, [LINKS]: [targetId] })
  })
})
