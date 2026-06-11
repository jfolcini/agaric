/**
 * E2E — mobile/touch editor coverage (#916).
 *
 * The UX review found that NONE of the e2e specs exercise the editor on a
 * mobile/touch viewport — the only mobile specs test Search. This spec proves
 * the core note-taking surface works on an iPhone 13 viewport with touch
 * enabled: tap-to-focus, typing commits, Enter creates a block, and arrow
 * navigation moves focus across blocks. It drives the default boot (Journal)
 * view, whose seeded day already has editable blocks.
 *
 * Scope note: precise caret control via key chords (Ctrl+A select-all, End)
 * does NOT behave identically under Playwright's touch/mobile emulation, so
 * these tests deliberately avoid asserting exact split text (that is covered on
 * desktop by block-keyboard-fundamentals.spec.ts) and instead assert the
 * mobile-reachable contract: typing lands, a block is created, focus moves.
 */

import { devices } from '@playwright/test'

import {
  clearInvokeCalls,
  expect,
  focusBlock,
  getInvokeCalls,
  installIpcRecorder,
  test,
  waitForBoot,
} from './helpers'

const iPhone13 = devices['iPhone 13']

async function liveEditorBlockId(page: import('@playwright/test').Page): Promise<string | null> {
  return page.locator('[data-testid="block-editor"]').first().getAttribute('data-block-id')
}

test.describe('Mobile editor (iPhone 13 viewport)', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
    await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
  })

  test('tapping a block focuses it and typing commits the text', async ({ page }) => {
    const editor = await focusBlock(page, 0)
    const before = (await editor.textContent()) ?? ''

    await editor.pressSequentially('ZZZ')

    // The typed text is now present in the contenteditable (ProseMirror committed it).
    await expect.poll(async () => (await editor.textContent()) ?? '').toContain('ZZZ')
    expect(before).not.toContain('ZZZ')
  })

  test('Enter creates a new block on a touch viewport', async ({ page }) => {
    const editor = await focusBlock(page, 0)
    await editor.pressSequentially('note')
    await clearInvokeCalls(page)
    await editor.press('Enter')

    // A new block is created (the create_block IPC fires) — the core
    // outline-building gesture works on mobile.
    await expect
      .poll(async () => (await getInvokeCalls(page, 'create_block')).length)
      .toBeGreaterThan(0)
  })

  test('ArrowDown at the end of a block moves focus to another block', async ({ page }) => {
    const editor = await focusBlock(page, 0)
    const startId = await liveEditorBlockId(page)
    await editor.press('ArrowDown')

    await expect.poll(async () => liveEditorBlockId(page)).not.toBe(startId)
  })
})
