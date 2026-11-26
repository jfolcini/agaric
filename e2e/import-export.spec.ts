import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Page } from '@playwright/test'
import JSZip from 'jszip'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  getInvokeCalls,
  importFile,
  importFolder,
  installIpcRecorder,
  ipc,
  navigateToDataSettings,
  navigateToView,
  openPage,
  reopenTitled,
  rowOf,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E tests for import/export functionality.
 *
 * Covers:
 *  1. Export page as markdown — trigger export from kebab menu, verify clipboard content
 *  2. Import markdown — upload a .md file via StatusPanel, verify blocks are created
 *  3. Export preserves block structure — export page with multiple blocks, verify hierarchy
 *  4. Export includes tags and links — the export names them (backend only)
 *  5. Round-trip fidelity — export a page, verify content matches original blocks
 *  6. Export all pages as ZIP (#2707) — trigger Settings → Data → "Export this space",
 *     capture the real browser download, and unzip it (via the same `jszip`
 *     package the app itself uses) to assert the namespace hierarchy round-trips.
 *  7. Import warning summary (#2707) — the mock's `import_markdown` handler always
 *     appends one representative parse warning (handlers.ts, "dev-preview mock:
 *     attachments are not imported"); assert the result panel's warnings
 *     heading + list render it.
 *  8. The real importer — depth, links, task keywords, properties and callouts,
 *     which the mock's import does not model (backend only)
 *
 * Seed data (`src/lib/tauri-mock/seed.ts`):
 *   PAGE_GETTING_STARTED ("Getting Started") — 5 child blocks, some with [[link]] and #[tag] tokens
 *   PAGE_QUICK_NOTES ("Quick Notes") — 2 child blocks with [[link]] to Getting Started
 *   PAGE_DAILY (today's date) — 5 child blocks with tasks
 *   PAGE_PROJECTS ("Projects"), PAGE_MEETINGS ("Meetings"), PAGE_TMPL_MEETING
 *   ("Meeting Notes Template") — also stamped into SPACE_PERSONAL (the mock's
 *   only/default active space), so all 6 are the pages a ZIP export of the
 *   active space is expected to contain.
 */

/** Local YYYY-MM-DD, matching `date-utils.formatDate` / the seed's `todayDate()`. */
function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ===========================================================================
// Helper: open the kebab menu on the current page and click Export → "Copy as Markdown"
// ===========================================================================

async function triggerExport(page: import('@playwright/test').Page) {
  // Open the kebab (⋮) overflow menu in PageHeader
  const kebabButton = page.getByRole('button', { name: 'Page actions' })
  await expect(kebabButton).toBeVisible()
  await kebabButton.click()

  // Open the Export submenu, then click its "Copy as Markdown" row
  await page.getByRole('menuitem', { name: 'Export', exact: true }).click()
  await page.getByText('Copy as Markdown').click()
}

// ===========================================================================
/**
 * The first line of each block of a page's export: its lines below the
 * `# Title` line that start at column 0. The export lays a page out as Edit as
 * Markdown does (#6277 E2): a plain block is a paragraph, a list block or a
 * task opens with its marker, and property lines and children are indented.
 */
function exportedBlockLines(markdown: string): string[] {
  const lines = markdown.split('\n')
  const title = lines.findIndex((line) => line.startsWith('# '))
  return lines.slice(title + 1).filter((line) => line !== '' && !/^\s/.test(line))
}

// ===========================================================================
// 1. Export page as markdown
// ===========================================================================

test.describe('Export page as markdown @markdown', () => {
  test.beforeEach(async ({ context, page }) => {
    // `handleExport` awaits `exportPageMarkdown(pageId)` before calling
    // `navigator.clipboard.writeText(...)`. That awaited promise resolution
    // breaks the user-activation chain from the kebab click, so Chromium
    // rejects the clipboard write unless `clipboard-write` is granted
    // upfront. Without it, PageHeader's catch branch fires and shows the
    // "Export failed" toast instead of "Markdown copied to clipboard".
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await waitForBoot(page)
  })

  test('export copies markdown to clipboard with page title as heading', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Grant clipboard permissions and set up clipboard interception
    // Since clipboard access may be restricted, we intercept the toast message
    // which confirms the export happened successfully
    await triggerExport(page)

    // The toast "Markdown copied to clipboard" should appear
    await expect(page.getByText('Markdown copied to clipboard')).toBeVisible({ timeout: 5000 })
  })

  test('export produces valid markdown structure via evaluate', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Directly call the mock's export_page_markdown via page.evaluate
    // to verify the content structure without clipboard dependency
    const markdown = await page.evaluate(() => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke('export_page_markdown', { pageId: '00000000000000000000PAGE01' })
    })

    // The page's front matter, then its title as a heading (#6277 A1)
    expect(markdown).toMatch(/^---\naliases: \[getting-started, gs\]\n---\n\n# Getting Started\n\n/)

    // Each plain child block is a paragraph of its own (#6277 E2)
    expect(markdown).toContain('\n\nWelcome to Agaric!')
    expect(markdown).toContain('\n\nUse the sidebar to navigate')
    expect(markdown).toContain('\n\nCreate new blocks by pressing Enter')
  })
})

// ===========================================================================
// 1b. Export all pages as ZIP (#2707)
// ===========================================================================
//
// `handleExportAll` (ExportSection.tsx) calls `exportGraphAsZip` (src/lib/export-graph.ts),
// which is REAL, unmocked client-side code: it lists pages via the
// `list_all_pages_in_space` IPC, exports each via `export_page_markdown`, zips
// them with the real `jszip` package, and triggers a real browser download via
// an `<a download>` click. None of that is mocked, so — unlike most of this
// suite — the resulting ZIP is a genuine downloadable artifact Playwright can
// intercept with `page.waitForEvent('download')` and unzip for real (using the
// same `jszip` package, imported directly into this Node-side spec).

test.describe('Export all pages as ZIP @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Export this space downloads a ZIP whose entries mirror the page set', async ({ page }) => {
    await installIpcRecorder(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Data' }).click()
    await expect(page.locator('[data-testid="export-panel-title"]')).toBeVisible()

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export this space', exact: true }).click(),
    ])

    // Filename: `agaric-export-<space>-<date>.zip` (DataTab.tsx handleExportAll).
    // The active (only) mock space is "Personal" -> sanitized "personal".
    expect(download.suggestedFilename()).toMatch(/^agaric-export-personal-\d{4}-\d{2}-\d{2}\.zip$/)

    // "Export complete" toast (data.exportSuccess).
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 5000 })

    // Real IPC calls fired: one page listing, then one export per page.
    const listCalls = await getInvokeCalls(page, 'list_all_pages_in_space')
    expect(listCalls.length).toBeGreaterThanOrEqual(1)
    const exportCalls = await getInvokeCalls(page, 'export_page_markdown')
    // 6 pages stamped into SPACE_PERSONAL: Getting Started, Quick Notes,
    // the daily page (today's date), Projects, Meetings, and the "Meeting
    // Notes Template" page (PAGE_TMPL_MEETING is a real `block_type: 'page'`
    // row, so it is exported like any other page).
    expect(exportCalls.length).toBe(6)

    // Unzip the REAL downloaded bytes (not a mock) and assert the namespace
    // hierarchy round-trips: every page title becomes `<title>.md` at the
    // ZIP root (none of the seed pages are namespaced with `/`).
    const stream = await download.createReadStream()
    expect(stream).not.toBeNull()
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      stream?.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream?.on('end', () => resolve())
      stream?.on('error', reject)
    })
    const zip = await JSZip.loadAsync(Buffer.concat(chunks))
    const todayStr = localDateStr(new Date())
    const names = Object.keys(zip.files).toSorted()
    expect(names).toEqual(
      [
        '.agaric/',
        '.agaric/space.json',
        'Getting Started.md',
        'Meeting Notes Template.md',
        'Meetings.md',
        'Projects.md',
        'Quick Notes.md',
        `${todayStr}.md`,
      ].toSorted(),
    )

    // Spot-check one entry's content round-trips the same export the
    // per-page "Copy as Markdown" flow produces.
    // The path names the page, so the file drops its `# Title` line, and the
    // space's typed definitions travel beside it (#6277 decision 8).
    const gettingStarted = await zip.file('Getting Started.md')?.async('string')
    expect(gettingStarted).not.toContain('# Getting Started')
    expect(gettingStarted).toContain('\n\nWelcome to Agaric!')
    const space = JSON.parse((await zip.file('.agaric/space.json')?.async('string')) ?? '{}')
    expect(space.propertyDefinitions).toContainEqual({
      key: 'project',
      value_type: 'select',
      options: JSON.stringify(['alpha', 'beta', 'gamma']),
    })
  })
})

// ===========================================================================
// 2. Import markdown
// ===========================================================================

test.describe('Import markdown @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('importing a markdown file creates blocks and shows success toast', async ({ page }) => {
    await navigateToDataSettings(page)

    // Create a synthetic file and set it on the hidden file input
    const fileInput = page.locator('[data-testid="import-file-input"]')

    // Use setInputFiles to upload a markdown file
    const mdContent =
      '# Test Import Page\n\n- First block content\n- Second block content\n- Third block content\n'
    await fileInput.setInputFiles({
      name: 'test-import.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(mdContent),
    })

    // Success toast should appear
    await expect(page.getByText(/Imported \d+ blocks/)).toBeVisible({ timeout: 5000 })

    // The import result card should show the page title and block count
    const importResult = page.locator('[data-testid="import-result"]')
    await expect(importResult).toBeVisible()
    // Title is filename-derived (#1919): 'test-import.md' -> 'test-import'.
    // A leading `# heading` is ordinary content, not a title source.
    await expect(importResult).toContainText('test-import')
    // 4 blocks: the `# Test Import Page` heading line is content (1) plus the
    // three `- ` bullets (3). Blank lines are dropped.
    await expect(importResult).toContainText('4 blocks')
  })

  test('imported page appears in the page list', async ({ page }) => {
    await navigateToDataSettings(page)

    // Import a markdown file
    const fileInput = page.locator('[data-testid="import-file-input"]')
    const mdContent = '# My Imported Notes\n\n- Note one\n- Note two\n'
    await fileInput.setInputFiles({
      name: 'my-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(mdContent),
    })

    // Wait for import to complete
    await expect(page.getByText(/Imported \d+ blocks/)).toBeVisible({ timeout: 5000 })

    // Navigate to Pages and verify the imported page is listed
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    // Title is filename-derived (#1919): 'my-notes.md' -> 'my-notes'.
    await expect(page.getByText('my-notes')).toBeVisible({ timeout: 5000 })
  })

  test('importing a file without heading uses filename as page title', async ({ page }) => {
    await navigateToDataSettings(page)

    // Import markdown without a heading — title should come from filename
    const fileInput = page.locator('[data-testid="import-file-input"]')
    const mdContent = '- Block without a heading\n- Another block\n'
    await fileInput.setInputFiles({
      name: 'no-heading-page.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(mdContent),
    })

    // Import result should show filename-derived title
    const importResult = page.locator('[data-testid="import-result"]')
    await expect(importResult).toBeVisible()
    await expect(importResult).toContainText('no-heading-page')
  })

  // #2707 — the mock's `import_markdown` handler (handlers.ts) unconditionally
  // appends one representative parse warning to every successful import
  // ("dev-preview mock: attachments are not imported (kept as literal text)";
  // tags resolve since #5160 N4), so the result panel's warnings summary is exercisable on
  // ANY import — no special seeding required. This was never asserted despite
  // every other import test in this file uploading a file that triggers it.
  test(
    'import result panel shows the warning count and message',
    { tag: '@mock-only' },
    async ({ page }) => {
      await navigateToDataSettings(page)

      const fileInput = page.locator('[data-testid="import-file-input"]')
      const mdContent = '- A single content block\n'
      await fileInput.setInputFiles({
        name: 'warnings-check.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(mdContent),
      })

      await expect(page.getByText(/Imported \d+ blocks/)).toBeVisible({ timeout: 5000 })

      const importResult = page.locator('[data-testid="import-result"]')
      await expect(importResult).toBeVisible()

      // Collapsed <details> — the heading itself is visible without expanding.
      const detailsToggle = page.getByTestId('import-warnings-heading')
      await expect(detailsToggle).toBeVisible()
      await expect(detailsToggle).toHaveText('1 warning')

      // Expand the <details> to reveal the actual warning message.
      await page.getByTestId('import-result-details').locator('summary').click()
      const warningItem = page.getByTestId('import-warning-item')
      await expect(warningItem).toBeVisible()
      await expect(warningItem).toContainText('attachments are not imported')
    },
  )

  // #2707 — `key:: value` property lines count into `properties_set`, driving
  // the result summary's ", N properties" suffix. A paragraph, as a `- ` item
  // also stores its list style (#6190), which the mock does not count.
  test('import result summary includes the properties-set count', async ({ page }) => {
    await navigateToDataSettings(page)

    const fileInput = page.locator('[data-testid="import-file-input"]')
    const mdContent = 'A paragraph with a property\nmood:: open\n'
    await fileInput.setInputFiles({
      name: 'properties-check.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(mdContent),
    })

    const importResult = page.locator('[data-testid="import-result"]')
    await expect(importResult).toBeVisible()
    await expect(importResult).toContainText('1 property')
  })
})

// ===========================================================================
// 2b. Folder import of other formats (#6032). The mock models titles and block
// text but no property, task keyword or nesting, so the Org task state, the
// Notion properties and the resolved links are under "The real importer".
// ===========================================================================

test.describe('Folder import of Notion, Org and text files @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('titles each page as its source names it and turns a Notion aside into a callout', async ({
    page,
  }) => {
    const id = '0123456789abcdef0123456789abcdef'
    const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'pw-6032-')), 'Export')
    mkdirSync(root)
    const files: Record<string, string> = {
      [`Plan ${id}.md`]: '# Plan\n\nStatus: Active\n\n<aside>\n💡 Mind the deadline.\n</aside>\n',
      [`Notes ${id.replace('0', '1')}.md`]: '# Notes\n\nA note.\n',
      [`Tasks ${id}.csv`]: 'Name,Status\n',
      'tasks.org': '#+TITLE: Org Tasks\n* TODO Write report\n',
      'reading.txt': '- a text file\n',
    }
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text)

    await navigateToDataSettings(page)
    await page.locator('[data-testid="import-folder-input"]').setInputFiles(root)

    const importResult = page.locator('[data-testid="import-result"]')
    await expect(importResult).toContainText('4 files')
    await page.getByTestId('import-result-details').locator('summary').click()
    await expect(page.getByTestId('import-warning-item').first()).toContainText(
      'Skipped 1 Notion database table (.csv)',
    )

    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    // The picked folder's own name is no part of a title (#6277 decision 8).
    for (const title of ['Plan', 'Notes', 'Org Tasks', 'reading']) {
      await expect(page.locator(`span[data-page-title="${title}"]`)).toBeVisible()
    }
    await expect(page.locator(`span[data-page-title="Plan ${id}"]`)).toHaveCount(0)
    await expect(page.locator('span[data-page-title="Export/Plan"]')).toHaveCount(0)

    await page.locator('span[data-page-title="Plan"]').click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Plan')
    await expect(page.getByTestId('callout-block')).toContainText('Mind the deadline.')
  })
})

// #6554 — a folder pick of an unzipped Export all spaces ZIP restores each
// space; e2e/import-formats.spec.ts runs a real export of it against the backend.
test.describe('Restore of a whole-vault export @markdown @spaces', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('imports each space folder into the space of its name, created when missing, once confirmed', async ({
    page,
  }) => {
    const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'pw-6554-')), 'Vault')
    const spaceFile = (name: string, keys: string[]) =>
      JSON.stringify({
        name,
        propertyDefinitions: keys.map((key) => ({ key, value_type: 'number', options: null })),
        titles: {},
      })
    const files: Record<string, string> = {
      'Personal/.agaric/space.json': spaceFile('Personal', []),
      'Personal/Restored Roadmap.md': '- from the vault\n',
      'Travel_x/.agaric/space.json': spaceFile('Travel/x', ['pwrestoreeffort']),
      'Travel_x/Trip.md': '- go\n',
      '.agaric/export-report.txt': 'Agaric export report\n',
    }
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
      writeFileSync(path.join(root, name), text)
    }

    await navigateToDataSettings(page)
    await page.locator('[data-testid="import-folder-input"]').setInputFiles(root)
    const dialog = page.getByTestId('import-vault-dialog')
    await expect(dialog).toContainText('Personal: imported into the existing space')
    await expect(dialog).toContainText('Travel/x: created')
    await dialog.getByRole('button', { name: 'Restore spaces' }).click()
    await expect(page.locator('[data-testid="import-result"]')).toContainText('2 files')

    const spaces = await ipc<{ id: string; name: string }[]>(page, 'list_spaces', undefined)
    expect(spaces.map(({ name }) => name).toSorted()).toEqual(['Personal', 'Travel/x', 'Work'])
    const spaceId = (name: string) => spaces.find((space) => space.name === name)?.id
    const titles = async (name: string): Promise<(string | null)[]> =>
      (
        await ipc<{ content: string | null }[]>(page, 'list_all_pages_in_space', {
          scope: { kind: 'active', space_id: spaceId(name) },
          tagIds: null,
        })
      ).map(({ content }) => content)
    expect(await titles('Travel/x')).toEqual(['Trip'])
    expect(await titles('Personal')).toContain('Restored Roadmap')
    expect(await titles('Personal')).not.toContain('Trip')
    const defs = await ipc<{ items: { key: string; value_type: string }[] }>(
      page,
      'list_property_defs',
      { spaceId: spaceId('Travel/x'), cursor: null, limit: null },
    )
    expect(defs.items.find(({ key }) => key === 'pwrestoreeffort')?.value_type).toBe('number')
  })
})

test.describe('Evernote links between notes @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('#6032 — links a note to the note of its file the link text names, and warns for the rest', async ({
    page,
  }) => {
    const link = (text: string) => `<a href="evernote:///view/1/s1/g/g/">${text}</a>`
    const note = (title: string, enml: string) =>
      `<note><title>${title}</title><content><![CDATA[<en-note>${enml}</en-note>]]></content></note>`
    const notes = [
      note('Plan', `<div>See ${link('Meeting')} and ${link('Elsewhere')}</div>`),
      note('Meeting', '<div>Agenda</div>'),
    ]
    const enex = `<?xml version="1.0" encoding="UTF-8"?><en-export>${notes.join('')}</en-export>`

    await navigateToDataSettings(page)
    await page.locator('[data-testid="import-enex-input"]').setInputFiles({
      name: 'Work.enex',
      mimeType: 'application/xml',
      buffer: Buffer.from(enex),
    })
    await expect(page.locator('[data-testid="import-result"]')).toContainText('2 notes')
    await page.getByTestId('import-result-details').locator('summary').click()
    await expect(
      page.getByTestId('import-warning-item').filter({ hasText: 'Evernote note link' }),
    ).toHaveText('1 Evernote note link stays an Evernote link: its text names no note in its file.')

    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await page.locator('span[data-page-title="Work/Plan"]').click()
    const block = page.locator('[data-testid="block-static"]', { hasText: 'See' })
    await expect(block.getByTestId('block-link-chip')).toHaveAttribute('title', 'Work/Meeting')
  })
})

// ===========================================================================
// 2c. What only the real importer stores. The mock's `import_markdown` is a
// declared approximation (flat, no nesting, links, task keywords, properties or
// callouts; src/lib/tauri-mock/handlers/pages.ts), so these run on the bridge
// only. Each asserts on a page reopened from a fresh backend read.
// ===========================================================================

const LOGSEQ_CONFIG = '{:file/name-format :triple-lowbar}\n'

/** Import `markdown` as the page `title` of a Logseq graph, read as `LogseqOrg` (#6277 E1). */
async function importLogseqPage(page: Page, title: string, markdown: string, summary?: string) {
  await importFolder(
    page,
    'import-folder-input',
    `${title}-graph`,
    { 'logseq/config.edn': LOGSEQ_CONFIG, [`pages/${title}.md`]: markdown },
    summary ?? `Imported “${title}”`,
  )
}

/** The id of the page titled `title` in Personal. */
async function pageIdTitled(page: Page, title: string): Promise<string> {
  const pages = await ipc<{ id: string; content: string | null }[]>(
    page,
    'list_all_pages_in_space',
    { scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }, tagIds: null },
  )
  const found = pages.filter((p) => p.content === title)
  expect(found, `pages titled ${title}`).toHaveLength(1)
  return found[0]?.id ?? ''
}

/** The task marker of `text`'s row reads `state`. */
async function expectTaskState(page: Page, text: string, state: string) {
  await expect(rowOf(page, text).getByTestId('task-marker')).toHaveAttribute(
    'aria-label',
    new RegExp(`^Task: ${state}`),
  )
}

test.describe('The real importer @markdown', { tag: '@real-only' }, () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  // #4671 — two-space indentation is depth; a `[[link]]` creates its page.
  test('an indented list keeps its depth, and its [[link]] resolves to the page it creates', async ({
    page,
  }) => {
    await importFile(
      page,
      'import-file-input',
      'nest-doc.md',
      '- nest-parent\n  - nest-child\n    - nest-leaf links [[nest-target]]\n',
      'Imported “nest-doc”: 3 blocks',
    )
    await reopenTitled(page, 'nest-doc')
    await expect(rowOf(page, 'nest-parent')).toHaveAttribute('aria-level', '1')
    await expect(rowOf(page, 'nest-child')).toHaveAttribute('aria-level', '2')
    await expect(rowOf(page, 'nest-leaf')).toHaveAttribute('aria-level', '3')
    await expect(rowOf(page, 'nest-leaf').getByTestId('block-link-chip')).toHaveAttribute(
      'data-id',
      await pageIdTitled(page, 'nest-target'),
    )
  })

  // #5160 — the title line is the title, a heading owns nothing, a fence is one
  // block, and list items nest by their content column (#6277 decision 1).
  test('a README is headings owning nothing, paragraphs, a fence and nested list items', async ({
    page,
  }) => {
    const markdown = [
      '# readme-doc',
      '',
      'readme-intro is a tiny grep clone.',
      '',
      '## readme-install',
      '',
      '```sh',
      'cargo install readme-bin',
      '```',
      '',
      '## readme-usage',
      '',
      '1. readme-build the index',
      '2. readme-search for a needle',
      '',
      '## readme-features',
      '',
      '* readme-regex support',
      '* readme-ignore files',
      '  * readme-nested ignore files',
      '',
    ].join('\n')
    // The intro, three headings, the fence, two numbered items, two starred
    // items and the nested one; the title line is not a block.
    await importFile(
      page,
      'import-file-input',
      'readme-doc.md',
      markdown,
      'Imported “readme-doc”: 10 blocks',
    )
    await reopenTitled(page, 'readme-doc')
    for (const text of [
      'readme-intro',
      'readme-install',
      'readme-features',
      'cargo install readme-bin',
      'readme-build',
      'readme-regex',
    ]) {
      await expect(rowOf(page, text)).toHaveAttribute('aria-level', '1')
    }
    await expect(rowOf(page, 'readme-nested')).toHaveAttribute('aria-level', '2')
    await expect(rowOf(page, 'readme-doc')).toHaveCount(0)
  })

  // #6751 — a block that is one comment is a comment callout; one inside a sentence stays text.
  test('an Obsidian comment block is a comment callout, and one inside a sentence stays text', async ({
    page,
  }) => {
    const markdown = [
      '%%comment-oneline%%',
      '',
      '%%',
      'comment-first',
      'comment-second',
      '%%',
      '',
      'comment-said %%aside%% more',
      '',
    ].join('\n')
    await importFile(
      page,
      'import-file-input',
      'comment-vault.md',
      markdown,
      'Imported “comment-vault”',
    )
    await reopenTitled(page, 'comment-vault')
    const oneLine = rowOf(page, 'comment-oneline')
    await expect(oneLine.getByTestId('callout-block')).toHaveAttribute(
      'data-callout-type',
      'comment',
    )
    await expect(oneLine).not.toContainText('%%')
    const multiLine = rowOf(page, 'comment-first')
    await expect(multiLine.getByTestId('callout-block')).toHaveAttribute(
      'data-callout-type',
      'comment',
    )
    await expect(multiLine).toContainText('comment-second')
    await expect(multiLine).not.toContainText('%%')
    const inline = rowOf(page, 'comment-said')
    await expect(inline).toContainText('%%aside%%')
    await expect(inline.getByTestId('callout-block')).toHaveCount(0)
  })

  // #5160 D12 — one file per IPC, in pick order: a file titled like the empty
  // page an earlier file's link created adopts it, in either order.
  for (const order of ['linker-first', 'target-first'] as const) {
    test(`a second file adopts the page an earlier link created (${order})`, async ({ page }) => {
      const runs: [string, string, string][] = [
        ['adopt-A.md', '- adopt-links [[adopt-B]]\n', 'adopt-A'],
        ['adopt-B.md', '- adopt-body\n', 'adopt-B'],
      ]
      if (order === 'target-first') runs.reverse()
      for (const [name, text, title] of runs) {
        await importFile(page, 'import-file-input', name, text, `Imported “${title}”`)
      }
      const target = await pageIdTitled(page, 'adopt-B')
      await reopenTitled(page, 'adopt-B')
      await expect(rowOf(page, 'adopt-body')).toBeVisible()
      await reopenTitled(page, 'adopt-A')
      await expect(rowOf(page, 'adopt-links').getByTestId('block-link-chip')).toHaveAttribute(
        'data-id',
        target,
      )
    })
  }

  // #6033 — a graph's page and journal titles are Logseq's; the backend makes
  // `2026-10-21` that day's journal page and resolves the link to it.
  test('a Logseq graph imports a namespaced page and a journal, the link to it naming its day @journal @pages', async ({
    page,
  }) => {
    await importFolder(
      page,
      'import-folder-input',
      'lsq-graph',
      {
        'logseq/config.edn':
          '{:journal/page-title-format "MMM do, yyyy"\n :file/name-format :triple-lowbar}\n',
        'logseq/bak/pages/lsq___b/2026.md': '- lsq-backup\n',
        'pages/lsq___b.md': '- lsq-link [[Oct 21st, 2026]]\n',
        'journals/2026_10_21.md': '- lsq-day\n',
      },
      // The backup under `logseq/` is no page: two files import.
      'Imported “2 files”',
    )
    const scope = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
    const journal = await ipc<{ id: string } | null>(page, 'get_journal_page_by_date', {
      date: '2026-10-21',
      scope,
    })
    expect(journal).not.toBeNull()
    const { blocks } = await ipc<{ blocks: { content: string | null }[] }>(
      page,
      'load_page_subtree',
      { rootBlockId: journal?.id, scope },
    )
    expect(blocks.map(({ content }) => content)).toContain('lsq-day')
    await reopenTitled(page, 'lsq/b')
    await expect(rowOf(page, 'lsq-link').getByTestId('block-link-chip')).toHaveAttribute(
      'data-id',
      journal?.id ?? '',
    )
  })

  // #6754 — a translatable `{{query}}` is a live query block over the tags and
  // task states the import stored; any other is kept, counted in one warning.
  test('a Logseq query is a live query block, and one with no equivalent a counted code block @search', async ({
    page,
  }) => {
    const untranslatable = '{{query (between -7d today)}}'
    await importLogseqPage(
      page,
      'lq-dash',
      [
        '- {{query (and (task TODO) [[lq-tag]])}}',
        `- ${untranslatable}`,
        '- TODO lq-hit #lq-tag',
        '- DONE lq-miss #lq-tag',
        '',
      ].join('\n'),
    )
    await page.getByTestId('import-result-details').locator('summary').click()
    await expect(
      page.getByTestId('import-warning-item').filter({ hasText: 'Logseq quer' }),
    ).toHaveText(['1 Logseq query has no equivalent here and was kept as a code block to rebuild.'])

    await reopenTitled(page, 'lq-dash')
    const results = page.getByTestId('query-result-item')
    await expect(results.filter({ hasText: 'lq-hit' })).toHaveCount(1)
    await expect(results.filter({ hasText: 'lq-miss' })).toHaveCount(0)
    const kept = rowOf(page, 'between')
    await expect(kept).toContainText(untranslatable)
    await expect(kept).toContainText('Logseq query, not translated:')
  })

  // #5160 D7 — the keyword, the priority cookie and the planning line are the
  // stored task state, priority and scheduled date.
  test('a Logseq `TODO [#A]` with a SCHEDULED line is a TODO with a priority and a date', async ({
    page,
  }) => {
    // Two blocks: the planning line is consumed, not made a block or a warning.
    await importLogseqPage(
      page,
      'lst-doc',
      '- TODO [#A] lst-task\n  SCHEDULED: <2031-10-01 Wed>\n- lst-plain\n',
      'Imported “lst-doc”: 2 blocks',
    )
    await reopenTitled(page, 'lst-doc')
    const task = rowOf(page, 'lst-task')
    await expect(task.getByTestId('block-static')).not.toContainText('TODO')
    await expect(task.getByTestId('block-static')).not.toContainText('[#A]')
    await expect(rowOf(page, 'lst-plain')).toBeVisible()
    await expectTaskState(page, 'lst-task', 'TODO')
    // `[#A]` is the first built-in priority level, `1`.
    await expect(task.getByTestId('priority-badge')).toContainText('1')
    await expect(task.locator('.scheduled-chip')).toHaveAttribute('aria-label', /Oct 1, 2031/)
  })

  test('a Logseq `STARTED` task is a DOING task (#6033)', async ({ page }) => {
    await importLogseqPage(page, 'lst-started', '- STARTED lst-started-task\n')
    await reopenTitled(page, 'lst-started')
    await expect(rowOf(page, 'lst-started-task').getByTestId('block-static')).not.toContainText(
      'STARTED',
    )
    await expectTaskState(page, 'lst-started-task', 'DOING')
  })

  test('a Logseq `#+BEGIN_NOTE` block is a note callout (#6033)', async ({ page }) => {
    await importLogseqPage(page, 'lst-note', '- #+BEGIN_NOTE\n  lst-note-body\n  #+END_NOTE\n')
    await reopenTitled(page, 'lst-note')
    const block = rowOf(page, 'lst-note-body')
    await expect(block).not.toContainText('#+BEGIN_NOTE')
    await expect(block.getByTestId('callout-block')).toHaveAttribute('data-callout-type', 'note')
  })

  // #6032 — what the Markdown the frontend writes for a Notion export or an Org
  // file stores: properties, resolved links, task keywords, dates and depth.
  test('a Notion export stores its properties and links, and an Org file its tasks, dates, properties and depth', async ({
    page,
  }) => {
    const planId = '0123456789abcdef0123456789abcdef'
    const notesId = 'fedcba9876543210fedcba9876543210'
    await importFolder(
      page,
      'import-folder-input',
      'notion-export',
      {
        [`Plan ${planId}.md`]: `# Plan\n\nReviewer: notion-ann\n\n- notion-link [Notes](Notes%20${notesId}.md)\n`,
        [`Notes ${notesId}.md`]: '# Notes\n\n- notion-notes\n',
        [`Tasks ${planId}.csv`]: 'Name,Status\n',
        'tasks.org': [
          '#+TITLE: notion Org',
          '* TODO org-task',
          '  SCHEDULED: <2031-10-01 Wed>',
          '  :PROPERTIES:',
          '  :owner: org-alice',
          '  :END:',
          '** DONE org-sub',
          '',
        ].join('\n'),
        'reading.txt': '- notion-text\n',
      },
      'Imported “4 files”',
    )
    await reopenTitled(page, 'Plan')
    await expect(rowOf(page, 'notion-link').getByTestId('block-link-chip')).toHaveAttribute(
      'data-id',
      await pageIdTitled(page, 'Notes'),
    )
    await page.locator('.page-property-table-header').click()
    await expect(page.getByLabel('reviewer value', { exact: true })).toHaveValue('notion-ann')

    await reopenTitled(page, 'notion Org')
    await expectTaskState(page, 'org-task', 'TODO')
    await expectTaskState(page, 'org-sub', 'DONE')
    const task = rowOf(page, 'org-task')
    await expect(task).toHaveAttribute('aria-level', '1')
    await expect(rowOf(page, 'org-sub')).toHaveAttribute('aria-level', '2')
    await expect(task.locator('.scheduled-chip')).toHaveAttribute('aria-label', /Oct 1, 2031/)
    await expect(task.getByTestId('property-chip').filter({ hasText: 'org-alice' })).toHaveCount(1)
  })

  // #6032 N4, N7 — an Org file's own vocabulary and links.
  test('an Org file’s `#+TODO` keywords, headline tags and `id:` links are read, and a heading link makes no page', async ({
    page,
  }) => {
    const fileId = '5f2c0000-0000-4000-8000-000000000002'
    const headlineId = '5f2c0000-0000-4000-8000-000000000001'
    await importFolder(
      page,
      'import-folder-input',
      'roam-export',
      {
        'roam.org': [
          ':PROPERTIES:',
          `:ID: ${fileId}`,
          ':END:',
          '#+TITLE: org Roam',
          '#+TODO: TODO NEXT | DONE',
          '* NEXT roam-next :orgtag:',
          '* roam-target',
          '  :PROPERTIES:',
          `  :ID: ${headlineId}`,
          '  :END:',
          '',
        ].join('\n'),
        'links.org': [
          `* roam-ref [[id:${headlineId}][the target]] and [[*Budget]]`,
          `* roam-back [[id:${fileId}][roam]]`,
          '',
        ].join('\n'),
      },
      'Imported “2 files”',
    )
    await navigateToView(page, 'Pages')
    await expect(page.locator('span[data-page-title="links"]')).toBeVisible()
    await expect(page.locator('span[data-page-title="*Budget"]')).toHaveCount(0)

    await reopenTitled(page, 'org Roam')
    await expectTaskState(page, 'roam-next', 'TODO')
    await expect(rowOf(page, 'roam-next').getByTestId('tag-ref-chip')).toHaveText('orgtag')

    await reopenTitled(page, 'links')
    await expect(
      rowOf(page, 'roam-ref').getByTestId('block-ref-chip').locator('.block-ref-chip-label'),
    ).toHaveText('roam-target')
    await expect(rowOf(page, 'roam-back').getByTestId('block-link-chip')).toHaveAttribute(
      'data-id',
      await pageIdTitled(page, 'org Roam'),
    )
  })

  test('a Markdown link to a sibling .txt note links to the page it imports as (#6032)', async ({
    page,
  }) => {
    await importFolder(
      page,
      'import-folder-input',
      'txt-vault',
      { 'txt-a.md': '- txt-link [r](txt-reading.txt)\n', 'txt-reading.txt': '- txt-text\n' },
      'Imported “2 files”',
    )
    await reopenTitled(page, 'txt-a')
    await expect(rowOf(page, 'txt-link').getByTestId('block-link-chip')).toHaveAttribute(
      'data-id',
      await pageIdTitled(page, 'txt-reading'),
    )
  })

  test('an Org `file:` link links to the page the linked file’s `#+TITLE` names (#6032)', async ({
    page,
  }) => {
    await importFolder(
      page,
      'import-folder-input',
      'orgfile-vault',
      {
        'orgfile-a.org': '#+TITLE: orgfile Alpha\n* orgfile-alpha\n',
        'orgfile-b.org': '* orgfile-link [[file:orgfile-a.org][see]]\n',
      },
      'Imported “2 files”',
    )
    await navigateToView(page, 'Pages')
    await expect(page.locator('span[data-page-title="orgfile-a"]')).toHaveCount(0)
    await reopenTitled(page, 'orgfile-b')
    await expect(rowOf(page, 'orgfile-link').getByTestId('block-link-chip')).toHaveAttribute(
      'data-id',
      await pageIdTitled(page, 'orgfile Alpha'),
    )
  })
})

// ===========================================================================
// 3. Export preserves block structure
// ===========================================================================

test.describe('Export preserves block structure @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('exported markdown contains all child blocks as blocks of their own', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Use evaluate to get the raw markdown
    const markdown = (await page.evaluate(() => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke('export_page_markdown', { pageId: '00000000000000000000PAGE01' })
    })) as string

    // The page has 5 plain child blocks — each a paragraph of its own
    const blockLines = exportedBlockLines(markdown)
    expect(blockLines.length).toBe(5)

    // Verify block ordering matches seed data positions
    expect(blockLines[0]).toMatch(/^Welcome to Agaric!/)
    expect(blockLines[1]).toMatch(/^Use the sidebar/)
    expect(blockLines[2]).toMatch(/^Create new blocks/)
    expect(blockLines[3]).toMatch(/^Try tagging blocks/)
    expect(blockLines[4]).toMatch(/^\*\*Use the search panel/)
  })

  test('exported Daily page preserves task blocks in order', async ({ page }) => {
    // The daily page has 5 children with various todo states
    const markdown = (await page.evaluate(() => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke('export_page_markdown', { pageId: '00000000000000000000PAGE03' })
    })) as string

    // Two paragraphs, then three tasks, each a checkbox item (#6277 E2) with its
    // priority, due date and, done, completion date as Tasks signifiers (#6277 D3).
    const blockLines = exportedBlockLines(markdown)
    expect(blockLines.length).toBe(5)

    // Verify position-based ordering
    expect(blockLines[0]).toBe('Morning standup notes go here')
    expect(blockLines[1]).toBe('Review project milestones')
    expect(blockLines[2]).toMatch(/^- \[ \] Buy groceries ⏫ 📅 \d{4}-\d{2}-\d{2}$/)
    expect(blockLines[3]).toMatch(/^- \[\/\] Review pull requests 🔼 📅 \d{4}-\d{2}-\d{2}$/)
    expect(blockLines[4]).toMatch(
      /^- \[x\] Write documentation 🔽 📅 \d{4}-\d{2}-\d{2} ✅ \d{4}-\d{2}-\d{2}$/,
    )
  })
})

// ===========================================================================
// 4. Export includes tags and links
// ===========================================================================

test.describe('Export includes tags and links @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  // The export names a link's page and a tag as the user reads them; the mock
  // keeps the stored ids, as its export writes no names (#5071).
  test(
    'exported Getting Started page names its links and tags',
    { tag: '@real-only' },
    async ({ page }) => {
      const markdown = await ipc<string>(page, 'export_page_markdown', {
        pageId: SEED_IDS.PAGE_GETTING_STARTED,
      })
      expect(markdown).toContain('See [[Quick Notes]] for tips.')
      expect(markdown).toContain('Try tagging blocks with #work or #personal')
      expect(markdown).not.toContain(SEED_IDS.PAGE_QUICK_NOTES)
      expect(markdown).not.toContain(SEED_IDS.TAG_WORK)
    },
  )

  test(
    'Quick Notes export names its link to Getting Started',
    { tag: '@real-only' },
    async ({ page }) => {
      const markdown = await ipc<string>(page, 'export_page_markdown', {
        pageId: SEED_IDS.PAGE_QUICK_NOTES,
      })
      expect(markdown).toContain('the [[Getting Started]] guide')
    },
  )
})

// ===========================================================================
// 5. Round-trip fidelity
// ===========================================================================

test.describe('Round-trip fidelity @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('exported content matches the page blocks displayed in the editor', async ({ page }) => {
    await openPage(page, 'Quick Notes')

    // Get the visible block text from the editor
    const blockTexts = await page
      .locator('[data-testid="sortable-block"] [data-testid="block-static"]')
      .allTextContents()

    // Get the exported markdown
    const markdown = (await page.evaluate(() => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke('export_page_markdown', { pageId: '00000000000000000000PAGE02' })
    })) as string

    // Verify heading
    expect(markdown).toMatch(/^# Quick Notes/)

    // Each block should be a block of the export, a paragraph here
    // The rendered text may resolve [[ULID]] tokens into display text,
    // but the raw export should contain the original content with tokens
    expect(exportedBlockLines(markdown).length).toBe(blockTexts.length)
  })

  test('import then export preserves block content', async ({ page }) => {
    await navigateToDataSettings(page)
    await page.locator('[data-testid="import-file-input"]').setInputFiles({
      name: 'round-trip.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Round Trip Test\n\n- Alpha block\n- Beta block\n- Gamma block\n'),
    })
    // Title is filename-derived (#1919): 'round-trip.md' -> 'round-trip'. 4 blocks:
    // the `# Round Trip Test` heading line is content, plus the three bullets.
    await expect(page.locator('[data-testid="import-result"]')).toContainText(
      'Imported “round-trip”: 4 blocks',
    )

    const pages = await ipc<{ id: string; content: string | null }[]>(
      page,
      'list_all_pages_in_space',
      { scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }, tagIds: null },
    )
    const imported = pages.find((p) => p.content === 'round-trip')
    expect(imported).toBeTruthy()
    const exportedMd = await ipc<string>(page, 'export_page_markdown', { pageId: imported?.id })

    // The export header is the (filename-derived) page title (#1919), and the
    // original `# Round Trip Test` heading is ordinary content, a block of its
    // own. The list marker each block opens with is the backend's (#6277 E2):
    // the mock stamps no list style, so its blocks come back as paragraphs.
    expect(exportedMd).toMatch(/^# round-trip\n\n/)
    expect(exportedBlockLines(exportedMd).map((line) => line.replace(/^[-+*] /, ''))).toEqual([
      '# Round Trip Test',
      'Alpha block',
      'Beta block',
      'Gamma block',
    ])
  })

  test('export of Projects page has correct block count', async ({ page }) => {
    const markdown = (await page.evaluate(() => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke('export_page_markdown', { pageId: '00000000000000000000PAGE04' })
    })) as string

    expect(markdown).toMatch(/\n# Projects\n\n/)

    // Projects page has 5 child blocks (BLOCK_PROJ_1..4 + BLOCK_OVERDUE_1),
    // each a task item
    const blockLines = exportedBlockLines(markdown)
    expect(blockLines.length).toBe(5)
    expect(blockLines.every((line) => /^- \[.\] /.test(line))).toBe(true)

    // Verify specific content from seed data
    expect(markdown).toContain('Ship v2.0 release')
    expect(markdown).toContain('Fix login bug')
    expect(markdown).toContain('Update dependencies')
    expect(markdown).toContain('Design new dashboard')
    expect(markdown).toContain('Submit report')
  })
})
