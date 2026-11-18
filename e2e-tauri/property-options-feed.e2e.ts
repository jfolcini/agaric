// ---------------------------------------------------------------------------
// Real-backend: an option added in the page header's Properties clears the
// "doesn't fit" mark of a block below without leaving the page (#6545).
//
// A select is declared with the options alpha and beta, the page and a block
// on it hold beta, and the options are narrowed to alpha: the block's chip
// carries the mark. The page header's Edit options then adds beta back. The
// chip reads the space's definitions (`useSpacePropertyDefs`), which nothing
// in the frontend refetches after the header's write; only the backend's
// change feed does, `blocks:changed` with `local_command` and the
// `property_defs` domain, mapped to `invalidatePropertyCaches`. The header's
// own row takes the new definition from the write's answer, so the assertion
// is on the block's chip.
//
// The spec never leaves the page: the point is that it need not, so there is
// no navigation round-trip, which would read the definitions again by itself.
//
// The definition and the value are set through the real IPC: the setup is not
// under test.
//
// Globals (`$`, `$$`, `browser`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  invoke,
  openPageTitled,
  runScopedMarker,
  typeInputVerified,
  waitForAppReady,
} from './helpers'

const KEY = runScopedMarker('wdio-optfeed')
const PAGE = runScopedMarker('wdio-optfeed-page')
const POPOVER = '[data-slot="popover-content"]'

describe("an option added in the page header clears a block's mark without leaving the page @editor @pages", () => {
  it("drops the block's doesn't-fit mark once the option is saved", async () => {
    await waitForAppReady()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const spaceId = spaces.find((space) => space.name === 'Personal')?.id
    if (spaceId === undefined) throw new Error('no Personal space')
    await invoke('create_property_def', {
      spaceId,
      key: KEY,
      valueType: 'select',
      options: '["alpha","beta"]',
    })
    const pageId = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: PAGE,
      spaceId,
    })
    const block = await invoke<{ id: string }>('create_block', {
      blockType: 'content',
      content: runScopedMarker('wdio-optfeed-block'),
      parentId: pageId,
      index: null,
      scope: { kind: 'active', space_id: spaceId },
      blockId: null,
    })
    for (const blockId of [pageId, block.id]) {
      await invoke('set_property', {
        blockId,
        key: KEY,
        value: {
          value_text: 'beta',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      })
    }
    await invoke('update_property_def_options', { spaceId, key: KEY, options: '["alpha"]' })

    await openPageTitled(PAGE)
    const mark = `[data-testid="sortable-block"][data-block-id="${block.id}"] button[aria-label^="beta doesn't fit"]`
    await $(mark).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: "the block holding beta never showed the doesn't-fit mark",
    })

    const properties = $('.page-property-table-header')
    await properties.waitForClickable({ timeout: NAV_TIMEOUT })
    await properties.click()
    const editOptions = $(`button[aria-label="Edit options for ${KEY}"]`)
    await editOptions.waitForClickable({ timeout: ACTION_TIMEOUT })
    await editOptions.click()
    await typeInputVerified(`${POPOVER} input[aria-label="New option value"]`, 'beta')
    const add = $(`${POPOVER} button[aria-label="Add option"]`)
    await add.waitForClickable({ timeout: ACTION_TIMEOUT })
    await add.click()
    const save = $(`${POPOVER}`).$('button=Save options')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await $(POPOVER).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

    await browser.waitUntil(async () => (await $$(mark).getElements()).length === 0, {
      timeout: NAV_TIMEOUT,
      timeoutMsg:
        "the block's doesn't-fit mark stayed after the page header added beta to the options",
    })
  })
})
