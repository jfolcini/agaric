// ---------------------------------------------------------------------------
// Real-backend markdown import: nesting depth + resolved page link (#4671).
//
// The mock's `import_markdown` is a declared approximation (flat, no nesting,
// no links — src/lib/tauri-mock/handlers/pages.ts), so only this lane can
// prove what the real importer does with an indented list and a `[[link]]`:
// `parse_logseq_markdown` (agaric-engine/src/import.rs) turns two-space
// indentation into depth, and `resolve_inbound_page_links`
// (commands/pages/markdown.rs) creates the missing target page and rewrites
// the link to its ULID. Both are asserted here through the page editor AFTER a
// navigation round-trip, i.e. on what the backend actually stored.
//
// The file is picked through the Data tab's hidden `<input type="file">`
// (ImportSection.tsx `import-file-input`): WebDriver's Element Send Keys on a
// file input sets its FileList from a path, so the fixture is written to the
// runner's tmpdir and its path typed into the input. No native dialog exists
// on this path. The `hidden` class (display:none) is stripped first because
// WebKitWebDriver applies the keyboard-interactability check to file inputs
// unless strict file interactability is off, and the spec cannot rely on it.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-import')
// The page title is the file path minus `.md` (markdown.rs `title_from_path`).
const TITLE = `${MARKER}-doc`
const TARGET = `${MARKER}-target`
const MARKDOWN = [
  `- ${MARKER}-parent`,
  `  - ${MARKER}-child`,
  `    - ${MARKER}-leaf links [[${TARGET}]]`,
  '',
].join('\n')

async function ariaLevelOf(marker: string): Promise<string | null> {
  const block = blockStaticByMarker(marker)
  await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
  const id = await block.getAttribute('data-block-id')
  // SortableBlockWrapper.tsx renders the row <li> with aria-level = depth + 1.
  return $(`li[data-block-id="${id}"]`).getAttribute('aria-level')
}

describe('Agaric real-backend markdown import (#4671)', () => {
  it('imports an indented list with a [[link]] and keeps the depth and the resolved link', async () => {
    await waitForAppReady()
    await navigateTo('Settings')
    const dataTab = $('#settings-tab-data')
    await dataTab.waitForClickable({ timeout: NAV_TIMEOUT })
    await dataTab.click()
    await $('[data-testid="settings-panel-data"]').waitForDisplayed({ timeout: NAV_TIMEOUT })

    const dir = mkdtempSync(path.join(os.tmpdir(), 'wdio-import-'))
    const file = path.join(dir, `${TITLE}.md`)
    writeFileSync(file, MARKDOWN)

    const input = $('[data-testid="import-file-input"]')
    await input.waitForExist({ timeout: ACTION_TIMEOUT })
    await browser.execute(() => {
      document.querySelector('[data-testid="import-file-input"]')?.classList.remove('hidden')
    })
    await input.addValue(file)

    // The result region reports the backend's own count: three list items,
    // no properties (ImportSection.tsx `data.importResultSummary`).
    const result = $('[data-testid="import-result"]')
    await result.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.waitUntil(async () => (await result.getText()).includes(`Imported “${TITLE}”`), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'import result never named the imported page',
    })
    expect(await result.getText()).toContain('3 blocks')

    // Round-trip: Journal first, then back in through the Pages list, so the
    // page editor mounts from a fresh backend read rather than the
    // import-time navigation.
    await navigateTo('Journal')
    await reopenPageByTitle(TITLE)

    expect(await ariaLevelOf(`${MARKER}-parent`)).toBe('1')
    expect(await ariaLevelOf(`${MARKER}-child`)).toBe('2')
    expect(await ariaLevelOf(`${MARKER}-leaf`)).toBe('3')

    // The link was rewritten to the created target page's ULID and renders as
    // a chip whose `title` resolves back to the target's title
    // (RichContentRenderer/marks/blockLink.tsx).
    const leaf = blockStaticByMarker(`${MARKER}-leaf`)
    const leafId = await leaf.getAttribute('data-block-id')
    const chip = $(`li[data-block-id="${leafId}"] [data-testid="block-link-chip"]`)
    await chip.waitForExist({ timeout: NAV_TIMEOUT })
    await browser.waitUntil(async () => (await chip.getAttribute('title')) === TARGET, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `link chip never resolved to ${JSON.stringify(TARGET)}`,
    })
    await expect(chip).toBeDisplayed()
  })
})
