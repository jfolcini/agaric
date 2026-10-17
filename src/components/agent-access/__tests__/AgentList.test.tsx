/**
 * AgentList + CreateAgentDialog (#5667), over a stateful `invoke` fake: every
 * assertion reads the list the component re-fetched from the fake, not the
 * shape of the call that changed it.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { AgentList } from '@/components/agent-access/AgentList'
import type { McpAgent, McpAgentMode } from '@/lib/bindings'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/lib/clipboard', () => ({ writeText: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockedInvoke = vi.mocked(invoke)
const SOCKET = '/data/com.agaric.app/mcp.sock'
const TOKEN = `agt_${'a'.repeat(32)}`

let agents: McpAgent[]

function makeAgent(overrides: Partial<McpAgent> = {}): McpAgent {
  return {
    id: '01AGENT0000000000000000000',
    name: 'Planner',
    mode: 'read_only',
    space_ids: null,
    token: TOKEN,
    created_at_ms: 1_700_000_000_000,
    last_used_ms: null,
    ...overrides,
  }
}

/** The backend's create, list and revoke, enough for the UI's flows. */
function installAgentBackend(): void {
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      list_mcp_agents: () => structuredClone(agents),
      create_mcp_agent: (args) => {
        const { name, mode, spaceIds } = args as {
          name: string
          mode: McpAgentMode
          spaceIds: string[] | null
        }
        const trimmed = name.trim()
        if (agents.some((a) => a.name.toLowerCase() === trimmed.toLowerCase())) {
          return Promise.reject({
            kind: 'validation',
            code: 'DuplicateAgentName',
            message: `an agent named '${trimmed}' already exists`,
          })
        }
        const agent = makeAgent({
          id: `01AGENT${agents.length}`,
          name: trimmed,
          mode,
          space_ids: spaceIds,
          token: `agt_${String(agents.length).padStart(32, '0')}`,
        })
        agents.push(agent)
        return { ...agent }
      },
      revoke_mcp_agent: (args) => {
        agents = agents.filter((a) => a.id !== (args as { id: string }).id)
        return undefined
      },
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(writeText).mockResolvedValue(undefined)
  agents = []
  useSpaceStore.setState({
    availableSpaces: [
      { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null },
      { id: 'SPACE_WORK', name: 'Work', accent_color: null },
    ],
  })
  installAgentBackend()
})

async function auditClean(container: Element): Promise<void> {
  await waitFor(
    async () => {
      expect(await axe(container)).toHaveNoViolations()
    },
    { timeout: 5000 },
  )
}

describe('AgentList — empty', () => {
  it('shows the empty state with the migration sentence and Add agent', async () => {
    const { container } = render(<AgentList socketPath={SOCKET} />)

    expect(await screen.findByText('No agents yet')).toBeInTheDocument()
    expect(screen.getByText(/replace that client's agaric-ro and agaric-rw entries/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Add agent' })).toBeInTheDocument()
    expect(screen.queryAllByTestId('mcp-agent-row')).toHaveLength(0)
    await auditClean(container)
  })
})

describe('AgentList — create', () => {
  it('creates a read-write agent in one space, then lists it from a re-read', async () => {
    const user = userEvent.setup()
    render(<AgentList socketPath={SOCKET} />)
    await user.click(await screen.findByRole('button', { name: 'Add agent' }))

    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'Planner')
    await user.click(within(dialog).getByRole('radio', { name: 'Read and write' }))
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'All spaces, including new ones' }),
    )
    await user.click(within(dialog).getByRole('checkbox', { name: 'Work' }))
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))

    const row = await screen.findByTestId('mcp-agent-row')
    expect(row).toHaveTextContent('Planner')
    expect(row).toHaveTextContent('Read and write')
    expect(row).toHaveTextContent('Work · Never used')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('defaults to read-only in every space, and Enter in the name submits', async () => {
    const user = userEvent.setup()
    render(<AgentList socketPath={SOCKET} />)
    await user.click(await screen.findByRole('button', { name: 'Add agent' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: 'Read only' })).toBeChecked()
    expect(within(dialog).queryByRole('group', { name: 'Spaces' })).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Name'), 'Reader{Enter}')

    const row = await screen.findByTestId('mcp-agent-row')
    expect(row).toHaveTextContent('Read only')
    expect(row).toHaveTextContent('All spaces · Never used')
  })

  it('keeps the dialog open on a duplicate name, with an alert, a log and a toast', async () => {
    agents = [makeAgent()]
    const user = userEvent.setup()
    render(<AgentList socketPath={SOCKET} />)
    await user.click(await screen.findByRole('button', { name: 'Add agent' }))

    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'planner{Enter}')

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'An agent named planner already exists',
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'AgentAccessSettingsTab',
      'failed to create agent',
      expect.anything(),
      expect.objectContaining({ code: 'DuplicateAgentName' }),
    )
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Couldn't add the agent")
    expect(screen.getAllByTestId('mcp-agent-row')).toHaveLength(1)
  })

  it('has no axe violations with the dialog open and the spaces revealed', async () => {
    const user = userEvent.setup()
    render(<AgentList socketPath={SOCKET} />)
    await user.click(await screen.findByRole('button', { name: 'Add agent' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'All spaces, including new ones' }),
    )
    expect(within(dialog).getByRole('group', { name: 'Spaces' })).toBeInTheDocument()

    await auditClean(document.body)
  })
})

describe('AgentList — rows', () => {
  it('names the spaces left, last use, and has no axe violations', async () => {
    agents = [
      makeAgent({ id: 'A1', name: 'Gone', space_ids: ['SPACE_DELETED'] }),
      makeAgent({
        id: 'A2',
        name: 'Planner',
        mode: 'read_write',
        space_ids: ['SPACE_WORK', 'SPACE_PERSONAL'],
        last_used_ms: Date.now() - 5 * 60_000,
      }),
    ]
    const { container } = render(<AgentList socketPath={SOCKET} />)

    const rows = await screen.findAllByTestId('mcp-agent-row')
    expect(rows[0]).toHaveTextContent('No spaces left · Never used')
    expect(rows[1]).toHaveTextContent('Personal, Work · Last used 5m ago')
    await auditClean(container)
  })

  it('copies configs that carry the token, which the DOM never holds', async () => {
    agents = [makeAgent()]
    const user = userEvent.setup()
    render(<AgentList socketPath={SOCKET} />)

    await user.click(
      await screen.findByRole('button', { name: 'Copy Claude Code command for Planner' }),
    )
    expect(vi.mocked(writeText)).toHaveBeenLastCalledWith(
      `claude mcp add -s user agaric-planner-000000 -- agaric-mcp --socket "${SOCKET}" --token ${TOKEN}`,
    )

    await user.click(screen.getByRole('button', { name: 'Copy Claude Desktop config for Planner' }))
    const desktop = vi.mocked(writeText).mock.lastCall?.[0] ?? ''
    expect(JSON.parse(desktop).mcpServers['agaric-planner-000000'].args).toEqual([
      '--socket',
      SOCKET,
      '--token',
      TOKEN,
    ])

    expect(document.body.innerHTML).not.toContain(TOKEN)
  })

  it('revokes only after confirmation; Cancel keeps the row', async () => {
    agents = [makeAgent()]
    const user = userEvent.setup()
    render(<AgentList socketPath={SOCKET} />)

    await user.click(await screen.findByRole('button', { name: 'Revoke Planner' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Revoke Planner?' })
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(agents).toHaveLength(1)
    expect(screen.getAllByTestId('mcp-agent-row')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Revoke Planner' }))
    const again = await screen.findByRole('alertdialog')
    await user.click(within(again).getByRole('button', { name: 'Revoke' }))

    expect(await screen.findByText('No agents yet')).toBeInTheDocument()
    expect(screen.queryAllByTestId('mcp-agent-row')).toHaveLength(0)
  })

  it('logs, toasts and keeps the row when revoke rejects', async () => {
    agents = [makeAgent()]
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_mcp_agents: () => structuredClone(agents),
        revoke_mcp_agent: () => Promise.reject({ kind: 'database', message: 'locked' }),
      }),
    )
    const user = userEvent.setup()
    render(<AgentList socketPath={SOCKET} />)

    await user.click(await screen.findByRole('button', { name: 'Revoke Planner' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke' }),
    )

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Couldn't revoke the agent"),
    )
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'AgentAccessSettingsTab',
      'failed to revoke agent',
      undefined,
      expect.objectContaining({ message: 'locked' }),
    )
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getAllByTestId('mcp-agent-row')).toHaveLength(1)
  })

  it('shows an alert when the list fails to load', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_mcp_agents: () => Promise.reject({ kind: 'database', message: 'boom' }),
      }),
    )
    render(<AgentList socketPath={SOCKET} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load agents')
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'AgentAccessSettingsTab',
      'failed to load agents',
      undefined,
      expect.objectContaining({ message: 'boom' }),
    )
  })
})
