// ---------------------------------------------------------------------------
// Real-backend: a meeting page (#5364), from the `/meeting` dialog and from an
// MCP agent's `add_meeting`, both through `add_meeting_inner`.
//
// The mock cannot show this: the meeting is several writes in one backend
// transaction (page, `#meeting`, `meeting_date`, link, files), its files are
// bytes on disk, and the player decodes them in WebKitGTK. The dialog case
// makes a meeting without files, since the driver's file uploads are not
// relied on here; the agent case carries the audio, the transcript and the
// summary, and seeks the real player from a timestamp. *New meeting* from the
// palette links today's journal, which is on screen. Each is checked after
// leaving the page and coming back.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  McpClient,
  NAV_TIMEOUT,
  blockStaticByMarker,
  defaultSpaceId,
  invoke,
  isoDay,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  startReadWriteAgent,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const PAGE = runScopedMarker('wdio-meeting-from')
const BLOCK = runScopedMarker('wdio-meeting-block')
const DIALOG_TITLE = runScopedMarker('wdio-sync')
const AGENT = runScopedMarker('wdio-meeting-agent')
const AGENT_TITLE = runScopedMarker('wdio-retro')
const PALETTE_TITLE = runScopedMarker('wdio-planning')

interface PropertyRow {
  key: string
  value_date: string | null
}

interface AttachmentRow {
  filename: string
  mime_type: string
}

describe('Agaric real-backend meeting pages (#5364) @attachments @pages @mcp', () => {
  before(async () => {
    await waitForAppReady()
  })

  it('the /meeting dialog makes the dated, tagged page and links it from the block', async () => {
    await openNewPage(PAGE)
    await typeMarkerVerified(BLOCK)
    // One key per call: WebKit coalesces identical adjacent keys sent together.
    for (const key of ' /meeting') await browser.keys([key])
    const command = $('[data-testid="suggestion-item"]*=MEETING')
    await command.waitForClickable({ timeout: ACTION_TIMEOUT })
    await command.click()

    const dialog = $('[data-testid="meeting-dialog"]')
    await dialog.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await typeInputVerified(
      '[data-testid="meeting-dialog"] input[placeholder="Meeting"]',
      DIALOG_TITLE,
    )
    await dialog.$('button=Create meeting').click()
    const title = `${DIALOG_TITLE} ${isoDay(new Date())}`
    await waitForToast(`Meeting ${title} created`)

    await navigateTo('Journal')
    await reopenPageByTitle(PAGE)
    const block = blockStaticByMarker(BLOCK)
    await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await browser.waitUntil(async () => (await block.getText()).includes(title), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `the block never showed the link to ${title}`,
    })

    const blockId = await block.getAttribute('data-block-id')
    const { content } = await invoke<{ content: string }>('get_block', { blockId })
    const pageId = /\[\[([0-9A-Z]{26})\]\]/.exec(content)?.[1]
    if (pageId === undefined) throw new Error(`the block holds no page link: ${content}`)
    await reopenPageByTitle(title)
    const props = await invoke<PropertyRow[]>('get_properties', { blockId: pageId })
    expect(props.find((p) => p.key === 'meeting_date')?.value_date).toBe(isoDay(new Date()))
    await $('button[aria-label="Remove tag meeting"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
  })

  it('an agent’s add_meeting files play, with the transcript collapsed under them', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wdio-meeting-'))
    const transcript = path.join(dir, 'retro.md')
    writeFileSync(transcript, '[00:00:00] **Alice:** Hi.\n\n[00:00:01] **Bob:** Bye.\n')
    const summary = path.join(dir, 'recap.md')
    writeFileSync(summary, `Recap of ${AGENT_TITLE}\n`)
    const { socketPath, token } = await startReadWriteAgent(AGENT)
    const agent = await McpClient.connect(socketPath, token)
    let recordingId: string
    try {
      const spaceId = await defaultSpaceId(agent)
      const made = (await agent.call('add_meeting', {
        space_id: spaceId,
        title: AGENT_TITLE,
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
    await reopenPageByTitle(`${AGENT_TITLE} 2031-03-14`)
    // The summary is open: its text shows without a click.
    await $(`[data-testid="markdown-attachment-body"]*=Recap of ${AGENT_TITLE}`).waitForDisplayed({
      timeout: NAV_TIMEOUT,
    })
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

  it('New meeting from the palette links it from today’s journal on screen', async () => {
    await navigateTo('Journal')
    await $('[data-testid="header-search-button"]').click()
    await typeInputVerified('[data-testid="command-palette-input"]', '>New meeting')
    const command = $('[role="option"]*=New meeting')
    await command.waitForClickable({ timeout: ACTION_TIMEOUT })
    await command.click()
    await typeInputVerified(
      '[data-testid="meeting-dialog"] input[placeholder="Meeting"]',
      PALETTE_TITLE,
    )
    await $('[data-testid="meeting-dialog"]').$('button=Create meeting').click()
    const title = `${PALETTE_TITLE} ${isoDay(new Date())}`
    await waitForToast(`Meeting ${title} created`)

    // The journal was on screen the whole time; its link shows without leaving.
    const link = blockStaticByMarker(title)
    await link.waitForDisplayed({ timeout: NAV_TIMEOUT })

    await reopenPageByTitle(title)
    await $('button[aria-label="Remove tag meeting"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
    await navigateTo('Journal')
    await blockStaticByMarker(title).waitForDisplayed({ timeout: NAV_TIMEOUT })
  })
})
