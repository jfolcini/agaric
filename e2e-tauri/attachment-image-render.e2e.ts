// ---------------------------------------------------------------------------
// Real-backend pasted image renders from its stored bytes (#5365).
//
// A pasted image is stored as an `attachments` row plus a file under the app
// data dir (`add_attachment_with_bytes`), and the block holds only an
// `![name](attachment:<id>)` ref. GatedImage resolves the ref with
// `read_attachment` into a `blob:` URL, so an `<img>` that decodes
// (`naturalWidth > 0`) after a round trip proves the bytes on disk, which
// the mock never holds. `attachment-paste-roundtrip` checks only the row.
//
// Then an Edit-as-Markdown save that edits only the block below must leave the
// image block's ref as it was, and the image still rendering: the buffer's
// render and parse (`get_page_buffer` / `apply_page_source`) are the real
// backend's.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  enterBlankSibling,
  expectAbsent,
  navigateTo,
  openNewPage,
  openPageSource,
  pageSourceButton,
  pageSourceLines,
  pasteFileIntoFocusedBlock,
  reopenPageByTitle,
  runScopedMarker,
  setPageSourceLines,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const IMAGE_BLOCK = runScopedMarker('wdio-img-holder')
const BELOW = runScopedMarker('wdio-img-below')
const BELOW_EDITED = runScopedMarker('wdio-img-edited')
const FILENAME = 'wdio-image.png'
// A 1x1 transparent PNG (68 bytes).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(marker: string): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await blockStaticByMarker(marker).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Wait until block `id` renders exactly one image, decoded from a `blob:` URL. */
async function expectImageRendered(id: string, when: string): Promise<void> {
  await $(`[data-block-id="${id}"]`).scrollIntoView()
  let seen: Array<{ src: string; complete: boolean; width: number }> = []
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute(
          (blockId: string) =>
            [...document.querySelectorAll<HTMLImageElement>('[data-testid="image-rendered"]')]
              .filter(
                (img) => img.closest('[data-block-id]')?.getAttribute('data-block-id') === blockId,
              )
              .map((img) => ({
                src: img.getAttribute('src') ?? '',
                complete: img.complete,
                width: img.naturalWidth,
              })),
          id,
        )
        const [only] = seen
        return (
          seen.length === 1 &&
          only !== undefined &&
          only.src.startsWith('blob:') &&
          only.complete &&
          only.width > 0
        )
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${when}: the image block renders ${JSON.stringify(seen)}`)
    })
}

/** The buffer line of the image block, which carries its `attachment:` ref. */
async function imageLine(id: string): Promise<string> {
  const line = (await pageSourceLines()).find((l) => l.id === id)
  if (line === undefined) throw new Error('the buffer holds no line for the image block')
  return line.text
}

describe('Agaric real-backend pasted image render (#5365)', () => {
  it('renders a pasted PNG from its bytes, also after a source save of another line', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(IMAGE_BLOCK)
    await pasteFileIntoFocusedBlock(PNG_BASE64, FILENAME, 'image/png')
    await waitForToast(`Attached "${FILENAME}"`)
    // The image decoding after the paste re-renders the block and moves the
    // layout under the next keystrokes; typing below it before then dropped
    // characters and left the editor non-interactable.
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const img = document.querySelector<HTMLImageElement>(
            '[data-testid="block-editor"] [data-testid="image-rendered"]',
          )
          return img !== null && img.complete && img.naturalWidth > 0
        }),
      { timeout: NAV_TIMEOUT, timeoutMsg: 'the pasted image never rendered in the editor' },
    )
    await enterBlankSibling()
    await typeMarkerVerified(BELOW)
    // The sidebar click commits the block below by blurring the editor.
    await reopenTheNewPage(BELOW)

    const id = await blockStaticByMarker(IMAGE_BLOCK).getAttribute('data-block-id')
    if (id === null) throw new Error('the image block has no data-block-id')
    await expectImageRendered(id, 'after the round trip')

    const source = await openPageSource([IMAGE_BLOCK, BELOW])
    const before = await imageLine(id)
    expect(before).toContain(`](attachment:`)
    await setPageSourceLines(
      (await pageSourceLines()).map(({ text, id: lineId }) => ({
        id: lineId,
        text: text.replace(BELOW, BELOW_EDITED),
      })),
    )
    const save = pageSourceButton('Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await source.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Save did not close source mode',
    })

    await reopenTheNewPage(BELOW_EDITED)
    await expectAbsent(`[data-testid="block-static"]*=${BELOW}`, 'the text the save replaced')
    await expectImageRendered(id, 'after the source save')
    await openPageSource([IMAGE_BLOCK, BELOW_EDITED])
    expect(await imageLine(id)).toBe(before)
  })
})
