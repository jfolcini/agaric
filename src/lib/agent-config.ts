/**
 * Client config snippets for one MCP agent (#5667). Built on click, so an
 * agent's token never sits in the DOM.
 */

/** The agent's MCP server name: `agaric-` plus its name lowercased, each run of other characters a dash. */
export function agentServerName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `agaric-${slug === '' ? 'agent' : slug}`
}

export function claudeDesktopConfig(name: string, token: string, socketPath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [agentServerName(name)]: {
          command: 'agaric-mcp',
          args: ['--socket', socketPath, '--token', token],
        },
      },
    },
    null,
    2,
  )
}

// The server name comes before `--` so `claude mcp add` never takes it for an
// option value; the path is quoted because app-data dirs can contain spaces.
export function claudeCodeCommand(name: string, token: string, socketPath: string): string {
  return `claude mcp add -s user ${agentServerName(name)} -- agaric-mcp --socket "${socketPath}" --token ${token}`
}
