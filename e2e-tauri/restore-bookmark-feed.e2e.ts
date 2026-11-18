// ---------------------------------------------------------------------------
// Real-backend: a bookmarked page restored from the Trash is back in the
// sidebar's Bookmarks without another navigation (#6545).
//
// The page is created, bookmarked and trashed through raw IPC, so the sidebar's
// bookmark list, read at boot, never held it. That list is re-read only on an
// `invalidated` name change (`src/lib/starred-pages.ts`), which after a local
// command comes only from the backend's change feed: `blocks:changed` with
// `local_command` and the `names` domain, mapped to `invalidateNameCaches`.
// Trash's Restore marks the page live in the resolve cache, but the list must
// be read again to hold it at all, so only the restore's change-feed event can
// put it in the sidebar.
//
// Globals (`$`, `$$`, `browser`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  NAV_TIMEOUT,
  invoke,
  materializerIdle,
  openTrash,
  restoreFromTrash,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const PAGE = runScopedMarker('wdio-restore-bookmark')
const SIDEBAR_ENTRY = `[aria-label="Bookmarks"] button[aria-label="Remove ${PAGE} from bookmarks"]`

describe('a bookmarked page restored from the Trash is back in the sidebar @pages', () => {
  it("lists the restored page under the sidebar's Bookmarks", async () => {
    await waitForAppReady()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const spaceId = spaces.find((space) => space.name === 'Personal')?.id
    if (spaceId === undefined) throw new Error('no Personal space')
    const pageId = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: PAGE,
      spaceId,
    })
    await invoke('set_property', {
      blockId: pageId,
      key: 'bookmark',
      value: {
        value_text: null,
        value_num: 1,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    await invoke('delete_block', { blockId: pageId })
    await materializerIdle(NAV_TIMEOUT)
    expect(await $$(SIDEBAR_ENTRY).getElements()).toHaveLength(0)

    await openTrash()
    await restoreFromTrash(PAGE)

    await browser.waitUntil(async () => (await $$(SIDEBAR_ENTRY).getElements()).length === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: "the sidebar's Bookmarks never listed the page restored from the Trash",
    })
  })
})
