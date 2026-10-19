// ---------------------------------------------------------------------------
// An agent made in Settings reaches the vault through `agaric-mcp` with the
// mode and spaces it was given, its writes carry its name, and revoking it or
// Disconnect all shuts it out (#5667, #5759).
//
// Settings › Agent access makes the agent; the real bridge, given its token,
// reads and writes over the app's socket; Revoke in the same list refuses the
// connection's next call. The bridge is `src-tauri/target/debug/agaric-mcp`,
// which `wdio.conf.ts` builds and the workflow builds for CI.
//
// The History view shows no origin, so a write's `agent:<name>` attribution
// is read back through `block_history`, the agent's own view of the op log.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  confirmDialog,
  invoke,
  navigateTo,
  runScopedMarker,
  typeInputVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const AGENT = runScopedMarker('wdio-agent')
const TITLE = runScopedMarker('wdio-agent-page')
const READER = runScopedMarker('wdio-reader')
const WRITER = runScopedMarker('wdio-writer')

type Reply = Record<string, unknown>

/** `agaric-mcp`, spawned as an MCP client spawns it, JSON-RPC on stdio. */
class Bridge {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >()
  private readonly child: ChildProcessWithoutNullStreams

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    createInterface({ input: child.stdout }).on('line', (line) => {
      const reply = JSON.parse(line) as Reply
      this.pending.get(reply['id'] as number)?.resolve(reply)
    })
    child.once('exit', (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`agaric-mcp exited with code ${String(code)}`))
      }
    })
  }

  static async start(socketPath: string, token: string): Promise<Bridge> {
    const binary = path.resolve(
      import.meta.dirname,
      '..',
      'src-tauri',
      'target',
      'debug',
      'agaric-mcp',
    )
    const child = spawn(binary, ['--socket', socketPath, '--token', token])
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', (error) => {
        reject(new Error(`cannot start ${binary}: ${error.message}`))
      })
    })
    child.stderr.pipe(process.stderr)
    const bridge = new Bridge(child)
    const init = await bridge.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'wdio', version: '1' },
    })
    if (init['result'] === undefined) throw new Error(`initialize: ${JSON.stringify(init)}`)
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )
    return bridge
  }

  request(method: string, params: unknown): Promise<Reply> {
    const id = this.nextId++
    const reply = new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => reject(new Error(`${method} got no reply`)), ACTION_TIMEOUT)
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return reply
  }

  /** A tool's JSON result; throws with the reply on any error. */
  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await this.request('tools/call', { name, arguments: args })
    const text = (reply['result'] as { content?: { text?: string }[] } | undefined)?.content?.[0]
      ?.text
    if (text === undefined) throw new Error(`${name} failed: ${JSON.stringify(reply)}`)
    return JSON.parse(text) as Record<string, unknown>
  }

  close(): void {
    this.child.kill()
  }
}

/** The JSON-RPC error a tool call is refused with; throws if it is served. */
async function refusal(
  bridge: Bridge,
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: number; message: string }> {
  const reply = await bridge.request('tools/call', { name, arguments: args })
  const error = reply['error'] as { code: number; message: string } | undefined
  if (error === undefined) throw new Error(`${name} was served: ${JSON.stringify(reply)}`)
  return error
}

async function openAgentAccess(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-agent')
  await tab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await tab.click()
  await $('[data-testid="settings-panel-agent"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Turn on "Let agents connect" unless an earlier test of this file already did. */
async function enableAgentAccess(): Promise<void> {
  const toggle = $('button[role="switch"][aria-label="Let agents connect"]')
  await toggle.waitForClickable({ timeout: ACTION_TIMEOUT })
  if ((await toggle.getAttribute('aria-checked')) === 'true') return
  await toggle.click()
  await waitForToast('Agent access enabled')
}

/**
 * Add the agent `name` in the open Agent access tab with `mode`, limited to
 * the spaces named `spaces` (all spaces when omitted), and resolve to its row.
 */
async function addAgent(
  name: string,
  mode: 'Read only' | 'Read and write',
  spaces?: string[],
): Promise<ReturnType<typeof $>> {
  const add = $('[data-testid="settings-panel-agent"]').$('button=Add agent')
  await add.waitForClickable({ timeout: ACTION_TIMEOUT })
  await add.click()
  const dialog = $('[data-testid="create-agent-dialog"]')
  await dialog.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await typeInputVerified('[data-testid="create-agent-dialog"] input[autocomplete="off"]', name)
  // The mode is a single-choice toggle group: clicking the current choice keeps it.
  await dialog.$(`button=${mode}`).click()
  if (spaces !== undefined) {
    await dialog.$('button[role="checkbox"]').click()
    for (const space of spaces) {
      const box = dialog.$(
        `.//fieldset//label[normalize-space(.)="${space}"]/preceding-sibling::div/button[@role="checkbox"]`,
      )
      await box.waitForClickable({ timeout: ACTION_TIMEOUT })
      await box.click()
    }
  }
  await dialog.$('button[type="submit"]').click()
  await waitForToast('Agent added')
  const row = $(`[data-testid="mcp-agent-row"]*=${name}`)
  await row.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  return row
}

/** Wait until the app counts `count` open MCP connections. */
async function waitForConnections(count: number, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await invoke<{ active_connections: number }>('get_mcp_status')).active_connections === count,
    { timeout: ACTION_TIMEOUT, timeoutMsg },
  )
}

/** The real bridge, connected with the token of the agent `name`. */
async function connectAs(name: string): Promise<Bridge> {
  const agents = await invoke<{ name: string; token: string }[]>('list_mcp_agents')
  const token = agents.find((agent) => agent.name === name)?.token
  if (token === undefined) throw new Error(`no agent named ${name}`)
  const { socket_path: socketPath } = await invoke<{ socket_path: string }>('get_mcp_status')
  await browser.waitUntil(() => existsSync(socketPath), {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `MCP socket never appeared at ${socketPath}`,
  })
  return Bridge.start(socketPath, token)
}

describe('Agaric real-backend MCP agent token @mcp @spaces', () => {
  it('serves an agent through agaric-mcp, and refuses it once revoked', async () => {
    await waitForAppReady()
    await openAgentAccess()
    await enableAgentAccess()
    const row = await addAgent(AGENT, 'Read and write')

    const bridge = await connectAs(AGENT)
    try {
      const listed = await bridge.request('tools/call', { name: 'list_spaces', arguments: {} })
      const spaces = JSON.parse(
        (listed['result'] as { content: { text: string }[] }).content[0]?.text ?? '[]',
      ) as { id: string; is_default: boolean }[]
      const spaceId = spaces.find((space) => space.is_default)?.id
      if (spaceId === undefined) throw new Error(`no default space in ${JSON.stringify(spaces)}`)

      const page = await bridge.call('create_page', { title: TITLE, space_id: spaceId })
      const read = await bridge.call('get_page', { page_id: page['id'], space_id: spaceId })
      expect((read['page'] as { content: string }).content).toBe(TITLE)

      // Centred, so the "Agent added" toast at the bottom does not take the click.
      const revoke = row.$(`button[aria-label="Revoke ${AGENT}"]`)
      await revoke.scrollIntoView({ block: 'center' })
      await revoke.waitForClickable({ timeout: ACTION_TIMEOUT })
      await revoke.click()
      const confirm = $('[role="alertdialog"]').$('button=Revoke')
      await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
      await confirm.click()
      await row.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

      const refused = await bridge.request('tools/call', {
        name: 'get_page',
        arguments: { page_id: page['id'], space_id: spaceId },
      })
      const error = refused['error'] as { code: number; message: string } | undefined
      expect(error?.code).toBe(-32001)
      expect(error?.message).toContain(`'${AGENT}' was revoked`)
    } finally {
      bridge.close()
    }
  })

  it('holds a read-only agent to its spaces: no writes, only Work listed, a Personal page refused', async () => {
    await waitForAppReady()
    const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
    const idOf = (name: string): string => {
      const id = spaces.find((space) => space.name === name)?.id
      if (id === undefined) throw new Error(`no space ${name} in ${JSON.stringify(spaces)}`)
      return id
    }
    const work = idOf('Work')
    const personal = idOf('Personal')
    const pageIn = (space: string, title: string): Promise<string> =>
      invoke<string>('create_page_in_space', {
        parentId: null,
        content: runScopedMarker(title),
        spaceId: space,
      })
    const workPage = await pageIn(work, 'wdio-work-page')
    const personalPage = await pageIn(personal, 'wdio-personal-page')

    await openAgentAccess()
    await enableAgentAccess()
    const row = await addAgent(READER, 'Read only', ['Work'])
    expect(await row.getText()).toContain('Read only')
    expect(await row.getText()).toContain('Work ·')

    const bridge = await connectAs(READER)
    try {
      const write = await refusal(bridge, 'append_block', {
        parent_id: workPage,
        content: 'never written',
        space_id: work,
      })
      expect(write.code).toBe(-32001)
      expect(write.message).toContain('unknown tool `append_block`')

      const listed = await bridge.request('tools/call', { name: 'list_spaces', arguments: {} })
      const visible = JSON.parse(
        (listed['result'] as { content: { text: string }[] }).content[0]?.text ?? '[]',
      ) as { name: string }[]
      expect(visible.map((space) => space.name)).toEqual(['Work'])

      const read = await refusal(bridge, 'get_page', { page_id: personalPage, space_id: personal })
      expect(read.code).toBe(-32602)
      expect(read.message).toContain(`agent '${READER}' may not use space ${personal}`)
    } finally {
      bridge.close()
    }
  })

  it("counts an agent's connection, signs its writes agent:<name>, and Disconnect all closes it", async () => {
    await waitForAppReady()
    await openAgentAccess()
    await enableAgentAccess()
    await addAgent(WRITER, 'Read and write')

    const bridge = await connectAs(WRITER)
    try {
      // The tab reads the count when it mounts, so it is opened again once
      // the earlier tests' bridges have gone.
      await waitForConnections(1, 'the app never counted the one connection')
      await navigateTo('Journal')
      await openAgentAccess()
      const panel = $('[data-testid="settings-panel-agent"]')
      await browser.waitUntil(
        async () => (await panel.getText()).includes('1 active connection.'),
        {
          timeout: ACTION_TIMEOUT,
          timeoutMsg: 'Agent access never counted the connection',
        },
      )

      const listed = await bridge.request('tools/call', { name: 'list_spaces', arguments: {} })
      const spaces = JSON.parse(
        (listed['result'] as { content: { text: string }[] }).content[0]?.text ?? '[]',
      ) as { id: string; is_default: boolean }[]
      const spaceId = spaces.find((space) => space.is_default)?.id
      if (spaceId === undefined) throw new Error(`no default space in ${JSON.stringify(spaces)}`)
      const page = await bridge.call('create_page', {
        title: runScopedMarker('wdio-writer-page'),
        space_id: spaceId,
      })
      const block = await bridge.call('append_block', {
        parent_id: page['id'],
        content: runScopedMarker('wdio-writer-block'),
        space_id: spaceId,
      })
      const history = await bridge.call('block_history', {
        block_id: block['id'],
        space_id: spaceId,
      })
      const ops = history['items'] as { op_type: string; origin: string | null }[]
      expect(ops.find((op) => op.op_type === 'create_block')?.origin).toBe(`agent:${WRITER}`)

      const disconnect = panel.$('button[aria-label="Disconnect all"]')
      await disconnect.scrollIntoView({ block: 'center' })
      await disconnect.waitForClickable({ timeout: ACTION_TIMEOUT })
      await disconnect.click()
      await confirmDialog('Disconnect all')
      await waitForToast('Disconnected all active sessions')

      // The app drops the connection once the grace period for an in-flight
      // call is up. The bridge lingers until the client writes again (tokio
      // cannot cancel its blocking stdin read), so the next call is what
      // finds the socket gone: it gets no reply and the bridge exits.
      await waitForConnections(0, 'the app still counts the connection after Disconnect all')
      await expect(
        bridge.request('tools/call', { name: 'list_spaces', arguments: {} }),
      ).rejects.toThrow('agaric-mcp exited with code 0')
    } finally {
      bridge.close()
    }
  })
})
