<!-- markdownlint-disable MD060 -->
# Agent Access

Agaric exposes itself to AI agents (Claude Desktop, Cursor, Continue, and any other MCP-capable client) via the **Model Context Protocol (MCP)** over a local socket / named pipe. Agents can read and write to your vault using the same primitives the UI uses. There's an in-app activity feed so you can watch (and revert) what an agent does.

## What you can do

- **Enable / disable MCP** entirely (Settings → Agent access).
- **Watch agent activity in real time** in the **ActivityFeed** (Settings → Agent access).
- **Revert a whole session's edits** with one click (the **SessionRevertControls** action).
- **Open Agaric from another app** via the `agaric://` deep-link scheme.
- **Capture quickly into Agaric** via the global Quick Capture hotkey (works even when the app is in the background) — see [editor.md](editor.md) and [keyboard.md](keyboard.md).

## How agents connect

Agaric runs a local MCP server endpoint when MCP is enabled. The endpoint is a Unix domain socket (Linux / macOS) or a Windows named pipe — never an open TCP port. Agents connect via the stdio bridge (`agaric-mcp`) bundled with the app.

**Claude Desktop config example** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agaric": {
      "command": "/path/to/agaric-mcp"
    }
  }
}
```

Cursor and Continue use the same `command` shape under their respective MCP config keys. The *Agent access* settings tab shows the exact path for the current install.

## What agents can do

The MCP surface is split into:

- **Read-only tools** (always available when MCP is enabled): list pages, get page, search, get block, list backlinks, list tags, list property definitions, get agenda, fetch a journal page by date.
- **Read-write tools**: append block, update block content, set property, add tag, create page, delete block. Separate from read-only so you can disable writes while keeping reads on.

Every tool call:

- Is **scoped to a space**. Agents pass a space when calling; the server enforces it so an agent in one space can't see another.
- Is **logged to the activity feed** with timestamp, tool name, summary of the action, and the operations it produced.
- Is **revertable** — every write goes through the same op log as user edits, so `Ctrl+Z` and the History view treat agent ops identically to user ops.

## Activity feed

The **ActivityFeed** in the Settings → Agent access tab streams a window of recent tool invocations. Each entry shows:

- Relative timestamp (*"3s ago"*).
- Tool name and a short, privacy-safe summary (`"search: 'planning'" → 4 results`).
- Operation count if the call wrote anything.
- A status indicator (green / amber / red).
- A clickable target if relevant (the block or page that was touched).

The feed is local to each device — agent activity isn't synced.

## Session revert

If you decide an agent's last batch of edits was a mistake, hit **Revert session** in the **SessionRevertControls**. It unwinds every op that agent produced since the MCP session began, in reverse. The revert itself is a normal op log entry, so you can undo the revert if you change your mind.

## `agaric://` deep links

External tools (and you, from anywhere on the OS) can open Agaric to a specific target with a URL:

| URL | What it does |
| --- | --- |
| `agaric://block/<id>` | Open the page containing the block; scroll the block into view; focus it. |
| `agaric://page/<id>` | Open the page in the active tab. |
| `agaric://settings/<tab>` | Open Settings to a specific tab (e.g. `agent-access`, `keyboard`, `data`). |

The OS handler is registered on app install. From a terminal: `open agaric://...` (macOS), `xdg-open` (Linux), `start` (Windows).

## Pitfalls to know

- **MCP listens locally only.** It's never exposed over the network. Two computers can't share one Agaric's MCP — pair them via [sync.md](sync.md) instead.
- **An agent can only see and write to the space it asked for.** If the agent reports nothing, check it's asking the right space.
- **Reverting a session reverts *everything* the agent did since connect.** It's coarse on purpose — if you want surgical reverts, use the History view to undo specific operations.
- **The activity feed is bounded.** Old entries scroll out. For a long-term record, the History view is the source of truth (agent ops appear there with an agent badge).
- **Quick Capture goes to the active space.** If you switch spaces and capture, it lands in the new space.
