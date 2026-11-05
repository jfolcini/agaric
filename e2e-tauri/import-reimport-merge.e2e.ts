// ---------------------------------------------------------------------------
// Real-backend re-import into the page of the file's title (#6277 G5).
//
// A Markdown file whose title names a page with blocks merges into it as an
// Edit as Markdown save of the file does (decision 7). Before it runs, the
// import asks in a dialog listing the existing pages it will update, read
// through `list_import_merges` (commands/pages/markdown_import_merge.rs). The
// mock lists from its own approximation, so only this lane shows the real
// match: the page the backend will merge into, by the title the backend
// derives from the file name. After the confirm, the page is updated in place
// (one page, the edited line's block rewritten, the dropped line's block in
// the Trash), asserted after a navigation round-trip, on what the backend
// stored.
//
// The file is picked as import-markdown-readme.e2e.ts picks its fixture:
// WebDriver's Element Send Keys on the Data tab's hidden `<input type="file">`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  confirmDialog,
  expectAbsent,
  importMarkdownPage,
  navigateTo,
  openDataTab,
  reopenPageByTitle,
  runScopedMarker,
  waitForAppReady,
  waitForImportResult,
} from './helpers'

const MARKER = runScopedMarker('wdio-reimport')
const TITLE = `${MARKER}-plan`

/** How many rows of the Pages list carry exactly `title`. */
async function pagesTitled(title: string): Promise<number> {
  await navigateTo('Pages')
  const rows = `.//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]`
  await $(rows).waitForDisplayed({ timeout: NAV_TIMEOUT })
  return $$(rows).length
}

describe('Agaric real-backend re-import merges into the page of its title (#6277 G5) @markdown @pages', () => {
  it('lists the existing page before it runs and updates it in place', async () => {
    await waitForAppReady()
    await importMarkdownPage(TITLE, `${MARKER}-alpha\n\n${MARKER}-beta\n\n${MARKER}-gamma\n`)

    await openDataTab()
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'wdio-reimport-')), `${TITLE}.md`)
    writeFileSync(file, `${MARKER}-alpha\n\n${MARKER}-beta-edited\n`)
    const input = $('[data-testid="import-file-input"]')
    await input.waitForExist({ timeout: ACTION_TIMEOUT })
    await browser.execute(() => {
      document.querySelector('[data-testid="import-file-input"]')?.classList.remove('hidden')
    })
    await input.addValue(file)

    // The dialog lists the one page the import updates (ImportMergeDialog.tsx).
    const pages = $('[data-testid="import-merge-pages"]')
    await pages.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const listed = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="import-merge-pages"] li')].map(
        (item) => item.textContent,
      ),
    )
    expect(listed).toEqual([TITLE])
    await confirmDialog('Update and import')
    await waitForImportResult('1 existing page updated')

    // Round-trip: one page of the title, updated in place.
    await navigateTo('Journal')
    expect(await pagesTitled(TITLE)).toBe(1)
    await reopenPageByTitle(TITLE)
    await blockStaticByMarker(`${MARKER}-beta-edited`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await blockStaticByMarker(`${MARKER}-alpha`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(`[data-testid="block-static"]*=${MARKER}-gamma`, 'the dropped line')
  })
})
