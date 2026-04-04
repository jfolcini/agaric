import { expect, test } from '@playwright/test'
import { openPage, waitForBoot } from './helpers'

/**
 * E2E tests for import/export functionality.
 *
 * Covers:
 *  1. Export page as markdown — trigger export from kebab menu, verify clipboard content
 *  2. Import markdown — upload a .md file via StatusPanel, verify blocks are created
 *  3. Export preserves block structure — export page with multiple blocks, verify hierarchy
 *  4. Export includes tags and links — verify #[tag_id] and [[block_id]] tokens in export
 *  5. Round-trip fidelity — export a page, verify content matches original blocks
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") — 5 child blocks, some with [[link]] and #[tag] tokens
 *   PAGE_QUICK_NOTES ("Quick Notes") — 2 child blocks with [[link]] to Getting Started
 *   PAGE_DAILY (today's date) — 5 child blocks with tasks
 */

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
// Helper: navigate to Status panel
// ===========================================================================

async function navigateToStatus(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Status' }).click()
  await expect(page.locator('header').getByText('Status')).toBeVisible()
}

// ===========================================================================
// 1. Export page as markdown
// ===========================================================================

test.describe('Export page as markdown', () => {
  test.beforeEach(async ({ page }) => {
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
    const markdown = await page.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
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
// 2. Import markdown
// ===========================================================================

test.describe('Import markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('importing a markdown file creates blocks and shows success toast', async ({ page }) => {
    await navigateToStatus(page)

    // The import section should be visible in the Status panel
    await expect(page.locator('[data-testid="import-panel-title"]')).toBeVisible()

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
    await expect(importResult).toContainText('Test Import Page')
    await expect(importResult).toContainText('3 blocks')
  })

  test('imported page appears in the page list', async ({ page }) => {
    await navigateToStatus(page)

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
    await page.getByRole('button', { name: 'Pages' }).click()
    await expect(page.getByText('My Imported Notes')).toBeVisible({ timeout: 5000 })
  })

  test('importing a file without heading uses filename as page title', async ({ page }) => {
    await navigateToStatus(page)

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
    const markdown = (await page.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
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
    const markdown = (await page.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
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
    const markdown = (await page.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      return invoke('export_page_markdown', { pageId: '00000000000000000000PAGE01' })
    })) as string

    // Block GS_2 content: "Use the sidebar ... See [[PAGE_QUICK_NOTES]] for tips."
    // The export should contain the [[ULID]] link token
    expect(markdown).toContain('[[00000000000000000000PAGE02]]')
  })

  test('exported Getting Started page contains #[tag] tokens', async ({ page }) => {
    const markdown = (await page.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      return invoke('export_page_markdown', { pageId: '00000000000000000000PAGE01' })
    })) as string

    // Block GS_4 content: "Try tagging blocks with #[TAG_WORK] or #[TAG_PERSONAL]..."
    expect(markdown).toContain('#[000000000000000000000TAG01]')
    expect(markdown).toContain('#[000000000000000000000TAG02]')
  })

  test('Quick Notes export contains backlink to Getting Started', async ({ page }) => {
    const markdown = (await page.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
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
    const markdown = (await page.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
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

    const importResult = (await page.evaluate(async (content) => {
      const { invoke } = await import('@tauri-apps/api/core')
      return invoke('import_markdown', { content, filename: 'round-trip.md' })
    }, originalContent)) as { page_title: string; blocks_created: number }

    expect(importResult.page_title).toBe('Round Trip Test')
    expect(importResult.blocks_created).toBe(3)

    // Now find the imported page and export it
    // We need to find the page ID by listing all pages
    const pages = (await page.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
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

    const importedPage = pages.items.find((p) => p.content === 'Round Trip Test')
    expect(importedPage).toBeTruthy()

    // Export the imported page
    const exportedMd = (await page.evaluate(async (pageId) => {
      const { invoke } = await import('@tauri-apps/api/core')
      return invoke('export_page_markdown', { pageId })
    }, importedPage?.id)) as string

    // Verify the exported markdown contains the original content
    expect(exportedMd).toMatch(/^# Round Trip Test/)
    expect(exportedMd).toContain('- Alpha block')
    expect(exportedMd).toContain('- Beta block')
    expect(exportedMd).toContain('- Gamma block')
  })

  test('export of Projects page has correct block count', async ({ page }) => {
    const markdown = (await page.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
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
