// ---------------------------------------------------------------------------
// Real-backend Trash: a deleted page and its tree, restored or purged (#5737).
//
// Deleting a page soft-deletes its whole subtree in one cohort (`delete_block`),
// Trash lists only the cohort's root with a "+N blocks" badge
// (`list_trash` + `trash_descendant_counts`), Restore brings the cohort back
// (`restore_block`) and Purge erases it (`purge_block`). All of it is backend,
// so each case re-reads the result after a view change.
//
// The Pages list deletes the first page and the page editor's kebab ("Page
// actions" › "Delete page") the third; Trash is opened from the Pages header's
// "Trash" button (PageBrowserHeader.tsx), and its rows are
// `[data-testid="trash-item"]` (TrashRowItem.tsx).
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  enterBlankSibling,
  expectAbsent,
  navigateTo,
  openNewPageDialog,
  reopenPageByTitle,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
// A live page every case can wait for before asserting another row is absent.
const KEPT = runScopedMarker('wdio-trash-kept')

/** The Pages list row of the page titled `title` (PageRow.tsx). */
function pageRow(title: string): string {
  return `//div[@data-page-item][.//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]]`
}

/** The Trash row whose content is the page title `title`. */
function trashRow(title: string): string {
  return `//*[@data-testid="trash-item"][.//*[contains(@class, "trash-item-text")][normalize-space(.)="${title}"]]`
}

/** Create page `title` in the New page dialog; it opens with its first block in the editor. */
async function openTitledPage(title: string): Promise<void> {
  await openNewPageDialog()
  await typeInputVerified('#new-page-name', title)
  await browser.keys(['Enter'])
  await browser.waitUntil(async () => (await $('[aria-label="Page title"]').getText()) === title, {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the page ${title} never opened`,
  })
  await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
}

/** The page's rows in document order, as `<marker>@<aria-level>` for each of `markers` found. */
function outline(markers: string[]): Promise<string[]> {
  return browser.execute(
    (wanted: string[]) =>
      [...document.querySelectorAll('[data-testid="sortable-block"]')].map((row) => {
        const text = row.textContent ?? ''
        const level = row.closest('li[aria-level]')?.getAttribute('aria-level') ?? null
        return `${wanted.filter((marker) => text.includes(marker)).join('+')}@${level}`
      }),
    markers,
  )
}

/** Wait until the open page shows each of `markers` one level below the one before it. */
async function waitForChain(markers: string[], what: string): Promise<void> {
  const expected = markers.map((marker, i) => `${marker}@${i + 1}`)
  let seen: string[] = []
  await browser
    .waitUntil(
      async () => {
        seen = await outline(markers)
        return JSON.stringify(seen) === JSON.stringify(expected)
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}: expected ${JSON.stringify(expected)}, saw ${JSON.stringify(seen)}`)
    })
}

/** Create page `title` holding `markers` as a chain, each block the child of the one before. */
async function createChainPage(title: string, markers: string[]): Promise<void> {
  await openTitledPage(title)
  for (const [i, marker] of markers.entries()) {
    if (i > 0) {
      await enterBlankSibling()
      await browser.keys(['Tab'])
      await browser.waitUntil(async () => (await outline(markers)).at(-1) === `@${i + 1}`, {
        timeout: ACTION_TIMEOUT,
        timeoutMsg: `Tab did not indent block ${i + 1}`,
      })
    }
    await typeMarkerVerified(marker)
  }
  // The sidebar click blurs, and so commits, the last block.
  await navigateTo('Journal')
  await reopenPageByTitle(title)
  await waitForChain(markers, 'the new page did not come back with its chain')
}

/** Delete page `title` from its Pages list row and confirm. */
async function deleteFromPagesList(title: string): Promise<void> {
  await navigateTo('Pages')
  const row = $(pageRow(title))
  await row.waitForDisplayed({ timeout: NAV_TIMEOUT })
  // The row's delete button is opacity-0 until the row is hovered (PageRow.tsx).
  await row.moveTo()
  const remove = row.$('button[aria-label="Delete page"]')
  await remove.waitForClickable({ timeout: ACTION_TIMEOUT })
  await remove.click()
  await confirmDialog('Delete')
  await waitForToast('Page deleted')
}

/** Confirm the open `[role="alertdialog"]` with its `label` button and wait for it to close. */
async function confirmDialog(label: string): Promise<void> {
  const dialog = $('[role="alertdialog"]')
  await dialog.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  const confirm = dialog.$(`button=${label}`)
  await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
  await confirm.click()
  await dialog.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
}

/** Open Trash from the Pages header and wait until its list has loaded. */
async function openTrash(): Promise<void> {
  await navigateTo('Pages')
  // Named "Trash, N items" while the trash holds something.
  const button = $('//button[@aria-label="Trash" or starts-with(@aria-label, "Trash, ")]')
  await button.waitForClickable({ timeout: NAV_TIMEOUT })
  await button.click()
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          document.querySelector('[data-slot="feature-page-header-title"]')?.textContent ===
            'Trash' &&
          document.querySelector('.trash-view-loading') === null &&
          (document.querySelector('[data-testid="trash-item"]') !== null ||
            document.querySelector(
              '[aria-label="Nothing in trash. Deleted items will appear here."]',
            ) !== null),
      ),
    { timeout: NAV_TIMEOUT, timeoutMsg: 'the Trash list never finished loading' },
  )
}

/** Click Restore on page `title`'s Trash row and wait for the row to leave. */
async function restoreFromTrash(title: string): Promise<void> {
  const row = $(trashRow(title))
  await row.waitForDisplayed({ timeout: NAV_TIMEOUT, timeoutMsg: `Trash does not list ${title}` })
  const restore = row.$('[data-testid="trash-restore-btn"]')
  await restore.waitForClickable({ timeout: ACTION_TIMEOUT })
  await restore.click()
  await row.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
}

describe('Agaric real-backend Trash: page cascade, restore, purge (#5737)', () => {
  before(async () => {
    await waitForAppReady()
    await openTitledPage(KEPT)
    await typeMarkerVerified(runScopedMarker('wdio-trash-kept-body'))
    await navigateTo('Pages')
  })

  it('lists a deleted page once with its child count, and restore brings its tree back', async () => {
    const page = runScopedMarker('wdio-trash-tree-page')
    const chain = ['one', 'two', 'six'].map((n) => runScopedMarker(`wdio-trash-tree-${n}`))
    await createChainPage(page, chain)

    await deleteFromPagesList(page)
    await openTrash()
    const row = $(trashRow(page))
    await row.waitForDisplayed({ timeout: NAV_TIMEOUT, timeoutMsg: 'Trash does not list the page' })
    // One root for the cohort: no row of its own for any block of the tree.
    const mentioning = await browser.execute(
      (names: string[]) =>
        [...document.querySelectorAll('[data-testid="trash-item"]')]
          .map((item) => item.textContent ?? '')
          .filter((text) => names.some((name) => text.includes(name))),
      [page, ...chain],
    )
    expect(mentioning.length).toBe(1)
    await expect(row.$('[data-testid="trash-descendant-badge"]')).toHaveText('+3 blocks')

    await restoreFromTrash(page)
    await reopenPageByTitle(page)
    await waitForChain(chain, 'the restored page did not bring its tree back')
  })

  it('purges a trashed page so neither Trash nor Pages lists it', async () => {
    const page = runScopedMarker('wdio-trash-purge-page')
    await openTitledPage(page)
    await typeMarkerVerified(runScopedMarker('wdio-trash-purge-body'))
    await deleteFromPagesList(page)

    await openTrash()
    const row = $(trashRow(page))
    await row.waitForDisplayed({ timeout: NAV_TIMEOUT, timeoutMsg: 'Trash does not list the page' })
    const purge = row.$('[data-testid="trash-purge-btn"]')
    await purge.waitForClickable({ timeout: ACTION_TIMEOUT })
    await purge.click()
    await confirmDialog('Yes, delete')
    // The purge re-reads the trash (TrashView `handlePurge`): this is the backend's list.
    await row.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the purged page is still listed in Trash',
    })

    await navigateTo('Journal')
    await openTrash()
    await expectAbsent(trashRow(page), 'the purged page in Trash')
    await navigateTo('Journal')
    await navigateTo('Pages')
    await $(pageRow(KEPT)).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(pageRow(page), 'the purged page in the Pages list')
  })

  it("sends a page to Trash from the editor's kebab, stepping off it, and restores its tree", async () => {
    const page = runScopedMarker('wdio-trash-kebab-page')
    const chain = ['one', 'two', 'six'].map((n) => runScopedMarker(`wdio-trash-kebab-${n}`))
    await createChainPage(page, chain)

    const kebab = $('button[aria-label="Page actions"]')
    await kebab.waitForClickable({ timeout: ACTION_TIMEOUT })
    await kebab.click()
    const deleteItem = $('[role="menu"]').$('[role="menuitem"]*=Delete page')
    await deleteItem.waitForClickable({ timeout: ACTION_TIMEOUT })
    await deleteItem.click()
    await confirmDialog('Delete page')

    // The tab steps back off the deleted page, to the page before it in the
    // tab's history or, with none, to Pages.
    let shown: string | null = null
    await browser
      .waitUntil(
        async () => {
          shown = await browser.execute(
            () => document.querySelector('[aria-label="Page title"]')?.textContent ?? null,
          )
          return shown !== page
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(`the editor still shows the deleted page ${JSON.stringify(shown)}`)
      })
    await expectAbsent(`[data-testid="block-static"]*=${chain[0]}`, "the deleted page's tree")
    await navigateTo('Journal')
    await navigateTo('Pages')
    await $(pageRow(KEPT)).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(pageRow(page), 'the deleted page in the Pages list')

    await openTrash()
    await restoreFromTrash(page)
    await reopenPageByTitle(page)
    await waitForChain(chain, 'the page restored from the kebab delete did not bring its tree back')
  })
})
