// ---------------------------------------------------------------------------
// Real-backend spaces: delete, Move to space, and the window title (#5739).
//
// - Delete: Settings › Spaces enables Delete only for a space whose scoped
//   `list_blocks` probe finds no page (SpacesTab.tsx). The mock ignores the
//   scope, so it disables Delete for every space.
// - Move to space: the page header's Move to space is `move_blocks_to_space`
//   (after `preview_space_move` finds nothing to drop), which re-stamps
//   `blocks.space_id` on the page and every block of it and moves its
//   `pages_cache` row; the Pages list, search and the Tags view's usage counts
//   all read those copies.
// - Window title: `useAppSpaceLifecycle` writes `<Page> · <Space> · Agaric`
//   through the window plugin. WebDriver's Get Title reads `document.title`,
//   which stays the `<title>` of index.html, so the spec asks the window for
//   its title (`plugin:window|title`, granted by `core:default`).
//
// A real vault boots with the spaces Personal and Work (spaces/bootstrap.rs).
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  chooseSelectOption,
  confirmDialog,
  enterBlankSibling,
  expectAbsent,
  invoke,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  switchToSpace,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const SWITCHER = '[aria-label="Switch space"]'
const PANEL = '[data-testid="settings-panel-spaces"]'
const SEARCH_INPUT = '[aria-label="Search blocks"]'
const SEARCH_STATUS = '[data-testid="search-results-count"]'

/** A Pages list row's title span (PageBrowser/PageRow.tsx), by exact title. */
function pageRow(title: string): string {
  return `//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]`
}

/** Settings › Spaces, opened from the switcher's Manage spaces item. */
async function openSpacesSettings(): Promise<void> {
  await chooseSelectOption(SWITCHER, 'Manage spaces')
  await $(PANEL).waitForDisplayed({ timeout: ACTION_TIMEOUT })
}

interface SpaceRow {
  name: string
  deleteDisabled: boolean
  blockedHint: boolean
}

/** The Settings › Spaces rows: the name in the rename field, Delete's state, the blocked hint. */
function spaceRows(): Promise<SpaceRow[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-slot="space-manage-row"]')].map((row) => ({
      name: row.querySelector<HTMLInputElement>('[aria-label="Rename space"]')?.value ?? '',
      deleteDisabled:
        row.querySelector<HTMLButtonElement>('button[aria-label="Delete space"]')?.disabled ?? true,
      blockedHint: row.querySelector('[data-testid="space-delete-blocked-hint"]') !== null,
    })),
  )
}

/** Wait until the Settings › Spaces rows satisfy `holds`. */
async function waitForSpaceRows(holds: (rows: SpaceRow[]) => boolean, what: string) {
  let seen: SpaceRow[] = []
  await browser
    .waitUntil(
      async () => {
        seen = await spaceRows()
        return holds(seen)
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}: Settings › Spaces reads ${JSON.stringify(seen)}`)
    })
}

async function createSpace(name: string): Promise<void> {
  const create = $(PANEL).$('button[aria-label="Create new space"]')
  await create.waitForClickable({ timeout: ACTION_TIMEOUT })
  await create.click()
  await typeInputVerified('[aria-label="New space name"]', name)
  await browser.keys(['Enter'])
  await waitForSpaceRows(
    (rows) => rows.some((row) => row.name === name),
    `the space ${name} never appeared`,
  )
}

/** The names the open switcher offers, read and then closed with Escape. */
async function switcherOptions(): Promise<string[]> {
  const trigger = $(SWITCHER)
  await trigger.waitForClickable({ timeout: ACTION_TIMEOUT })
  await trigger.click()
  await $('[role="option"]').waitForDisplayed({ timeout: ACTION_TIMEOUT })
  const options = await browser.execute(() =>
    [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? ''),
  )
  await browser.keys(['Escape'])
  await $('[role="option"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
  return options
}

interface Row {
  text: string
  level: string | null
}

/** The open page's block rows in order: text and nesting level. */
function outline(): Promise<Row[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="sortable-block"]')].map((row) => ({
      text: row.textContent ?? '',
      level: row.closest('li[aria-level]')?.getAttribute('aria-level') ?? null,
    })),
  )
}

/** The DOM text of `selector`, or '' when it is not rendered. */
function textOf(selector: string): Promise<string> {
  return browser.execute((sel: string) => document.querySelector(sel)?.textContent ?? '', selector)
}

/** Search `word` in the active space until `settled` holds, re-submitting between reads. */
async function searchUntil(word: string, settled: () => Promise<boolean>, what: string) {
  await navigateTo('Search')
  await browser.waitUntil(
    async () => {
      await $(SEARCH_INPUT).click()
      await browser.keys(['Control', 'a'])
      await browser.keys(['Delete'])
      await typeInputVerified(SEARCH_INPUT, word)
      await browser.keys(['Enter'])
      return browser.waitUntil(settled, { timeout: 5_000 }).then(
        () => true,
        () => false,
      )
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: what },
  )
}

/**
 * Wait until the active space's Tags view lists `tag` with `count` uses,
 * re-opening the view between reads: the count is the `tags_cache` row the
 * background materializer rebuilds.
 */
async function waitForTagUsage(tag: string, count: number, what: string): Promise<void> {
  let seen: string | null = null
  await browser
    .waitUntil(
      async () => {
        await navigateTo('Journal')
        await navigateTo('Tags')
        await $('[data-testid^="tag-item-"], [aria-label^="No tags yet"]').waitForExist({
          timeout: NAV_TIMEOUT,
        })
        // The badge reads the name, then the count (TagList.tsx).
        seen = await browser.execute(
          (sel: string) => document.querySelector(sel)?.textContent ?? null,
          `[data-testid="tag-item-${tag}"]`,
        )
        return seen === `${tag}${count}`
      },
      { timeout: NAV_TIMEOUT, interval: 1_000 },
    )
    .catch(() => {
      throw new Error(`${what}: the Tags view row reads ${JSON.stringify(seen)}`)
    })
}

/** The OS window's title, asked of the window plugin (WebDriver's Get Title reads `document.title`). */
function windowTitle(): Promise<string> {
  return invoke<string>('plugin:window|title', { label: 'main' })
}

async function waitForWindowTitle(expected: string): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = await windowTitle()
        return seen === expected
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `the window title never read ${JSON.stringify(expected)}; it reads ${JSON.stringify(seen)}`,
      )
    })
}

describe('Agaric real-backend spaces (#5739) @spaces', () => {
  before(async () => {
    await waitForAppReady()
  })

  it('deletes an empty space after confirming, and refuses one that holds a page', async () => {
    const empty = runScopedMarker('wdio-empty-space')
    const full = runScopedMarker('wdio-full-space')
    const page = runScopedMarker('wdio-full-page')

    await openSpacesSettings()
    await createSpace(empty)
    await createSpace(full)
    await switchToSpace(full)
    await openNewPage(page)

    await openSpacesSettings()
    await waitForSpaceRows(
      (rows) =>
        rows.some((row) => row.name === empty && !row.deleteDisabled) &&
        rows.some((row) => row.name === full && row.deleteDisabled && row.blockedHint),
      `Delete is not enabled for ${empty} and refused for ${full}`,
    )
    const index = (await spaceRows()).findIndex((row) => row.name === empty)
    const deleteButton = (await $$('[data-slot="space-manage-row"]').getElements())[index]?.$(
      'button[aria-label="Delete space"]',
    )
    if (deleteButton === undefined) throw new Error(`no Settings › Spaces row for ${empty}`)
    await deleteButton.click()
    await confirmDialog('Delete')

    // Re-opening Settings probes every space's emptiness afresh.
    await navigateTo('Journal')
    await openSpacesSettings()
    await waitForSpaceRows(
      (rows) =>
        !rows.some((row) => row.name === empty) &&
        rows.some((row) => row.name === full && row.deleteDisabled && row.blockedHint),
      `${empty} is still listed, or ${full} lost its refusal`,
    )
    const options = await switcherOptions()
    expect(options.some((option) => option.includes(full))).toBe(true)
    expect(options.some((option) => option.includes(empty))).toBe(false)
  })

  it('moves a page with its nested block to Work: Pages, blocks and search follow, and its tag stops counting in Personal', async () => {
    const page = runScopedMarker('wdio-moved-page')
    const stay = runScopedMarker('wdio-staying-page')
    const child = runScopedMarker('wdio-moved-child')
    const grandchild = runScopedMarker('wdio-moved-grandchild')
    const tag = runScopedMarker('wdio-moved-tag')

    await switchToSpace('Personal')
    await openNewPage(stay)
    await openNewPage(page)
    await typeMarkerVerified(`${child} @${tag}`)
    await $('[data-testid="suggestion-item"]*=Create').waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.keys(['Enter'])
    await $('[data-testid="block-editor"] [data-testid="tag-ref-chip"]').waitForExist({
      timeout: ACTION_TIMEOUT,
    })
    const grandchildId = await enterBlankSibling()
    await browser.keys(['Tab'])
    await typeMarkerVerified(grandchild)
    await browser.keys(['Escape'])
    await blockStaticByMarker(grandchild).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await waitForTagUsage(tag, 1, `Personal's Tags view never counted ${tag} once`)

    await reopenPageByTitle(page)
    const kebab = $('button[aria-label="Page actions"]')
    await kebab.waitForClickable({ timeout: ACTION_TIMEOUT })
    await kebab.click()
    const moveTo = $('[role="menu"]').$('[role="menuitem"]*=Move to space')
    await moveTo.waitForClickable({ timeout: ACTION_TIMEOUT })
    await moveTo.click()
    const work = $('[role="menu"][aria-label="Move to space"]').$('[role="menuitem"]=Work')
    await work.waitForClickable({ timeout: ACTION_TIMEOUT })
    await work.click()
    await waitForToast('Page moved to Work')

    // Personal: the page left its Pages list; the staying page is the list's readiness.
    await navigateTo('Journal')
    await navigateTo('Pages')
    await $(pageRow(stay)).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(pageRow(page), `${page} in Personal's Pages list`)

    // Work: listed, and both blocks came with it, nesting included.
    await switchToSpace('Work')
    await reopenPageByTitle(page)
    let rows: Row[] = []
    await browser
      .waitUntil(
        async () => {
          rows = await outline()
          return (
            rows.length === 2 &&
            rows[0]?.text.includes(child) === true &&
            rows[0].level === '1' &&
            rows[1]?.text.includes(grandchild) === true &&
            rows[1].level === '2'
          )
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(`${page} in Work does not hold its two blocks: ${JSON.stringify(rows)}`)
      })

    // Search finds the nested block in Work and not in Personal.
    const hit = `[data-testid="search-result-row-${grandchildId}"]`
    await searchUntil(
      grandchild,
      () => $(hit).isDisplayed(),
      `a search in Work never found ${grandchild}`,
    )
    await switchToSpace('Personal')
    await searchUntil(
      grandchild,
      async () => (await textOf(SEARCH_STATUS)) === 'No results',
      `a search in Personal for ${grandchild} never settled on no results`,
    )

    // The tag stays a Personal tag (tags never cross spaces), and the moved
    // block no longer counts toward it there.
    await waitForTagUsage(tag, 0, `Personal's Tags view still counts the moved block for ${tag}`)
  })

  it('titles the window <Page> · <Space> · Agaric, following the space and the page', async () => {
    const page = runScopedMarker('wdio-titled-page')

    await switchToSpace('Work')
    await openNewPage(page)
    await waitForWindowTitle(`${page} · Work · Agaric`)

    await navigateTo('Pages')
    await waitForWindowTitle('Pages · Work · Agaric')
    await switchToSpace('Personal')
    await navigateTo('Pages')
    await waitForWindowTitle('Pages · Personal · Agaric')

    await switchToSpace('Work')
    await reopenPageByTitle(page)
    await waitForWindowTitle(`${page} · Work · Agaric`)
  })
})
