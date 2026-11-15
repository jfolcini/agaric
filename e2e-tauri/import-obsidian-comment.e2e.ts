// ---------------------------------------------------------------------------
// Real-backend import of Obsidian `%%comment%%` blocks (#6751).
//
// The rewrite is the backend's (`comment_as_callout` in
// agaric-engine/src/import.rs, applied by `normalize_foreign_forms`); the
// mock's import models no comment, so only this lane shows what an import
// stores: a block that is one comment, on one line or across lines, renders as
// a `comment` callout without its markers, and a comment inside a sentence
// stays text. Asserted after a navigation round-trip, on what the backend
// stored. The file is picked as import-markdown-readme.e2e.ts picks its own.
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

const MARKER = runScopedMarker('wdio-comment')
const TITLE = `${MARKER}-vault`
const MARKDOWN = [
  `%%${MARKER}-oneline%%`,
  '',
  '%%',
  `${MARKER}-first`,
  `${MARKER}-second`,
  '%%',
  '',
  `${MARKER}-said %%aside%% more`,
  '',
].join('\n')

/** The callout type and text of the block whose text holds `marker`. */
async function calloutOf(marker: string): Promise<{ type: string | null; text: string }> {
  const block = blockStaticByMarker(marker)
  await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
  const callout = block.$('[data-testid="callout-block"]')
  if (!(await callout.isExisting())) return { type: null, text: await block.getText() }
  return { type: await callout.getAttribute('data-callout-type'), text: await block.getText() }
}

describe('Agaric real-backend Obsidian comment import (#6751) @markdown', () => {
  it('imports a comment block as a comment callout and keeps one inside a sentence as text', async () => {
    await waitForAppReady()
    await navigateTo('Settings')
    const dataTab = $('#settings-tab-data')
    await dataTab.waitForClickable({ timeout: NAV_TIMEOUT })
    await dataTab.click()
    await $('[data-testid="settings-panel-data"]').waitForDisplayed({ timeout: NAV_TIMEOUT })

    const dir = mkdtempSync(path.join(os.tmpdir(), 'wdio-comment-'))
    const file = path.join(dir, `${TITLE}.md`)
    writeFileSync(file, MARKDOWN)

    const input = $('[data-testid="import-file-input"]')
    await input.waitForExist({ timeout: ACTION_TIMEOUT })
    await browser.execute(() => {
      document.querySelector('[data-testid="import-file-input"]')?.classList.remove('hidden')
    })
    await input.addValue(file)

    const result = $('[data-testid="import-result"]')
    await result.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.waitUntil(async () => (await result.getText()).includes(`Imported “${TITLE}”`), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'import result never named the imported page',
    })

    await navigateTo('Journal')
    await reopenPageByTitle(TITLE)

    const oneLine = await calloutOf(`${MARKER}-oneline`)
    expect(oneLine.type).toBe('comment')
    expect(oneLine.text).not.toContain('%%')
    const multiLine = await calloutOf(`${MARKER}-first`)
    expect(multiLine.type).toBe('comment')
    expect(multiLine.text).toContain(`${MARKER}-second`)
    expect(multiLine.text).not.toContain('%%')
    const inline = await calloutOf(`${MARKER}-said`)
    expect(inline.type).toBeNull()
    expect(inline.text).toContain('%%aside%%')
  })
})
