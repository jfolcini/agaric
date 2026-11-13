/**
 * Text typed in page mode (#5691), against the mock backend, each read back
 * from it: the mark chords, Markdown typed as text, the `@` picker and an `@`
 * in prose, a `[[Page|label]]` link, and a `key:: value` line the backend
 * refuses.
 */

import type { Page } from '@playwright/test'

import {
  activeSuggestionList,
  clearConsoleErrors,
  expect,
  getConsoleErrors,
  ipc,
  test,
  waitForBoot,
} from './helpers'
import {
  PAGE_EDITOR,
  SCOPE,
  backendTexts,
  caret,
  openInPageMode,
  openPageByTitle,
  seedPage,
  shownBlocks,
} from './page-mode'

/** The seeded Getting Started page and `work` tag (`src/lib/tauri-mock/seed.ts`). */
const PAGE_GETTING_STARTED = '00000000000000000000PAGE01'
const TAG_WORK = '000000000000000000000TAG01'

const content = (page: Page, id: string | undefined) =>
  page.locator(`${PAGE_EDITOR} [data-page-block-id="${id}"] .page-block-content`)

test.describe('text typed in page mode (#5691) @editor @pages @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('each mark chord marks the selected word, stored as its Markdown, and it stays', async ({
    page,
  }) => {
    const marks = [
      ['Control+b', 'strong', '**word** bold'],
      ['Control+i', 'em', '*word* italic'],
      ['Control+u', 'u', '<u>word</u> underline'],
      ['Control+Shift+K', 'code', '`word` code'],
      ['Control+Shift+S', 's', '~~word~~ strike'],
      ['Control+Shift+H', 'mark', '==word== highlight'],
    ] as const
    const { pageId, ids } = await seedPage(
      page,
      'Mark chords',
      marks.map(([, , stored]) => [0, `word ${stored.split(' ')[1]}`]),
    )
    await openInPageMode(page, 'Mark chords', marks.length)

    for (const [index, [chord, tag]] of marks.entries()) {
      await caret(page, index, 0, { index, offset: 'word'.length })
      await page.keyboard.press(chord)
      await expect(content(page, ids[index]).locator(tag)).toHaveText('word')
    }
    await page.keyboard.press('Escape')

    const stored = marks.map(([, , text]) => text)
    await expect.poll(() => backendTexts(page, pageId)).toEqual(stored)

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, 'Mark chords', marks.length)
    for (const [index, [, tag]] of marks.entries()) {
      await expect(content(page, ids[index]).locator(tag)).toHaveText('word')
    }
    expect(await backendTexts(page, pageId)).toEqual(stored)
  })

  test('Markdown typed as text becomes its marks and link, stored as typed', async ({ page }) => {
    const { pageId, ids } = await seedPage(page, 'Typed Markdown', [
      [0, ''],
      [0, ''],
    ])
    await openInPageMode(page, 'Typed Markdown', 2)

    await caret(page, 0, 'end')
    await page.keyboard.type('a **bold** and *slanted* word')
    await caret(page, 1, 'end')
    await page.keyboard.type('see [the docs](https://example.com) now')
    await page.keyboard.press('Escape')

    await expect(content(page, ids[0]).locator('strong')).toHaveText('bold')
    await expect(content(page, ids[0]).locator('em')).toHaveText('slanted')
    await expect(content(page, ids[1]).locator('a')).toHaveText('the docs')
    await expect
      .poll(() => backendTexts(page, pageId))
      .toEqual(['a **bold** and *slanted* word', 'see [the docs](https://example.com) now'])
  })

  test('@ picks a tag, and an @ in prose stays text and makes none', async ({ page }) => {
    const { pageId, ids } = await seedPage(page, 'At in page mode', [
      [0, 'filed under'],
      [0, 'meet'],
    ])
    const tags = () => ipc<unknown[]>(page, 'list_all_tags_in_space', { scope: SCOPE })
    const tagsBefore = await tags()
    await openInPageMode(page, 'At in page mode', 2)

    await caret(page, 0, 'end')
    await page.keyboard.type(' @wor')
    const work = activeSuggestionList(page).getByRole('option', { name: 'work', exact: true })
    await expect(work).toBeVisible()
    await work.click()
    await expect(content(page, ids[0]).getByTestId('tag-ref-chip')).toHaveText('work')

    await caret(page, 1, 'end')
    await page.keyboard.type(' @ 5pm tomorrow')
    await page.keyboard.press('Enter')
    await page.keyboard.type('after')

    await expect
      .poll(() => backendTexts(page, pageId))
      .toEqual([`filed under #[${TAG_WORK}]`, 'meet @ 5pm tomorrow', 'after'])
    expect(await tags()).toHaveLength(tagsBefore.length)
  })

  test('[[Page|label]] typed is a chip showing the label, stored with it, and it stays', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'Labelled link', [
      [0, 'read'],
      [0, 'next'],
    ])
    await openInPageMode(page, 'Labelled link', 2)

    await caret(page, 0, 'end')
    await page.keyboard.type(' [[Getting Started|the guide]] first')
    const chip = content(page, ids[0]).getByTestId('block-link-chip')
    await expect(chip).toHaveText('the guide')
    const stored = `read [[${PAGE_GETTING_STARTED}|the guide]] first`
    await expect.poll(async () => (await backendTexts(page, pageId))[0]).toBe(stored)

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, 'Labelled link', 2)
    await expect(chip).toHaveText('the guide')
    expect((await backendTexts(page, pageId))[0]).toBe(stored)
  })

  test('a key:: value line the backend refuses stays text, with one toast, and nothing is written', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'Refused property', [
      [0, 'plan'],
      [0, 'next'],
    ])
    await openInPageMode(page, 'Refused property', 2)

    await caret(page, 0, 'end')
    await page.keyboard.press('Shift+Enter')
    // `project` is a seeded select; `delta` is not one of its options.
    await page.keyboard.type('project:: delta')
    await page.keyboard.press('ArrowDown')

    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'project:: delta' }),
    ).toBeVisible()
    // A snapshot, not a retrying count: a second toast would pass once the first had gone.
    expect(await page.locator('[data-sonner-toast]').count()).toBe(1)
    const kept = 'plan\nproject:: delta'
    await expect.poll(async () => (await backendTexts(page, pageId))[0]).toBe(kept)
    expect(await ipc<unknown[]>(page, 'get_properties', { blockId: ids[0] })).toEqual([])
    expect((await shownBlocks(page))[0]?.text).toBe('planproject:: delta')

    expect(getConsoleErrors(page).join('\n')).toContain(
      'Failed to set inline property from :: syntax',
    )
    clearConsoleErrors(page)
  })
})
