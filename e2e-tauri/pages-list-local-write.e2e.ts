// ---------------------------------------------------------------------------
// Real-backend Pages list: a page another surface creates appears in the open
// list without leaving the view (#6545).
//
// The creates here are raw IPC calls, neither the list's own New page dialog
// nor a `commands.*` call, so nothing in the frontend knows they happened. The
// list hears of them only through the backend's change feed: `blocks:changed`
// with `local_command`, sent once a create's background rebuilds have run,
// which `useSyncEvents` maps to its domains' caches, the Pages list's among
// them. The list reads `pages_cache`, which only that background rebuild
// fills, so this spec's app starts every background batch a second late
// (`SPECS_WITH_A_SLOW_MATERIALIZER`, wdio.conf.ts): an event sent before the
// rebuild would refetch a list without the page and nothing would ask again.
//
// The spec never leaves the view: the point is that it need not, so there is
// no navigation round-trip, which would refetch the list by itself.
//
// Globals (`$`, `browser`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  invoke,
  NAV_TIMEOUT,
  navigateTo,
  pageEntryTitled,
  runScopedMarker,
  switcherLabel,
  waitForAppReady,
} from './helpers'

const FIRST = runScopedMarker('wdio-feed-first')
const SECOND = runScopedMarker('wdio-feed-second')

/** Create a page titled `title` in the active space, as an agent or a script would. */
async function createPageElsewhere(title: string): Promise<void> {
  const active = await switcherLabel()
  const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
  const space = spaces.find((s) => active.includes(s.name))
  if (space === undefined) {
    throw new Error(`no space matches the switcher's ${JSON.stringify(active)}`)
  }
  await invoke<string>('create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: space.id,
  })
}

describe('the Pages list shows a page created elsewhere without leaving the view @pages', () => {
  it('lists each new page while the list stays open', async () => {
    await waitForAppReady()
    await createPageElsewhere(FIRST)
    await navigateTo('Pages')
    // The list has loaded with the first page, before the second exists.
    await pageEntryTitled(FIRST).waitForDisplayed({ timeout: NAV_TIMEOUT })

    await createPageElsewhere(SECOND)

    await pageEntryTitled(SECOND).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the open Pages list never showed a page created elsewhere',
    })
  })
})
