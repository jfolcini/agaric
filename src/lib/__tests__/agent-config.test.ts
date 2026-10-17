import { describe, expect, it } from 'vitest'

import { agentServerName, claudeCodeCommand, claudeDesktopConfig } from '@/lib/agent-config'

const TOKEN = `agt_${'a'.repeat(32)}`
const SOCKET = '/Users/me/Library/Application Support/com.agaric.app/mcp.sock'
const ID = '01JAGENT00000000000000X7K2'

function agent(name: string, id = ID) {
  return { id, name, token: TOKEN }
}

describe('agentServerName', () => {
  it('lowercases the name, turns each run of other characters into one dash, and appends the id tail', () => {
    expect(agentServerName(agent('Claude Desktop'))).toBe('agaric-claude-desktop-00x7k2')
    expect(agentServerName(agent('  My   Planner (work) '))).toBe('agaric-my-planner-work-00x7k2')
    expect(agentServerName(agent('Bot_2.0'))).toBe('agaric-bot-2-0-00x7k2')
  })

  it('falls back to agent when no letter or digit survives', () => {
    expect(agentServerName(agent('日本語'))).toBe('agaric-agent-00x7k2')
    expect(agentServerName(agent('---'))).toBe('agaric-agent-00x7k2')
  })

  it('gives two agents whose names differ only in punctuation distinct server names', () => {
    const one = agentServerName(agent('Bot 1', '01JAGENT0000000000000AAAAA'))
    const two = agentServerName(agent('Bot-1', '01JAGENT0000000000000BBBBB'))
    expect(one).not.toBe(two)
    expect([one, two]).toEqual(['agaric-bot-1-0aaaaa', 'agaric-bot-1-0bbbbb'])
  })
})

describe('claudeDesktopConfig', () => {
  it('passes the socket path and the token as separate args, the path unquoted', () => {
    expect(JSON.parse(claudeDesktopConfig(agent('Planner'), SOCKET))).toEqual({
      mcpServers: {
        'agaric-planner-00x7k2': {
          command: 'agaric-mcp',
          args: ['--socket', SOCKET, '--token', TOKEN],
        },
      },
    })
  })
})

describe('claudeCodeCommand', () => {
  it('quotes the socket path, puts the server name before --, and appends the token', () => {
    expect(claudeCodeCommand(agent('Claude Code'), SOCKET)).toBe(
      `claude mcp add -s user agaric-claude-code-00x7k2 -- agaric-mcp --socket "${SOCKET}" --token ${TOKEN}`,
    )
  })
})
