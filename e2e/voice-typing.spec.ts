/**
 * #5745 — OS voice typing (Gboard voice, macOS Dictation, Win+H) reaches the
 * webview as input-method composition: the interim words are a composition that
 * grows, and the final phrase is committed over it. These tests drive that
 * through CDP (`Input.imeSetComposition` for the interim text, with a
 * replacement range for a self-correction, and `Input.insertText` for the
 * commit) and check that the text is stored once, where the caret was, in the
 * block editor, the page title, the command palette, the `[[` picker, the link
 * popover and an inline property value.
 *
 * Limits:
 * - CDP only approximates the event sequences real Gboard, Dictation and Win+H
 *   send; a device check covers those (#5745).
 * - W3C WebDriver, and so WebKitWebDriver, has no IME composition actions, so
 *   no `e2e-tauri/` spec can compose in WebKitGTK; this Chromium lane (the
 *   engine of Android's WebView) is the only one that drives composition.
 */

import { devices, type CDPSession, type Locator, type Page } from '@playwright/test'

import {
  activePopover,
  activeSuggestionList,
  expect,
  focusBlockById,
  ipc,
  openPage,
  openPageMobile,
  reopenPage,
  replaceEditorText,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

// `SEED_IDS` in src/lib/tauri-mock/seed.ts.
const GS_1 = '0000000000000000000BLOCK01'
const GS_3 = '0000000000000000000BLOCK03'
const MTG_1 = '0000000000000000000BLOCK17'
const GS_3_TEXT = 'Create new blocks by pressing Enter at the end of any block.'
const QUICK_NOTES = '00000000000000000000PAGE02'
const GETTING_STARTED = 'Getting Started'
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

/**
 * Say `phrase` into the focused field: one composition that grows word by word,
 * as voice typing shows its interim result, then the phrase committed over it.
 */
async function dictate(page: Page, phrase: string): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page)
  for (const word of phrase.matchAll(/\S+/g)) {
    const text = phrase.slice(0, word.index + word[0].length)
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    })
  }
  await cdp.send('Input.insertText', { text: phrase })
  return cdp
}

function staticBlock(page: Page, id: string): Locator {
  return page.locator(`[data-testid="block-static"][data-block-id="${id}"]`)
}

async function storedContent(page: Page, blockId: string): Promise<string> {
  return (await ipc<{ content: string }>(page, 'get_block', { blockId })).content
}

/** Leave the block, reopen the page, and expect the block stored as `markdown`. */
async function expectStored(page: Page, blockId: string, markdown: string) {
  await page.keyboard.press('Escape')
  await reopenPage(page, GETTING_STARTED)
  await expect(staticBlock(page, blockId)).toBeVisible()
  await expect.poll(() => storedContent(page, blockId)).toBe(markdown)
}

test.describe('voice typing lands once, where the caret is @editor @search @pages @mobile', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test.describe('in a block', () => {
    test.beforeEach(async ({ page }) => {
      await openPage(page, GETTING_STARTED)
      await focusBlockById(page, GS_1)
    })

    // [where, typed through the input rules, caret offset (markers not counted) or `null` to
    // leave it where typing did, phrase, stored once the `!` typed after it is in]
    const CASES = [
      ['mid plain text', 'Meet team', 5, 'the ', 'Meet the !team'],
      [
        'the end of bold',
        'X before **bold** after',
        13,
        'est one',
        'X before **boldest one!** after',
      ],
      ['the end of italic', 'X before *it* after', 11, 'em two', 'X before *item two!* after'],
      ['the end of code', 'X before `code` after', 13, 'base', 'X before `codebase!` after'],
      [
        'the end of a link',
        'X before [label](https://example.com) after',
        14,
        'led',
        'X before [labelled!](https://example.com) after',
      ],
      ['the end of a block', 'Plain end', null, ' of the line', 'Plain end of the line!'],
      // The input rule leaves the caret past the bold, as typing on would.
      ['the end of a block, past bold', 'Make **bold**', null, ' then', 'Make **bold** then!'],
      ['an empty block', '', null, 'spoken into nothing', 'spoken into nothing!'],
    ] as const

    for (const [where, typed, caret, phrase, markdown] of CASES) {
      test(`dictated at ${where}, the phrase is stored once with the caret after it`, async ({
        page,
      }) => {
        await replaceEditorText(page, '')
        await page.keyboard.type(typed)
        if (caret !== null) await selectEditorRange(page, caret, caret)
        await dictate(page, phrase)
        await page.keyboard.insertText('!')
        await expectStored(page, GS_1, markdown)
      })
    }

    test('a phrase composed whole and committed is stored once', async ({ page }) => {
      await replaceEditorText(page, 'Notes:')
      const phrase = ' call the plumber on Friday'
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.imeSetComposition', {
        text: phrase,
        selectionStart: phrase.length,
        selectionEnd: phrase.length,
      })
      await cdp.send('Input.insertText', { text: phrase })
      await expectStored(page, GS_1, `Notes:${phrase}`)
    })

    test('a self-correction re-composes the last word over its own range', async ({ page }) => {
      await replaceEditorText(page, '')
      await page.keyboard.type('X before **bold** after')
      await selectEditorRange(page, 13, 13)
      const cdp = await dictate(page, 'est for')
      // The recognizer revises `for` to `four`. Its range is in the text the input method
      // reads, which holds the drawn `**` markers around the bold.
      const start = await page
        .locator(EDITOR)
        .evaluate((root) => (root.textContent ?? '').lastIndexOf('for'))
      await cdp.send('Input.imeSetComposition', {
        text: 'four',
        selectionStart: 4,
        selectionEnd: 4,
        replacementStart: start,
        replacementEnd: start + 'for'.length,
      })
      await cdp.send('Input.insertText', { text: 'four' })
      await expectStored(page, GS_1, 'X before **boldest four** after')
    })

    test('a composition open when another block is clicked commits once, in its own block', async ({
      page,
    }) => {
      await replaceEditorText(page, 'First')
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.imeSetComposition', {
        text: ' still open',
        selectionStart: 11,
        selectionEnd: 11,
      })
      // The press keeps the editor focused until the click moves it (`keepEditorUntilClick`),
      // and a CDP press does not end the composition, so it is still open when the editor moves.
      const second = await focusBlockById(page, GS_3)
      await expect(staticBlock(page, GS_1)).toHaveText('First still open')
      await expect(second).toHaveText(GS_3_TEXT)
      // What is said next goes to the block now being edited.
      await dictate(page, ' and more')

      await page.keyboard.press('Escape')
      await reopenPage(page, GETTING_STARTED)
      await expect(staticBlock(page, GS_1)).toHaveText('First still open')
      await expect.poll(() => storedContent(page, GS_1)).toBe('First still open')
      await expect.poll(() => storedContent(page, GS_3)).toBe(`${GS_3_TEXT} and more`)
    })

    test('a [[ picker query takes the dictated words and links the page they name', async ({
      page,
    }) => {
      await replaceEditorText(page, 'See')
      await page.keyboard.type(' [[', { delay: 30 })
      await expect(activeSuggestionList(page)).toBeVisible()
      await dictate(page, 'quick notes')
      const options = activeSuggestionList(page).getByRole('option')
      await expect(options.filter({ hasText: 'Getting Started' })).toHaveCount(0)
      await options.filter({ hasText: /^Quick Notes$/ }).click()
      await expect(page.locator(EDITOR).getByTestId('block-link-chip')).toHaveText('Quick Notes')

      await page.keyboard.press('Escape')
      await reopenPage(page, GETTING_STARTED)
      await expect(staticBlock(page, GS_1).getByTestId('block-link-chip')).toHaveText('Quick Notes')
      await expect.poll(() => storedContent(page, GS_1)).toBe(`See [[${QUICK_NOTES}]]`)
    })

    test('a URL dictated into the link popover becomes the link', async ({ page }) => {
      await replaceEditorText(page, 'see label')
      await selectEditorRange(page, 4, 9)
      await page.keyboard.press('Control+k')
      const url = activePopover(page).getByPlaceholder('https://...')
      await expect(url).toBeFocused()
      await dictate(page, 'example.org/spoken')
      await expect(url).toHaveValue('example.org/spoken')
      await url.press('Enter')
      await expect(url).toBeHidden()
      await expectStored(page, GS_1, 'see [label](https://example.org/spoken)')
      await expect(staticBlock(page, GS_1).getByTestId('external-link')).toHaveAttribute(
        'data-href',
        'https://example.org/spoken',
      )
    })
  })

  test('a page title takes the dictated words once', async ({ page }) => {
    await openPage(page, 'Quick Notes')
    const title = page.getByRole('textbox', { name: 'Page title' })
    await title.click()
    await title.press('End')
    await dictate(page, ' for today')
    await expect(title).toHaveText('Quick Notes for today')
    await title.press('Enter')

    await reopenPage(page, 'Quick Notes for today')
    await expect(title).toHaveText('Quick Notes for today')
    await expect.poll(() => storedContent(page, QUICK_NOTES)).toBe('Quick Notes for today')
  })

  test('the command palette searches for the dictated words', async ({ page }) => {
    await page.getByTestId('header-search-button').click()
    const input = page.getByTestId('command-palette-input')
    await expect(input).toBeFocused()
    await dictate(page, 'quick notes')
    await expect(input).toHaveValue('quick notes')
    await expect(page.getByRole('option', { name: /Quick Notes/ }).first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveText('Quick Notes')
  })

  test('a property value takes the dictated words', async ({ page }) => {
    await openPage(page, 'Meetings')
    // "Weekly standup notes", with `context: @office`.
    const block = page.locator(`[data-testid="sortable-block"][data-block-id="${MTG_1}"]`)
    await block.getByRole('button', { name: 'Context: @office' }).click()
    const input = page.getByRole('dialog', { name: 'Edit property' }).getByRole('textbox')
    await expect(input).toBeFocused()
    await input.press('Control+a')
    await dictate(page, 'at home')
    await expect(input).toHaveValue('at home')
    await input.press('Enter')
    await expect(input).toBeHidden()

    await reopenPage(page, 'Meetings')
    await expect(block.getByRole('button', { name: 'Context: at home', exact: true })).toBeVisible()
    const props = await ipc<Array<{ key: string; value_text: string | null }>>(
      page,
      'get_properties',
      { blockId: MTG_1 },
    )
    expect(props.find((p) => p.key === 'context')?.value_text).toBe('at home')
  })

  test.describe('on an Android phone', () => {
    const { defaultBrowserType: _, ...pixel7 } = devices['Pixel 7']
    test.use(pixel7)

    test('a block takes the dictated words at the end of bold', async ({ page }) => {
      await openPageMobile(page, GETTING_STARTED)
      await focusBlockById(page, GS_1)
      await replaceEditorText(page, '')
      await page.keyboard.type('X before **bold** after')
      await selectEditorRange(page, 13, 13)
      await dictate(page, 'est one')
      await page.keyboard.press('Escape')
      await openPageMobile(page, 'Quick Notes')
      await openPageMobile(page, GETTING_STARTED)
      await expect(staticBlock(page, GS_1)).toHaveText('X before boldest one after')
      await expect.poll(() => storedContent(page, GS_1)).toBe('X before **boldest one** after')
    })
  })
})
