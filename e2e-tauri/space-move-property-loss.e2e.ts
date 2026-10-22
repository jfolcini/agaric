// ---------------------------------------------------------------------------
// Real-backend cross-space move: confirm, then drop (#5841 S0.6).
//
// `wdiolevel` is declared `number` in Personal and `text` in Work, through the
// real IPC, and a Personal page holds `wdiolevel = 42` (the setup is not under
// test). The page header's Move to space previews the move, lists the property
// with its one value, and moves once confirmed: in Work the page has its block
// but no `wdiolevel`. One Ctrl+Z on the moved page reverses the move and then
// restores the value, so the page is back in Personal holding 42.
//
// The page carries a content block so opening it creates none: the undo is the
// positional group fallback, which reverts every op of the page within
// `UNDO_GROUP_WINDOW_MS` of the newest, so the move's ops must be the newest.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  expectAbsent,
  confirmDialog,
  invoke,
  reopenPageHolding,
  runScopedMarker,
  switchToSpace,
  waitForAppReady,
  waitForToast,
} from './helpers'

const KEY = 'wdiolevel'
const TITLE = runScopedMarker('wdio-moving-page')
const MARKER = runScopedMarker('wdio-moving-block')
const PROPERTIES = '.page-property-table-header'

/** The open page's `KEY` value, read from its property table. */
async function expectLevel(value: string, what: string): Promise<void> {
  const header = $(PROPERTIES)
  await header.waitForClickable({ timeout: NAV_TIMEOUT })
  await header.click()
  const input = $(`[aria-label="${KEY} value"]`)
  await input.waitForDisplayed({ timeout: NAV_TIMEOUT })
  await browser
    .waitUntil(async () => (await input.getValue()) === value, { timeout: ACTION_TIMEOUT })
    .catch(async () => {
      throw new Error(`${what}: ${KEY} reads ${JSON.stringify(await input.getValue())}`)
    })
}

/** The page header's kebab → Move to space → `space`. */
async function moveOpenPageTo(space: string): Promise<void> {
  const kebab = $('button[aria-label="Page actions"]')
  await kebab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await kebab.click()
  const moveTo = $('[role="menu"]').$('[role="menuitem"]*=Move to space')
  await moveTo.waitForClickable({ timeout: ACTION_TIMEOUT })
  await moveTo.click()
  const target = $('[role="menu"][aria-label="Move to space"]').$(`[role="menuitem"]=${space}`)
  await target.waitForClickable({ timeout: ACTION_TIMEOUT })
  await target.click()
}

describe('Agaric real-backend cross-space move drops a differently defined property (#5841) @spaces @editor', () => {
  it('asks before dropping the value, and one undo moves the page back with it', async () => {
    await waitForAppReady()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const idOf = (name: string) => {
      const space = spaces.find((s) => s.name === name)
      if (space === undefined) throw new Error(`no ${name} space`)
      return space.id
    }
    const personal = idOf('Personal')
    for (const [name, valueType] of [
      ['Personal', 'number'],
      ['Work', 'text'],
    ] as const) {
      await invoke('create_property_def', {
        spaceId: idOf(name),
        key: KEY,
        valueType,
        options: null,
      })
    }
    const page = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: TITLE,
      spaceId: personal,
    })
    await invoke('create_block', {
      blockType: 'content',
      content: MARKER,
      parentId: page,
      index: null,
      scope: { kind: 'active', space_id: personal },
      blockId: null,
    })
    await invoke('set_property', { blockId: page, key: KEY, value: { value_num: 42 } })

    await switchToSpace('Personal')
    await reopenPageHolding(TITLE, MARKER)
    await expectLevel('42', 'before the move')

    await moveOpenPageTo('Work')
    const dialog = $('[role="alertdialog"]')
    await dialog.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const listed = await dialog.$(`button*=${KEY}`).getText()
    expect(listed).toContain('1 value')
    await confirmDialog('Move and remove')
    await waitForToast('Page moved to Work')

    // Work: the page and its block came, the value did not.
    await switchToSpace('Work')
    await reopenPageHolding(TITLE, MARKER)
    await expectAbsent(PROPERTIES, `a property table holding ${KEY} on the moved page`)

    // Ctrl+Z reaches the page undo only with no block focused.
    await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
    await browser.keys(['Control', 'z'])
    await waitForToast('Undid property change')

    await switchToSpace('Personal')
    await reopenPageHolding(TITLE, MARKER)
    await expectLevel('42', 'after the undo')
  })
})
