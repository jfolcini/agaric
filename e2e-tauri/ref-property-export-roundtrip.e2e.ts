// ---------------------------------------------------------------------------
// A ref-typed property value is written as a link (#6277 F3).
//
// The export writes a page's ref value as `"[[Title]]"` in its front matter,
// which Obsidian reads as a link, and an import reads it back as the same
// page. The mock writes no names, so only the real backend can show it.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  importMarkdownPage,
  invoke,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  switchToSpace,
  waitForAppReady,
} from './helpers'

/** A ref property only this spec defines. */
const KEY = 'wdioowner'

describe('Agaric real-backend ref property export (#6277 F3) @markdown @editor @pages', () => {
  it('exports a page ref as a link and imports it back as the same page', async () => {
    await waitForAppReady()
    await switchToSpace('Personal')
    const marker = runScopedMarker('wdio-refexp')
    const target = `${marker}-target`
    const holder = `${marker}-holder`
    const copy = `${marker}-copy`
    const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
    const spaceId = spaces.find((space) => space.name === 'Personal')?.id
    if (spaceId === undefined) throw new Error(`no Personal space in ${JSON.stringify(spaces)}`)
    const scope = { kind: 'active', space_id: spaceId }
    await invoke('create_property_def', { spaceId, key: KEY, valueType: 'ref', options: null })
    const targetId = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: target,
      spaceId,
    })
    const holderId = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: holder,
      spaceId,
    })
    await invoke('create_block', {
      blockType: 'content',
      content: `${marker}-held`,
      parentId: holderId,
      index: null,
      scope,
      blockId: null,
    })
    await invoke('set_property', { blockId: holderId, key: KEY, value: { value_ref: targetId } })

    const md = await invoke<string>('export_page_markdown', { pageId: holderId })
    expect(md).toContain(`${KEY}: "[[${target}]]"\n`)

    await importMarkdownPage(copy, md)

    // Away and back, so the page and its property table are read again.
    await navigateTo('Journal')
    await reopenPageByTitle(copy)
    const header = $('.page-property-table-header')
    await header.waitForClickable({
      timeout: NAV_TIMEOUT,
      timeoutMsg: `the page ${copy} shows no property table`,
    })
    await header.click()
    const value = $(`button[aria-label="${KEY} value"]`)
    await browser.waitUntil(async () => (await value.getText()) === target, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the page ${copy}'s ${KEY} never showed ${target}`,
    })
    const pages = await invoke<{ id: string; content: string | null }[]>(
      'list_all_pages_in_space',
      { scope, tagIds: null },
    )
    const copyId = pages.find((page) => page.content === copy)?.id
    if (copyId === undefined) throw new Error(`no page ${copy} in Personal`)
    const rows = await invoke<{ key: string; value_ref: string | null }[]>('get_properties', {
      blockId: copyId,
    })
    expect(rows.find((row) => row.key === KEY)?.value_ref).toBe(targetId)
  })
})
