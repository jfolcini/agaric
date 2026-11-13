// ---------------------------------------------------------------------------
// Real-backend restore of a space's ZIP export into another space (#6277 G6
// T3, decision 8).
//
// The space's export, unzipped in Node and folder-picked into a second space,
// gives the same pages: each title, a journal day as a journal day, every
// block at its depth, a typed property's definition and its value's type, a
// template page as a template, a done task's date, and each file on its block
// under its own name. Both spaces are read back through the backend after
// navigating away and back, so the comparison is of what each stored.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import JSZip from 'jszip'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  importFolder,
  invoke,
  navigateTo,
  openDataTab,
  pageEntryTitled,
  runScopedMarker,
  switchToSpace,
  takeDownload,
  waitForAppReady,
  waitForToast,
} from './helpers'

/** A journal day far from today, so no space holds it by itself. */
const DAY = '2018-07-09'

interface BlockRow {
  id: string
  parent_id: string | null
  content: string | null
  todo_state: string | null
}

interface PropertyRow {
  key: string
  value_text: string | null
  value_num: number | null
  value_date: string | null
  value_ref: string | null
}

interface Scope {
  kind: 'active'
  space_id: string
}

async function addBlock(spaceId: string, parentId: string, content: string): Promise<string> {
  const block = await invoke<{ id: string }>('create_block', {
    blockType: 'content',
    content,
    parentId,
    index: null,
    scope: { kind: 'active', space_id: spaceId },
    blockId: null,
  })
  return block.id
}

async function setValue(blockId: string, key: string, value: Partial<PropertyRow>): Promise<void> {
  await invoke('set_property', {
    blockId,
    key,
    value: {
      value_text: null,
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
      ...value,
    },
  })
}

/**
 * What a restore must keep of the page `id`: each block's depth, text, task
 * state and files, and the page's and each block's properties, in tree order.
 */
async function pageShape(id: string, scope: Scope, keys: string[]): Promise<string[]> {
  const { blocks } = await invoke<{ blocks: BlockRow[] }>('load_page_subtree', {
    rootBlockId: id,
    scope,
  })
  const children = new Map<string, BlockRow[]>()
  for (const block of blocks) {
    if (block.id === id) continue
    const siblings = children.get(block.parent_id ?? '') ?? []
    siblings.push(block)
    children.set(block.parent_id ?? '', siblings)
  }
  const describe = async (blockId: string): Promise<string> => {
    const properties = await invoke<PropertyRow[]>('get_properties', { blockId })
    const kept = properties
      .filter((row) => keys.includes(row.key))
      .map((row) => `${row.key}=${JSON.stringify([row.value_text, row.value_num, row.value_date])}`)
    const files = await invoke<{ filename: string }[]>('list_attachments', { blockId })
    return [...kept.toSorted(), ...files.map((file) => `file ${file.filename}`).toSorted()].join(
      ' ',
    )
  }
  const rows = [`page ${await describe(id)}`]
  const walk = async (parentId: string, level: number): Promise<void> => {
    for (const block of children.get(parentId) ?? []) {
      const text = (block.content ?? '').replace(/attachment:[0-9A-Z]{26}/g, 'attachment:<id>')
      rows.push(`${level} ${text} ${block.todo_state ?? ''} ${await describe(block.id)}`)
      await walk(block.id, level + 1)
    }
  }
  await walk(id, 0)
  return rows
}

describe('Agaric real-backend restore of a space export into another space (#6277 G6) @markdown @journal @pages', () => {
  it('restores the same pages, blocks and depths, typed properties, template, done date and files', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-g6')
    const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
    const spaceId = (name: string): string => {
      const id = spaces.find((space) => space.name === name)?.id
      if (id === undefined) throw new Error(`no space ${name} in ${JSON.stringify(spaces)}`)
      return id
    }
    const personal = spaceId('Personal')
    const work = spaceId('Work')
    const effort = `${marker.replaceAll('-', '')}effort`
    const due = `${marker.replaceAll('-', '')}due`
    for (const [key, valueType] of [
      [effort, 'number'],
      [due, 'date'],
    ]) {
      await invoke('create_property_def', {
        spaceId: personal,
        key,
        valueType,
        options: null,
      })
    }
    const keys = [effort, due, 'template', 'completed_at']

    const tree = `${marker}-ns/${marker}-tree`
    const treeId = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: tree,
      spaceId: personal,
    })
    const parent = await addBlock(personal, treeId, `${marker}-parent`)
    const child = await addBlock(personal, parent, `${marker}-child`)
    await addBlock(personal, child, `${marker}-grandchild`)
    await addBlock(personal, treeId, `${marker}-sibling`)
    await setValue(treeId, effort, { value_num: 3 })
    await setValue(child, due, { value_date: '2026-06-01' })
    await invoke('add_attachment_with_bytes', {
      blockId: child,
      filename: `${marker} report.pdf`,
      mimeType: 'application/pdf',
      bytes: btoa('%PDF-1'),
    })
    const task = await addBlock(personal, treeId, `${marker}-task`)
    await invoke('set_todo_state', { blockId: task, state: 'DONE' })

    const template = `${marker}-a:b template`
    const templateId = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: template,
      spaceId: personal,
    })
    await addBlock(personal, templateId, `${marker}-template-body`)
    await setValue(templateId, 'template', { value_text: 'true' })

    const dayId = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: DAY,
      spaceId: personal,
    })
    await addBlock(personal, dayId, `${marker}-day`)

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
    const notes = Object.keys(files).filter((name) => name.endsWith('.md')).length

    await switchToSpace('Work')
    await importFolder(
      'import-folder-input',
      `${marker}-export`,
      files,
      `Imported “${notes} files”`,
    )

    // Away and back: both spaces are read again from what the backend stored.
    await navigateTo('Journal')
    await navigateTo('Pages')
    await pageEntryTitled(tree).waitForDisplayed({ timeout: NAV_TIMEOUT })

    const titledIn = async (scope: Scope, title: string): Promise<string> => {
      const pages = await invoke<{ id: string; content: string | null }[]>(
        'list_all_pages_in_space',
        { scope, tagIds: null },
      )
      const matches = pages.filter((page) => page.content === title)
      expect(matches.map((page) => page.content)).toEqual([title])
      return matches[0]?.id ?? ''
    }
    const from: Scope = { kind: 'active', space_id: personal }
    const into: Scope = { kind: 'active', space_id: work }
    for (const title of [tree, template]) {
      expect(await pageShape(await titledIn(into, title), into, keys)).toEqual(
        await pageShape(await titledIn(from, title), from, keys),
      )
    }
    const day = await invoke<{ id: string } | null>('get_journal_page_by_date', {
      date: DAY,
      scope: into,
    })
    if (day === null) throw new Error(`${DAY} is no journal day in Work`)
    expect(await pageShape(day.id, into, keys)).toEqual(await pageShape(dayId, from, keys))

    const defs = await invoke<{ items: { key: string; value_type: string }[] }>(
      'list_property_defs',
      { spaceId: work, cursor: null, limit: null },
    )
    expect(
      [effort, due].map((key) => defs.items.find((def) => def.key === key)?.value_type),
    ).toEqual(['number', 'date'])
  })
})
