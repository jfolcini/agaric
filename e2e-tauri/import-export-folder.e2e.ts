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
// shows them. What a file cannot carry comes back from the export's
// `.agaric/space.json` (#6277 G2): a number property's definition, so its value
// lands as a number, and the title its file name cannot spell (`a:b` is filed as
// `a_b.md`); nothing under `.agaric/` becomes a page.
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

/** A number property only Personal defines, so only the export can define it in Work. */
const KEY = 'wdiorestorelevel'

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
  it('titles each page as the export named it, keeps its namespaced link, its journal day and its typed property', async () => {
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
    const colon = `${marker}-a:b`
    const leafId = await createPage(spaceId('Personal'), leaf, `${marker}-leaf-body`)
    await createPage(spaceId('Personal'), home, `${marker}-link [[${leafId}]]`)
    await createPage(spaceId('Personal'), DAY, `${marker}-day`)
    await invoke('create_property_def', {
      spaceId: spaceId('Personal'),
      key: KEY,
      valueType: 'number',
      options: null,
    })
    const colonId = await createPage(spaceId('Personal'), colon, `${marker}-colon-body`)
    await invoke('set_property', { blockId: colonId, key: KEY, value: { value_num: 42 } })

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
    for (const name of [`${leaf}.md`, `${home}.md`, `${DAY}.md`, `${marker}-a_b.md`]) {
      if (files[name] === undefined)
        throw new Error(`no ${name} in ${JSON.stringify(Object.keys(files))}`)
    }
    const notes = Object.keys(files).filter((name) => name.endsWith('.md')).length
    // A partial export's skip ledger, which must not come back as a page.
    files['.agaric/export-report.txt'] = Buffer.from('Agaric export report\n')

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

    await navigateTo('Pages')
    await pageEntryTitled(colon).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(`span[title="${marker}-a_b"]`, 'a page titled with its file name')
    await expectAbsent('span[title="export-report"]', 'the export report as a page')
    await expectAbsent('span[title=".agaric/export-report"]', 'the export report as a page')
    const work = { kind: 'active', space_id: spaceId('Work') }
    const defs = await invoke<{ items: { key: string; value_type: string }[] }>(
      'list_property_defs',
      { spaceId: spaceId('Work'), cursor: null, limit: null },
    )
    expect(defs.items.find((def) => def.key === KEY)?.value_type).toBe('number')
    const pages = await invoke<{ id: string; content: string | null }[]>(
      'list_all_pages_in_space',
      {
        scope: work,
        tagIds: null,
      },
    )
    const restored = pages.find((page) => page.content === colon)
    if (restored === undefined) throw new Error(`no page ${colon} in Work`)
    const properties = await invoke<{ key: string; value_num: number | null }[]>('get_properties', {
      blockId: restored.id,
    })
    expect(properties.find((row) => row.key === KEY)?.value_num).toBe(42)
  })
})
