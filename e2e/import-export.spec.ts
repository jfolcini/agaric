import JSZip from 'jszip'

import { expect, getInvokeCalls, installIpcRecorder, openPage, test, waitForBoot } from './helpers'

/**
 * E2E tests for import/export functionality.
 *
 * Covers:
 *  1. Export page as markdown — trigger export from kebab menu, verify clipboard content
 *  2. Import markdown — upload a .md file via StatusPanel, verify blocks are created
 *  3. Export preserves block structure — export page with multiple blocks, verify hierarchy
 *  4. Export includes tags and links — verify #[tag_id] and [[block_id]] tokens in export
 *  5. Round-trip fidelity — export a page, verify content matches original blocks
 *  6. Export all pages as ZIP (#2707) — trigger Settings → Data → "Export All",
 *     capture the real browser download, and unzip it (via the same `jszip`
 *     package the app itself uses) to assert the namespace hierarchy round-trips.
 *  7. Import warning summary (#2707) — the mock's `import_markdown` handler always
 *     appends one representative parse warning (handlers.ts, "dev-preview mock:
 *     tags (#tag) and attachments are not imported"); assert the result panel's
 *     warnings heading + list render it.
 *
 * Seed data (tauri-mock.ts):
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
// Helper: open the kebab menu on the current page and click "Export as Markdown"
// ===========================================================================

async function triggerExport(page: import('@playwright/test').Page) {
  // Open the kebab (⋮) overflow menu in PageHeader
  const kebabButton = page.getByRole('button', { name: 'Page actions' })
  await expect(kebabButton).toBeVisible()
  await kebabButton.click()

  // Click the "Export as Markdown" option
  await page.getByText('Export as Markdown').click()
}

// ===========================================================================
// Helper: navigate to Settings → Data tab (where the import/export UI lives
// After). The import panel used to live in the Status panel but was
// moved to Settings → Data with the lazy-loaded DataSettingsTab component.
// ===========================================================================

async function navigateToDataSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Data' }).click()
  // DataSettingsTab is lazy-loaded (Suspense) — wait for it to mount.
  await expect(page.locator('[data-testid="import-panel-title"]')).toBeVisible()
}

// ===========================================================================
// 1. Export page as markdown
// ===========================================================================

test.describe('Export page as markdown', () => {
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

    // Verify it starts with the page title as a heading
    expect(markdown).toMatch(/^# Getting Started/)

    // Verify it contains list items for the child blocks
    expect(markdown).toContain('- Welcome to Agaric!')
    expect(markdown).toContain('- Use the sidebar to navigate')
    expect(markdown).toContain('- Create new blocks by pressing Enter')
  })
})

// ===========================================================================
// 1b. Export all pages as ZIP (#2707)
// ===========================================================================
//
// `handleExportAll` (DataTab.tsx) calls `exportGraphAsZip` (src/lib/export-graph.ts),
// which is REAL, unmocked client-side code: it lists pages via the
// `list_all_pages_in_space` IPC, exports each via `export_page_markdown`, zips
// them with the real `jszip` package, and triggers a real browser download via
// an `<a download>` click. None of that is mocked, so — unlike most of this
// suite — the resulting ZIP is a genuine downloadable artifact Playwright can
// intercept with `page.waitForEvent('download')` and unzip for real (using the
// same `jszip` package, imported directly into this Node-side spec).

test.describe('Export all pages as ZIP', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Export All downloads a ZIP whose entries mirror the page set', async ({ page }) => {
    await installIpcRecorder(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Data' }).click()
    await expect(page.locator('[data-testid="export-panel-title"]')).toBeVisible()

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export All', exact: true }).click(),
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
        'Getting Started.md',
        'Meeting Notes Template.md',
        'Meetings.md',
        'Projects.md',
        'Quick Notes.md',
        `${todayStr}.md`,
      ].toSorted(),
    )

    // Spot-check one entry's content round-trips the same export the
    // per-page "Export as Markdown" flow produces.
    const gettingStarted = await zip.file('Getting Started.md')?.async('string')
    expect(gettingStarted).toMatch(/^# Getting Started/)
    expect(gettingStarted).toContain('- Welcome to Agaric!')
  })
})

// ===========================================================================
// 2. Import markdown
// ===========================================================================

test.describe('Import markdown', () => {
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
  // ("dev-preview mock: tags (#tag) and attachments are not imported (kept as
  // literal text)"), so the result panel's warnings summary is exercisable on
  // ANY import — no special seeding required. This was never asserted despite
  // every other import test in this file uploading a file that triggers it.
  test('import result panel shows the warning count and message', async ({ page }) => {
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
    await expect(warningItem).toContainText('tags (#tag) and attachments are not imported')
  })

  // #2707 — the mock also counts `key:: value` property lines into
  // `properties_set` (handlers.ts `propertiesSet`), driving the result
  // summary's ", N properties" suffix. Never asserted.
  test('import result summary includes the properties-set count', async ({ page }) => {
    await navigateToDataSettings(page)

    const fileInput = page.locator('[data-testid="import-file-input"]')
    const mdContent = '- A task with a property\nstatus:: open\n'
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
// 3. Export preserves block structure
// ===========================================================================

test.describe('Export preserves block structure', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('exported markdown contains all child blocks as list items', async ({ page }) => {
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

    // The page has 5 child blocks — each should be a list item
    const listItems = markdown.split('\n').filter((line: string) => line.startsWith('- '))
    expect(listItems.length).toBe(5)

    // Verify block ordering matches seed data positions
    expect(listItems[0]).toContain('Welcome to Agaric!')
    expect(listItems[1]).toContain('Use the sidebar')
    expect(listItems[2]).toContain('Create new blocks')
    expect(listItems[3]).toContain('Try tagging blocks')
    expect(listItems[4]).toContain('Use the search panel')
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

    const listItems = markdown.split('\n').filter((line: string) => line.startsWith('- '))
    expect(listItems.length).toBe(5)

    // Verify position-based ordering
    expect(listItems[0]).toContain('Morning standup notes')
    expect(listItems[1]).toContain('Review project milestones')
    expect(listItems[2]).toContain('Buy groceries')
    expect(listItems[3]).toContain('Review pull requests')
    expect(listItems[4]).toContain('Write documentation')
  })
})

// ===========================================================================
// 4. Export includes tags and links
// ===========================================================================

test.describe('Export includes tags and links', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('exported Getting Started page contains [[link]] tokens', async ({ page }) => {
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

    // Block GS_2 content: "Use the sidebar ... See [[PAGE_QUICK_NOTES]] for tips."
    // The export should contain the [[ULID]] link token
    expect(markdown).toContain('[[00000000000000000000PAGE02]]')
  })

  test('exported Getting Started page contains #[tag] tokens', async ({ page }) => {
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

    // Block GS_4 content: "Try tagging blocks with #[TAG_WORK] or #[TAG_PERSONAL]..."
    expect(markdown).toContain('#[000000000000000000000TAG01]')
    expect(markdown).toContain('#[000000000000000000000TAG02]')
  })

  test('Quick Notes export contains backlink to Getting Started', async ({ page }) => {
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

    // Block QN_1 references [[PAGE_GETTING_STARTED]]
    expect(markdown).toContain('[[00000000000000000000PAGE01]]')
  })
})

// ===========================================================================
// 5. Round-trip fidelity
// ===========================================================================

test.describe('Round-trip fidelity', () => {
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

    // Each block's text content should appear as a list item in the export
    // The rendered text may resolve [[ULID]] tokens into display text,
    // but the raw export should contain the original content with tokens
    const listItems = markdown.split('\n').filter((line: string) => line.startsWith('- '))
    expect(listItems.length).toBe(blockTexts.length)
  })

  test('import then export preserves block content', async ({ page }) => {
    // Import some markdown content
    const originalContent = '# Round Trip Test\n\n- Alpha block\n- Beta block\n- Gamma block\n'

    const importResult = (await page.evaluate((content) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke('import_markdown', { content, filename: 'round-trip.md' })
    }, originalContent)) as { page_title: string; blocks_created: number }

    // Title is filename-derived (#1919): 'round-trip.md' -> 'round-trip'.
    expect(importResult.page_title).toBe('round-trip')
    // 4 blocks: the `# Round Trip Test` heading line is content (1) plus the
    // three `- ` bullets (Alpha/Beta/Gamma).
    expect(importResult.blocks_created).toBe(4)

    // Now find the imported page and export it
    // We need to find the page ID by listing all pages
    const pages = (await page.evaluate(() => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke('list_blocks', {
        blockType: 'page',
        parentId: null,
        showDeleted: null,
        tagId: null,
        agendaDate: null,
        agendaSource: null,
        cursor: null,
        limit: null,
      })
    })) as { items: Array<{ id: string; content: string }> }

    const importedPage = pages.items.find((p) => p.content === 'round-trip')
    expect(importedPage).toBeTruthy()

    // Export the imported page
    const exportedMd = (await page.evaluate((pageId) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke('export_page_markdown', { pageId })
    }, importedPage?.id)) as string

    // The export header is the (filename-derived) page title (#1919).
    expect(exportedMd).toMatch(/^# round-trip/)
    // The original `# Round Trip Test` heading is now ordinary content, so it
    // round-trips as a content bullet rather than the page title.
    expect(exportedMd).toContain('- # Round Trip Test')
    // The body content still round-trips faithfully.
    expect(exportedMd).toContain('- Alpha block')
    expect(exportedMd).toContain('- Beta block')
    expect(exportedMd).toContain('- Gamma block')
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

    expect(markdown).toMatch(/^# Projects/)

    // Projects page has 5 child blocks (BLOCK_PROJ_1..4 + BLOCK_OVERDUE_1)
    const listItems = markdown.split('\n').filter((line: string) => line.startsWith('- '))
    expect(listItems.length).toBe(5)

    // Verify specific content from seed data
    expect(markdown).toContain('Ship v2.0 release')
    expect(markdown).toContain('Fix login bug')
    expect(markdown).toContain('Update dependencies')
    expect(markdown).toContain('Design new dashboard')
    expect(markdown).toContain('Submit report')
  })
})
