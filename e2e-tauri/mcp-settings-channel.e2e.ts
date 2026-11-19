// ---------------------------------------------------------------------------
// Real-backend agent access driven from Settings › Agent access (#5740).
//
// The switch starts the MCP server, whose path the tab shows; an agent made
// through the app's own command writes through the real tools on a connection
// that presents its token; the activity feed lists each call from the
// backend's ring (`get_mcp_recent_activity`, read on every mount of the tab,
// so opening it is the durable re-query); and Revert session sends the
// session's op refs to `revert_ops`. One file, one vault: the `before` turns
// access on and makes the agent once, and each case opens its own connection,
// so it is its own feed session.
//
// A session revert is undone from the History view, not Ctrl+Z: its reverse
// ops carry `is_undo = 1`, which page-level undo skips
// (`enumerate_undo_group_in_tx`), and the feed does not feed the undo store.
//
// The tests after those three each make an agent of their own on the same
// server, for what only the real MCP path shows: a tag `create_tag` makes is
// offered by the open journal's `#` picker (#6049); History badges an agent's
// op by name (#6535); `add_meeting`'s files play in WebKitGTK (#5364); a burst
// of writes leaves the app responsive; and `attach_file`'s files play (#5410).
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  McpClient,
  NAV_TIMEOUT,
  blockStaticByMarker,
  blockStaticsByMarker,
  confirmDialog,
  defaultSpaceId,
  enterBlankSibling,
  expectAbsent,
  invoke,
  navigateTo,
  openEditHistory,
  openJournalBlockEditor,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  startReadWriteAgent,
  typeMarkerVerified,
  waitForAppReady,
  waitForPickerToOffer,
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

// The `#` picker test. Letters, digits and `-` only, so a bare `#name` ends at the space after it.
const SEED_TAG = runScopedMarker('wdio-seed-tag')
const AGENT_TAG = runScopedMarker('wdio-agent-tag')
const PICKER_FILL = runScopedMarker('wdio-picker-fill')
const TAGGED = runScopedMarker('wdio-agent-tagged')
const EDITOR = '[data-testid="block-editor"]'
// The History badge test.
const HISTORY_PAGE = runScopedMarker('wdio-history-page')
const HISTORY_AGENT_TEXT = runScopedMarker('wdio-agent-wrote')
const HISTORY_USER_TEXT = runScopedMarker('wdio-user-wrote')
const AGENT_BADGE = '[data-testid="history-agent-badge"]'
// The add_meeting test.
const MEETING_TITLE = runScopedMarker('wdio-retro')
// The write burst. Each MCP connection rewrites its own block; every write emits twice.
const BURST_TITLE = runScopedMarker('wdio-mcp-burst-page')
const BURST_MARKER = runScopedMarker('wdio-mcp-burst-block')
const CONNECTIONS = 4
const WRITES_PER_CONNECTION = 50
const IPC_LOOPS = 8
const IPC_ROUNDS = 100
// The attach_file test. `plays`: whether the runner's WebKitGTK decodes the format.
const ATTACH_PAGE = runScopedMarker('wdio-attach-page')
const ATTACH_BLOCK = runScopedMarker('wdio-attach-block')
const ATTACH_FIXTURES = [
  { file: 'tone-opus.ogg', mime: 'audio/ogg', plays: true },
  { file: 'tone.mp3', mime: 'audio/mpeg', plays: true },
  { file: 'tone.m4a', mime: 'audio/mp4', plays: false },
] as const

interface AttachedRow {
  block_id: string
  filename: string
  mime_type: string
  size_bytes: number
  path: string
}

interface AttachmentRow {
  filename: string
  mime_type: string
}

interface Internals {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>
}

let socketPath = ''
let token = ''
let spaceId = ''

/** Settings › Agent access, ready once the switch can be used. */
async function openAgentAccess(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-agent')
  await tab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await tab.click()
  await $('#mcp-toggle').waitForClickable({ timeout: NAV_TIMEOUT })
}

/** Turn access on with the switch and return the socket path the tab shows. */
async function enableFromSettings(): Promise<string> {
  await openAgentAccess()
  await $('#mcp-toggle').click()
  await waitForToast('Agent access enabled')
  const shown = $('[data-testid="mcp-socket-path"]')
  await shown.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  const socket = (await shown.getText()).trim()
  await browser.waitUntil(() => existsSync(socket), {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the switch is on, but no socket appeared at the shown path ${socket}`,
  })
  return socket
}

/** A read-write agent on every space, made through the app's own command; returns its token. */
async function createAgent(name: string): Promise<string> {
  const agent = await invoke<{ token: string }>('create_mcp_agent', {
    name,
    mode: 'read_write',
    spaceIds: null,
  })
  return agent.token
}

/** Append one block per entry of `contents` under the page titled `page`, over one connection. */
async function agentAppends(page: string, contents: string[]): Promise<Block[]> {
  const agent = await McpClient.connect(socketPath, token)
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

/** The tag chip named `name`, as a selector chained under a block. */
const tagChip = (name: string) => `[data-testid="tag-ref-chip"]*=${name}`

/** Wait until the block matched by `root` shows the chip of `name`, finding both afresh each poll. */
async function waitForChip(root: string, name: string, what: string): Promise<void> {
  await browser.waitUntil(() => $(root).$(tagChip(name)).isDisplayed(), {
    timeout: NAV_TIMEOUT,
    timeoutMsg: what,
  })
}

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

function withinTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${what} did not finish: the app is frozen`)),
        ACTION_TIMEOUT,
      ),
    ),
  ])
}

describe('Agaric real-backend agent access from Settings (#5740) @mcp @settings @editor @pages @attachments', () => {
  before(async () => {
    await waitForAppReady()
    socketPath = await enableFromSettings()
    token = await createAgent(runScopedMarker('wdio-mcp-settings-agent'))
    const setup = await McpClient.connect(socketPath, token)
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
    expect(await $('#mcp-toggle').getAttribute('aria-checked')).toBe('true')
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
      '//*[@data-history-item][.//*[@data-testid="history-type-badge"][@data-op-type="delete_block"]]'
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
  // #6049 (reached users) — the `#` picker filters a tag list it fetched once
  // per block tree, and MCP `create_tag` emitted no `blocks:changed`, so nothing
  // dropped that list: typing the agent's tag offered only "Create". This fills
  // the list with a first tag, has the agent create a second while the journal
  // stays open, and reads the stored block's chip after a nav round-trip.
  // `create_tag` answers once `tags_cache`, which the picker reads, holds the
  // tag, so each name is typed right away.
  it("offers the agent's new tag in the open journal and stores it on the block (#6049)", async () => {
    const { socketPath: socket, token: tagToken } = await startReadWriteAgent(
      runScopedMarker('wdio-tag-agent'),
    )
    const agent = await McpClient.connect(socket, tagToken)
    try {
      const space = await defaultSpaceId(agent)
      await agent.call('create_tag', { name: SEED_TAG, space_id: space })

      // 1. The picker fetches the space's tags on its first use and filters
      //    that list from then on; an empty list is re-fetched, so it holds one.
      await navigateTo('Journal')
      await openJournalBlockEditor()
      await typeMarkerVerified(`${PICKER_FILL} #${SEED_TAG}`)
      await waitForPickerToOffer(SEED_TAG)
      await browser.keys([' '])
      await waitForChip(EDITOR, SEED_TAG, 'the first tag never became a chip in the editor')
      await enterBlankSibling()

      // 2. The agent creates a tag while the journal and its list stay open.
      await agent.call('create_tag', { name: AGENT_TAG, space_id: space })

      // 3. The picker offers it, and the typed name becomes its chip.
      await typeMarkerVerified(`${TAGGED} #${AGENT_TAG}`)
      await waitForPickerToOffer(AGENT_TAG)
      await browser.keys([' '])
      await waitForChip(EDITOR, AGENT_TAG, "the agent's tag never became a chip in the editor")
      await browser.keys(['Enter'])
      await browser.keys(['Escape'])
      await blockStaticByMarker(TAGGED).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    } finally {
      agent.close()
    }

    // 4. Navigate away and back: the chip is rendered from the stored content.
    await navigateTo('Pages')
    await navigateTo('Journal')
    await waitForChip(
      `[data-testid="block-static"]*=${TAGGED}`,
      AGENT_TAG,
      `the stored block never showed the tag ${AGENT_TAG}`,
    )
  })

  // #6535 — an agent's op carries `op_log.origin = 'agent:<name>'`, written only
  // on the MCP path, which the mock does not model. The agent writes a block,
  // the user rewrites it in the editor, and History lists both ops.
  it("History badges the agent's op with its name and leaves the user's unbadged (#6535)", async () => {
    const agentName = runScopedMarker('wdio-history-agent')
    const { socketPath: socket, token: historyToken } = await startReadWriteAgent(agentName)
    const agent = await McpClient.connect(socket, historyToken)
    try {
      const space = await defaultSpaceId(agent)
      const page = (await agent.call('create_page', { title: HISTORY_PAGE, space_id: space })) as {
        id: string
      }
      await agent.call('append_block', {
        parent_id: page.id,
        content: HISTORY_AGENT_TEXT,
        space_id: space,
      })
    } finally {
      agent.close()
    }

    // The user rewrites the agent's block and commits it by leaving the page.
    await reopenPageByTitle(HISTORY_PAGE)
    await blockStaticByMarker(HISTORY_AGENT_TEXT).click()
    const editor = $(`${EDITOR} [contenteditable="true"]`)
    await editor.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await editor.click()
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
    await typeMarkerVerified(HISTORY_USER_TEXT)
    await navigateTo('Journal')

    await openEditHistory()
    const agentBadge = (await historyRow('create_block', HISTORY_AGENT_TEXT)).$(AGENT_BADGE)
    await agentBadge.waitForDisplayed({
      timeout: ACTION_TIMEOUT,
      timeoutMsg: "the agent's op carried no agent badge",
    })
    // `textContent`, because `getText()` leaves out the screen-reader name.
    expect(String(await agentBadge.getProperty('textContent'))).toContain(
      `Written by agent ${agentName}`,
    )
    expect(
      await (await historyRow('edit_block', HISTORY_USER_TEXT)).$(AGENT_BADGE).isExisting(),
    ).toBe(false)
  })

  // #5364 — `add_meeting` is several writes in one backend transaction (page,
  // `#meeting`, `meeting_date`, link, files), its files are bytes on disk, and
  // the player decodes them in WebKitGTK; a timestamp seeks the real player.
  it('an agent’s add_meeting files play, with the transcript collapsed under them (#5364)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wdio-meeting-'))
    const transcript = path.join(dir, 'retro.md')
    writeFileSync(transcript, '[00:00:00] **Alice:** Hi.\n\n[00:00:01] **Bob:** Bye.\n')
    const summary = path.join(dir, 'recap.md')
    writeFileSync(summary, `Recap of ${MEETING_TITLE}\n`)
    const { socketPath: socket, token: meetingToken } = await startReadWriteAgent(
      runScopedMarker('wdio-meeting-agent'),
    )
    const agent = await McpClient.connect(socket, meetingToken)
    let recordingId: string
    try {
      const space = await defaultSpaceId(agent)
      const made = (await agent.call('add_meeting', {
        space_id: space,
        title: MEETING_TITLE,
        date: '2031-03-14',
        audio_path: path.resolve(import.meta.dirname, 'fixtures', 'tone-opus.ogg'),
        transcript_path: transcript,
        summary_path: summary,
      })) as { recording_block_id: string }
      recordingId = made.recording_block_id
    } finally {
      agent.close()
    }
    const rows = await invoke<AttachmentRow[]>('list_attachments', { blockId: recordingId })
    expect(rows.map((row) => row.filename).toSorted()).toEqual([
      'recap.summary.md',
      'retro.transcript.md',
      'tone-opus.ogg',
    ])

    await navigateTo('Journal')
    await reopenPageByTitle(`${MEETING_TITLE} 2031-03-14`)
    // The summary is open: its text shows without a click.
    await $(`[data-testid="markdown-attachment-body"]*=Recap of ${MEETING_TITLE}`).waitForDisplayed(
      { timeout: NAV_TIMEOUT },
    )
    const player = 'audio[aria-label="Audio tone-opus.ogg"]'
    await $(player).waitForExist({ timeout: NAV_TIMEOUT })
    await browser.waitUntil(
      async () =>
        browser.execute((selector: string) => {
          const audio = document.querySelector<HTMLAudioElement>(selector)
          return (audio?.readyState ?? 0) >= 1 && (audio?.duration ?? 0) > 0
        }, player),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the meeting audio never loaded' },
    )
    const toggle = $('[data-testid="transcript-attachment"] button[aria-expanded]')
    await toggle.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')

    // A timestamp seeks the real player. The fixture is about a second long, so
    // its one later segment sits at its end, where WebKit may clamp the seek
    // onto the duration: the player has moved when it is past 0 and inside it.
    await toggle.click()
    const seek = $('button[aria-label="Seek to 00:00:01"]')
    await seek.waitForClickable({ timeout: ACTION_TIMEOUT })
    await seek.click()
    await browser.waitUntil(
      async () =>
        browser.execute((selector: string) => {
          const audio = document.querySelector<HTMLAudioElement>(selector)
          if (audio === null) return false
          return audio.currentTime > 0.5 && audio.currentTime <= audio.duration
        }, player),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the timestamp never moved the player' },
    )
  })

  // Each MCP write emits from a tokio worker while the open page answers over
  // IPC. With Tauri's `tracing` feature an off-main-thread emit waits on the
  // main thread while holding Tauri's webview lock, which the main thread's IPC
  // handler needs; `main_thread.rs` runs every emit on the main thread instead.
  it('stays responsive while a burst of MCP writes reloads the open page', async () => {
    const { socketPath: socket, token: burstToken } = await startReadWriteAgent(
      runScopedMarker('wdio-mcp-burst-agent'),
    )
    const clients = await Promise.all(
      Array.from({ length: CONNECTIONS }, () => McpClient.connect(socket, burstToken)),
    )
    const [first] = clients
    if (first === undefined) throw new Error('no MCP connection')

    try {
      const space = await defaultSpaceId(first)
      const page = (await first.call('create_page', { title: BURST_TITLE, space_id: space })) as {
        id: string
      }
      const blockIds: string[] = []
      for (let c = 0; c < CONNECTIONS; c++) {
        const block = (await first.call('append_block', {
          parent_id: page.id,
          content: `${BURST_MARKER} c${c} v-`,
          space_id: space,
        })) as { id: string }
        blockIds.push(block.id)
      }

      // The open page answers every `blocks:changed` with IPC on the main thread.
      await reopenPageByTitle(BURST_TITLE)

      // Keep IPC requests queued at the main thread for the whole burst, so the
      // window in which a worker emit holds Tauri's lock is reliably hit.
      const ipcLoops = browser.execute(
        async (loops: number, rounds: number) => {
          const internals = (window as unknown as { __TAURI_INTERNALS__: Internals })
            .__TAURI_INTERNALS__
          const loop = async () => {
            for (let i = 0; i < rounds; i++) await internals.invoke('get_mcp_status')
          }
          await Promise.all(Array.from({ length: loops }, loop))
        },
        IPC_LOOPS,
        IPC_ROUNDS,
      )
      const writes = clients.flatMap((client, c) =>
        Array.from({ length: WRITES_PER_CONNECTION }, (_, v) =>
          client.call('update_block_content', {
            block_id: blockIds[c],
            content: `${BURST_MARKER} c${c} v${v}`,
            space_id: space,
          }),
        ),
      )
      await withinTimeout(
        Promise.all([...writes, ipcLoops]),
        `${CONNECTIONS * WRITES_PER_CONNECTION} MCP writes under IPC load`,
      )
      // Pipelined writes to one block may land in any order; settle each on a
      // known final text.
      for (let c = 0; c < CONNECTIONS; c++) {
        await first.call('update_block_content', {
          block_id: blockIds[c],
          content: `${BURST_MARKER} c${c} final`,
          space_id: space,
        })
      }
    } finally {
      for (const client of clients) client.close()
    }

    // The UI still answers, and each block shows its final write after a re-query.
    await withinTimeout(reopenPageByTitle(BURST_TITLE), 'reopening the page')
    for (let c = 0; c < CONNECTIONS; c++) {
      const final = `${BURST_MARKER} c${c} final`
      await $(`[data-testid="block-static"]*=${final}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    }
    expect(await blockStaticsByMarker(BURST_MARKER)).toHaveLength(CONNECTIONS)
  })

  // #5410 — `attach_file` reads a file on this device and stores it through the
  // app's own attachment write: the agent attaches one-second Ogg Opus, MP3 and
  // M4A tones (`fixtures/`, made with ffmpeg), each stored copy is the file's
  // bytes, the user leaves the page and opens it again, and the Opus and MP3
  // `<audio>` elements load their stored bytes in WebKitGTK. The M4A is not
  // played: the runner has GStreamer's base and good plugins, which decode Ogg
  // Opus and MP3, and AAC needs `gstreamer1.0-libav` or `gstreamer1.0-plugins-bad`.
  describe('attach_file (#5410)', () => {
    before(async () => {
      const { socketPath: socket, token: attachToken } = await startReadWriteAgent(
        runScopedMarker('wdio-attach-agent'),
      )
      const agent = await McpClient.connect(socket, attachToken)
      try {
        const space = await defaultSpaceId(agent)
        const page = (await agent.call('create_page', { title: ATTACH_PAGE, space_id: space })) as {
          id: string
        }
        const block = (await agent.call('append_block', {
          parent_id: page.id,
          content: ATTACH_BLOCK,
          space_id: space,
        })) as { id: string }
        for (const { file, mime } of ATTACH_FIXTURES) {
          const source = path.resolve(import.meta.dirname, 'fixtures', file)
          const row = (await agent.call('attach_file', {
            space_id: space,
            block_id: block.id,
            path: source,
          })) as AttachedRow
          expect(row.block_id).toBe(block.id)
          expect(row.filename).toBe(file)
          expect(row.mime_type).toBe(mime)
          const bytes = readFileSync(source)
          expect(row.size_bytes).toBe(bytes.length)
          if (!readFileSync(row.path).equals(bytes)) {
            throw new Error(`${file}: the stored copy at ${row.path} is not the file's bytes`)
          }
        }
      } finally {
        agent.close()
      }

      // Leave and come back: the players render from the stored rows and bytes.
      await navigateTo('Journal')
      await reopenPageByTitle(ATTACH_PAGE)
      await blockStaticByMarker(ATTACH_BLOCK).waitForDisplayed({ timeout: NAV_TIMEOUT })
    })

    for (const { file } of ATTACH_FIXTURES.filter((fixture) => fixture.plays)) {
      it(`loads the attached ${file} with its duration`, async () => {
        const player = `audio[aria-label="Audio ${file}"]`
        await $(player).waitForExist({ timeout: NAV_TIMEOUT })
        let state = { readyState: 0, duration: Number.NaN, error: 0 }
        await browser
          .waitUntil(
            async () => {
              state = await browser.execute((selector: string) => {
                const audio = document.querySelector<HTMLAudioElement>(selector)
                return {
                  readyState: audio?.readyState ?? 0,
                  duration: audio?.duration ?? Number.NaN,
                  error: audio?.error?.code ?? 0,
                }
              }, player)
              return state.readyState >= 1 && Number.isFinite(state.duration) && state.duration > 0
            },
            { timeout: ACTION_TIMEOUT },
          )
          .catch(() => {
            throw new Error(`${file} never loaded: ${JSON.stringify(state)}`)
          })
        expect(state.duration).toBeLessThan(2)
      })
    }
  })
})
