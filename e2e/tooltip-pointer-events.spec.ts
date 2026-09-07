import { expect, test, waitForBoot } from './helpers'

/**
 * E2E — an open tooltip must never swallow a click (#4671).
 *
 * Radix portals every popper into a positioned
 * `[data-radix-popper-content-wrapper]` div, and that wrapper hit-tests. A
 * tooltip is not interactive — there is nothing inside one to click — so a
 * wrapper that intercepts is pure loss: it covers whatever is underneath and
 * eats the next click on it.
 *
 * Found by the real-backend lane, not by this estate: `space-scoped-tag` spent
 * 60 s on `element ("…Journal…") still not clickable`. Closing a Radix Select
 * restores focus to its trigger, the SpaceSwitcher's trigger carries a tooltip,
 * and that tooltip's shortcut hint is tall enough to cover the first sidebar
 * nav item — so the click after a mouse space switch landed on the tooltip.
 *
 * This asserts the MECHANISM (the wrapper does not hit-test) rather than that
 * one particular click lands. A spec that clicked the nav item passes whether
 * or not the fix is present, because whether the tooltip actually covers that
 * button depends on viewport height and on how many spaces exist — it was
 * green against a reverted fix, which is worth stating so nobody re-writes it
 * that way. `elementFromPoint` over the tooltip's own centre is exact: with the
 * wrapper transparent to hit-testing it returns whatever is beneath, and
 * without the fix it returns the tooltip itself.
 */
test('an open tooltip does not hit-test, so clicks reach what it covers', async ({ page }) => {
  await page.goto('/')
  await waitForBoot(page)

  const switcher = page.getByRole('combobox', { name: 'Switch space', exact: true })
  await expect(switcher).toBeVisible()

  // Escape out of the Select: focus returns to the trigger, which re-opens its
  // tooltip. That is the state the reported failure needs.
  await switcher.click()
  await page.keyboard.press('Escape')
  const tooltip = page.locator('[data-slot="tooltip-content"]')
  await expect(tooltip).toBeVisible()

  const hit = await tooltip.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const under = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return {
      // Non-zero box, or the centre point below would be meaningless and the
      // assertion would hold for the wrong reason.
      area: box.width * box.height,
      hitsTooltip: under != null && (el.contains(under) || under.contains(el)),
      underTag: under?.tagName ?? null,
    }
  })

  expect(hit.area).toBeGreaterThan(0)
  expect(hit.underTag).not.toBeNull()
  expect(hit.hitsTooltip).toBe(false)
})
