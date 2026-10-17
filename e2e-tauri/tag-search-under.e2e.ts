// ---------------------------------------------------------------------------
// Real-backend "Search everything under #tag" (#5679).
//
// A tag's page links to Search on `under:#tag`, which sends
// `tagsMatchInlineAndInherited` and widens the tag filter to the tag query's
// leaf: attached, inline, or inherited through `block_tag_inherited`, which
// the backend maintains in the `add_tag` transaction. The mock derives
// inheritance by walking ancestors, so only this lane reads the real table.
// This spec writes a block on a page, THEN tags the page, opens the tag,
// follows the link, and asserts the block comes back: a stale or missing
// inherited row drops it.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  navigateTo,
  openNewPage,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const TAG = runScopedMarker('wdio-under')
const PAGE = runScopedMarker('wdio-under-page')
const CHILD = runScopedMarker('wdio-under-child')

/** Tag the open page from its kebab's "Add tag" picker. */
async function tagOpenPage(tag: string): Promise<void> {
  const kebab = $('button[aria-label="Page actions"]')
  await kebab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await kebab.click()
  const addTag = $('[role="menuitem"]*=Add tag')
  await addTag.waitForClickable({ timeout: ACTION_TIMEOUT })
  await addTag.click()
  await typeInputVerified('[aria-label="Search tags"]', tag)
  const option = $(`//*[@data-radix-popper-content-wrapper]//button[normalize-space(.)="${tag}"]`)
  await option.waitForClickable({ timeout: ACTION_TIMEOUT })
  await option.click()
  await $(`[aria-label="Remove tag ${tag}"]`).waitForDisplayed({ timeout: ACTION_TIMEOUT })
}

describe('Agaric real-backend search under a tag (#5679)', () => {
  it('finds a block that only inherits the tag from its page', async () => {
    await waitForAppReady()

    // 1. The tag.
    await navigateTo('Tags')
    await typeInputVerified('[aria-label="New tag name"]', TAG)
    const create = $('button*=Add Tag')
    await create.waitForClickable({ timeout: ACTION_TIMEOUT })
    await create.click()
    await $(`[data-testid="tag-item-${TAG}"]`).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // 2. A page whose first block is written before the page is tagged, so
    //    the block's inherited row comes from the tag op, not the create.
    await openNewPage(PAGE)
    await typeMarkerVerified(CHILD)
    await browser.keys(['Escape'])
    await $(`[data-testid="block-static"]*=${CHILD}`).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await tagOpenPage(TAG)

    // 3. The tag's page, then its link to Search.
    await navigateTo('Tags')
    const tagItem = $(`[data-testid="tag-item-${TAG}"]`)
    await tagItem.waitForClickable({ timeout: NAV_TIMEOUT })
    await tagItem.click()
    const link = $(`button*=Search everything under #${TAG}`)
    await link.waitForClickable({ timeout: NAV_TIMEOUT })
    await link.click()

    const input = $('input[placeholder="Search blocks..."]')
    await browser.waitUntil(async () => (await input.getValue()) === `under:#${TAG}`, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `Search never opened on under:#${TAG}`,
    })

    // 4. The block that carries the tag only through its page is a result.
    const results = '[data-testid="search-result-region"] [role="option"]'
    let texts: string[] = []
    await browser
      .waitUntil(
        async () => {
          texts = await browser.execute(
            (selector: string) =>
              [...document.querySelectorAll(selector)].map((row) => row.textContent ?? ''),
            results,
          )
          return texts.some((text) => text.includes(CHILD))
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(`no result held ${CHILD}; the results were ${JSON.stringify(texts)}`)
      })
    expect(texts.some((text) => text.includes(CHILD))).toBe(true)
  })
})
