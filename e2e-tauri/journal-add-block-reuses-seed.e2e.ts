// ---------------------------------------------------------------------------
// Real-backend: "Add block" on a fresh day types into the day's empty seed
// block instead of stranding it above a second one.
//
// A virgin vault opens the journal on today's page with one empty block
// (BlockTree's `autoCreateFirstBlock`). Once the caret has left it, "Add block"
// created a second empty block, and nothing ever removed the first: the blur
// cleanup only looks at the block focus leaves, and kept this one because it
// was the day's only block. The Playwright twin is
// `e2e/journal-add-block-reuses-empty.spec.ts`.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  APP_READY_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  navigateTo,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-seed-reuse')
const EDITOR = '[data-testid="block-editor"]'
const STATIC = '[data-testid="block-static"]'
// A committed blank block renders StaticBlock's placeholder span in place of
// content (StaticBlock.tsx); a block with text never does.
const BLANK_STATIC = `${STATIC} .block-placeholder`

describe('Agaric real-backend Add block on a fresh day @editor @journal', () => {
  it('types into the empty seed block instead of adding a second one', async () => {
    await waitForAppReady()
    await navigateTo('Journal')

    // Today's page auto-creates with its seed block, editing or static.
    await browser.waitUntil(
      async () => (await $(EDITOR).isDisplayed()) || (await $(BLANK_STATIC).isDisplayed()),
      {
        timeout: APP_READY_TIMEOUT,
        timeoutMsg: "today's seed block never rendered",
      },
    )
    await browser.keys(['Escape'])
    await $(EDITOR).waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
    await $(BLANK_STATIC).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const statics = await $$(STATIC).getElements()
    expect(statics.length).toBe(1)
    const seedId = await $(STATIC).getAttribute('data-block-id')

    const addBlock = $('button*=Add block')
    await addBlock.waitForClickable({ timeout: ACTION_TIMEOUT })
    await addBlock.click()
    await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    expect(await $(EDITOR).getAttribute('data-block-id')).toBe(seedId)
    await typeMarkerVerified(MARKER)

    await navigateTo('Pages')
    await navigateTo('Journal')

    const typed = blockStaticByMarker(MARKER)
    await typed.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await typed.getAttribute('data-block-id')).toBe(seedId)
    await expectAbsent(BLANK_STATIC, 'the stranded seed block')
  })
})
