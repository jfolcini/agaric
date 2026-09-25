// ---------------------------------------------------------------------------
// Real-backend two-file import: a forward `[[link]]` and the file it names
// (#5160 D12, N5).
//
// Only the real importer decides whether a second file titled like the empty
// page an earlier file's link created adopts that page or mints a twin
// (`create_import_page` in commands/pages/markdown.rs). The frontend imports
// one file per IPC, in FileList order, so both orders are driven here: A (which
// links `[[B]]`) then B, and B then A. Each order must leave exactly one page
// `B`, holding B's block, with A's link chip resolving to it — asserted after a
// navigation round-trip, on what the backend stored.
//
// The files are picked one at a time through the Data tab's hidden
// `<input type="file">` (ImportSection.tsx `import-file-input`), so each run's
// result names its page: a multi-file pick reports no page title
// (useImportRunner.ts `pageTitle`). The backend sees the same thing either way,
// one `import_markdown` per file. The `hidden` class is stripped first, as the
// other import specs do.
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
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

async function importFile(file: string, title: string): Promise<void> {
  await navigateTo('Settings')
  const dataTab = $('#settings-tab-data')
  await dataTab.waitForClickable({ timeout: NAV_TIMEOUT })
  await dataTab.click()
  await $('[data-testid="settings-panel-data"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
  const input = $('[data-testid="import-file-input"]')
  await input.waitForExist({ timeout: ACTION_TIMEOUT })
  await browser.execute(() => {
    document.querySelector('[data-testid="import-file-input"]')?.classList.remove('hidden')
  })
  await input.addValue(file)
  // The result region names the imported page (ImportSection.tsx
  // `data.importResultSummary`), so the run is over once it does.
  const result = $('[data-testid="import-result"]')
  await result.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await browser.waitUntil(async () => (await result.getText()).includes(`Imported “${title}”`), {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `import result never named ${JSON.stringify(title)}`,
  })
}

/** How many rows of the Pages list carry exactly `title`. */
async function pagesTitled(title: string): Promise<number> {
  await navigateTo('Pages')
  const first = $(
    `.//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]`,
  )
  await first.waitForDisplayed({ timeout: NAV_TIMEOUT })
  return $$(`.//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]`)
    .length
}

async function assertOneTargetHoldingItsBlockAndLinked(
  marker: string,
  linker: string,
  target: string,
): Promise<void> {
  expect(await pagesTitled(target)).toBe(1)

  await reopenPageByTitle(target)
  const body = blockStaticByMarker(`${marker}-body`)
  await body.waitForDisplayed({ timeout: NAV_TIMEOUT })

  await navigateTo('Journal')
  await reopenPageByTitle(linker)
  const link = blockStaticByMarker(`${marker}-links`)
  await link.waitForDisplayed({ timeout: NAV_TIMEOUT })
  const linkId = await link.getAttribute('data-block-id')
  // The link was rewritten to the one B's ULID and renders as a chip whose
  // `title` resolves to B (RichContentRenderer/marks/blockLink.tsx).
  const chip = $(`li[data-block-id="${linkId}"] [data-testid="block-link-chip"]`)
  await chip.waitForExist({ timeout: NAV_TIMEOUT })
  await browser.waitUntil(async () => (await chip.getAttribute('title')) === target, {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `link chip never resolved to ${JSON.stringify(target)}`,
  })
}

describe('Agaric real-backend two-file import adopts the page a link created (#5160 D12)', () => {
  for (const order of ['linker-first', 'target-first'] as const) {
    it(`leaves one target page holding its block, linked from the other file (${order})`, async () => {
      await waitForAppReady()
      const marker = runScopedMarker(`wdio-vault-${order}`)
      const linker = `${marker}-A`
      const target = `${marker}-B`
      const dir = mkdtempSync(path.join(os.tmpdir(), 'wdio-vault-'))
      const linkerFile = path.join(dir, `${linker}.md`)
      const targetFile = path.join(dir, `${target}.md`)
      writeFileSync(linkerFile, `- ${marker}-links [[${target}]]\n`)
      writeFileSync(targetFile, `- ${marker}-body\n`)

      const runs: [string, string][] = [
        [linkerFile, linker],
        [targetFile, target],
      ]
      if (order === 'target-first') runs.reverse()
      for (const [file, title] of runs) await importFile(file, title)
      await assertOneTargetHoldingItsBlockAndLinked(marker, linker, target)
    })
  }
})
