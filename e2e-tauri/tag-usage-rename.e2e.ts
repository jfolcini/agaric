// ---------------------------------------------------------------------------
// Real-backend tag usage count and rename (#5366).
//
// The Tags view lists `tags_cache` (`list_all_tags_in_space`), whose name and
// `usage_count` the materializer rebuilds in the background after a block is
// tagged or the tag renamed. The mock derives both on every read and leaves
// inline `#tag` references out of the count (`src/lib/tauri-mock/handlers/tags.ts`),
// so only this lane shows the count rise, or a name the cache never caught up
// with. The view loads on mount, so each nav round-trip below is a fresh read.
//
// The block is tagged by typing `#name` and a space once the `#` picker offers
// the existing tag; the chips on it name the tag through the block's stored
// `#[ULID]`, so after the rename they read the new name.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  navigateTo,
  openJournalBlockEditor,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForPickerToOffer,
  waitForToast,
} from './helpers'

// Letters, digits and `-` only, so a bare `#name` ends at the space after it.
const TAG = runScopedMarker('wdio-usage-tag')
const RENAMED = runScopedMarker('wdio-renamed-tag')
const MARKER = runScopedMarker('wdio-tagged-block')
const CHIP = '[data-testid="tag-ref-chip"]'

/** The Tags list row of `name` (TagList.tsx `tag-item-<name>`). */
const tagItem = (name: string) => `[data-testid="tag-item-${name}"]`

/**
 * The usage count each listed tag shows (the span after the name inside its
 * badge), by tag name, read once.
 */
function listedCounts(): Promise<Record<string, string>> {
  return browser.execute(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-testid^="tag-item-"]')].map((item) => [
        item.getAttribute('data-testid')?.slice('tag-item-'.length) ?? '',
        item.querySelector('[data-slot="badge"] > span')?.textContent ?? '',
      ]),
    ),
  )
}

/**
 * Wait until the Tags list shows exactly `expected` among the tags this spec
 * names, leaving the view and coming back between reads.
 */
async function waitForListed(expected: Record<string, string>): Promise<void> {
  let seen: Record<string, string> = {}
  await browser
    .waitUntil(
      async () => {
        const counts = await listedCounts()
        seen = Object.fromEntries(
          [TAG, RENAMED].filter((name) => name in counts).map((name) => [name, counts[name] ?? '']),
        )
        if (JSON.stringify(seen) === JSON.stringify(expected)) return true
        await navigateTo('Journal')
        await navigateTo('Tags')
        return false
      },
      { timeout: NAV_TIMEOUT, interval: 3_000 },
    )
    .catch(() => {
      throw new Error(
        `the Tags list never read ${JSON.stringify(expected)}: ${JSON.stringify(seen)}`,
      )
    })
}

/** The names the tag chips under `root` show, in text order. */
async function chipNames(root: string): Promise<string[]> {
  const names: string[] = []
  for (const chip of await $(root).$$(CHIP).getElements()) names.push((await chip.getText()).trim())
  return names
}

describe('Agaric real-backend tag usage and rename (#5366)', () => {
  it('counts a tagged block and relabels the list and the chips after a rename', async () => {
    await waitForAppReady()
    await navigateTo('Tags')
    await typeInputVerified('[aria-label="New tag name"]', TAG)
    const addTag = $('button*=Add Tag')
    await addTag.waitForClickable({ timeout: ACTION_TIMEOUT })
    await addTag.click()
    await $(tagItem(TAG)).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await waitForListed({ [TAG]: '0' })

    await navigateTo('Journal')
    await openJournalBlockEditor()
    await typeMarkerVerified(`${MARKER} #${TAG}`)
    await waitForPickerToOffer(TAG)
    await browser.keys([' '])
    const editor = '[data-testid="block-editor"]'
    await browser.waitUntil(async () => (await chipNames(editor)).join() === TAG, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the typed tag never became a chip in the editor',
    })
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])
    await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    await navigateTo('Tags')
    await waitForListed({ [TAG]: '1' })

    // The row's actions show on hover (TagList.tsx `group-hover`).
    await $(tagItem(TAG)).moveTo()
    const rename = $(tagItem(TAG)).parentElement().$('button[aria-label="Rename tag"]')
    await rename.waitForClickable({ timeout: ACTION_TIMEOUT })
    await rename.click()
    // The create field shares the label, so the dialog's field is scoped.
    const field = '[role="dialog"] input[aria-label="New tag name"]'
    await $(field).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await $(field).click()
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
    await typeInputVerified(field, RENAMED)
    const save = $('[role="dialog"]').$('button=Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await waitForToast('Tag renamed successfully.')

    await navigateTo('Journal')
    await navigateTo('Tags')
    await waitForListed({ [RENAMED]: '1' })

    await navigateTo('Journal')
    const block = `[data-testid="block-static"]*=${MARKER}`
    await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
    let stored: string[] = []
    await browser
      .waitUntil(
        async () => {
          stored = await chipNames(block)
          return stored.join() === RENAMED
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(`the tagged block's chips never read ${RENAMED}: ${JSON.stringify(stored)}`)
      })
  })
})
