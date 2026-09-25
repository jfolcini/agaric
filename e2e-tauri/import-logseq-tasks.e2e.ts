// ---------------------------------------------------------------------------
// Real-backend markdown import of Logseq task syntax (#5160 D7).
//
// The mock's `import_markdown` models a checkbox but no Logseq keyword,
// priority cookie or planning line (src/lib/tauri-mock/handlers/pages.ts), so
// only this lane can prove what the real importer stores for
// `- TODO [#A] text` followed by `SCHEDULED: <date>`: `parse_logseq_markdown`
// (agaric-engine/src/import.rs) reads the keyword, the cookie and the planning
// line into `todo_state`, `priority` and `scheduled_date`, the import command
// maps `[#A]` onto the priority definition's first option, and the page editor
// shows the three from the stored row AFTER a navigation round-trip.
//
// The file is picked through the Data tab's hidden `<input type="file">`, as
// `import-markdown-nesting.e2e.ts` does.
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

const MARKER = runScopedMarker('wdio-logseq-task')
// The page title is the file path minus `.md`.
const TITLE = `${MARKER}-doc`
const MARKDOWN = [
  `- TODO [#A] ${MARKER}-task`,
  '  SCHEDULED: <2031-10-01 Wed>',
  `- ${MARKER}-plain`,
  '',
].join('\n')

describe('Agaric real-backend Logseq task import (#5160 D7)', () => {
  it('imports `TODO [#A]` with a SCHEDULED line as a TODO with a priority and a scheduled date', async () => {
    await waitForAppReady()
    await navigateTo('Settings')
    const dataTab = $('#settings-tab-data')
    await dataTab.waitForClickable({ timeout: NAV_TIMEOUT })
    await dataTab.click()
    await $('[data-testid="settings-panel-data"]').waitForDisplayed({ timeout: NAV_TIMEOUT })

    const dir = mkdtempSync(path.join(os.tmpdir(), 'wdio-logseq-'))
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
    // Two blocks; the planning line was consumed, not made a block or a warning.
    expect(await result.getText()).toContain('2 blocks')

    // Round-trip: Journal first, then back in through the Pages list, so the
    // page editor mounts from a fresh backend read.
    await navigateTo('Journal')
    await reopenPageByTitle(TITLE)

    // The keyword and the cookie are out of the text; the plain block is as written.
    const task = blockStaticByMarker(`${MARKER}-task`)
    await task.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await task.getText()).not.toContain('TODO')
    expect(await task.getText()).not.toContain('[#A]')
    await blockStaticByMarker(`${MARKER}-plain`).waitForDisplayed({ timeout: NAV_TIMEOUT })

    // The row wrapper (`li[data-block-id]`) holds the task marker, the priority
    // badge and the scheduled chip that render from the stored columns
    // (BlockInlineControls.tsx).
    const taskId = await task.getAttribute('data-block-id')
    const row = $(`li[data-block-id="${taskId}"]`)
    const taskMarker = row.$('[data-testid="task-marker"]')
    await taskMarker.waitForExist({ timeout: ACTION_TIMEOUT })
    await browser.waitUntil(
      async () => ((await taskMarker.getAttribute('aria-label')) ?? '').startsWith('Task: TODO'),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the imported task never showed the TODO state' },
    )
    // `[#A]` is the first option of the seeded priority definition, `1`.
    const badge = row.$('[data-testid="priority-badge"]')
    await badge.waitForExist({ timeout: ACTION_TIMEOUT })
    expect(await badge.getText()).toContain('1')
    // The scheduled chip's label carries the compact date (`formatCompactDate`).
    const chip = row.$('.scheduled-chip')
    await chip.waitForExist({ timeout: ACTION_TIMEOUT })
    expect(await chip.getAttribute('aria-label')).toContain('Oct 1, 2031')
  })
})
