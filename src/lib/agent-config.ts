/**
 * Client config snippets for one MCP agent (#5667). Built on click, so an
 * agent's token never sits in the DOM.
 */

import type { McpAgent } from '@/lib/bindings'

type AgentConfigSource = Pick<McpAgent, 'id' | 'name' | 'token'>

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

export function claudeDesktopConfig(agent: AgentConfigSource, socketPath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [agentServerName(agent)]: {
          command: 'agaric-mcp',
          args: ['--socket', socketPath, '--token', agent.token],
        },
      },
    },
    null,
    2,
  )
}

// The server name comes before `--` so `claude mcp add` never takes it for an
// option value; the path is quoted because app-data dirs can contain spaces.
export function claudeCodeCommand(agent: AgentConfigSource, socketPath: string): string {
  return `claude mcp add -s user ${agentServerName(agent)} -- agaric-mcp --socket "${socketPath}" --token ${agent.token}`
}
