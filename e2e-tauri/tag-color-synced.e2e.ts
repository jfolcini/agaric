// ---------------------------------------------------------------------------
// Real-backend tag colour from the synced `color` property (#6544).
//
// A colour picked in the Tags view is written to localStorage and to the tag's
// `color` property; the chip paints the property and falls back to
// localStorage. This spec clears localStorage, so only the property can keep
// the colour: after a navigation round-trip, and again after a restart, where
// the colour can come only from the preload's re-read of the property.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  invoke,
  navigateTo,
  restartApp,
  runScopedMarker,
  typeInputVerified,
  waitForAppReady,
} from './helpers'

const TAG = runScopedMarker('wdio-tag-colour')
const ROSE = 'var(--accent-rose, var(--accent-current))'

const tagItem = `[data-testid="tag-item-${TAG}"]`

/** Wait until the tag's badge in the Tags view paints `expected` as its `--tag-color`. */
async function expectBadgeColour(expected: string, when: string): Promise<void> {
  await $(tagItem).waitForDisplayed({ timeout: NAV_TIMEOUT })
  let seen = ''
  await browser.waitUntil(
    async () => {
      seen = (await browser.execute(
        (selector: string) =>
          document
            .querySelector<HTMLElement>(`${selector} [title]`)
            ?.style.getPropertyValue('--tag-color') ?? '',
        tagItem,
      )) as string
      return seen === expected
    },
    {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `${when}: the badge painted ${JSON.stringify(seen)}, not ${expected}`,
    },
  )
}

describe('Agaric real-backend tag colour from the synced property (#6544) @pages', () => {
  it('keeps a tag colour with localStorage cleared, across navigation and a restart', async () => {
    await waitForAppReady()

    await navigateTo('Tags')
    await typeInputVerified('[aria-label="New tag name"]', TAG)
    const addTag = $('button*=Add Tag')
    await addTag.waitForClickable({ timeout: ACTION_TIMEOUT })
    await addTag.click()
    await $(tagItem).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    const row = $(`//li[.//*[@data-testid="tag-item-${TAG}"]]`)
    await row.moveTo()
    await row.$('button[aria-label="Set tag color"]').click()
    const rose = $('[data-radix-popper-content-wrapper] button[aria-label="Rose"]')
    await rose.waitForClickable({ timeout: ACTION_TIMEOUT })
    await rose.click()
    await expectBadgeColour(ROSE, 'after picking rose')

    await browser.execute(() => localStorage.removeItem('tag-colors'))
    await navigateTo('Journal')
    await navigateTo('Tags')
    await expectBadgeColour(ROSE, 'after clearing localStorage and navigating back')
    expect(await invoke<string[]>('list_property_values', { key: 'color' })).toContain(
      'accent-rose',
    )

    await restartApp()
    await browser.execute(() => localStorage.removeItem('tag-colors'))
    await navigateTo('Tags')
    await expectBadgeColour(ROSE, 'after a restart with localStorage cleared')
  })
})
