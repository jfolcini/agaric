import { expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

/**
 * Settings › Data › Markdown mirror (#5363): choosing a folder turns the
 * mirror on and the card shows it; Turn off clears it. The mock's folder
 * dialog answers a fixed path and keeps the choice as its `app_settings` row,
 * so persistence shows by leaving Settings and coming back.
 */

// `MOCK_MIRROR_FOLDER` in src/lib/tauri-mock/handlers/system.ts.
const MOCK_FOLDER = '/home/mock/Agaric mirror'

async function openMirrorCard(page: import('@playwright/test').Page) {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Data')
  await expect(page.getByTestId('mirror-panel-title')).toBeVisible()
}

test.describe('Settings › Data: Markdown mirror @settings @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('choosing a folder turns the mirror on, and Turn off clears it', async ({ page }) => {
    await openMirrorCard(page)
    await expect(page.getByText('Off. No folder chosen.')).toBeVisible()

    await page.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(page.getByTestId('mirror-folder')).toHaveText(MOCK_FOLDER)
    await expect(page.getByText('No file has changed outside Agaric.')).toBeVisible()

    await navigateToView(page, 'Journal')
    await openMirrorCard(page)
    await expect(page.getByTestId('mirror-folder')).toHaveText(MOCK_FOLDER)

    await page.getByRole('button', { name: 'Turn off' }).click()
    await expect(page.getByText('Off. No folder chosen.')).toBeVisible()
    await expect(page.getByTestId('mirror-folder')).toHaveCount(0)

    await navigateToView(page, 'Journal')
    await openMirrorCard(page)
    await expect(page.getByText('Off. No folder chosen.')).toBeVisible()
  })

  test('reading changes back is chosen with the folder and changed later', async ({ page }) => {
    await openMirrorCard(page)
    const readBack = page.getByRole('switch', { name: 'Read changes back' })
    await expect(readBack).toBeChecked()

    await readBack.click()
    await page.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(page.getByTestId('mirror-folder')).toHaveText(MOCK_FOLDER)

    await navigateToView(page, 'Journal')
    await openMirrorCard(page)
    await expect(readBack).not.toBeChecked()

    // Choosing a folder while mirroring keeps reading back as it is.
    await page.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(page.getByTestId('mirror-folder')).toHaveText(MOCK_FOLDER)
    await navigateToView(page, 'Journal')
    await openMirrorCard(page)
    await expect(readBack).not.toBeChecked()

    await readBack.click()
    await expect(readBack).toBeChecked()
    await navigateToView(page, 'Journal')
    await openMirrorCard(page)
    await expect(readBack).toBeChecked()
  })
})

test.describe('Settings › Data: asking before many changes @settings @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('is on by default, and turned off stays off', async ({ page }) => {
    await openMirrorCard(page)
    await page.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(page.getByTestId('mirror-folder')).toHaveText(MOCK_FOLDER)
    const ask = page.getByRole('switch', { name: 'Ask before reading in many changes' })
    await expect(ask).toBeChecked()

    await ask.click()
    await expect(ask).not.toBeChecked()
    await navigateToView(page, 'Journal')
    await openMirrorCard(page)
    await expect(ask).not.toBeChecked()

    await ask.click()
    await navigateToView(page, 'Journal')
    await openMirrorCard(page)
    await expect(ask).toBeChecked()
  })

  test('Show the setting, clicked, shows the ask switch focused', async ({ page }) => {
    // The mock reads no folder, so the hold a real one reports is answered here.
    await page.evaluate((folder) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      const invoke = internals.invoke.bind(internals)
      internals.invoke = async (c, a) => {
        const answer = await invoke(c, a)
        if (c !== 'get_mirror_status') return answer
        return {
          ...(answer as object),
          folder,
          read_back: false,
          held: ['Personal'],
          failed: [{ page_id: '', path: 'Personal', message: '6 of its files changed' }],
          pending: ['Personal/A.md'],
        }
      }
    }, MOCK_FOLDER)
    await openMirrorCard(page)
    const ask = page.getByRole('switch', { name: 'Ask before reading in many changes' })
    const focusShown = () => ask.evaluate((el) => el.matches(':focus-visible'))

    await page.getByRole('button', { name: 'Show the setting' }).click()
    await expect(ask).toBeFocused()
    expect(await focusShown()).toBe(true)

    await page.getByRole('switch', { name: 'Read changes back' }).click()
    const question = page.getByRole('alertdialog')
    await question.getByRole('button', { name: 'Show the setting' }).click()
    await expect(question).toHaveCount(0)
    await expect(ask).toBeFocused()
    expect(await focusShown()).toBe(true)
  })
})

test.describe('Settings › Data: which spaces are mirrored @settings @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a space turned off stays off, and the others stay mirrored', async ({ page }) => {
    await openMirrorCard(page)
    await page.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(page.getByTestId('mirror-folder')).toHaveText(MOCK_FOLDER)
    const work = page.getByRole('switch', { name: 'Work', exact: true })
    const personal = page.getByRole('switch', { name: 'Personal', exact: true })
    await expect(work).toBeChecked()
    await expect(personal).toBeChecked()

    await work.click()
    await expect(work).not.toBeChecked()
    await navigateToView(page, 'Journal')
    await openMirrorCard(page)
    await expect(work).not.toBeChecked()
    await expect(personal).toBeChecked()

    await work.click()
    await navigateToView(page, 'Journal')
    await openMirrorCard(page)
    await expect(work).toBeChecked()
  })
})
