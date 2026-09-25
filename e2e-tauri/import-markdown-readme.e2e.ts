// ---------------------------------------------------------------------------
// Real-backend markdown import of a README shape (#5160 Phase 2a).
//
// The block grammar is the backend's (`parse_block_lines` in
// agaric-engine/src/import.rs); the mock's `parseOutline` is a declared
// approximation and the mock's import emits every block flat, so only this
// lane can prove what the real importer does with a document that is not a
// `- ` outline: the leading `# Title` equal to the file name is the title and
// not a block (S6), a heading owns what follows it (D16), a paragraph is a
// block (D2), a fence is one block (S4), `1.` and `*` items are blocks nested
// by their content column (S1, S7). Depths are asserted through the page
// editor AFTER a navigation round-trip, i.e. on what the backend stored.
//
// The file is picked as import-markdown-nesting.e2e.ts picks its fixture:
// WebDriver's Element Send Keys on the Data tab's hidden `<input type="file">`
// sets its FileList from a path.
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
  expectAbsent,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-readme')
// The page title is the file path minus `.md` (markdown.rs `folder_path_to_namespace_title`),
// and the README's own `# Title` line repeats it, as an export does.
const TITLE = `${MARKER}-doc`
const MARKDOWN = [
  `# ${TITLE}`,
  '',
  `${MARKER}-intro is a tiny grep clone.`,
  '',
  `## ${MARKER}-install`,
  '',
  '```sh',
  `cargo install ${MARKER}-bin`,
  '```',
  '',
  `## ${MARKER}-usage`,
  '',
  `1. ${MARKER}-build the index`,
  `2. ${MARKER}-search for a needle`,
  '',
  `## ${MARKER}-features`,
  '',
  `* ${MARKER}-regex support`,
  `* ${MARKER}-ignore files`,
  `  * ${MARKER}-nested ignore files`,
  '',
].join('\n')
// The intro, three headings, the fence, two numbered items, two starred items
// and the nested one; the title line is not a block.
const BLOCKS_TOTAL = 10

async function ariaLevelOf(marker: string): Promise<string | null> {
  const block = blockStaticByMarker(marker)
  await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
  const id = await block.getAttribute('data-block-id')
  // SortableBlockWrapper.tsx renders the row <li> with aria-level = depth + 1.
  return $(`li[data-block-id="${id}"]`).getAttribute('aria-level')
}

describe('Agaric real-backend README import (#5160)', () => {
  it('imports a README as headings owning their sections, paragraphs, a fence and nested list items', async () => {
    await waitForAppReady()
    await navigateTo('Settings')
    const dataTab = $('#settings-tab-data')
    await dataTab.waitForClickable({ timeout: NAV_TIMEOUT })
    await dataTab.click()
    await $('[data-testid="settings-panel-data"]').waitForDisplayed({ timeout: NAV_TIMEOUT })

    const dir = mkdtempSync(path.join(os.tmpdir(), 'wdio-readme-'))
    const file = path.join(dir, `${TITLE}.md`)
    writeFileSync(file, MARKDOWN)

    const input = $('[data-testid="import-file-input"]')
    await input.waitForExist({ timeout: ACTION_TIMEOUT })
    await browser.execute(() => {
      document.querySelector('[data-testid="import-file-input"]')?.classList.remove('hidden')
    })
    await input.addValue(file)

    // The result region reports the backend's own count (ImportSection.tsx
    // `data.importResultSummary`).
    const result = $('[data-testid="import-result"]')
    await result.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.waitUntil(async () => (await result.getText()).includes(`Imported “${TITLE}”`), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'import result never named the imported page',
    })
    expect(await result.getText()).toContain(`${BLOCKS_TOTAL} blocks`)

    // Round-trip: Journal first, then back in through the Pages list, so the
    // page editor mounts from a fresh backend read.
    await navigateTo('Journal')
    await reopenPageByTitle(TITLE)

    // The title line is the page title, not a block.
    await expectAbsent(`[data-testid="block-static"]*=# ${TITLE}`, 'a block repeating the title')
    // Top level: the intro paragraph and the headings.
    expect(await ariaLevelOf(`${MARKER}-intro`)).toBe('1')
    expect(await ariaLevelOf(`${MARKER}-install`)).toBe('1')
    expect(await ariaLevelOf(`${MARKER}-features`)).toBe('1')
    // Each heading owns its section: the fence, the numbered and the starred
    // items are one level down, the nested `*` item two.
    expect(await ariaLevelOf(`cargo install ${MARKER}-bin`)).toBe('2')
    expect(await ariaLevelOf(`${MARKER}-build`)).toBe('2')
    expect(await ariaLevelOf(`${MARKER}-regex`)).toBe('2')
    expect(await ariaLevelOf(`${MARKER}-nested`)).toBe('3')
  })
})
