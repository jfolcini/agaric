import { test, expect } from '@playwright/test'

// #366 — pdfjs-dist v5 → v6 major bump. The worker is hand-vendored at
// public/pdf.worker.min.mjs and pdfjs requires the API and worker versions
// to match EXACTLY, or getDocument() throws "The API version … does not
// match the Worker version …". This smoke test drives the *same* call shape
// PdfViewerDialog.tsx uses (workerSrc='/pdf.worker.min.mjs' + getDocument →
// getPage → getViewport → render{canvasContext,viewport,canvas:null}) against
// a real 1-page PDF, in the real browser, served by vite. It asserts the
// version match, that the page parses, and that pixels actually get painted.

// Minimal valid 1-page PDF ("Hi 6.0"), generated offline.
const PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAzNyA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDUwIDEwMCBUZCAoSGkgNi4wKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMyOCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjM5OAolJUVPRg=='

test('pdfjs v6 worker + API render the vendored worker without version mismatch', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto('/')

  const result = await page.evaluate(async (b64) => {
    // Import the same package the app imports; vite serves it in dev.
    // Non-literal specifier so tsc doesn't try to resolve the runtime URL.
    const pdfPath = '/node_modules/pdfjs-dist/build/pdf.min.mjs'
    const pdfjs = (await import(/* @vite-ignore */ pdfPath)) as typeof import('pdfjs-dist')
    // Same worker the app wires up — the hand-vendored file under public/.
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

    const doc = await pdfjs.getDocument({ data: bytes }).promise
    const numPages = doc.numPages
    const pg = await doc.getPage(1)
    const viewport = pg.getViewport({ scale: 1.5 })

    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d canvas context')
    // Exact render-param shape from PdfViewerDialog.tsx.
    await pg.render({ canvasContext: ctx, viewport, canvas: null }).promise

    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let paintedPixels = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) paintedPixels++

    return { version: pdfjs.version, numPages, w: canvas.width, h: canvas.height, paintedPixels }
  }, PDF_B64)

  // API version must equal the vendored worker version (else getDocument would
  // have rejected before we got here).
  expect(result.version).toBe('6.0.227')
  expect(result.numPages).toBe(1)
  expect(result.w).toBeGreaterThan(0)
  expect(result.h).toBeGreaterThan(0)
  // The page actually rasterised (text "Hi 6.0" paints pixels).
  expect(result.paintedPixels).toBeGreaterThan(0)
  // No "API version does not match the Worker version" (or any) page error.
  expect(pageErrors.join('\n')).not.toMatch(/does not match the Worker version/i)
})
