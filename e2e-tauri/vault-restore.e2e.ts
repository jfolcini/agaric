// ---------------------------------------------------------------------------
// Real-backend restore of a whole-vault export by folder import (#6554).
//
// *Export all spaces* writes one folder per space, each with a space file
// naming its space; a folder pick of the unzipped ZIP restores every space
// with its property definitions, after one confirmation, instead of filing
// every note into the active space. Space creation, the typed values and the
// titles are the backend's, so only this lane shows them.
//
// One vault per spec file, and its seeded Personal and Work cannot be emptied
// cheaply, so "an empty vault" is modelled by spaces that do not exist yet:
// the two space folders, and the names their space files carry, are renamed
// to run-scoped names before the pick. A second pick of the same folder
// imports into the spaces the first created, not into two more.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import JSZip from 'jszip'

import {
  ACTION_TIMEOUT,
  importFolder,
  invoke,
  openDataTab,
  runScopedMarker,
  switchToSpace,
  takeDownload,
  waitForAppReady,
  waitForToast,
} from './helpers'

interface Space {
  id: string
  name: string
}

/**
 * A number property and a page holding `value` for it, both in `spaceId`. The
 * page has a block, so a second import of it is a merge, which asks first.
 */
async function seedTypedPage(spaceId: string, key: string, title: string, value: number) {
  await invoke('create_property_def', { spaceId, key, valueType: 'number', options: null })
  const page = await invoke<string>('create_page_in_space', {
    parentId: null,
    content: title,
    spaceId,
  })
  await invoke('set_property', { blockId: page, key, value: { value_num: value } })
  await invoke('create_block', {
    blockType: 'content',
    content: `${title}-body`,
    parentId: page,
    index: null,
    scope: { kind: 'active', space_id: spaceId },
    blockId: null,
  })
}

async function pagesIn(spaceId: string): Promise<{ id: string; content: string | null }[]> {
  return invoke('list_all_pages_in_space', {
    scope: { kind: 'active', space_id: spaceId },
    tagIds: null,
  })
}

describe('Agaric real-backend restore of an Export all spaces ZIP (#6554) @markdown @spaces', () => {
  it('recreates each space with its typed definition and page, and a second pick duplicates none', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-vault')
    const seeded = await invoke<Space[]>('list_spaces')
    const idOf = (spaces: Space[], name: string): string => {
      const matches = spaces.filter((space) => space.name === name)
      if (matches.length !== 1)
        throw new Error(`not one space ${name} in ${JSON.stringify(spaces)}`)
      return matches[0]?.id ?? ''
    }
    // Each seeded space's folder, its page, its key and value, and the new space it restores into.
    const restores = [
      { from: 'Personal', to: `${marker}-a`, page: `${marker}-pa`, key: 'wdiovaultpa', value: 42 },
      { from: 'Work', to: `${marker}-b`, page: `${marker}-pb`, key: 'wdiovaultpb', value: 7 },
    ]
    for (const { from, page, key, value } of restores) {
      await seedTypedPage(idOf(seeded, from), key, page, value)
    }

    await openDataTab()
    const exportButton = $('[data-testid="export-all-spaces-button"]')
    await exportButton.waitForClickable({ timeout: ACTION_TIMEOUT })
    const since = Date.now()
    await exportButton.click()
    await waitForToast(`Exported ${seeded.length} spaces`)
    const zip = await JSZip.loadAsync(
      await takeDownload(/^agaric-export-all-spaces-\d{4}-\d{2}-\d{2}( \(\d+\))?\.zip$/, since),
    )
    const files: Record<string, Buffer> = {}
    for (const { from, to } of restores) {
      for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir || !name.startsWith(`${from}/`)) continue
        files[`${to}/${name.slice(from.length + 1)}`] = await entry.async('nodebuffer')
      }
      const spaceFile = files[`${to}/.agaric/space.json`]
      if (spaceFile === undefined) throw new Error(`the export wrote no space file for ${from}`)
      const space = JSON.parse(spaceFile.toString('utf8')) as { name?: string }
      expect(space.name).toBe(from)
      files[`${to}/.agaric/space.json`] = Buffer.from(JSON.stringify({ ...space, name: to }))
    }
    const notes = Object.keys(files).filter((name) => name.endsWith('.md')).length
    const folder = `${marker}-vault`

    await switchToSpace('Personal')
    await importFolder(
      'import-folder-input',
      folder,
      files,
      `Imported “${notes} files”`,
      'Restore spaces',
    )

    const restored = await invoke<Space[]>('list_spaces')
    expect(restored.length).toBe(seeded.length + 2)
    for (const { to, page, key, value } of restores) {
      const spaceId = idOf(restored, to)
      const defs = await invoke<{ items: { key: string; value_type: string }[] }>(
        'list_property_defs',
        { spaceId, cursor: null, limit: null },
      )
      expect(defs.items.find((def) => def.key === key)?.value_type).toBe('number')
      const pageRow = (await pagesIn(spaceId)).filter((row) => row.content === page)
      expect(pageRow.length).toBe(1)
      const properties = await invoke<{ key: string; value_num: number | null }[]>(
        'get_properties',
        { blockId: pageRow[0]?.id },
      )
      expect(properties.find((row) => row.key === key)?.value_num).toBe(value)
    }
    // The active space holds its own page once, and none filed under a folder's name.
    const active = (await pagesIn(idOf(restored, 'Personal'))).map((row) => row.content ?? '')
    expect(active.filter((title) => title === `${marker}-pa`).length).toBe(1)
    expect(active.filter((title) => title === `${marker}-pb`).length).toBe(0)
    expect(active.filter((title) => title.startsWith(`${marker}-`) && title.includes('/'))).toEqual(
      [],
    )

    // Their pages exist now, so the second pick also asks, space by space, before updating them.
    await importFolder('import-folder-input', folder, files, `Imported “${notes} files”`, [
      'Restore spaces',
      'Update and import',
      'Update and import',
    ])
    expect((await invoke<Space[]>('list_spaces')).length).toBe(seeded.length + 2)
  })
})
