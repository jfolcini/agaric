// ---------------------------------------------------------------------------
// Real-backend folder import of the space's own ZIP export (#6277 G1).
//
// A folder pick's files carry the picked folder's name in front of their
// paths; the import titles each page by its path below that folder (#6277
// decision 8), so an unzipped export folder-picked into another space comes
// back with its titles as they were: a namespaced page keeps its namespace and
// no title gains the folder's name, the namespaced link in another page opens
// the page holding that page's blocks, not an empty twin, and a journal day
// is a journal day again (`get_journal_page_by_date`). Titles, the link and the
// journal lookup are the backend's (`parse_import_payload`), so only this lane
// shows them.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import JSZip from 'jszip'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  importFolder,
  invoke,
  navigateTo,
  openDataTab,
  openPageTitled,
  pageEntryTitled,
  runScopedMarker,
  switchToSpace,
  takeDownload,
  waitForAppReady,
  waitForToast,
} from './helpers'

/** The journal day the export carries; far from today, so no space holds it by itself. */
const DAY = '2019-03-14'

async function createPage(spaceId: string, title: string, block: string): Promise<string> {
  const page = await invoke<string>('create_page_in_space', {
    parentId: null,
    content: title,
    spaceId,
  })
  await invoke('create_block', {
    blockType: 'content',
    content: block,
    parentId: page,
    index: null,
    scope: { kind: 'active', space_id: spaceId },
    blockId: null,
  })
  return page
}

describe('Agaric real-backend restore of an export by folder import (#6277 G1) @markdown', () => {
  it('titles each page as the export named it, keeps its namespaced link and its journal day', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-restore')
    const leaf = `${marker}-ns/${marker}-leaf`
    const home = `${marker}-home`
    const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
    const spaceId = (name: string): string => {
      const id = spaces.find((space) => space.name === name)?.id
      if (id === undefined) throw new Error(`no space ${name} in ${JSON.stringify(spaces)}`)
      return id
    }
    const leafId = await createPage(spaceId('Personal'), leaf, `${marker}-leaf-body`)
    await createPage(spaceId('Personal'), home, `${marker}-link [[${leafId}]]`)
    await createPage(spaceId('Personal'), DAY, `${marker}-day`)

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
    for (const name of [`${leaf}.md`, `${home}.md`, `${DAY}.md`]) {
      if (files[name] === undefined)
        throw new Error(`no ${name} in ${JSON.stringify(Object.keys(files))}`)
    }
    const notes = Object.keys(files).filter((name) => name.endsWith('.md')).length

    const folder = `${marker}-export`
    await switchToSpace('Work')
    await importFolder('import-folder-input', folder, files, `Imported “${notes} files”`)

    await navigateTo('Journal')
    await navigateTo('Pages')
    await pageEntryTitled(leaf).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(`span[title="${folder}/${leaf}"]`, "a page titled with the folder's name")
    await openPageTitled(home)
    const linker = blockStaticByMarker(`${marker}-link`)
    await linker.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const linkerId = await linker.getAttribute('data-block-id')
    const chip = $(`li[data-block-id="${linkerId}"] [data-testid="block-link-chip"]`)
    await chip.waitForClickable({ timeout: NAV_TIMEOUT })
    await chip.click()
    await browser.waitUntil(async () => (await $('[aria-label="Page title"]').getText()) === leaf, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `the link never opened ${leaf}`,
    })
    await blockStaticByMarker(`${marker}-leaf-body`).waitForDisplayed({ timeout: NAV_TIMEOUT })

    const day = await invoke<{ content: string } | null>('get_journal_page_by_date', {
      date: DAY,
      scope: { kind: 'active', space_id: spaceId('Work') },
    })
    expect(day?.content).toBe(DAY)
  })
})
