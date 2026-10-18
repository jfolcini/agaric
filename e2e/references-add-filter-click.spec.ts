/**
 * The first click on a References control lands while a block above it is
 * being edited. The press blurs the roving editor, whose formatting toolbar
 * sits in the flow above the text: had the block left edit mode on the press,
 * everything below would move up by the toolbar's height before the release
 * and the click would be lost. The blur saves at once and the block keeps its
 * editor until the press ends (`useEditorBlur`).
 */

import { devices, type Locator, type Page } from '@playwright/test'

import {
  activePopover,
  expect,
  openPage,
  openPageMobile,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

const TARGET = 'Refclick Target'
const TYPED = 'saved on the press'

/** An empty page, a block on Projects linking to it, and one naming it in plain text. */
function seed(page: Page): Promise<void> {
  return page.evaluate(async (target) => {
    const { invoke } = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    const targetId = (await invoke('create_page_in_space', {
      parentId: null,
      content: target,
      spaceId: 'SPACE_PERSONAL',
    })) as string
    await invoke('create_blocks_batch', {
      specs: [
        {
          blockType: 'content',
          content: `See [[${targetId}]]`,
          parentId: '00000000000000000000PAGE04',
          position: null,
        },
        {
          blockType: 'content',
          content: `Mentions ${target} in passing`,
          parentId: '00000000000000000000PAGE04',
          position: null,
        },
      ],
    })
  }, TARGET)
}

const editor = (page: Page) => page.locator('[data-testid="block-editor"] [contenteditable="true"]')

/** Open the target page; its auto-created block is in the editor, the toolbar above it. */
async function editTargetPage(page: Page, open: (page: Page, title: string) => Promise<void>) {
  await waitForBoot(page)
  await seed(page)
  await open(page, TARGET)
  await expect(editor(page)).toBeFocused()
  await page.keyboard.insertText(TYPED)
  await expect(editor(page)).toHaveText(TYPED)
}

interface Control {
  name: string
  locate: (page: Page) => Locator
  expectLanded: (page: Page, control: Locator) => Promise<void>
}

const references = (page: Page) => page.getByTestId('linked-references')

const ADD_FILTER: Control = {
  name: 'Add filter',
  locate: (page) => references(page).getByRole('button', { name: 'Add filter', exact: true }),
  expectLanded: (page) =>
    expect(references(page).getByRole('combobox', { name: 'Filter category' })).toBeVisible(),
}

const CONTROLS: Control[] = [
  ADD_FILTER,
  {
    name: 'the Page links toggle',
    locate: (page) => references(page).getByRole('button', { name: 'Page links', exact: true }),
    expectLanded: (_page, control) => expect(control).toHaveAttribute('aria-pressed', 'true'),
  },
  {
    name: 'Filter by source page',
    locate: (page) => references(page).getByRole('button', { name: 'Filter by source page' }),
    expectLanded: (page) =>
      expect(
        activePopover(page).getByRole('textbox', { name: 'Search source pages' }),
      ).toBeVisible(),
  },
  {
    name: 'the References header',
    locate: (page) => references(page).getByRole('button', { name: /1 Reference$/ }),
    expectLanded: (_page, control) => expect(control).toHaveAttribute('aria-expanded', 'false'),
  },
  {
    name: 'the Unlinked References header',
    locate: (page) =>
      page
        .getByTestId('unlinked-references')
        .getByRole('button', { name: /1 Unlinked Reference$/ }),
    expectLanded: (_page, control) => expect(control).toHaveAttribute('aria-expanded', 'true'),
  },
]

for (const control of CONTROLS) {
  test(`one click on ${control.name} lands while a block above is edited`, async ({ page }) => {
    await editTargetPage(page, openPage)
    await expect(page.getByTestId('formatting-toolbar')).toBeVisible()

    const target = control.locate(page)
    await target.scrollIntoViewIfNeeded()
    await target.click()
    await control.expectLanded(page, target)

    // The press ended the edit: the block is static, and its text was saved.
    await expect(page.locator('[data-testid="block-editor"]')).toHaveCount(0)
    await reopenPage(page, TARGET)
    await expect(page.locator('[data-testid="block-static"]').first()).toHaveText(TYPED)
  })
}

test.describe('mobile', () => {
  test.use({
    viewport: devices['iPhone 13'].viewport,
    userAgent: devices['iPhone 13'].userAgent,
    isMobile: true,
    hasTouch: true,
  })

  test('one tap on Add filter lands while a block above is edited', async ({ page }) => {
    await editTargetPage(page, openPageMobile)
    const addFilter = ADD_FILTER.locate(page)
    await addFilter.scrollIntoViewIfNeeded()
    await addFilter.tap()
    await ADD_FILTER.expectLanded(page, addFilter)
  })
})
