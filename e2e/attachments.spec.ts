import { truncate, writeFile } from 'node:fs/promises'

import type { FileChooser, Page } from '@playwright/test'

import {
  activeSuggestionList,
  blurEditors,
  expect,
  focusBlockById,
  navigateToView,
  openPage,
  reopenPage,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * E2E tests for the attachments lifecycle.
 *
 * Covers:
 *   1. Empty state — no attachment badges when blocks have no attachments
 *   2. Attachment section exists — badge appears, toggles list, shows details
 *   3. Delete attachment — two-click confirmation flow removes attachment
 *   4. Rename attachment — survives reopening the page; History lists the op
 *   5. `/attach` through the file chooser — an allowed file attaches; a
 *      disallowed type or an oversized file is refused with a toast and no row
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
    ({ blockId: bId, filename: fName, mimeType: mType, sizeBytes: size }) => {
      ;(window as unknown as MockAttachmentWindow).__addMockAttachment?.(bId, fName, mType, size)
    },
    { blockId, filename, mimeType, sizeBytes },
  )
}

/** A block's attachment rows as the mock backend holds them, not as the UI last rendered them. */
async function listAttachmentRows(
  page: Page,
  blockId: string,
): Promise<Array<{ filename: string; mime_type: string; size_bytes: number }>> {
  return page.evaluate(async (bId) => {
    const invoke = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__.invoke
    const rows = (await invoke('list_attachments', { blockId: bId })) as Array<{
      filename: string
      mime_type: string
      size_bytes: number
    }>
    return rows.map(({ filename, mime_type, size_bytes }) => ({ filename, mime_type, size_bytes }))
  }, blockId)
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
    await expect(page.getByTestId('attachment-badge')).toHaveCount(0)
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
    const badge = page.getByTestId('attachment-badge').first()
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('1')
  })

  test('clicking badge toggles attachment list open', async ({ page }) => {
    await addMockAttachment(page, BLOCK_GS_1, 'screenshot.png', 'image/png', 54321)

    await openPage(page, 'Getting Started')

    const badge = page.getByTestId('attachment-badge').first()
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
    await page.getByTestId('attachment-badge').first().click()

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
    await page.getByTestId('attachment-badge').first().click()

    const list = page.getByRole('list', { name: 'Attachments' })
    await expect(list.getByText('report.pdf')).toBeVisible()

    // Hover the list item to reveal the delete button (opacity-0 → group-hover:opacity-100)
    const listItem = list.getByRole('listitem').filter({ hasText: 'report.pdf' })
    await listItem.hover()

    // First click on delete — shows confirmation toast
    const deleteBtn = page.getByRole('button', { name: /delete attachment report\.pdf/i })
    await deleteBtn.click()

    await expect(page.getByText('Click the delete button again to confirm.')).toBeVisible()

    // Second click — confirms deletion. Arming CHANGES the accessible name
    // (#2281 item 9: aria-label becomes "Click again to confirm deleting …" +
    // aria-pressed), so the original name-based locator no longer matches —
    // re-locate via the armed name.
    const armedBtn = page.getByRole('button', {
      name: /click again to confirm deleting report\.pdf/i,
    })
    await armedBtn.click()

    // Success toast
    await expect(page.getByText(/Deleted report\.pdf/i)).toBeVisible()

    // SortableBlock unmounts both the attachment badge and the AttachmentList
    // when `attachmentCount > 0` becomes false (SortableBlock.tsx:368) — the
    // EmptyState inside AttachmentList is never rendered through this flow.
    // Confirm the deletion by waiting for both surfaces to disappear.
    await expect(page.getByTestId('attachment-badge')).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'Attachments' })).toHaveCount(0)
  })
})

// ===========================================================================
// 4. Rename attachment
// ===========================================================================

test.describe('Rename attachment', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a renamed attachment keeps its new name after reopening the page, and History lists the rename', async ({
    page,
  }) => {
    await addMockAttachment(page, BLOCK_GS_1, 'notes.pdf', 'application/pdf', 24576)
    await openPage(page, 'Getting Started')

    await page.getByRole('button', { name: '1 attachment', exact: true }).click()
    const list = page.getByRole('list', { name: 'Attachments' })
    await list.getByRole('listitem').filter({ hasText: 'notes.pdf' }).hover()
    await page.getByRole('button', { name: 'Rename attachment notes.pdf', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'Rename attachment notes.pdf', exact: true })
    await input.fill('renamed.pdf')
    await input.press('Enter')

    await expect(list.getByText('renamed.pdf', { exact: true })).toBeVisible()
    await expect
      .poll(() => listAttachmentRows(page, BLOCK_GS_1))
      .toEqual([{ filename: 'renamed.pdf', mime_type: 'application/pdf', size_bytes: 24576 }])

    await reopenPage(page, 'Getting Started')
    await page.getByRole('button', { name: '1 attachment', exact: true }).click()
    const reopened = page.getByRole('list', { name: 'Attachments' })
    await expect(reopened.getByText('renamed.pdf', { exact: true })).toBeVisible()
    await expect(reopened.getByText('notes.pdf', { exact: true })).toHaveCount(0)

    await navigateToView(page, 'History')
    const renameEntry = page.locator('[data-history-item]').filter({
      has: page.getByTestId('history-type-badge').filter({ hasText: 'rename_attachment' }),
    })
    await expect(renameEntry).toHaveCount(1)
    await expect(renameEntry).toContainText('notes.pdf → renamed.pdf')
  })
})

// ===========================================================================
// 5. /attach through the file chooser
// ===========================================================================

/** `MAX_ATTACHMENT_BYTES` in `src/lib/file-utils.ts`. */
const MAX_ATTACHMENT_BYTES = 52_428_800

const HELLO_TXT = {
  name: 'hello.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('hello, agaric'),
}

function toast(page: Page, text: string) {
  return page.locator('[data-sonner-toast]').getByText(text, { exact: true })
}

/** Run `/attach` on BLOCK_GS_1 and answer the file chooser it opens with `files`. */
async function attachThroughSlashCommand(
  page: Page,
  files: Parameters<FileChooser['setFiles']>[0],
) {
  await focusBlockById(page, BLOCK_GS_1)
  await typeSlashCommand(page, 'attach')
  const chooserOpened = page.waitForEvent('filechooser')
  await activeSuggestionList(page)
    .getByRole('option', { name: /ATTACH — Attach file to block/ })
    .click()
  await (await chooserOpened).setFiles(files)
}

/**
 * A refusal writes nothing, so there is no event to wait on before reading the
 * block's rows, and a read straight after the toast would run ahead of any
 * upload a broken guard let through. An allowed attach issued afterwards is the
 * anchor: once its row has landed, the block must hold that row alone.
 */
async function expectOnlyALaterAllowedAttachLands(page: Page) {
  await blurEditors(page)
  await attachThroughSlashCommand(page, HELLO_TXT)
  await expect(toast(page, 'Attached "hello.txt"')).toBeVisible()
  const rows = await listAttachmentRows(page, BLOCK_GS_1)
  expect(rows.map((row) => row.filename)).toEqual(['hello.txt'])
}

test.describe('/attach through the file chooser', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('an allowed file attaches to the block', async ({ page }) => {
    await attachThroughSlashCommand(page, HELLO_TXT)

    await expect(toast(page, 'Attached "hello.txt"')).toBeVisible()
    await expect
      .poll(() => listAttachmentRows(page, BLOCK_GS_1))
      .toEqual([{ filename: 'hello.txt', mime_type: 'text/plain', size_bytes: 13 }])
    await expect(page.getByRole('button', { name: '1 attachment', exact: true })).toBeVisible()
  })

  test('a disallowed type is refused with a toast and leaves no attachment row', async ({
    page,
  }) => {
    await attachThroughSlashCommand(page, {
      name: 'setup.exe',
      mimeType: 'application/x-msdownload',
      buffer: Buffer.from('MZ'),
    })

    await expect(
      toast(
        page,
        'application/x-msdownload cannot be attached — allowed: images, text, PDF, JSON, ZIP, TAR',
      ),
    ).toBeVisible()
    await expectOnlyALaterAllowedAttachLands(page)
  })

  test('a file over the size cap is refused with a toast and leaves no attachment row', async ({
    page,
  }, testInfo) => {
    // A path, not a Buffer: Playwright refuses a buffer payload of 50 MiB or
    // more, and the cap is exactly 50 MiB. `truncate` extends the empty file
    // sparsely, so nothing is written to disk.
    const oversized = testInfo.outputPath('oversized.png')
    await writeFile(oversized, '')
    await truncate(oversized, MAX_ATTACHMENT_BYTES + 1)

    await attachThroughSlashCommand(page, oversized)

    await expect(toast(page, 'File is 50.0 MB — max is 50 MB')).toBeVisible()
    await expectOnlyALaterAllowedAttachLands(page)
  })
})
