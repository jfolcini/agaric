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

- **Read-write tools require a `space_id` — but it's a self-declared consistency check, not an isolation boundary.** Every write tool (`append_block`, `update_block_content`, `set_property`, `add_tag`, `create_page`, `delete_block`) takes a **required** `space_id`, supplied by the agent itself. Before mutating a block, the server checks that the target block actually lives in the space the agent claimed, and rejects the call if it doesn't. This catches an agent acting on a stale or mismatched ULID (e.g. reusing a block ID from the wrong space) — but it does **not** confine an agent to "its" space: nothing binds a connection or agent identity to a fixed set of allowed spaces, so an agent that supplies the block's real `space_id` passes the check and can write to any space — and getting that value is trivial. `list_spaces` enumerates every real `space_id` in the vault (`get_page` / `get_block` don't return a block's `space_id` directly, but there are typically only a handful of spaces to try), and a wrong guess is self-correcting: the rejection message states the block's actual space (`"block '…' belongs to space '…'"`), so a single failed write hands the agent the value the next call needs.
- **Read-only tools are deliberately vault-wide.** The read surface is designed to give an agent a whole-vault view, so reads are **not** uniformly confined to one space. Concretely, the read tools fall into three space-scoping patterns:

  | Pattern | Read-only tools | Behaviour |
  | --- | --- | --- |
  | **`space_id` required** | `search`, `journal_for_date` | The call runs inside the named space; results are confined to that space. |
  | **`space_id` optional** | `list_backlinks`, `get_agenda` | Pass a `space_id` to confine the result; omit it for the cross-space (whole-vault) view. |
  | **`space_id` absent** | `list_pages`, `get_page`, `get_block`, `list_tags`, `list_property_definitions`, `list_spaces` | No space argument exists; these tools always span every space. Fetch-by-ULID (`get_page` / `get_block`) and enumeration (`list_pages`) therefore reach **any** space's data. |

### Security implication

Because the read surface is cross-space, **handing an agent a `space_id` does not confine either its reads or its writes.** An agent "given" space A can still read every other space's pages, blocks, and tags — by enumerating with `list_pages` / `list_tags`, or by fetching a known ULID with `get_page` / `get_block`. That cross-space read access also undermines the write guard: `list_spaces` hands the agent every real `space_id` in the vault to try, and a write attempt with the wrong one is self-correcting — the guard's own rejection message states the block's actual space, so the agent can pass that value straight back on the next call and clear the consistency check above. The `space_id` argument is not an authorization or isolation boundary in either direction; it only catches accidental cross-space writes from a stale ULID.

This is intentional for reads (agents are treated as whole-vault readers) and is a known, accepted limitation for writes (there is no per-connection or per-agent space allowlist). If you have a space whose contents an agent must not read or write, **do not rely on the MCP `space_id` argument to fence it off** — disable MCP, or don't expose that data to the agent's vault. Real per-space isolation (read or write) would require binding a connection/agent to an authorised space set and enforcing it in the dispatch layer, which does not exist today.

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
- **The MCP `space_id` argument fences off neither reads nor writes.** The read-only surface is deliberately vault-wide, and the write-side `space_id` is a self-declared consistency check an adversarial agent can satisfy for any space — not an isolation boundary. See [Space scoping](#space-scoping-reads-are-vault-wide-writes-are-space-scoped) above. Don't rely on the MCP space argument to hide or protect one space's contents from an agent.
- **Reverting a session reverts *everything* the agent did since connect.** It's coarse on purpose — if you want surgical reverts, use the History view to undo specific operations.
- **The activity feed is bounded.** Old entries scroll out. For a long-term record, the History view is the source of truth (agent ops appear there with an agent badge).
- **Quick Capture goes to the active space.** If you switch spaces and capture, it lands in the new space.
