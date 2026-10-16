// ---------------------------------------------------------------------------
// Real-backend refresh of open views after a sync (#5256, #5258, #5242, #5255).
//
// The real-lane twin of `e2e/sync-refresh.spec.ts` (testing invariant 4). There
// the "peer" is a direct mock invoke plus an emitted `sync:complete`; here it
// is `e2e_sync_peer` (sync-peer.ts), and its writes reach the app through a
// real pull. No local surface announces them, so each view holds only if
// `reloadChangedPageStores` (useSyncEvents.ts) refreshes it, on `sync:complete`
// and again on the `blocks:changed` that follows the post-sync cache rebuild
// (`SpacePlacementSink`), which is when `agenda_cache`, `pages_cache` and
// `tags_cache` hold the peer's rows.
//
// The pull is started from the sidebar's Sync button: "Sync now" lives in
// Settings, and leaving the view to press it would remount the view and
// re-query it, which is the very refresh under test. Each refresh is waited
// for in the view that stayed open, pressing Sync again between reads, since a
// pull never remounts it. A seed the peer writes before a view opens is waited
// for with remounts instead, since its arrival is not under test.
//
// The tests share one vault: the first pairs, and each after it writes on the peer.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  typeInputVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'
import {
  type SyncPeer,
  openPairing,
  openSyncSettings,
  readPairingQr,
  setPeerAddress,
  startSyncPeer,
} from './sync-peer'

const TODAY_TASK = runScopedMarker('wdio-peer-today-task')
const LATE_TASK = runScopedMarker('wdio-peer-late-task')
const TAGGED = runScopedMarker('wdio-peer-tagged')
const DAY_ENTRY = runScopedMarker('wdio-peer-day-entry')
// Not run-scoped: every spec file boots its own vault (see search-bm25-order).
// Titles are matched whole, and the tag is typed, so it doubles no letter.
const TASKS_PAGE = 'peer tasks'
const LATE_PAGE = 'peer late tasks'
const TAGGED_PAGE = 'peer tagged notes'
const LISTED = 'peer listed page'
const CREATED = 'peer created page'
const RENAMED = 'peer renamed page'
const OPEN_TITLE = 'peer open page'
const RETITLED = 'peer retitled page'
const TAG = 'marigold'

const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'
const DUE_PANEL = '[data-testid="due-panel"]'
const DONE_PANEL = '.done-panel'
const UNFINISHED = '[data-testid="unfinished-tasks"]'
const TITLE = '[aria-label="Page title"]'
const TAB_LIST = '[role="tablist"][aria-label="Editor tabs"]'
const SEARCH_INPUT = '[aria-label="Search blocks"]'
const SEARCH_STATUS = '[data-testid="search-results-count"]'

/** A Pages list row's title span (PageBrowser/PageRow.tsx), by exact title. */
function pageRow(title: string): string {
  return `//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]`
}

/** The DOM text of `selector`, or '' when it is not rendered; read whether or not it is visible. */
function textOf(selector: string): Promise<string> {
  return browser.execute((sel: string) => document.querySelector(sel)?.textContent ?? '', selector)
}

/** The local date `offsetDays` from today, as the app's views compute it. */
function localDate(offsetDays: number): Promise<string> {
  return browser.execute((offset: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, offsetDays)
}

/** Switch the journal to `mode` (`JournalControls`, `journalTabId(mode)`). */
async function openJournalMode(mode: 'daily' | 'weekly'): Promise<void> {
  await navigateTo('Journal')
  const tab = $(`#journal-tab-${mode}`)
  await tab.waitForClickable({ timeout: NAV_TIMEOUT })
  await tab.click()
  await browser.waitUntil(async () => (await tab.getAttribute('aria-selected')) === 'true', {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the ${mode} journal tab never became selected`,
  })
}

/** Whether the sidebar's Sync button takes a click: it is `aria-disabled` while a sync runs. */
async function syncIdle(): Promise<boolean> {
  return (await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false'
}

/**
 * Wait until `holds`, pressing Sync (see `waitInOpenView`) and re-opening the
 * view with `open` between reads. For a seed only: a remount re-queries, so it
 * would hide the refresh under test.
 */
async function waitInFreshView(
  open: () => Promise<void>,
  holds: () => Promise<boolean>,
  what: string,
): Promise<void> {
  await open()
  await browser.waitUntil(
    async () => {
      if (await holds()) return true
      if (await syncIdle()) await $(SYNC_BUTTON).click()
      await navigateTo('Tags')
      await open()
      return false
    },
    { timeout: NAV_TIMEOUT, interval: 1_000, timeoutMsg: what },
  )
}

/** Write on the peer, then press the sidebar's Sync, which leaves the open view mounted. */
async function pullPeerWrites<T>(peer: SyncPeer, writes: () => Promise<T>): Promise<T> {
  const written = await writes()
  await browser.waitUntil(syncIdle, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'the app never finished the sync it was running',
  })
  await $(SYNC_BUTTON).click()
  await peer.waitPulled()
  return written
}

/**
 * Wait until the open view shows `holds`, pressing Sync again between reads. A
 * pull of the daemon's already running at the first press can end after the
 * peer's writes without carrying them, and answer `waitPulled` early; a later
 * pull carries them. A pull never remounts the view, so with the refresh gone
 * none of them makes `holds` true.
 */
async function waitInOpenView(holds: () => Promise<boolean>, what: () => string): Promise<void> {
  await browser
    .waitUntil(
      async () => {
        if (await holds()) return true
        if (await syncIdle()) await $(SYNC_BUTTON).click()
        return false
      },
      { timeout: NAV_TIMEOUT, interval: 1_000 },
    )
    .catch(() => {
      throw new Error(what())
    })
}

/** Expand Unfinished tasks if it renders collapsed (its default). */
async function expandUnfinished(): Promise<void> {
  const header = $(`${UNFINISHED} button[aria-expanded]`)
  if ((await header.isExisting()) && (await header.getAttribute('aria-expanded')) === 'false') {
    await header.click()
  }
}

/** The id of a week day other than `except` that still shows its no-page empty state. */
async function emptyWeekDay(except: string): Promise<string> {
  let found: string | undefined
  await browser.waitUntil(
    async () => {
      for (const day of await $$('section[id^="journal-"]').getElements()) {
        const date = ((await day.getAttribute('id')) ?? '').replace('journal-', '')
        if (date !== except && (await day.getText()).includes('No blocks for')) {
          found = date
          return true
        }
      }
      return false
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `the week view shows no day but ${except} without a page` },
  )
  if (found === undefined) throw new Error('no empty week day found')
  return found
}

describe('Agaric real-backend refresh of open views after a sync (#5365)', () => {
  let peer: SyncPeer | undefined
  let paired = false

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
  })

  /** The started peer, once the first test has paired it. */
  function pairedPeer(): SyncPeer {
    if (peer === undefined || !paired) throw new Error('the pairing test failed')
    return peer
  }

  it('pairs with the peer and gives the app its address', async () => {
    if (peer === undefined) throw new Error('the sync peer never started')
    await waitForAppReady()
    await openSyncSettings()
    await openPairing()
    const remote = await peer.pair(await readPairingQr())
    await waitForToast('Device paired successfully')
    await $('[data-testid="pairing-qr-code"]').waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
    })
    await setPeerAddress(remote.deviceId, remote.address)
    paired = true
  })

  it('a task the peer marks DONE leaves the Due panel and joins the Done panel (#5256)', async () => {
    const device = pairedPeer()
    const today = await localDate(0)
    // The panels leave out the open day's own blocks, so the task has a page of its own.
    const taskId = await pullPeerWrites(device, async () => {
      const page = await device.createInSpace('page', TASKS_PAGE)
      const id = await device.createBlock(page, TODAY_TASK)
      await device.setTodoState(id, 'TODO')
      await device.setDueDate(id, today)
      return id
    })
    await waitInFreshView(
      // Today's daily journal, where the Due, Done and Unfinished panels mount.
      () => openJournalMode('daily'),
      async () => (await textOf(DUE_PANEL)).includes(TODAY_TASK),
      "today's Due panel never listed the peer's task",
    )
    expect(await textOf(DONE_PANEL)).not.toContain(TODAY_TASK)

    await pullPeerWrites(device, () => device.setTodoState(taskId, 'DONE'))
    await waitInOpenView(
      async () =>
        (await textOf(DONE_PANEL)).includes(TODAY_TASK) &&
        !(await textOf(DUE_PANEL)).includes(TODAY_TASK),
      () => 'the open journal did not move the task from the Due panel to the Done panel',
    )
  })

  it('an overdue task the peer marks DONE leaves Unfinished tasks (#5256)', async () => {
    const device = pairedPeer()
    const yesterday = await localDate(-1)
    const taskId = await pullPeerWrites(device, async () => {
      const page = await device.createInSpace('page', LATE_PAGE)
      const id = await device.createBlock(page, LATE_TASK)
      await device.setTodoState(id, 'TODO')
      await device.setDueDate(id, yesterday)
      return id
    })
    await waitInFreshView(
      () => openJournalMode('daily'),
      async () => {
        await expandUnfinished()
        return (await textOf(UNFINISHED)).includes(LATE_TASK)
      },
      "Unfinished tasks never listed the peer's overdue task",
    )

    await pullPeerWrites(device, () => device.setTodoState(taskId, 'DONE'))
    // The Done panel listing it shows the pull has reached the open journal.
    await waitInOpenView(
      async () =>
        (await textOf(DONE_PANEL)).includes(LATE_TASK) &&
        !(await textOf(UNFINISHED)).includes(LATE_TASK),
      () => 'the open journal still lists the done task under Unfinished tasks',
    )
  })

  it('the Pages list shows a page the peer created and one it renamed (#5258)', async () => {
    const device = pairedPeer()
    const listedId = await pullPeerWrites(device, () => device.createInSpace('page', LISTED))
    await waitInFreshView(
      () => navigateTo('Pages'),
      () => $(pageRow(LISTED)).isDisplayed(),
      "the Pages list never showed the peer's page",
    )

    await pullPeerWrites(device, async () => {
      await device.createInSpace('page', CREATED)
      await device.editBlock(listedId, RENAMED)
    })
    const titles = () =>
      browser.execute(() =>
        [...document.querySelectorAll('.page-browser-item-title')].map((t) => t.textContent ?? ''),
      )
    let seen: string[] = []
    await waitInOpenView(
      async () => {
        seen = await titles()
        return seen.includes(CREATED) && seen.includes(RENAMED) && !seen.includes(LISTED)
      },
      () => `the open Pages list did not follow the peer: it lists ${JSON.stringify(seen)}`,
    )
  })

  it("the open page's title and tabs show the peer's new title (#5242)", async () => {
    const device = pairedPeer()
    const pageId = await pullPeerWrites(device, async () => {
      const id = await device.createInSpace('page', OPEN_TITLE)
      // A block of its own, so opening the page creates no first block here.
      await device.createBlock(id, runScopedMarker('wdio-peer-open-page-body'))
      return id
    })
    await waitInFreshView(
      () => navigateTo('Pages'),
      () => $(pageRow(OPEN_TITLE)).isDisplayed(),
      "the Pages list never showed the peer's page",
    )
    await reopenPageByTitle(OPEN_TITLE)
    await browser.waitUntil(async () => (await $(TITLE).getText()) === OPEN_TITLE, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: "the peer's page never opened under its title",
    })
    // A second tab on the same page makes the (otherwise hidden) tab bar render.
    await browser.keys(['Control', 't'])
    await browser.waitUntil(
      async () => (await $$(`${TAB_LIST} [role="tab"]`).getElements()).length === 2,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'Ctrl+T did not open a second tab' },
    )
    expect(await textOf(TAB_LIST)).toContain(OPEN_TITLE)

    await pullPeerWrites(device, () => device.editBlock(pageId, RETITLED))
    let seen = { title: '', tabs: '' }
    await waitInOpenView(
      async () => {
        seen = { title: await $(TITLE).getText(), tabs: await textOf(TAB_LIST) }
        return (
          seen.title === RETITLED && seen.tabs.includes(RETITLED) && !seen.tabs.includes(OPEN_TITLE)
        )
      },
      () => `the open page kept its old title: ${JSON.stringify(seen)}`,
    )
  })

  it('tag:# finds the block once the peer creates and applies the tag (#5255)', async () => {
    const device = pairedPeer()
    await navigateTo('Search')
    await typeInputVerified(SEARCH_INPUT, `tag:#${TAG}`)
    await browser.keys(['Enter'])
    // Settled: the search is held until the tag name resolves, here to none.
    await browser.waitUntil(async () => (await textOf(SEARCH_STATUS)) === 'No results', {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the search for an unknown tag never settled on no results`,
    })

    const blockId = await pullPeerWrites(device, async () => {
      const page = await device.createInSpace('page', TAGGED_PAGE)
      const id = await device.createBlock(page, TAGGED)
      const tag = await device.createInSpace('tag', TAG)
      await device.addTag(id, tag)
      return id
    })
    await waitInOpenView(
      () => $(`[data-testid="search-result-row-${blockId}"]`).isDisplayed(),
      () => `the open search for tag:#${TAG} never listed the block the peer tagged`,
    )
  })

  it('a journal day the peer wrote stops offering an empty day (#5258)', async () => {
    const device = pairedPeer()
    await openJournalMode('weekly')
    // Not today: the app makes today's page itself, and two pages would share the date.
    const date = await emptyWeekDay(await localDate(0))
    const day = `section[id="journal-${date}"]`

    await pullPeerWrites(device, async () => {
      const page = await device.createInSpace('page', date)
      await device.createBlock(page, DAY_ENTRY)
    })
    let seen = ''
    await waitInOpenView(
      async () => {
        seen = await textOf(day)
        const open = await $(day).$(`button[aria-label="Open ${date} in editor"]`).isExisting()
        return open && !seen.includes('No blocks for')
      },
      () => `the open week still shows ${date} without its page: ${seen}`,
    )
  })
})
