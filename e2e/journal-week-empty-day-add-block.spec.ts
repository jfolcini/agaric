import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * Week view, a day with no journal page: one click on its "Add block" creates
 * the day and exactly one focused, editable block in it. Before the fix the
 * click created only the page: with reduced motion the day sat on "Creating
 * first block…" until a second click, because the week view never seeds a
 * first block on mount (that would create a block on every empty day it
 * shows); without it the day stayed blank, because the lazy-mount observer
 * armed before the day had a page to mount.
 */
for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`one "Add block" click on an empty week day creates one focused block there (${reducedMotion}) @editor @journal`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion })
    await waitForBoot(page)
    await page.getByRole('tab', { name: 'Weekly view' }).click()

    // The seed has a journal page for today only, so every other day is empty.
    const emptyDays = page.locator('section[id^="journal-"]', { hasText: 'No blocks for' })
    await expect(emptyDays).toHaveCount(6)
    const day = emptyDays.first()
    const dayId = await day.getAttribute('id')
    if (dayId == null) throw new Error('empty day section has no id')
    const section = page.locator(`section[id="${dayId}"]`)

    await section.getByRole('button', { name: 'Add block', exact: true }).click()

    const editor = section.getByRole('textbox', { name: 'Block editor' })
    await expect(editor).toBeFocused()
    await expect(section.locator('[data-testid="sortable-block"]')).toHaveCount(1)
    await expect(section.getByText('Creating first block…')).toHaveCount(0)
    // The click seeded only its own day.
    await expect(emptyDays).toHaveCount(5)

    await editor.pressSequentially('moss ledger', { delay: 10 })
    await expect(editor).toHaveText('moss ledger')
    await page.keyboard.press('Escape')
    const committed = section.locator('[data-testid="block-static"]', { hasText: 'moss ledger' })
    await expect(committed).toBeVisible()

    // Durable: the block outlives a view round trip.
    await navigateToView(page, 'Pages')
    await navigateToView(page, 'Journal')
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    await expect(committed).toBeVisible()
  })
}
