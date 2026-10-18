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
 * `/voice` where `MediaRecorder` records no format, as on WebKitGTK (#5730):
 * the dialog captures through an `AudioWorklet`, encodes with WebCodecs
 * `AudioEncoder('opus')` and writes Ogg itself. Chromium's `MediaRecorder` is
 * removed to force that route; its fake microphone plays a tone. The vitest DOM
 * has no audio stack, so this is the lane where a real encoder and a real
 * `<audio>` read the file.
 */
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
  permissions: ['microphone'],
})

/** BLOCK_GS_1, the first child of "Getting Started" in the mock seed. */
const BLOCK_GS_1 = '0000000000000000000BLOCK01'

test('records a voice note as Ogg Opus where MediaRecorder cannot record', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: undefined })
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

  await reopenPage(page, 'Getting Started')
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
  expect(rows[0]?.mime_type).toBe('audio/ogg')
  expect(rows[0]?.filename).toMatch(/^voice-note-.*\.ogg$/)
  expect(rows[0]?.size_bytes).toBeGreaterThan(1000)

  const player = page.getByLabel(`Audio ${rows[0]?.filename}`)
  await expect(player).toBeAttached()
  await expect
    .poll(() => player.evaluate((audio: HTMLAudioElement) => audio.duration))
    .toBeGreaterThan(2.5)
  await expect
    .poll(() => player.evaluate((audio: HTMLAudioElement) => audio.duration))
    .toBeLessThan(4)
})
