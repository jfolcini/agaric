// ---------------------------------------------------------------------------
// Real-backend folder import of a Notion export, an Org file and a text file
// (#6032).
//
// The frontend rewrites each into Markdown the importer reads
// (`src/lib/notion-import.ts`, `src/lib/org-import.ts`); what that Markdown
// stores is the backend's: a Notion `Key: value` line as a page property, a
// link to `Notes%20<id>.md` or to `reading.txt` resolved to the page that file
// imports as (`rewrite_relative_md_links`), and an Org headline's TODO
// keyword, SCHEDULED line, drawer property and depth; and an Org file's own vocabulary
// and links (#6032 N4, N7): a `#+TODO` keyword as a task, a headline tag as a
// tag, an `id:` link as a block reference or a page link, and a heading link
// as text, not a page. The mock models none of these
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
  openPageTitled,
  pageEntryTitled,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const PLAN_ID = '0123456789abcdef0123456789abcdef'
const NOTES_ID = 'fedcba9876543210fedcba9876543210'

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
    // The picked folder's own name is no part of a title (#6277 decision 8).
    for (const title of ['Notes', orgTitle, 'reading']) {
      await pageEntryTitled(title).waitForDisplayed({ timeout: NAV_TIMEOUT })
    }
    await expectAbsent(`span[title="Plan ${PLAN_ID}"]`, 'a page titled with its id')
    await expectAbsent(`span[title="${folder}/Plan"]`, "a page titled with the folder's name")

    await openPageTitled('Plan')
    const chip = (await rowOf(`${marker}-link`)).$('[data-testid="block-link-chip"]')
    await browser.waitUntil(async () => (await chip.getAttribute('title')) === 'Notes', {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the link to Notes%20<id>.md never resolved to the page Notes',
    })
    const properties = $('.page-property-table-header')
    await properties.waitForClickable({ timeout: NAV_TIMEOUT })
    await properties.click()
    const reviewer = $('[aria-label="reviewer value"]')
    await reviewer.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await reviewer.getValue()).toBe(`${marker}-ann`)

    await openPageTitled(orgTitle)
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

  it('reads an Org file’s `#+TODO` keywords, headline tags and `id:` links, and makes no heading page', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-6032-roam')
    const folder = `${marker}-roam`
    const roamTitle = `${marker} Roam`
    const fileId = '5f2c0000-0000-4000-8000-000000000002'
    const headlineId = '5f2c0000-0000-4000-8000-000000000001'
    await importFolder(
      'import-folder-input',
      folder,
      {
        'roam.org': Buffer.from(
          [
            ':PROPERTIES:',
            `:ID: ${fileId}`,
            ':END:',
            `#+TITLE: ${roamTitle}`,
            '#+TODO: TODO NEXT | DONE',
            `* NEXT ${marker}-next :orgtag:`,
            `* ${marker}-target`,
            '  :PROPERTIES:',
            `  :ID: ${headlineId}`,
            '  :END:',
            '',
          ].join('\n'),
        ),
        'links.org': Buffer.from(
          [
            `* ${marker}-ref [[id:${headlineId}][the target]] and [[*Budget]]`,
            `* ${marker}-back [[id:${fileId}][roam]]`,
            '',
          ].join('\n'),
        ),
      },
      'Imported “2 files”',
    )

    await navigateTo('Journal')
    await navigateTo('Pages')
    await pageEntryTitled(`${folder}/links`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent('span[title="*Budget"]', 'a page made of a heading link')

    await openPageTitled(`${folder}/${roamTitle}`)
    await expectTaskState(`${marker}-next`, 'TODO')
    const tag = (await rowOf(`${marker}-next`)).$('[data-testid="tag-ref-chip"]')
    await tag.waitForExist({ timeout: ACTION_TIMEOUT })
    expect(await tag.getText()).toBe('orgtag')

    await openPageTitled(`${folder}/links`)
    // A reference chip's title is its target's text; an unresolved one reads otherwise.
    const ref = (await rowOf(`${marker}-ref`)).$('[data-testid="block-ref-chip"]')
    await browser.waitUntil(async () => (await ref.getAttribute('title')) === `${marker}-target`, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the id: link never resolved to the headline it names',
    })
    const page = (await rowOf(`${marker}-back`)).$('[data-testid="block-link-chip"]')
    await browser.waitUntil(
      async () => (await page.getAttribute('title')) === `${folder}/${roamTitle}`,
      { timeout: NAV_TIMEOUT, timeoutMsg: 'the file id: link never resolved to its page' },
    )
  })

  it('links a Markdown link to a sibling .txt note to the page it imports as', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-6032-txt')
    const folder = `${marker}-vault`
    await importFolder(
      'import-folder-input',
      folder,
      {
        // Named apart from the first case's `reading`, whose vault this one shares.
        [`${marker}-a.md`]: Buffer.from(`- ${marker}-link [r](${marker}-reading.txt)\n`),
        [`${marker}-reading.txt`]: Buffer.from(`- ${marker}-text\n`),
      },
      'Imported “2 files”',
    )

    await navigateTo('Journal')
    await navigateTo('Pages')
    await openPageTitled(`${marker}-a`)
    const chip = (await rowOf(`${marker}-link`)).$('[data-testid="block-link-chip"]')
    await browser.waitUntil(
      async () => (await chip.getAttribute('title')) === `${marker}-reading`,
      {
        timeout: NAV_TIMEOUT,
        timeoutMsg: 'the link to reading.txt never resolved to the page reading',
      },
    )
  })
})
