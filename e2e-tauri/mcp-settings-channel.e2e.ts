// ---------------------------------------------------------------------------
// Real-backend agent access driven from Settings › Agent access (#5740).
//
// The RW switch starts the RW socket server, whose path the tab shows; an
// agent connected there writes through the real tools; the activity feed
// lists each call from the backend's ring (`get_mcp_recent_activity`, read
// on every mount of the tab, so opening it is the durable re-query); and
// Revert session sends the session's op refs to `revert_ops`. One file, one
// vault: the `before` turns the channel on once, and each case opens its own
// connection, so it is its own feed session.
//
// A session revert is undone from the History view, not Ctrl+Z: its reverse
// ops carry `is_undo = 1`, which page-level undo skips
// (`enumerate_undo_group_in_tx`), and the feed does not feed the undo store.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs'

import {
  ACTION_TIMEOUT,
  McpClient,
  NAV_TIMEOUT,
  blockStaticByMarker,
  confirmDialog,
  expectAbsent,
  navigateTo,
  openEditHistory,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

interface Block {
  id: string
  parent_id: string
}

interface FeedRow {
  tool: string
  summary: string
  text: string
}

let socketPath = ''
let spaceId = ''

/** Settings › Agent access, ready once the RW switch can be used. */
async function openAgentAccess(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-agent')
  await tab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await tab.click()
  await $('#mcp-rw-toggle').waitForClickable({ timeout: NAV_TIMEOUT })
}

/** Turn RW access on with its switch and return the socket path the tab shows. */
async function enableRwFromSettings(): Promise<string> {
  await openAgentAccess()
  await $('#mcp-rw-toggle').click()
  await waitForToast('Read-write agent access enabled')
  const shown = $('[data-testid="mcp-rw-socket-path"]')
  await shown.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  const path = (await shown.getText()).trim()
  await browser.waitUntil(() => existsSync(path), {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the RW switch is on, but no socket appeared at the shown path ${path}`,
  })
  return path
}

/** Append one block per entry of `contents` under the page titled `page`, over one connection. */
async function agentAppends(page: string, contents: string[]): Promise<Block[]> {
  const agent = await McpClient.connect(socketPath)
  try {
    const blocks: Block[] = []
    for (const content of contents) {
      blocks.push(
        (await agent.call('append_block', {
          parent_id: page,
          content,
          space_id: spaceId,
        })) as Block,
      )
    }
    return blocks
  } finally {
    agent.close()
  }
}

/** The feed's rows: the tool badge, the summary line, and the row's whole text. */
function feedRows(): Promise<FeedRow[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="mcp-activity-row"]')].map((row) => ({
      tool: row.querySelector(':scope > :first-child')?.textContent ?? '',
      summary: row.querySelector(':scope > div > span:first-child')?.textContent ?? '',
      text: row.textContent ?? '',
    })),
  )
}

/** Wait for the open feed to list a row that `matches`, and return it. */
async function feedRow(matches: (row: FeedRow) => boolean, what: string): Promise<FeedRow> {
  let found: FeedRow | undefined
  await browser.waitUntil(
    async () => {
      found = (await feedRows()).find(matches)
      return found !== undefined
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `the activity feed never listed ${what}` },
  )
  return found as FeedRow
}

function appendSummary(block: Block): string {
  return `append_block — added ${block.id.slice(0, 8)} under ${block.parent_id.slice(0, 8)}`
}

/** Selector of the committed block rows whose text contains `marker`. */
function staticSelector(marker: string): string {
  return `[data-testid="block-static"]*=${marker}`
}

async function expectShown(marker: string, what: string): Promise<void> {
  await blockStaticByMarker(marker).waitForDisplayed({ timeout: NAV_TIMEOUT, timeoutMsg: what })
}

describe('Agaric real-backend agent access from Settings (#5740)', () => {
  before(async () => {
    await waitForAppReady()
    socketPath = await enableRwFromSettings()
    const setup = await McpClient.connect(socketPath)
    try {
      const spaces = (await setup.call('list_spaces', {})) as { id: string; is_default: boolean }[]
      spaceId = spaces.find((space) => space.is_default)?.id ?? ''
    } finally {
      setup.close()
    }
    if (spaceId === '') throw new Error('list_spaces returned no default space')
  })

  it('serves an agent on the socket the Settings switch opened, onto the open page', async () => {
    const page = runScopedMarker('wdio-mcp-open-page')
    const marker = runScopedMarker('wdio-mcp-agent-block')
    await openNewPage(page)

    const [block] = await agentAppends(page, [marker])
    if (block === undefined) throw new Error('append_block returned nothing')
    await expectShown(marker, "the agent's block never showed on the open page")

    await openAgentAccess()
    expect(await $('#mcp-rw-toggle').getAttribute('aria-checked')).toBe('true')
    const summary = appendSummary(block)
    await feedRow((row) => row.summary === summary, summary)

    await reopenPageByTitle(page)
    await expectShown(marker, "the agent's block was gone on re-open")
  })

  it('lists an agent write in the activity feed by tool and ids, never by its text', async () => {
    const page = runScopedMarker('wdio-mcp-feed-page')
    const written = runScopedMarker('wdio-mcp-feed-text')
    await openNewPage(page)
    const [block] = await agentAppends(page, [written])
    if (block === undefined) throw new Error('append_block returned nothing')

    await openAgentAccess()
    const row = await feedRow(
      (r) => r.tool === 'append_block' && r.summary.includes(block.id.slice(0, 8)),
      `the append of ${block.id}`,
    )
    expect((await feedRows()).filter((r) => r.text.includes(written))).toEqual([])
    expect(row.summary).toBe(appendSummary(block))
  })

  it('reverts an agent session from the feed, and undoes the revert from History', async () => {
    const page = runScopedMarker('wdio-mcp-revert-page')
    const kept = runScopedMarker('wdio-mcp-revert-kept')
    const first = runScopedMarker('wdio-mcp-revert-one')
    const second = runScopedMarker('wdio-mcp-revert-two')
    await openNewPage(page)
    await typeMarkerVerified(kept)
    // Leaving commits the typed block before the agent writes to its page.
    await navigateTo('Journal')
    await agentAppends(page, [first, second])
    await reopenPageByTitle(page)
    await expectShown(second, "the agent's second block never showed")
    await expectShown(first, "the agent's first block never showed")

    await openAgentAccess()
    // The only session with two undoable actions is this case's.
    const header = $('[data-testid="mcp-activity-session-header"]')
    await header.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await header.getText()).toContain('2 agent actions')
    const revert = header.$('[data-testid="mcp-activity-revert-session"]')
    await revert.waitForClickable({ timeout: ACTION_TIMEOUT })
    await revert.click()
    await confirmDialog('Revert session')
    await waitForToast('Session reverted (2 actions)')

    await reopenPageByTitle(page)
    await expectShown(kept, 'the block the user typed did not survive the session revert')
    await expectAbsent(staticSelector(first), "the agent's first block")
    await expectAbsent(staticSelector(second), "the agent's second block")

    // History lists newest first: the two newest deletes are the revert's.
    await openEditHistory()
    const deletes =
      '//*[@data-history-item][.//*[@data-testid="history-type-badge"][normalize-space(.)="delete_block"]]'
    for (const n of [1, 2]) {
      const select = $(`(${deletes})[${n}]`).$('button[role="checkbox"]')
      await select.waitForClickable({
        timeout: NAV_TIMEOUT,
        timeoutMsg: `History never listed delete number ${n} of the session revert`,
      })
      await select.click()
    }
    const revertSelected = $('button*=Revert selected')
    await revertSelected.waitForClickable({ timeout: ACTION_TIMEOUT })
    await revertSelected.click()
    await confirmDialog('Revert')
    await revertSelected.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'undoing the revert did not succeed: the selection toolbar stayed',
    })

    await reopenPageByTitle(page)
    await expectShown(first, "the agent's first block did not come back when the revert was undone")
    await expectShown(
      second,
      "the agent's second block did not come back when the revert was undone",
    )
  })
})
