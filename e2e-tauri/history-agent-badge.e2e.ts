// ---------------------------------------------------------------------------
// Real-backend: History marks the ops an MCP agent wrote (#6535).
//
// An agent's op carries `op_log.origin = 'agent:<name>'`, written only on the
// MCP path, which the mock does not model. The agent writes a block over the
// socket, the user rewrites it in the editor, and History lists both ops: the
// agent's `create_block` with a badge naming the agent, the user's
// `edit_block` with none.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  McpClient,
  NAV_TIMEOUT,
  blockStaticByMarker,
  defaultSpaceId,
  navigateTo,
  openEditHistory,
  reopenPageByTitle,
  runScopedMarker,
  startReadWriteAgent,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const AGENT = runScopedMarker('wdio-history-agent')
const PAGE = runScopedMarker('wdio-history-page')
const AGENT_TEXT = runScopedMarker('wdio-agent-wrote')
const USER_TEXT = runScopedMarker('wdio-user-wrote')

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const AGENT_BADGE = '[data-testid="history-agent-badge"]'

/** The History row of the `opType` op whose preview reads `text`. */
async function historyRow(opType: string, text: string) {
  const row = $(
    '//*[@data-history-item]' +
      `[.//*[@data-testid="history-type-badge"][@data-op-type="${opType}"]]` +
      `[.//*[contains(@class, "history-item-preview")][contains(normalize-space(.), "${text}")]]`,
  )
  await row.waitForDisplayed({
    timeout: NAV_TIMEOUT,
    timeoutMsg: `History never listed the ${opType} that wrote ${text}`,
  })
  return row
}

describe('Agaric real-backend History marks an agent-written op (#6535) @mcp @pages', () => {
  it("badges the agent's op with its name and leaves the user's unbadged", async () => {
    await waitForAppReady()
    const { socketPath, token } = await startReadWriteAgent(AGENT)
    const agent = await McpClient.connect(socketPath, token)
    try {
      const spaceId = await defaultSpaceId(agent)
      const page = (await agent.call('create_page', { title: PAGE, space_id: spaceId })) as {
        id: string
      }
      await agent.call('append_block', {
        parent_id: page.id,
        content: AGENT_TEXT,
        space_id: spaceId,
      })
    } finally {
      agent.close()
    }

    // The user rewrites the agent's block and commits it by leaving the page.
    await reopenPageByTitle(PAGE)
    await blockStaticByMarker(AGENT_TEXT).click()
    const editor = $(EDITOR)
    await editor.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await editor.click()
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
    await typeMarkerVerified(USER_TEXT)
    await navigateTo('Journal')

    await openEditHistory()
    const agentBadge = (await historyRow('create_block', AGENT_TEXT)).$(AGENT_BADGE)
    await agentBadge.waitForDisplayed({
      timeout: ACTION_TIMEOUT,
      timeoutMsg: "the agent's op carried no agent badge",
    })
    // `textContent`, because `getText()` leaves out the screen-reader name.
    expect(String(await agentBadge.getProperty('textContent'))).toContain(
      `Written by agent ${AGENT}`,
    )
    expect(await (await historyRow('edit_block', USER_TEXT)).$(AGENT_BADGE).isExisting()).toBe(
      false,
    )
  })
})
