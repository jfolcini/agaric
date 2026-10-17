import { describe, expect, it } from 'vitest'

import { agentServerName, claudeCodeCommand, claudeDesktopConfig } from '@/lib/agent-config'

const TOKEN = `agt_${'a'.repeat(32)}`
const SOCKET = '/Users/me/Library/Application Support/com.agaric.app/mcp.sock'

describe('agentServerName', () => {
  it('lowercases the name and turns each run of other characters into one dash', () => {
    expect(agentServerName('Claude Desktop')).toBe('agaric-claude-desktop')
    expect(agentServerName('  My   Planner (work) ')).toBe('agaric-my-planner-work')
    expect(agentServerName('Bot_2.0')).toBe('agaric-bot-2-0')
  })

  it('falls back to agent when no letter or digit survives', () => {
    expect(agentServerName('日本語')).toBe('agaric-agent')
    expect(agentServerName('---')).toBe('agaric-agent')
  })
})

describe('claudeDesktopConfig', () => {
  it('passes the socket path and the token as separate args, the path unquoted', () => {
    expect(JSON.parse(claudeDesktopConfig('Planner', TOKEN, SOCKET))).toEqual({
      mcpServers: {
        'agaric-planner': {
          command: 'agaric-mcp',
          args: ['--socket', SOCKET, '--token', TOKEN],
        },
      },
    })
  })
})

describe('claudeCodeCommand', () => {
  it('quotes the socket path, puts the server name before --, and appends the token', () => {
    expect(claudeCodeCommand('Claude Code', TOKEN, SOCKET)).toBe(
      `claude mcp add -s user agaric-claude-code -- agaric-mcp --socket "${SOCKET}" --token ${TOKEN}`,
    )
  })
})
