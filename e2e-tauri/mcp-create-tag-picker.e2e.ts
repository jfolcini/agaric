// ---------------------------------------------------------------------------
// Real-backend: a tag an MCP agent creates is offered by the open journal's
// `#` picker (#6049).
//
// Bug class (reached users): the `#` picker filters a tag list it fetched once
// per block tree, and MCP `create_tag` emitted no `blocks:changed`, so nothing
// dropped that list: typing the agent's tag offered only "Create". This spec
// fills the list with a first tag, has the agent create a second while the
// journal stays open, waits for the picker to offer it, and reads the stored
// block's chip after a nav round-trip. `create_tag` answers once `tags_cache`,
// which the picker reads, holds the tag, so each name is typed right away.
//
// Globals (`$`, `browser`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  McpClient,
  NAV_TIMEOUT,
  blockStaticByMarker,
  defaultSpaceId,
  enterBlankSibling,
  navigateTo,
  openJournalBlockEditor,
  runScopedMarker,
  startReadWriteAgent,
  typeMarkerVerified,
  waitForAppReady,
  waitForPickerToOffer,
} from './helpers'

// Letters, digits and `-` only, so a bare `#name` ends at the space after it.
const SEED = runScopedMarker('wdio-seed-tag')
const TAG = runScopedMarker('wdio-agent-tag')
const FILL = runScopedMarker('wdio-picker-fill')
const MARKER = runScopedMarker('wdio-agent-tagged')
const AGENT = runScopedMarker('wdio-tag-agent')

const EDITOR = '[data-testid="block-editor"]'

/** The tag chip named `name`, as a selector chained under a block. */
const chip = (name: string) => `[data-testid="tag-ref-chip"]*=${name}`

/** Wait until the block matched by `root` shows the chip of `name`, finding both afresh each poll. */
async function waitForChip(root: string, name: string, what: string): Promise<void> {
  await browser.waitUntil(() => $(root).$(chip(name)).isDisplayed(), {
    timeout: NAV_TIMEOUT,
    timeoutMsg: what,
  })
}

describe('Agaric real-backend MCP create_tag reaches the # picker (#6049) @mcp @editor', () => {
  it("offers the agent's new tag in the open journal and stores it on the block", async () => {
    await waitForAppReady()
    const { socketPath, token } = await startReadWriteAgent(AGENT)
    const agent = await McpClient.connect(socketPath, token)
    try {
      const spaceId = await defaultSpaceId(agent)
      await agent.call('create_tag', { name: SEED, space_id: spaceId })

      // 1. The picker fetches the space's tags on its first use and filters
      //    that list from then on; an empty list is re-fetched, so it holds one.
      await navigateTo('Journal')
      await openJournalBlockEditor()
      await typeMarkerVerified(`${FILL} #${SEED}`)
      await waitForPickerToOffer(SEED)
      await browser.keys([' '])
      await waitForChip(EDITOR, SEED, 'the first tag never became a chip in the editor')
      await enterBlankSibling()

      // 2. The agent creates a tag while the journal and its list stay open.
      await agent.call('create_tag', { name: TAG, space_id: spaceId })

      // 3. The picker offers it, and the typed name becomes its chip.
      await typeMarkerVerified(`${MARKER} #${TAG}`)
      await waitForPickerToOffer(TAG)
      await browser.keys([' '])
      await waitForChip(EDITOR, TAG, "the agent's tag never became a chip in the editor")
      await browser.keys(['Enter'])
      await browser.keys(['Escape'])
      await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    } finally {
      agent.close()
    }

    // 4. Navigate away and back: the chip is rendered from the stored content.
    await navigateTo('Pages')
    await navigateTo('Journal')
    await waitForChip(
      `[data-testid="block-static"]*=${MARKER}`,
      TAG,
      `the stored block never showed the tag ${TAG}`,
    )
  })
})
