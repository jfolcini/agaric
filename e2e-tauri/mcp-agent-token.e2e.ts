// ---------------------------------------------------------------------------
// An agent made in Settings reaches the vault through `agaric-mcp`, and
// revoking it shuts it out (#5667).
//
// Settings › Agent access makes the agent; the real bridge, given its token,
// reads and writes over the app's socket; Revoke in the same list refuses the
// connection's next call. The bridge is `src-tauri/target/debug/agaric-mcp`,
// which `wdio.conf.ts` builds and the workflow builds for CI.
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
  navigateTo,
  runScopedMarker,
  typeInputVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const AGENT = runScopedMarker('wdio-agent')
const TITLE = runScopedMarker('wdio-agent-page')

interface Internals {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>
}

async function invoke<T>(cmd: string, args?: unknown): Promise<T> {
  return browser.execute(
    (c: string, a: unknown) =>
      (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__.invoke(c, a),
    cmd,
    args,
  ) as Promise<T>
}

type Reply = Record<string, unknown>

/** `agaric-mcp`, spawned as an MCP client spawns it, JSON-RPC on stdio. */
class Bridge {
  private nextId = 1
  private readonly pending = new Map<number, (reply: Reply) => void>()
  private readonly child: ChildProcessWithoutNullStreams

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    createInterface({ input: child.stdout }).on('line', (line) => {
      const reply = JSON.parse(line) as Reply
      this.pending.get(reply['id'] as number)?.(reply)
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
      this.pending.set(id, resolve)
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

async function openAgentAccess(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-agent')
  await tab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await tab.click()
  await $('[data-testid="settings-panel-agent"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

async function addReadWriteAgent(name: string): Promise<void> {
  const add = $('[data-testid="settings-panel-agent"]').$('button=Add agent')
  await add.waitForClickable({ timeout: ACTION_TIMEOUT })
  await add.click()
  const dialog = $('[data-testid="create-agent-dialog"]')
  await dialog.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await typeInputVerified('[data-testid="create-agent-dialog"] input[autocomplete="off"]', name)
  await dialog.$('button=Read and write').click()
  await dialog.$('button[type="submit"]').click()
  await waitForToast('Agent added')
}

describe('Agaric real-backend MCP agent token @mcp', () => {
  it('serves an agent through agaric-mcp, and refuses it once revoked', async () => {
    await waitForAppReady()
    await openAgentAccess()

    const toggle = $('button[role="switch"][aria-label="Let agents connect"]')
    await toggle.waitForClickable({ timeout: ACTION_TIMEOUT })
    await toggle.click()
    await waitForToast('Agent access enabled')
    await addReadWriteAgent(AGENT)
    const row = $(`[data-testid="mcp-agent-row"]*=${AGENT}`)
    await row.waitForDisplayed({ timeout: ACTION_TIMEOUT })

    const agents = await invoke<{ name: string; token: string }[]>('list_mcp_agents')
    const token = agents.find((agent) => agent.name === AGENT)?.token
    if (token === undefined) throw new Error(`no agent named ${AGENT}`)
    const { socket_path: socketPath } = await invoke<{ socket_path: string }>('get_mcp_status')
    await browser.waitUntil(() => existsSync(socketPath), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `MCP socket never appeared at ${socketPath}`,
    })

    const bridge = await Bridge.start(socketPath, token)
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
})
