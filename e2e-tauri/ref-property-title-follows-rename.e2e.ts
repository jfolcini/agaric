// ---------------------------------------------------------------------------
// An open ref property shows its target's new title once an agent renames it.
//
// The ref picker's trigger read the title from the resolve cache without
// subscribing to it, and the React Compiler keeps its props stable, so a title
// that reached the cache after the row mounted never reached the label: it
// kept the old title, or the raw `[[id…]]` when the target was not cached yet.
// Only the app build runs the compiler, so only this lane can show it.
//
// Globals (`$`, `browser`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  McpClient,
  NAV_TIMEOUT,
  defaultSpaceId,
  invoke,
  reopenPageByTitle,
  runScopedMarker,
  startReadWriteAgent,
  waitForAppReady,
} from './helpers'

/** A ref property only this spec defines. */
const KEY = 'wdiorenamedref'

/** Wait until the open page's `KEY` picker reads `title`. */
async function waitForRefLabel(title: string, what: string): Promise<void> {
  const value = $(`button[aria-label="${KEY} value"]`)
  await browser.waitUntil(async () => (await value.getText()) === title, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `${what}: the ${KEY} value never read ${title}, it reads ${await value.getText()}`,
  })
}

describe('Agaric real-backend ref property label follows its target @mcp @pages', () => {
  it("shows the target's new title after an agent renames it", async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-refren')
    const target = `${marker}-target`
    const renamed = `${marker}-renamed`
    const holder = `${marker}-holder`
    const { socketPath, token } = await startReadWriteAgent(`${marker}-agent`)
    const agent = await McpClient.connect(socketPath, token)
    try {
      const spaceId = await defaultSpaceId(agent)
      await invoke('create_property_def', { spaceId, key: KEY, valueType: 'ref', options: null })
      const targetPage = (await agent.call('create_page', {
        title: target,
        space_id: spaceId,
      })) as {
        id: string
      }
      const holderPage = (await agent.call('create_page', {
        title: holder,
        space_id: spaceId,
      })) as {
        id: string
      }
      await invoke('set_property', {
        blockId: holderPage.id,
        key: KEY,
        value: { value_ref: targetPage.id },
      })

      await reopenPageByTitle(holder)
      const header = $('.page-property-table-header')
      await header.waitForClickable({
        timeout: NAV_TIMEOUT,
        timeoutMsg: `the page ${holder} shows no property table`,
      })
      await header.click()
      await waitForRefLabel(target, 'before the rename')

      // The holder stays open while the agent renames the page it points at.
      await agent.call('update_block_content', {
        block_id: targetPage.id,
        content: renamed,
        space_id: spaceId,
      })
      await waitForRefLabel(renamed, 'after the agent renamed the target')
    } finally {
      agent.close()
    }
  })
})
