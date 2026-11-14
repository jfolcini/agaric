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

// What `get_mcp_status` reports on each desktop package (`mcp::bridge_invocation`).
const MAC = {
  bridge_command: '/Applications/Agaric.app/Contents/MacOS/agaric-mcp',
  bridge_args: [],
  socket_path: SOCKET,
}
const WINDOWS = {
  bridge_command: String.raw`C:\Users\Jo Doe\AppData\Local\Agaric\agaric-mcp.exe`,
  bridge_args: [],
  socket_path: String.raw`\\.\pipe\agaric-mcp`,
}
const DEB = {
  bridge_command: '/usr/bin/agaric-mcp',
  bridge_args: [],
  socket_path: '/home/me/.local/share/com.agaric.app/mcp.sock',
}
const APPIMAGE = {
  bridge_command: '/home/me/My Apps/Agaric.AppImage',
  bridge_args: ['agaric-mcp'],
  socket_path: '/home/me/.local/share/com.agaric.app/mcp.sock',
}

describe('claudeDesktopConfig', () => {
  it.each([
    ['macOS', MAC],
    ['Windows', WINDOWS],
    ['the .deb', DEB],
    ['an AppImage', APPIMAGE],
  ])('runs the bridge %s reports, then the socket path and the token', (_, bridge) => {
    expect(JSON.parse(claudeDesktopConfig(agent('Planner'), bridge))).toEqual({
      mcpServers: {
        'agaric-planner-00x7k2': {
          command: bridge.bridge_command,
          args: [...bridge.bridge_args, '--socket', bridge.socket_path, '--token', TOKEN],
        },
      },
    })
  })

  it('escapes the backslashes of a Windows path for JSON', () => {
    expect(claudeDesktopConfig(agent('Planner'), WINDOWS)).toContain(
      String.raw`"command": "C:\\Users\\Jo Doe\\AppData\\Local\\Agaric\\agaric-mcp.exe"`,
    )
  })
})

describe('claudeCodeCommand', () => {
  it('quotes the bridge and socket paths, puts the server name before --, and appends the token', () => {
    expect(claudeCodeCommand(agent('Claude Code'), MAC)).toBe(
      `claude mcp add -s user agaric-claude-code-00x7k2 -- "/Applications/Agaric.app/Contents/MacOS/agaric-mcp" --socket "${SOCKET}" --token ${TOKEN}`,
    )
  })

  it('keeps a Windows path with a space in one quoted argument', () => {
    expect(claudeCodeCommand(agent('Claude Code'), WINDOWS)).toBe(
      String.raw`claude mcp add -s user agaric-claude-code-00x7k2 -- "C:\Users\Jo Doe\AppData\Local\Agaric\agaric-mcp.exe" --socket "\\.\pipe\agaric-mcp" --token ` +
        TOKEN,
    )
  })

  it('runs an AppImage with the bridge argument before the bridge options', () => {
    expect(claudeCodeCommand(agent('Claude Code'), APPIMAGE)).toBe(
      `claude mcp add -s user agaric-claude-code-00x7k2 -- "/home/me/My Apps/Agaric.AppImage" agaric-mcp --socket "${APPIMAGE.socket_path}" --token ${TOKEN}`,
    )
  })
})
