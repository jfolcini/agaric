// ---------------------------------------------------------------------------
// Real-webview `/voice` on WebKitGTK (#5730).
//
// WebKitGTK's `MediaRecorder` records no format, so the recorder captures
// through an `AudioWorklet` (a same-origin module, under the app's CSP), encodes
// with WebCodecs `AudioEncoder('opus')` through GStreamer, and writes Ogg
// itself. Under `AGARIC_E2E_SANDBOX` the microphone is WebKitGTK's mock
// capture device, a tone (`microphone-permission.e2e.ts`). The mock-backed
// `e2e/voice-note-record.spec.ts` runs Chromium's encoder and player; only this
// lane plays the file in the engine Linux users have, from the bytes on disk.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const PAGE = runScopedMarker('wdio-voice-page')
const BLOCK = runScopedMarker('wdio-voice-note')

interface AttachmentRow {
  filename: string
  mime_type: string
  size_bytes: number
}

describe('Agaric real-webview voice note (#5730) @attachments', () => {
  it('records Ogg Opus from the microphone, and the note plays after a round trip', async () => {
    await waitForAppReady()
    await openNewPage(PAGE)
    await typeMarkerVerified(BLOCK)
    // One key per call: WebKit coalesces identical adjacent keys sent together.
    for (const key of ' /voice') await browser.keys([key])
    const command = $('[data-testid="suggestion-item"]*=VOICE')
    await command.waitForClickable({ timeout: ACTION_TIMEOUT })
    await command.click()

    const dialog = $('[data-testid="voice-note-dialog"]')
    await dialog.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const record = dialog.$('button=Record')
    await record.waitForClickable({ timeout: ACTION_TIMEOUT })
    await record.click()
    const timer = dialog.$('[role="timer"]')
    await browser.waitUntil(
      async () => {
        const [minutes = 0, seconds = 0] = (await timer.getText()).split(':').map(Number)
        return minutes * 60 + seconds >= 3
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the recording never reached three seconds' },
    )
    await dialog.$('button=Stop and save').click()
    await waitForToast('Voice note attached')

    await navigateTo('Journal')
    await reopenPageByTitle(PAGE)
    const block = blockStaticByMarker(BLOCK)
    await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const blockId = await block.getAttribute('data-block-id')
    if (blockId === null) throw new Error('the voice note block has no data-block-id')

    const rows = await browser.execute(
      async (id: string) =>
        (await (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
          }
        ).__TAURI_INTERNALS__.invoke('list_attachments', { blockId: id })) as AttachmentRow[],
      blockId,
    )
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row?.mime_type).toBe('audio/ogg')
    expect(row?.filename).toMatch(/^voice-note-.*\.ogg$/)
    expect(row?.size_bytes).toBeGreaterThan(1000)

    const player = `audio[aria-label="Audio ${row?.filename}"]`
    await $(player).waitForExist({ timeout: NAV_TIMEOUT })
    let duration = Number.NaN
    await browser.waitUntil(
      async () => {
        duration = await browser.execute(
          (selector: string) =>
            document.querySelector<HTMLAudioElement>(selector)?.duration ?? Number.NaN,
          player,
        )
        return duration > 0
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the voice note never reported a duration' },
    )
    // Three seconds on the timer, give or take the start-up and the click.
    expect(duration).toBeGreaterThan(2.5)
    expect(duration).toBeLessThan(4.5)
  })
})
