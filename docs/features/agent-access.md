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

- Is **logged to the activity feed** with timestamp, tool name, summary of the action, and the operations it produced.
- Is **revertable** — every write goes through the same op log as user edits, so `Ctrl+Z` and the History view treat agent ops identically to user ops.

Writes are space-scoped; reads are not. See the next section.

## Space scoping: reads are vault-wide, writes are space-scoped

The read-only and read-write surfaces treat spaces differently **by design**, and it's important to understand the difference before you hand an agent a space ULID.

- **Read-write tools are space-scoped.** Every write tool (`append_block`, `update_block_content`, `set_property`, `add_tag`, `create_page`, `delete_block`) takes a **required** `space_id`. Before mutating a block, the server checks that the target block actually lives in that space, so an agent scoped to space A cannot *modify* content owned by space B even if it knows a block's ULID.
- **Read-only tools are deliberately vault-wide.** The read surface is designed to give an agent a whole-vault view, so reads are **not** uniformly confined to one space. Concretely, the read tools fall into three space-scoping patterns:

  | Pattern | Read-only tools | Behaviour |
  | --- | --- | --- |
  | **`space_id` required** | `search`, `journal_for_date` | The call runs inside the named space; results are confined to that space. |
  | **`space_id` optional** | `list_backlinks`, `get_agenda` | Pass a `space_id` to confine the result; omit it for the cross-space (whole-vault) view. |
  | **`space_id` absent** | `list_pages`, `get_page`, `get_block`, `list_tags`, `list_property_definitions`, `list_spaces` | No space argument exists; these tools always span every space. Fetch-by-ULID (`get_page` / `get_block`) and enumeration (`list_pages`) therefore reach **any** space's data. |

### Security implication

Because the read surface is cross-space, **handing an agent a `space_id` for writes does not confine its reads.** An agent restricted to writing in space A can still read every other space's pages, blocks, and tags — by enumerating with `list_pages` / `list_tags`, or by fetching a known ULID with `get_page` / `get_block`. The space scoping on the write surface is a *write*-isolation boundary, not a read-isolation one.

This is intentional (agents are treated as whole-vault readers), but if you have a space whose contents an agent must not read, **do not rely on the MCP space argument to hide it** — disable MCP, or don't expose that data to the agent's vault. Per-space read isolation would require adding `space_id` enforcement to the currently-unscoped read tools.

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
- **An agent can only *write* to the space it asked for, but it can *read* across spaces.** The read-only surface is deliberately vault-wide — see [Space scoping](#space-scoping-reads-are-vault-wide-writes-are-space-scoped) above. Don't rely on the MCP space argument to hide one space's contents from an agent.
- **Reverting a session reverts *everything* the agent did since connect.** It's coarse on purpose — if you want surgical reverts, use the History view to undo specific operations.
- **The activity feed is bounded.** Old entries scroll out. For a long-term record, the History view is the source of truth (agent ops appear there with an agent badge).
- **Quick Capture goes to the active space.** If you switch spaces and capture, it lands in the new space.
