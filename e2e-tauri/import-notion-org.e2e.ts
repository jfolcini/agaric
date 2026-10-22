// ---------------------------------------------------------------------------
// Real-backend folder import of a Notion export, an Org file and a text file
// (#6032).
//
// The frontend rewrites each into Markdown the importer reads
// (`src/lib/notion-import.ts`, `src/lib/org-import.ts`); what that Markdown
// stores is the backend's: a Notion `Key: value` line as a page property, a
// link to `Notes%20<id>.md` resolved to the page `Notes` imports as
// (`rewrite_relative_md_links`), and an Org headline's TODO keyword,
// SCHEDULED line, drawer property and depth. The mock models none of these
// (`import_markdown` in src/lib/tauri-mock/handlers/pages.ts), so only this
// lane can show them failing; e2e/import-export.spec.ts covers the titles.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  importFolder,
  navigateTo,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const PLAN_ID = '0123456789abcdef0123456789abcdef'
const NOTES_ID = 'fedcba9876543210fedcba9876543210'

/** The Pages entry titled exactly `title` (a namespace leaf carries it as `title`). */
function pageEntry(title: string) {
  return $(`span[title="${title}"]`)
}

async function openPage(title: string): Promise<void> {
  await navigateTo('Pages')
  await pageEntry(title).waitForClickable({ timeout: NAV_TIMEOUT })
  await pageEntry(title).click()
  await browser.waitUntil(async () => (await $('[aria-label="Page title"]').getText()) === title, {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the page ${title} never opened`,
  })
}

/** The row (`li[data-block-id]`) of the block whose text holds `marker`. */
async function rowOf(marker: string) {
  const block = blockStaticByMarker(marker)
  await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
  return $(`li[data-block-id="${await block.getAttribute('data-block-id')}"]`)
}

async function expectTaskState(marker: string, state: string): Promise<void> {
  const taskMarker = (await rowOf(marker)).$('[data-testid="task-marker"]')
  await taskMarker.waitForExist({ timeout: ACTION_TIMEOUT })
  await browser.waitUntil(
    async () => ((await taskMarker.getAttribute('aria-label')) ?? '').startsWith(`Task: ${state}`),
    { timeout: ACTION_TIMEOUT, timeoutMsg: `${marker} never showed the ${state} state` },
  )
}

describe('Agaric real-backend Notion, Org and text folder import (#6032) @markdown', () => {
  it('stores Notion properties and links, and Org tasks, dates, properties and depth', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-6032')
    const folder = `${marker}-export`
    const orgTitle = `${marker} Org`
    await importFolder(
      'import-folder-input',
      folder,
      {
        [`Plan ${PLAN_ID}.md`]: Buffer.from(
          `# Plan\n\nReviewer: ${marker}-ann\n\n- ${marker}-link [Notes](Notes%20${NOTES_ID}.md)\n`,
        ),
        [`Notes ${NOTES_ID}.md`]: Buffer.from(`# Notes\n\n- ${marker}-notes\n`),
        [`Tasks ${PLAN_ID}.csv`]: Buffer.from('Name,Status\n'),
        'tasks.org': Buffer.from(
          [
            `#+TITLE: ${orgTitle}`,
            `* TODO ${marker}-task`,
            '  SCHEDULED: <2031-10-01 Wed>',
            '  :PROPERTIES:',
            `  :owner: ${marker}-alice`,
            '  :END:',
            `** DONE ${marker}-sub`,
            '',
          ].join('\n'),
        ),
        'reading.txt': Buffer.from(`- ${marker}-text\n`),
      },
      'Imported “4 files”',
    )

    await navigateTo('Journal')
    await navigateTo('Pages')
    for (const title of ['Notes', orgTitle, 'reading']) {
      await pageEntry(`${folder}/${title}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    }
    await expectAbsent(`span[title="${folder}/Plan ${PLAN_ID}"]`, 'a page titled with its id')

    await openPage(`${folder}/Plan`)
    const chip = (await rowOf(`${marker}-link`)).$('[data-testid="block-link-chip"]')
    await browser.waitUntil(async () => (await chip.getAttribute('title')) === `${folder}/Notes`, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the link to Notes%20<id>.md never resolved to the page Notes',
    })
    const properties = $('.page-property-table-header')
    await properties.waitForClickable({ timeout: NAV_TIMEOUT })
    await properties.click()
    const reviewer = $('[aria-label="reviewer value"]')
    await reviewer.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await reviewer.getValue()).toBe(`${marker}-ann`)

    await openPage(`${folder}/${orgTitle}`)
    await expectTaskState(`${marker}-task`, 'TODO')
    await expectTaskState(`${marker}-sub`, 'DONE')
    const task = await rowOf(`${marker}-task`)
    expect(await task.getAttribute('aria-level')).toBe('1')
    expect(await (await rowOf(`${marker}-sub`)).getAttribute('aria-level')).toBe('2')
    const scheduled = task.$('.scheduled-chip')
    await scheduled.waitForExist({ timeout: ACTION_TIMEOUT })
    expect(await scheduled.getAttribute('aria-label')).toContain('Oct 1, 2031')
    const owner = task.$(`[data-testid="property-chip"]*=${marker}-alice`)
    await owner.waitForExist({ timeout: ACTION_TIMEOUT })
  })
})
