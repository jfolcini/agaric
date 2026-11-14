/**
 * Client config snippets for one MCP agent (#5667). Built on click, so an
 * agent's token never sits in the DOM.
 */

import type { McpAgent, McpStatus } from '@/lib/bindings'

type AgentConfigSource = Pick<McpAgent, 'id' | 'name' | 'token'>

/** Where the bridge is and which socket it connects to, from `get_mcp_status`. */
export type BridgeSource = Pick<McpStatus, 'bridge_command' | 'bridge_args' | 'socket_path'>

/**
 * The agent's MCP server name: `agaric-`, its name lowercased with each run of
 * other characters a dash, then the random tail of its id, so two agents whose
 * names differ only in punctuation still get distinct servers.
 */
export function agentServerName(agent: Pick<McpAgent, 'id' | 'name'>): string {
  const slug = agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `agaric-${slug === '' ? 'agent' : slug}-${agent.id.slice(-6).toLowerCase()}`
}

export function claudeDesktopConfig(agent: AgentConfigSource, bridge: BridgeSource): string {
  return JSON.stringify(
    {
      mcpServers: {
        [agentServerName(agent)]: {
          command: bridge.bridge_command,
          args: [...bridge.bridge_args, '--socket', bridge.socket_path, '--token', agent.token],
        },
      },
    },
    null,
    2,
  )
}

// The server name comes before `--` so `claude mcp add` never takes it for an
// option value. The paths are double-quoted because install and app-data dirs
// can contain spaces, and double quotes are the one quoting that bash, zsh,
// PowerShell and Command Prompt all read the same way for a path.
export function claudeCodeCommand(agent: AgentConfigSource, bridge: BridgeSource): string {
  return [
    `claude mcp add -s user ${agentServerName(agent)} --`,
    `"${bridge.bridge_command}"`,
    ...bridge.bridge_args,
    `--socket "${bridge.socket_path}" --token ${agent.token}`,
  ].join(' ')
}
