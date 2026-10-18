import type { Page } from '@playwright/test'

import { expect, focusBlock, openPage, test, typeSlashCommand, waitForBoot } from './helpers'

/**
 * `/voice` is offered only where the webview's `MediaRecorder` supports a
 * recording format, or failing that, where it can encode Ogg Opus itself with
 * `AudioEncoder` (#5730, `voice-note-record.spec.ts`). Chromium has an
 * `AudioEncoder`, so it is removed here to leave `MediaRecorder` deciding.
 */

async function stubMediaRecorder(page: Page, canRecord: boolean) {
  await page.addInitScript((supported) => {
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: class {
        static isTypeSupported(): boolean {
          return supported
        }
      },
    })
    Object.defineProperty(window, 'AudioEncoder', { configurable: true, value: undefined })
  }, canRecord)
  await waitForBoot(page)
  await openPage(page, 'Getting Started')
  await focusBlock(page)
}

test.describe('/voice feature detection @attachments', () => {
  test('is not offered where MediaRecorder supports no format and AudioEncoder is missing', async ({
    page,
  }) => {
    await stubMediaRecorder(page, false)
    const list = await typeSlashCommand(page, '')
    // The sibling command is there, so the menu is open and populated.
    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'ATTACH' }),
    ).toBeVisible()
    await expect(list.locator('[data-testid="suggestion-item"]', { hasText: 'VOICE' })).toHaveCount(
      0,
    )

    await page.keyboard.type('voice', { delay: 30 })
    await expect(page.locator('.suggestion-empty')).toBeVisible()
    await expect(page.locator('[data-testid="suggestion-item"]', { hasText: 'VOICE' })).toHaveCount(
      0,
    )
  })

  test('is offered where MediaRecorder supports one', async ({ page }) => {
    await stubMediaRecorder(page, true)
    const list = await typeSlashCommand(page, '')

    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'VOICE' }),
    ).toBeVisible()
  })
})
