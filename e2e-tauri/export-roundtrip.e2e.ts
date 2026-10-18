// ---------------------------------------------------------------------------
// Real-backend export (#5740 items 9 and 10).
//
// Export as Markdown is the backend's `export_page_markdown`; the mock writes
// its own Markdown, so only this lane shows that what the backend writes, the
// backend's importer reads back to the same page. Export this space builds a
// ZIP from every page's export and the attachment bytes, and the file it
// downloads is only on disk here. The two tests share one vault.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import JSZip from 'jszip'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  clipboardText,
  confirmDialog,
  importMarkdownPage,
  navigateTo,
  openNewPage,
  pasteFileIntoFocusedBlock,
  reopenPageByTitle,
  runScopedMarker,
  takeDownload,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

// A 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** A row of the open page: the task chips and the depth it renders. */
interface RowShape {
  id: string
  level: string | null
  task: string | null
  repeat: string | null
  tags: string[]
  links: Array<{ label: string; title: string | null }>
}

/** The rendered shape of the block holding `marker`, once `ready` holds for it. */
async function rowShape(marker: string, ready: (row: RowShape) => boolean): Promise<RowShape> {
  const block = blockStaticByMarker(marker)
  await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
  const id = (await block.getAttribute('data-block-id')) ?? ''
  let shape: RowShape | null = null
  await browser
    .waitUntil(
      async () => {
        shape = await browser.execute((blockId: string) => {
          const li = document.querySelector(`li[data-block-id="${blockId}"]`)
          const row = li?.querySelector('[data-testid="sortable-block"]')
          return {
            id: blockId,
            level: li?.getAttribute('aria-level') ?? null,
            task:
              row?.querySelector('[data-testid="task-marker"]')?.getAttribute('aria-label') ?? null,
            repeat: row?.querySelector('.repeat-indicator')?.getAttribute('aria-label') ?? null,
            tags: [...(row?.querySelectorAll('[data-testid="tag-ref-chip"]') ?? [])].map(
              (chip) => chip.textContent ?? '',
            ),
            links: [...(row?.querySelectorAll('[data-testid="block-link-chip"]') ?? [])].map(
              (chip) => ({ label: chip.textContent ?? '', title: chip.getAttribute('title') }),
            ),
          }
        }, id)
        return shape !== null && ready(shape)
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`the block ${marker} renders ${JSON.stringify(shape)}`)
    })
  return shape as unknown as RowShape
}

/** Open the page kebab's `item`. */
async function pageAction(item: string): Promise<void> {
  const kebab = $('button[aria-label="Page actions"]')
  await kebab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await kebab.click()
  const entry = $('[role="menu"]').$(`[role="menuitem"]*=${item}`)
  await entry.waitForClickable({ timeout: ACTION_TIMEOUT })
  await entry.click()
}

/**
 * The open page's Export as Markdown, read off the clipboard. A sentinel goes
 * on the clipboard first, so an earlier export's toast and text are not taken
 * for this one's.
 */
async function exportOpenPage(): Promise<string> {
  const sentinel = runScopedMarker('wdio-rt-sentinel')
  await browser.execute(async (text: string) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: object) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    await internals.invoke('plugin:clipboard-manager|write_text', { text })
  }, sentinel)
  await pageAction('Export as Markdown')
  let text = sentinel
  await browser
    .waitUntil(
      async () => {
        text = await clipboardText()
        return text !== sentinel
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error('Export as Markdown never put the page on the clipboard')
    })
  return text
}

describe('Agaric real-backend export (#5740)', () => {
  it('re-imports an exported page with its task, repeat rule, tag, labelled link and nesting', async () => {
    const marker = runScopedMarker('wdio-rt')
    const title = `${marker}-page`
    const target = `${marker}-target`
    const task = `${marker}-task`
    const tag = `${marker}-tag`
    const label = `${marker}-label`
    // The tag chip is not read: an imported tag's chip can show its id instead
    // of its name (the resolve store's tag list reads `tags_cache`, which the
    // materializer may not have written yet), so the tag is checked in the
    // export the re-imported page writes.
    const expected = (row: RowShape) =>
      row.task === 'Task: TODO. Click to cycle.' &&
      row.repeat === 'Repeats weekly' &&
      row.tags.length === 1 &&
      row.links.length === 1 &&
      row.links[0]?.label === label &&
      row.links[0].title === target

    await waitForAppReady()
    await importMarkdownPage(target, `- ${target}-body\n`)
    await importMarkdownPage(
      title,
      [
        `- TODO ${task} #${tag} [[${target}|${label}]]`,
        '  repeat:: weekly',
        `- ${marker}-parent`,
        `  - ${marker}-child`,
        '',
      ].join('\n'),
    )
    await navigateTo('Journal')
    await reopenPageByTitle(title)
    const source = await rowShape(task, expected)
    const exported = await exportOpenPage()
    expect(exported).toBe(
      [
        `# ${title}`,
        '',
        `- [ ] ${task} #${tag} [[${target}|${label}]]`,
        '  repeat:: weekly',
        `- ${marker}-parent`,
        `  - ${marker}-child`,
        '',
      ].join('\n'),
    )

    // Trash the source so the import is the only live page of that title.
    await pageAction('Delete page')
    await confirmDialog('Delete page')

    await importMarkdownPage(title, exported)
    await navigateTo('Journal')
    await reopenPageByTitle(title)
    const copy = await rowShape(task, expected)
    expect(copy.id).not.toBe(source.id)
    expect(copy.level).toBe('1')
    expect((await rowShape(`${marker}-parent`, () => true)).level).toBe('1')
    expect((await rowShape(`${marker}-child`, () => true)).level).toBe('2')
    expect(await exportOpenPage()).toBe(exported)
  })

  it('exports the space as a ZIP with a folder per namespace and the image under assets/, linked relatively', async () => {
    const marker = runScopedMarker('wdio-zip')
    const folder = `${marker}-ns`
    const leaf = `${marker}-leaf`
    const filename = 'wdio-zip.png'

    await openNewPage(`${folder}/${leaf}`)
    await typeMarkerVerified(marker)
    await pasteFileIntoFocusedBlock(PNG_BASE64, filename, 'image/png')
    await waitForToast(`Attached "${filename}"`)
    await browser.keys(['Escape'])
    await blockStaticByMarker(marker).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    await navigateTo('Settings')
    const dataTab = $('#settings-tab-data')
    await dataTab.waitForClickable({ timeout: NAV_TIMEOUT })
    await dataTab.click()
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

    const names = Object.keys(zip.files)
    const assets = names.filter((name) => name.startsWith('assets/') && !zip.files[name]?.dir)
    expect(assets).toHaveLength(1)
    const [asset] = assets
    expect(asset).toMatch(new RegExp(`^assets/[0-9A-Z]{26}__${filename.replace('.', '\\.')}$`))
    const bytes = await zip.file(asset ?? '')?.async('base64')
    expect(bytes).toBe(PNG_BASE64)

    const page = await zip.file(`${folder}/${leaf}.md`)?.async('string')
    if (page === undefined) throw new Error(`no ${folder}/${leaf}.md in ${JSON.stringify(names)}`)
    expect(page).toContain(`- ${marker}![${filename}](../${asset})`)
    expect(page).not.toContain('attachment:')
    // The report lists what an export skipped; a clean export has none.
    expect(names).not.toContain('export-report.txt')
  })
})
