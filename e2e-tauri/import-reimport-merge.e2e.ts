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
// (still one page of that title, holding the unchanged and the edited line,
// the dropped line gone), asserted after a navigation round-trip, on what the
// backend stored. Which blocks keep their ids is the Rust tests'.
//
// The file is picked as import-markdown-readme.e2e.ts picks its fixture:
// WebDriver's Element Send Keys on the Data tab's hidden `<input type="file">`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import JSZip from 'jszip'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  confirmDialog,
  expectAbsent,
  importFolder,
  importMarkdownPage,
  invoke,
  navigateTo,
  openDataTab,
  pagesTitled,
  reopenPageByTitle,
  runScopedMarker,
  switchToSpace,
  takeDownload,
  waitForAppReady,
  waitForImportResult,
  waitForToast,
} from './helpers'

const MARKER = runScopedMarker('wdio-reimport')
const TITLE = `${MARKER}-plan`

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

describe('Agaric real-backend re-import of an export folder into its own space (#6277 G5) @markdown @pages', () => {
  it('updates each page in place, keeping its blocks, its files and its template flag', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-g5-folder')
    const title = `${marker}-review`
    const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
    const personal = spaces.find((space) => space.name === 'Personal')?.id
    if (personal === undefined) throw new Error(`no Personal space in ${JSON.stringify(spaces)}`)
    const pageId = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: title,
      spaceId: personal,
    })
    const holder = await invoke<{ id: string }>('create_block', {
      blockType: 'content',
      content: `${marker}-holder`,
      parentId: pageId,
      index: null,
      scope: { kind: 'active', space_id: personal },
      blockId: null,
    })
    await invoke('add_attachment_with_bytes', {
      blockId: holder.id,
      filename: `${marker} report.pdf`,
      mimeType: 'application/pdf',
      bytes: [...new TextEncoder().encode('%PDF-1')],
    })
    await invoke('set_property', {
      blockId: pageId,
      key: 'template',
      value: {
        value_text: 'true',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })

    await switchToSpace('Personal')
    await openDataTab()
    const exportButton = $('[data-testid="settings-panel-data"]').$('button*=Export this space')
    await exportButton.waitForClickable({ timeout: ACTION_TIMEOUT })
    const since = Date.now()
    await exportButton.click()
    await waitForToast('Export complete')
    const zip = await JSZip.loadAsync(
      await takeDownload(
        /^agaric-export-(?!all-spaces-).*\d{4}-\d{2}-\d{2}( \(\d+\))?\.zip$/,
        since,
      ),
    )
    const files: Record<string, Buffer> = {}
    for (const [name, entry] of Object.entries(zip.files)) {
      if (!entry.dir) files[name] = await entry.async('nodebuffer')
    }

    await importFolder(
      'import-folder-input',
      `${marker}-export`,
      files,
      'existing page',
      'Update and import',
    )

    // Round-trip: one page of the title, its block, file and flag as they were.
    await navigateTo('Journal')
    expect(await pagesTitled(title)).toBe(1)
    await expectAbsent(`span[title="${title} (2)"]`, 'a twin of the page')
    await reopenPageByTitle(title)
    await blockStaticByMarker(`${marker}-holder`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    const attached = await invoke<{ filename: string }[]>('list_attachments', {
      blockId: holder.id,
    })
    expect(attached.map((file) => file.filename)).toEqual([`${marker} report.pdf`])
    const properties = await invoke<{ key: string; value_text: string | null }[]>(
      'get_properties',
      { blockId: pageId },
    )
    expect(properties.find((row) => row.key === 'template')?.value_text).toBe('true')
  })
})

/** Pick `markdown` as the file `${title}.md` in the Data tab's file input. */
async function pickMarkdownFile(title: string, markdown: string): Promise<void> {
  await openDataTab()
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'wdio-reimport-')), `${title}.md`)
  writeFileSync(file, markdown)
  const input = $('[data-testid="import-file-input"]')
  await input.waitForExist({ timeout: ACTION_TIMEOUT })
  await browser.execute(() => {
    document.querySelector('[data-testid="import-file-input"]')?.classList.remove('hidden')
  })
  await input.addValue(file)
}

describe('Agaric real-backend re-import of a file with an Obsidian ^name anchor (#6277 G5) @markdown @pages', () => {
  it('takes the marker out of its new block and makes the link to it a ref to that block', async () => {
    await waitForAppReady()
    await switchToSpace('Personal')
    const marker = runScopedMarker('wdio-anchor')
    const title = `${marker}-notes`
    await importMarkdownPage(title, `${marker}-old\n`)

    await pickMarkdownFile(
      title,
      `- ${marker}-old\n- ${marker}-fresh ^two\n- ${marker}-see [[${title}#^two]]\n`,
    )
    await confirmDialog('Update and import')
    await waitForImportResult('1 existing page updated')

    // Round-trip, then read what the backend stored.
    await navigateTo('Journal')
    await reopenPageByTitle(title)
    await blockStaticByMarker(`${marker}-fresh`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
    const scope = { kind: 'active', space_id: spaces.find((s) => s.name === 'Personal')?.id ?? '' }
    const pages = await invoke<{ id: string; content: string | null }[]>(
      'list_all_pages_in_space',
      { scope, tagIds: null },
    )
    const pageId = pages.find((page) => page.content === title)?.id ?? ''
    const { blocks } = await invoke<{ blocks: { id: string; content: string | null }[] }>(
      'load_page_subtree',
      { rootBlockId: pageId, scope },
    )
    const fresh = blocks.find((block) => block.content === `${marker}-fresh`)
    expect(fresh?.content).toBe(`${marker}-fresh`)
    expect(blocks.map((block) => block.content)).toContain(`${marker}-see ((${fresh?.id}))`)
  })
})
