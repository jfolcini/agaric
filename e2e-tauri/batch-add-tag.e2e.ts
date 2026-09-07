// ---------------------------------------------------------------------------
// Real-backend batch tagging from the Pages view (#4671).
//
// `add_tags_by_ids` (commands/tags.rs) applies one tag to N pages in a single
// BEGIN IMMEDIATE transaction; no conformance fixture covers its atomicity.
// This spec creates a tag and three pages, selects the three rows, runs the
// batch toolbar's "Add tag", then re-opens EVERY page from the list after a
// navigation round-trip and asserts the page header shows the tag chip
// (`PageTagSection`, fed by `list_tags_for_block` on mount). A partial apply
// — two pages tagged, one not — fails on the untagged page's chip.
//
// The picker offers existing tags only (a Radix Select over
// `list_all_tags_in_space`), so the tag is created first in the Tags view,
// the same path `tag-roundtrip.e2e.ts` proves.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  chooseSelectOption,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  typeInputVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const TAG = runScopedMarker('wdio-batch-tag')
const PAGES = ['a', 'b', 'c'].map((suffix) => runScopedMarker(`wdio-batch-page-${suffix}`))

function pageRow(title: string) {
  // DensityRow.tsx: the row div carries `data-page-item`; the title is the
  // `span.page-browser-item-title` inside its button.
  return $(
    `//div[@data-page-item][.//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]]`,
  )
}

describe('Agaric real-backend batch add-tag (#4671)', () => {
  it('tags every selected page in one batch, durably', async () => {
    await waitForAppReady()

    // 1. The tag.
    await navigateTo('Tags')
    await typeInputVerified('[aria-label="New tag name"]', TAG)
    const addTag = $('button*=Add Tag')
    await addTag.waitForClickable({ timeout: ACTION_TIMEOUT })
    await addTag.click()
    await $(`[data-testid="tag-item-${TAG}"]`).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // 2. Three pages via the Pages view create form; each create navigates
    //    into the new page, so go back to the list before the next one.
    for (const title of PAGES) {
      await navigateTo('Pages')
      await typeInputVerified('#new-page-name', title)
      await browser.keys(['Enter'])
      await $('[aria-label="Page title"]').waitForDisplayed({ timeout: ACTION_TIMEOUT })
    }

    // 3. Select the three rows. The checkbox is opacity-0 until the row is
    //    hovered (DensityRow.tsx), so hover first; `data-selected` confirms.
    await navigateTo('Pages')
    for (const title of PAGES) {
      const row = pageRow(title)
      await row.waitForDisplayed({ timeout: NAV_TIMEOUT })
      await row.moveTo()
      const checkbox = row.$('[data-testid^="page-select-"]')
      await checkbox.waitForExist({ timeout: ACTION_TIMEOUT })
      await checkbox.click()
      await browser.waitUntil(async () => (await row.getAttribute('data-selected')) === 'true', {
        timeout: ACTION_TIMEOUT,
        timeoutMsg: `row ${JSON.stringify(title)} never became selected`,
      })
    }

    // 4. Batch add-tag: button -> in-place picker (Radix Select) -> confirm.
    const addTagButton = $('[data-testid="page-batch-add-tag-btn"]')
    await addTagButton.waitForClickable({ timeout: ACTION_TIMEOUT })
    await addTagButton.click()
    await chooseSelectOption(
      '[data-testid="page-batch-tag-picker"] [data-slot="select-trigger"]',
      TAG,
    )
    const confirm = $('[data-testid="page-batch-tag-confirm"]')
    await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
    await confirm.click()
    await waitForToast('Tagged 3 pages')

    // 5. Durable read: every page, re-opened from the list after leaving for
    //    the Journal, shows the direct tag chip with its remove button.
    await navigateTo('Journal')
    for (const title of PAGES) {
      await reopenPageByTitle(title)
      const chip = $(`[aria-label="Remove tag ${TAG}"]`)
      await chip.waitForExist({ timeout: NAV_TIMEOUT })
      await expect(chip).toBeExisting()
    }
  })
})
