import type { Page } from '@playwright/test'

import { expect, focusBlockById, openPage, reopenPage, test, waitForBoot } from './helpers'

/**
 * Dropping a file onto the block being edited attaches it to that block
 * (`processFileAttachments` in `src/components/editor/EditableBlock.tsx`): a
 * file of 1 MB or more shows an "Attaching" toast until the upload settles, and
 * a type outside the attachment allow-list is refused before it is read.
 *
 * In `e2e/` because the mock stores attachment rows, so a drop that attaches
 * nothing or to the wrong block fails here. Playwright cannot drag files from
 * the OS, so the drop is a `DragEvent` carrying a `DataTransfer` built in the
 * page.
 */

/** `SEED_IDS.BLOCK_GS_1` in `src/lib/tauri-mock/seed.ts`. */
const BLOCK_GS_1 = '0000000000000000000BLOCK01'

/** `ATTACH_PROGRESS_THRESHOLD_BYTES` in `EditableBlock.tsx`: the smallest file with a progress toast. */
const ONE_MB = 1_048_576

type InvokeWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>
  }
  __releaseUploads?: () => void
}

function toast(page: Page, text: string) {
  return page.locator('[data-sonner-toast]').getByText(text, { exact: true })
}

/** Drag a file of `size` zero bytes over the focused block's editor and drop it there. */
async function dropFile(page: Page, file: { name: string; type: string; size: number }) {
  await page.getByRole('textbox', { name: 'Block editor' }).evaluate((el, f) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array(f.size)], f.name, { type: f.type }))
    for (const type of ['dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }))
    }
  }, file)
}

test.describe('Dropping a file onto a block @attachments', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await focusBlockById(page, BLOCK_GS_1)
  })

  test('uploads it behind a progress toast and keeps it listed on the block', async ({ page }) => {
    // The mock answers at once, so the progress toast would be gone before it
    // could be seen: hold the upload until the toast has been asserted.
    await page.evaluate(() => {
      const w = window as unknown as InvokeWindow
      const invoke = w.__TAURI_INTERNALS__.invoke
      const held = new Promise<void>((resolve) => {
        w.__releaseUploads = resolve
      })
      w.__TAURI_INTERNALS__.invoke = async (cmd, args, opts) => {
        if (cmd === 'add_attachment_with_bytes') await held
        return invoke(cmd, args, opts)
      }
    })
    await dropFile(page, { name: 'big.txt', type: 'text/plain', size: ONE_MB })

    await expect(toast(page, 'Attaching "big.txt"…')).toBeVisible()
    await page.evaluate(() => (window as unknown as InvokeWindow).__releaseUploads?.())
    await expect(toast(page, 'Attached "big.txt"')).toBeVisible()
    await expect(toast(page, 'Attaching "big.txt"…')).toHaveCount(0)

    await reopenPage(page, 'Getting Started')
    await page.getByRole('button', { name: '1 attachment', exact: true }).click()
    const list = page.getByRole('list', { name: 'Attachments' })
    await expect(list.getByText('big.txt', { exact: true })).toBeVisible()
    await expect(list.getByText('1.0 MB', { exact: true })).toBeVisible()
  })

  // Only the toast is asserted: the mock refuses this type as well, so the
  // block's rows stay empty with or without the editor's guard.
  test('refuses a type outside the allow-list with a toast naming the allowed types', async ({
    page,
  }) => {
    await dropFile(page, { name: 'setup.exe', type: 'application/x-msdownload', size: 2 })

    await expect(
      toast(
        page,
        'application/x-msdownload cannot be attached — allowed: images, audio, text, PDF, JSON, ZIP, TAR',
      ),
    ).toBeVisible()
  })
})
