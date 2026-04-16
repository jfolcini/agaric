import { expect, test } from '@playwright/test'
import { openPage, waitForBoot } from './helpers'

/**
 * E2E tests for the attachments lifecycle.
 *
 * Covers:
 *   1. Empty state — no attachment badges when blocks have no attachments
 *   2. Attachment section exists — badge appears, toggles list, shows details
 *   3. Delete attachment — two-click confirmation flow removes attachment
 *
 * Seed data (tauri-mock.ts):
 *   BLOCK_GS_1 ('0000000000000000000BLOCK01') — first child of "Getting Started"
 *
 * The mock's attachment store (Map) persists state across IPC calls within a
 * single page session, so we can add attachments via invoke before navigating.
 */

const BLOCK_GS_1 = '0000000000000000000BLOCK01'

interface MockAttachmentWindow extends Window {
  __addMockAttachment?: (
    blockId: string,
    filename: string,
    mimeType: string,
    sizeBytes: number,
  ) => Record<string, unknown>
}

/** Add an attachment to the mock store via the exposed window global. */
async function addMockAttachment(
  page: import('@playwright/test').Page,
  blockId: string,
  filename: string,
  mimeType: string,
  sizeBytes: number,
) {
  await page.evaluate(
    ({ blockId, filename, mimeType, sizeBytes }) => {
      ;(window as unknown as MockAttachmentWindow).__addMockAttachment?.(
        blockId,
        filename,
        mimeType,
        sizeBytes,
      )
    },
    { blockId, filename, mimeType, sizeBytes },
  )
}

// ===========================================================================
// 1. Empty state — no attachments
// ===========================================================================

test.describe('Attachment empty state', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('no attachment badges when blocks have no attachments', async ({ page }) => {
    await openPage(page, 'Getting Started')
    // When no block has attachments, no attachment badges should render
    await expect(page.locator('.attachment-badge')).toHaveCount(0)
  })
})

// ===========================================================================
// 2. Attachment section exists — badge, list, details
// ===========================================================================

test.describe('Attachment section exists', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('attachment badge appears and shows count', async ({ page }) => {
    // Seed an attachment before navigating to the page
    await addMockAttachment(page, BLOCK_GS_1, 'notes.pdf', 'application/pdf', 24576)

    await openPage(page, 'Getting Started')

    // Badge should be visible on the first block
    const badge = page.locator('.attachment-badge').first()
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('1')
  })

  test('clicking badge toggles attachment list open', async ({ page }) => {
    await addMockAttachment(page, BLOCK_GS_1, 'screenshot.png', 'image/png', 54321)

    await openPage(page, 'Getting Started')

    const badge = page.locator('.attachment-badge').first()
    await expect(badge).toBeVisible()

    // aria-expanded should be false before clicking
    await expect(badge).toHaveAttribute('aria-expanded', 'false')

    // Click to expand the attachment list
    await badge.click()

    // aria-expanded should now be true
    await expect(badge).toHaveAttribute('aria-expanded', 'true')

    // The attachment list should show the filename
    const list = page.getByRole('list', { name: 'Attachments' })
    await expect(list).toBeVisible()
    await expect(list.getByText('screenshot.png')).toBeVisible()
  })

  test('attachment list renders file details (name, size, time)', async ({ page }) => {
    // 1 048 576 bytes = exactly 1.0 MB
    await addMockAttachment(page, BLOCK_GS_1, 'document.pdf', 'application/pdf', 1048576)

    await openPage(page, 'Getting Started')

    // Expand attachment list
    await page.locator('.attachment-badge').first().click()

    const list = page.getByRole('list', { name: 'Attachments' })
    await expect(list).toBeVisible()

    // Verify filename
    await expect(list.getByText('document.pdf')).toBeVisible()
    // Verify human-readable size
    await expect(list.getByText('1.0 MB')).toBeVisible()
    // Verify relative timestamp (created just now)
    await expect(list.getByText('just now')).toBeVisible()
  })
})

// ===========================================================================
// 3. Delete attachment
// ===========================================================================

test.describe('Delete attachment', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('delete attachment via two-click confirmation removes it', async ({ page }) => {
    await addMockAttachment(page, BLOCK_GS_1, 'report.pdf', 'application/pdf', 99999)

    await openPage(page, 'Getting Started')

    // Expand attachment list
    await page.locator('.attachment-badge').first().click()

    const list = page.getByRole('list', { name: 'Attachments' })
    await expect(list.getByText('report.pdf')).toBeVisible()

    // Hover the list item to reveal the delete button (opacity-0 → group-hover:opacity-100)
    const listItem = list.getByRole('listitem').filter({ hasText: 'report.pdf' })
    await listItem.hover()

    // First click on delete — shows confirmation toast
    const deleteBtn = page.getByRole('button', { name: /delete attachment report\.pdf/i })
    await deleteBtn.click()

    await expect(page.getByText('Click the delete button again to confirm.')).toBeVisible()

    // Second click — confirms deletion
    // After first click the button has opacity-100 (pending state), so it stays visible
    await deleteBtn.click()

    // Success toast
    await expect(page.getByText(/Deleted report\.pdf/i)).toBeVisible()

    // The attachment list should now show the empty state
    // (the <ul> is replaced by the EmptyState component)
    await expect(page.getByText('No attachments yet.')).toBeVisible()
  })
})
