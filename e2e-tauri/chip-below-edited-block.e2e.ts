// ---------------------------------------------------------------------------
// Real-backend: one click on a link chip in the block just below the edited
// one follows the link (#5723, #5807). The desktop formatting toolbar sits in
// the flow above the edited block's text. The press blurs the editor; had the
// block left edit mode then, the chip would move up by the toolbar's height
// and the release would land beside it. The block stays in edit mode until
// the press ends (`useEditorBlur`). The Playwright twin
// (`e2e/editor-lifecycle.spec.ts`) runs Chromium; this lane runs WebKitGTK,
// the engine the app ships on.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  importMarkdownPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const SOURCE = runScopedMarker('wdio-chip-source')
const TARGET = runScopedMarker('wdio-chip-target')
const EDITED = runScopedMarker('wdio-chip-edited')
const TYPED = runScopedMarker('wdio-chip-typed')

async function pageTitle(): Promise<string> {
  return $('[aria-label="Page title"]').getText()
}

describe('Agaric real-backend chip below the edited block (#5807) @editor', () => {
  it('one click on a link chip in the block below the edited one follows it', async () => {
    await waitForAppReady()
    expect(await importMarkdownPage(SOURCE, `- ${EDITED}\n- see [[${TARGET}]]\n`)).toContain(
      '2 blocks',
    )
    await reopenPageByTitle(SOURCE)

    const edited = $(`[data-testid="block-static"]*=${EDITED}`)
    await edited.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const editedId = await edited.getAttribute('data-block-id')
    await edited.click()
    await $('[data-testid="block-editor"] [contenteditable="true"]').waitForDisplayed({
      timeout: ACTION_TIMEOUT,
    })
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
    await typeMarkerVerified(TYPED)
    await $('[data-testid="formatting-toolbar"]').waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // While the first block is edited, the only static block is the one below.
    const chip = $('[data-testid="block-static"] [data-testid="block-link-chip"]')
    await chip.waitForClickable({ timeout: ACTION_TIMEOUT })
    await chip.click()

    await browser.waitUntil(async () => (await pageTitle()) === TARGET, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `one click on the chip did not open ${TARGET}`,
    })

    // The press saved the edit before the link was followed.
    await reopenPageByTitle(SOURCE)
    const saved = $(`[data-testid="block-static"][data-block-id="${editedId}"]`)
    await saved.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await browser.waitUntil(async () => (await saved.getText()) === TYPED, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the edited block does not read ${TYPED} after the round trip`,
    })
  })
})
