import { expect, openPage, test, waitForBoot } from './helpers'

/**
 * E2E for PDF annotation via pdf.js's prebuilt viewer (#1452).
 *
 * Flow under test:
 *   1. Seed a real (parseable) PDF attachment on a block, with bytes.
 *   2. Open the page → click the inline "Open file" attachment button.
 *   3. The PdfViewerDialog mounts the PREBUILT viewer (text + annotation
 *      layers) — NOT the old bare <canvas>. The page indicator renders.
 *   4. The annotation toolbar (highlight / comment / save) appears because the
 *      owning block is known; toggling Highlight switches the editor mode.
 *   5. Save is disabled until an annotation exists.
 *
 * The save round-trip (saveDocument → new attachment → delete old) is unit-
 * tested in PdfViewerDialog.test.tsx with mocked IPC; here we assert the
 * prebuilt viewer + editor UI render and wire up against a real PDF in the
 * real browser, with no page errors.
 *
 * Seed data (tauri-mock): BLOCK_GS_1 — first child of "Getting Started".
 */

const BLOCK_GS_1 = '0000000000000000000BLOCK01'

// Minimal valid 1-page PDF with selectable text ("Hi 6.0"). Same fixture as
// pdfjs-v6-smoke.spec.ts so we know pdf.js parses + renders it.
const PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAzNyA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDUwIDEwMCBUZCAoSGkgNi4wKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMyOCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjM5OAolJUVPRg=='

interface MockBytesWindow extends Window {
  __addMockAttachmentWithBytes?: (
    blockId: string,
    filename: string,
    mimeType: string,
    bytes: number[],
  ) => Record<string, unknown>
}

/** Seed a real PDF attachment (with bytes) into the mock store. */
async function seedPdf(page: import('@playwright/test').Page, blockId: string, filename: string) {
  await page.evaluate(
    ({ blockId, filename, b64 }) => {
      const bin = atob(b64)
      const bytes = Array.from({ length: bin.length }, (_, i) => bin.charCodeAt(i))
      ;(window as unknown as MockBytesWindow).__addMockAttachmentWithBytes?.(
        blockId,
        filename,
        'application/pdf',
        bytes,
      )
    },
    { blockId, filename, b64: PDF_B64 },
  )
}

test.describe('PDF annotation viewer (#1452)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('opens a PDF in the prebuilt viewer with the annotation toolbar', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    await seedPdf(page, BLOCK_GS_1, 'report.pdf')
    await openPage(page, 'Getting Started')

    // The inline attachment "Open file" button is rendered under the block.
    const openBtn = page.getByRole('button', { name: 'Open file report.pdf' })
    await expect(openBtn).toBeVisible()
    await openBtn.click()

    // The prebuilt viewer container mounts (NOT a bare <canvas>), and the page
    // indicator renders once the document parses.
    await expect(page.getByTestId('pdf-viewer-container')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('pdf-page-indicator')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('pdf-page-indicator')).toContainText('1 / 1')

    // The annotation toolbar appears because the owning block is known.
    await expect(page.getByTestId('pdf-annotation-toolbar')).toBeVisible()
    await expect(page.getByTestId('pdf-tool-highlight')).toBeVisible()
    await expect(page.getByTestId('pdf-tool-comment')).toBeVisible()

    // Save is disabled until an annotation exists.
    await expect(page.getByTestId('pdf-save')).toBeDisabled()

    // Toggling Highlight activates the editor mode (aria-pressed flips).
    await page.getByTestId('pdf-tool-highlight').click()
    await expect(page.getByTestId('pdf-tool-highlight')).toHaveAttribute('aria-pressed', 'true')

    // No page errors (e.g. the prebuilt viewer's `globalThis.pdfjsLib`
    // destructure, or a worker/API version mismatch).
    expect(pageErrors.join('\n')).not.toMatch(/pdfjsLib|does not match the Worker version/i)
  })

  test('renders the prebuilt text layer for selection', async ({ page }) => {
    await seedPdf(page, BLOCK_GS_1, 'doc.pdf')
    await openPage(page, 'Getting Started')

    await page.getByRole('button', { name: 'Open file doc.pdf' }).click()
    await expect(page.getByTestId('pdf-viewer-container')).toBeVisible({ timeout: 15000 })

    // The prebuilt viewer renders a `.textLayer` per page (the core-only
    // canvas renderer never did). Its presence is the marker that text
    // selection / highlight is wired up.
    await expect(page.locator('.pdfViewer .textLayer').first()).toBeAttached({ timeout: 15000 })
  })
})
