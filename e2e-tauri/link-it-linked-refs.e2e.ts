// ---------------------------------------------------------------------------
// Real-backend "Link it": the block it links appears in the open page's Linked
// References without leaving the page (#6545).
//
// "Link it" writes through `edit_block` straight from the Unlinked References
// panel, not through a page store, and nothing in the frontend bumps the graph
// counter the Linked References panel refetches on. The panel hears of the
// write only through the backend's change feed: `blocks:changed` with
// `local_command` and the `structure` domain, sent once the edit's background
// rebuilds have run. The panel reads `block_links`, which only that background
// rebuild fills, so this spec's app starts every background batch a second late
// (`SPECS_WITH_A_SLOW_MATERIALIZER`, wdio.conf.ts): a refetch before the
// rebuild would read the block as unlinked and nothing would ask again.
//
// The spec never leaves the page: the point is that it need not, so there is
// no navigation round-trip, which would refetch the panel by itself.
//
// Globals (`$`, `browser`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  invoke,
  materializerIdle,
  openPageTitled,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const SOURCE = runScopedMarker('wdio-linkit-source')
const TARGET = runScopedMarker('wdio-linkit-target')
const NOTE = runScopedMarker('wdio-linkit-note')

const UNLINKED = '[data-testid="unlinked-references"]'
const LINKED = '[data-testid="linked-references"]'

/** Whether the element `selector` names shows `text`. */
function panelShows(selector: string, text: string): Promise<boolean> {
  return browser.execute(
    (sel: string, t: string) => document.querySelector(sel)?.textContent?.includes(t) ?? false,
    selector,
    text,
  )
}

describe('"Link it" lists the block in Linked References without leaving the page @pages', () => {
  it('shows the linked block in the open page', async () => {
    await waitForAppReady()
    const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
    const spaceId = spaces.find((s) => s.name === 'Personal')?.id
    if (spaceId === undefined) throw new Error(`no Personal space in ${JSON.stringify(spaces)}`)
    const source = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: SOURCE,
      spaceId,
    })
    await invoke<string>('create_page_in_space', { parentId: null, content: TARGET, spaceId })
    await invoke('create_block', {
      blockType: 'content',
      content: `${NOTE} mentions ${TARGET}`,
      parentId: source,
      index: null,
      scope: { kind: 'active', space_id: spaceId },
      blockId: null,
    })
    // The mention is in the search index before the page lists its references.
    await materializerIdle(NAV_TIMEOUT)

    await openPageTitled(TARGET)
    const header = $(`${UNLINKED} .unlinked-references-header`)
    await header.waitForClickable({ timeout: NAV_TIMEOUT })
    await header.click()
    await browser.waitUntil(() => panelShows(UNLINKED, NOTE), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Unlinked References never listed the mention',
    })
    expect(await panelShows(LINKED, NOTE)).toBe(false)

    const linkIt = $(`${UNLINKED} .link-it-button`)
    await linkIt.waitForClickable({ timeout: ACTION_TIMEOUT })
    await linkIt.click()

    await browser.waitUntil(() => panelShows(LINKED, NOTE), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the open page\'s Linked References never listed the block "Link it" linked',
    })
  })
})
