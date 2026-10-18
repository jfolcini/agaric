import type { Page } from '@playwright/test'

import {
  activeDialog,
  activeSuggestionList,
  expect,
  focusBlockById,
  openPage,
  reopenPage,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * `/voice` on both recording routes. Where `MediaRecorder` records no format,
 * as on WebKitGTK (#5730), the dialog captures through an `AudioWorklet`,
 * encodes with WebCodecs `AudioEncoder('opus')` and writes Ogg itself;
 * Chromium's `MediaRecorder` is removed to force that route. Left in place, it
 * records WebM, as on Android and Windows. The fake microphone plays a tone.
 * The vitest DOM has no audio stack, so this is the lane where a real encoder
 * and a real `<audio>` read the file.
 */
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
  permissions: ['microphone'],
})

/** BLOCK_GS_1, the first child of "Getting Started" in the mock seed. */
const BLOCK_GS_1 = '0000000000000000000BLOCK01'

/**
 * Records a three-second note into BLOCK_GS_1 and saves it; checks the player
 * that appears, then again after leaving the page and coming back, and returns
 * the attachment row.
 */
async function recordVoiceNote(page: Page) {
  // Every `timeupdate` an `<audio>` fires, which is what moves the native controls' playhead.
  await page.addInitScript(() => {
    const seen: number[] = []
    Object.assign(window, { __audioTimeUpdates: seen })
    document.addEventListener(
      'timeupdate',
      (event) => seen.push((event.target as HTMLMediaElement).currentTime),
      true,
    )
  })
  await waitForBoot(page)
  await openPage(page, 'Getting Started')
  await focusBlockById(page, BLOCK_GS_1)
  await typeSlashCommand(page, 'voice')
  await activeSuggestionList(page)
    .locator('[data-testid="suggestion-item"]', { hasText: 'VOICE' })
    .click()

  const dialog = activeDialog(page)
  await dialog.getByRole('button', { name: 'Record' }).click()
  await expect(dialog.getByRole('timer', { name: 'Recording time' })).toHaveText('0:03', {
    timeout: 10_000,
  })
  await dialog.getByRole('button', { name: 'Stop and save' }).click()
  await expect(dialog).toBeHidden()
  await expectLengthBeforePlay(page)

  await reopenPage(page, 'Getting Started')
  await expectLengthBeforePlay(page)
  const rows = await page.evaluate(async (blockId) => {
    const { invoke } = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    return (await invoke('list_attachments', { blockId })) as Array<{
      filename: string
      mime_type: string
      size_bytes: number
    }>
  }, BLOCK_GS_1)
  expect(rows).toHaveLength(1)
  return rows[0]
}

/**
 * The player knows the note's length, about the three seconds recorded,
 * without being played, and its playhead never left the start.
 */
async function expectLengthBeforePlay(page: Page) {
  const player = page.getByLabel(/^Audio voice-note-/)
  await expect(player).toBeAttached()
  await expect
    .poll(() => player.evaluate((audio: HTMLAudioElement) => audio.duration))
    .toBeLessThan(4.5)
  const state = await player.evaluate((audio: HTMLAudioElement) => ({
    duration: audio.duration,
    currentTime: audio.currentTime,
    paused: audio.paused,
    played: audio.played.length,
    timeUpdates: (window as unknown as { __audioTimeUpdates: number[] }).__audioTimeUpdates,
  }))
  expect(state.duration).toBeGreaterThan(2.5)
  expect(state.currentTime).toBe(0)
  expect(state.paused).toBe(true)
  expect(state.played).toBe(0)
  expect(state.timeUpdates.filter((time) => time !== 0)).toEqual([])
}

test('records a voice note as Ogg Opus where MediaRecorder cannot record @attachments', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: undefined })
  })
  const row = await recordVoiceNote(page)
  expect(row?.mime_type).toBe('audio/ogg')
  expect(row?.filename).toMatch(/^voice-note-.*\.ogg$/)
  expect(row?.size_bytes).toBeGreaterThan(1000)
})

/**
 * Chromium's `MediaRecorder` (Android, Windows) writes WebM with no Duration
 * element, so `<audio>` reports `Infinity` until it has played the note to the
 * end, unless the player has the element find the length on load.
 */
test('a WebM voice note shows its length before it is played @attachments', async ({ page }) => {
  const row = await recordVoiceNote(page)
  expect(row?.mime_type).toBe('audio/webm')
  expect(row?.filename).toMatch(/^voice-note-.*\.webm$/)
})
