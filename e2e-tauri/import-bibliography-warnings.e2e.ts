// ---------------------------------------------------------------------------
// Real-backend bibliography import: one good entry, one malformed (#4671).
//
// `import_bibliography` is a mock approximation, so its warning surface is
// only proven here: the real BibTeX parser (agaric-engine/src/bibliography.rs
// `parse_bibtex`) skips an entry whose citation key is missing and reports it
// as a warning, while the well-formed entry becomes a page titled
// "{family} {year}" (commands/pages/bibliography.rs `citation_display_name`).
// The summary and warning list are asserted from the Data tab, then the
// created page is re-opened from the Pages list after a navigation
// round-trip, which is the durable read.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const FAMILY = runScopedMarker('wdiofam')
const YEAR = '2024'
const PAGE_TITLE = `${FAMILY} ${YEAR}`
const BIBTEX = [
  `@article{${FAMILY}key,`,
  `  author = {${FAMILY}, Test},`,
  '  title = {WDIO bibliography round trip},',
  `  year = {${YEAR}}`,
  '}',
  '@article{,',
  '  title = {Entry with no citation key},',
  `  year = {${YEAR}}`,
  '}',
  '',
].join('\n')

describe('Agaric real-backend bibliography import (#4671)', () => {
  it('creates a page for the good entry and lists the malformed one as a warning', async () => {
    await waitForAppReady()
    await navigateTo('Settings')
    const dataTab = $('#settings-tab-data')
    await dataTab.waitForClickable({ timeout: NAV_TIMEOUT })
    await dataTab.click()
    await $('[data-testid="settings-panel-data"]').waitForDisplayed({ timeout: NAV_TIMEOUT })

    const dir = mkdtempSync(path.join(os.tmpdir(), 'wdio-bib-'))
    const file = path.join(dir, 'refs.bib')
    writeFileSync(file, BIBTEX)

    const input = $('[data-testid="import-bib-input"]')
    await input.waitForExist({ timeout: ACTION_TIMEOUT })
    await browser.execute(() => {
      document.querySelector('[data-testid="import-bib-input"]')?.classList.remove('hidden')
    })
    await input.addValue(file)

    const summary = $('[data-testid="bib-import-summary"]')
    await summary.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    expect(await summary.getText()).toContain('Imported 1 reference page')

    // Warnings sit inside a closed <details>; open it so the items are
    // displayed, then assert the exact list.
    const warnings = $('[data-testid="bib-import-warnings"]')
    await warnings.waitForExist({ timeout: ACTION_TIMEOUT })
    await warnings.$('summary').click()
    const items = await $$('[data-testid="bib-import-warning-item"]').getElements()
    expect(items.length).toBe(1)
    const [item] = items
    if (item === undefined) throw new Error('warning item vanished between count and read')
    await item.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    expect(await item.getText()).toContain('missing or malformed citation key')

    // Durable read: the reference page is listed and opens with its title.
    await navigateTo('Journal')
    await reopenPageByTitle(PAGE_TITLE)
    const title = $('[aria-label="Page title"]')
    await browser.waitUntil(async () => (await title.getText()).trim() === PAGE_TITLE, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `page editor title never read ${JSON.stringify(PAGE_TITLE)}`,
    })
    await expect(title).toBeDisplayed()
  })
})
