<!-- markdownlint-disable MD060 -->
# Agent Access

Agaric exposes itself to AI agents (Claude Desktop, Cursor, Continue, and any other MCP-capable client) via the **Model Context Protocol (MCP)** over a local socket / named pipe. Agents can read and write to your vault using the same primitives the UI uses. There's an in-app activity feed so you can watch (and revert) what an agent does.

## What you can do

- **Enable / disable MCP** (Settings → Agent access). Reads and writes are two
  separate sockets with two separate toggles, so you can leave reads on while
  writes stay off.
- **Watch agent activity in real time** in the **ActivityFeed** (Settings → Agent access).
- **Revert a whole session's edits** with one click (the **SessionRevertControls** action).
- **Open Agaric from another app** via the `agaric://` deep-link scheme.
- **Capture quickly into Agaric** via the global Quick Capture hotkey (works even when the app is in the background) — see [editor.md](editor.md) and [keyboard.md](keyboard.md).

## How agents connect

Agaric runs local MCP server endpoints when MCP is enabled. Each endpoint is a Unix domain socket (Linux / macOS) or a Windows named pipe — never an open TCP port. Agents connect via the stdio bridge (`agaric-mcp`) bundled with the app.

There are **two sockets**: a read-only one and a read-write one, each with its own toggle. The bridge connects to the read-only socket unless you point it elsewhere with `--socket` or `AGARIC_MCP_SOCKET`, so a bare `command` entry gets read access only:

```json
{
  "mcpServers": {
    "agaric": {
      "command": "/path/to/agaric-mcp",
      "env": { "AGARIC_MCP_SOCKET": "/path/to/mcp-ro.sock" }
    }
  }
}
```

To give an agent the write tools, add a second server entry pointing `AGARIC_MCP_SOCKET` at the read-write socket. Cursor and Continue use the same shape under their respective MCP config keys. While a toggle is on, the *Agent access* settings tab shows that socket's exact path for the current install and its connection count, with *Disconnect all* while any agent is connected; the read-only card copies ready-made snippets for both sockets: a Claude Desktop JSON with an `agaric-ro` and an `agaric-rw` entry, and `claude mcp add` commands for Claude Code.

## What agents can do

The MCP surface is split into:

- **Read-only tools** (always available when MCP is enabled): list pages, get page, read a page as Markdown, search, get block, list backlinks, list tags, list property definitions, get agenda, list spaces, fetch a journal page by date, page history, block history, get journal, list journal, list trash, resolve names, query. One carve-out: `journal_for_date` **creates** the journal page if it doesn't exist yet and the date is near today — the only read-registry tool with a write side effect. A day it creates gets the space's journal template, as a day the journal creates does.
- **Read-write tools**: append block, append markdown, update block content, set property, add tag, create page, delete block, move page to space, create tag, delete property, undo, capture, move blocks, remove tag, restore block, batch, edit page markdown, set page aliases. Move blocks reparents or reorders blocks in one call and one transaction, keeping their ids, so links to them and their history survive. Append markdown lands a whole Markdown outline under a parent in one call and one undo, exactly as a paste in the app does: list items nest, headings own what follows them, `key:: value` lines become properties, and a `[[Page]]` or `#tag` that matches nothing in the parent's space creates that page or tag there. Separate from read-only so you can disable writes while keeping reads on.

What the page reads return:

- A block row leaves out its null fields: an unset `due_date`, `todo_state` or `parent_id`, and `deleted_at` on a live block.
- `get_block` returns the block's row plus `properties` (every property row, raw, `template` included), `tags` (tag ULIDs; `list_tags` maps them to names), its page's `page_title` and, for a page, `aliases`. `get_page` adds `properties`, `tags` and `aliases` to its `page`; its children are plain rows, without `page_title`, since `page.content` is that title. A block with none of them gets empty arrays.
- `list_pages { space_id, sort?, filters?, cursor?, limit? }` lists a space's pages as the Pages view does. `sort` is `alphabetical` (the default), `created` (newest first), `recently-modified`, `last-opened` (on this device), `most-linked` or `most-content`; `filters` are page predicates a page must all match: `Orphan`, `HasNoInboundLinks`, `Stub`, `Tag` / `TagOrRef`, `PathGlob`, `LastEdited`, `HasProperty`, `Priority`. Each row adds `last_modified_at`, `inbound_link_count` and `child_block_count`; the first page carries `total_count`. A cursor continues only the sort it came from.
- `search { query, space_id, parent_id?, tag_ids?, filter?, include_match_offsets?, cursor?, limit? }` matches each word as a case-insensitive substring and drops words under 3 characters; an empty `query` with a filter lists the matching blocks newest first. `parent_id` matches direct children only. A `tag_ids` tag matches a block that has it attached, written inline as `#tag`, or inherited from an ancestor such as its page. `filter.last_edited` takes `Rolling { days }`, `OlderThan { days }` or `Range { start, end }`. Each row carries its `page_title`, except a page, whose `content` is its title; `match_offsets` only when `include_match_offsets` is true.
- `query { space_id, where, sort?, group_by?, aggregate?, cursor?, limit? }` runs the advanced query engine (the app's query builder) over one space: `where` is its boolean tree of predicates (tags, properties, state, priority, due, scheduled, created and last-edited dates, links, parent), and `group_by` / `aggregate` bucket and count the matches. A row is the block with its page's title and the properties the query reads; a grouped query returns `{ key, title, count, aggregates }` groups instead. An unknown predicate, a malformed date or a `Between` range that ends before it starts is refused. Ids inside `where` are ULIDs, not names, and content is returned as stored, its ids not resolved to names.
- `get_page_markdown` returns `{ page_id, markdown, truncated, next_cursor }`: the page as `# Title`, YAML front matter (aliases, tags, properties), then the block outline with each block's `key:: value` properties. Links, tags and ref-typed values are written as names, for reading; a name two pages share stays text when written back, so an agent writes such a link by ULID. Every block ends with its `^ULID`, the id `update_block_content` takes. With `editable: true` it returns instead the page's whole source as the app's source mode edits it, never truncated: no title line, a name only where it reads back as the same link, ref-typed values as ids, each block still ending with its `^ULID`.
- A large read stops early: `get_page`, `list_backlinks` and `get_page_markdown` stop at a content budget per call (`RESPONSE_BYTES_CAP` in `src-tauri/src/mcp/tools_ro.rs`), cut at a block or group, with `truncated: true` and a `next_cursor`. Passing it back as `cursor` returns the rest from where the last call stopped, so no block is skipped; one block or group larger than the budget comes back whole.

Several writes at once:

- `batch { ops, space_id }` applies a list of writes in one transaction: one feed entry, one undo. Each op is `{ "op": <tool>, ... }`, one of `append_block`, `update_block_content`, `set_property`, `add_tag`, `remove_tag`, `move_blocks` or `delete_block`, with that tool's arguments less `space_id`. The ops run in order; if any is refused, nothing is written, and the error names the op as `ops[i]`. A batch that would write more operations than one undo reverts is refused.
- `edit_page_markdown { page_id, markdown, base, space_id }` saves a page edited as its source, exactly as the app's source mode saves it: read it with `get_page_markdown` and `editable: true`, edit the text, and send it back with the text read as `base`. Blocks pair by their `^ULID`, and only what changed is written, so moving one bullet is one move. A page that changed since `base` is refused, so the agent reads it again.

Names in place of ids:

- Wherever a tool takes a page, tag or parent id (`parent_id`, `page_id`, `tag_id`, `tag_ids`), a value that is not a ULID is a name in the call's `space_id`: a page by exact title, else by its one case-insensitive title, else by alias; a tag by name, ignoring case. A name two pages share is refused with a validation error listing them with their ids, and a name nothing has is refused too. Block ids stay ULIDs: blocks have no names. `get_page` and `get_page_markdown` take ids only.
- `append_block` and `update_block_content` write a `[[Name]]` or `#name` as the app's paste does: linked by id, creating the page or tag in the space when nothing matches. A name two pages share stays text, and the result lists it under `warnings`. A page's title and a tag's name are kept as written.
- `resolve { names, space_id }` looks up many names in one call and answers each with `page_id` and `tag_id` (null when nothing matches), or `page_candidates` when pages share the name.

The journal in one call:

- `capture { content, space_id, date? }` appends a Markdown outline, read as append markdown reads it, at the end of the day's journal page, creating the day with the space's journal template first. The day and the outline land together: one feed entry, one undo.
- `get_journal { space_id, date? }` returns `{ date, page_id, markdown }`, the day as `get_page_markdown` renders it. It never creates the day: a missing day returns `page_id: null` and empty `markdown`.
- `list_journal { space_id, from, to, cursor?, limit? }` lists the days in `[from, to]` as `{ page_id, date, block_count }`, oldest first, cursor paginated.
- `date` is `today` (the default), `yesterday`, or `YYYY-MM-DD`, on the device's clock, so the agent need not guess your timezone. `from` and `to` are `YYYY-MM-DD`.

Undo and history:

- Every write tool's result carries `op_refs` (`[{ device_id, seq }]`), the operations it wrote; a call that wrote nothing has none. `undo { op_refs, space_id }` reverts them through the same path as the activity feed's Undo, as one action that gets its own feed entry, so you can undo the agent's undo. It refuses an operation written by you or by another agent (a guard against mistakes, not a security boundary: an agent's name is whatever its client reports).
- `list_trash { space_id }` lists a space's deleted blocks, newest first and cursor paginated; `restore_block { block_id, deleted_at, space_id }` brings one back with what was deleted with it.
- `page_history { page_id, space_id }` and `block_history { block_id, space_id }` list who changed what and when, newest first and cursor paginated: device, origin (`user` or `agent:<name>`), op type, timestamp, block, the text or property value the op wrote and, for an edit, the text before it, each clipped to a short excerpt.

Every tool call:

- Is **logged to the activity feed** with timestamp, tool name, summary of the action, and the operations it produced.
- Is **revertable** — every write goes through the same op log as user edits, so `Ctrl+Z` and the History view treat agent ops identically to user ops.

## Space scoping

Every tool takes a required `space_id` except `list_spaces`, which lists the spaces, and `list_property_defs`, because property definitions are vault-wide. A call without it is refused with a validation error naming the field.

| Pattern | Tools | Behaviour |
| --- | --- | --- |
| **`space_id` required** | every other tool | The call runs inside the named space. Listings and searches return only that space's rows; a tool that addresses a block or page by id refuses a target in another space with a validation error. `create_page`, `create_tag` and `capture` create in that space; `move_page_to_space` moves the page into any live `target_space_id`. |
| **`space_id` absent** | `list_spaces`, `list_property_defs` | Vault-wide by nature: the list of spaces, and the property schema every space shares. |

### Security implication

**`space_id` is not an isolation boundary.** It confines each call, but nothing binds a connection or an agent to a set of spaces: `list_spaces` hands the agent every real `space_id`, and it can pass any of them to any tool. A refusal for a target in another space usually names the target's actual space (`"block '…' belongs to space '…'"`), so the next call can pass that value straight back. The argument catches accidental cross-space reads and writes from a stale or mismatched ULID; it does not stop an agent that means to cross spaces.

If you have a space whose contents an agent must not read or write, **do not rely on the MCP `space_id` argument to fence it off** — disable MCP, or don't expose that data to the agent's vault. Real per-space isolation would require binding a connection/agent to an authorised space set and enforcing it in the dispatch layer, which does not exist today.

## Activity feed

The **ActivityFeed** in the Settings → Agent access tab streams a window of recent tool invocations. It has its own card and stays visible with both toggles off, so past agent writes can still be undone. Each entry shows:

- Relative timestamp (*"3s ago"*).
- Tool name and a short, field-filtered summary using the real output shape (for example,
  `search — 4 matches` or `add_tag — applied 01HZTEST to 01HZB10C`).
- Operation count if the call wrote anything.
- A status indicator (green / amber / red).
- A clickable target if relevant (the block or page that was touched).

The feed is local to each device — agent activity isn't synced.

Summaries may show structural counts, dates, property keys, number/date/bool property values, and
shortened ULID/reference prefixes. They never include block content, page titles, tag display
names, search query strings, or text property values (`value_text`).

## Session revert

If you decide an agent's last batch of edits was a mistake, hit **Revert session** in the **SessionRevertControls**. It unwinds the agent's ops in reverse — specifically the ones still in the activity feed's 100-entry window, so it reverts exactly what you can see. The revert itself is a normal op log entry, so you can undo the revert if you change your mind. For a longer session, use the History view.

## `agaric://` deep links

External tools (and you, from anywhere on the OS) can open Agaric to a specific target with a URL:

| URL | What it does |
| --- | --- |
| `agaric://block/<id>` | Open the page containing the block; scroll the block into view; focus it. |
| `agaric://page/<id>` | Open the page in the active tab. |
| `agaric://settings/<tab>` | Open Settings to a specific tab (e.g. `agent-access`, `keyboard`, `data`). |

The OS handler is registered on app install. From a terminal: `open agaric://...` (macOS), `xdg-open` (Linux), `start` (Windows).

On **Android** the custom scheme isn't available, so the same three routes are served as App Links instead: `https://agaric.app/o/block/<id>`, `/o/page/<id>`, `/o/settings/<tab>`. Use those when linking from a mobile app.

## Pitfalls to know

- **MCP listens locally only.** It's never exposed over the network. Two computers can't share one Agaric's MCP — pair them via [sync.md](sync.md) instead.
- **The MCP `space_id` argument is not an isolation boundary.** It confines each call to the space it names, but an agent can name any space `list_spaces` returns. See [Space scoping](#space-scoping) above. Don't rely on the MCP space argument to hide or protect one space's contents from an agent.
- **Reverting a session is coarse, and bounded by the feed.** It reverts every agent op still in the 100-entry activity window — not a surgical subset, and not ops that have already scrolled out. Use the History view for either of those.
- **Reverting a session can be too large to run.** It sends every op of every action in one revert, which is capped at `MAX_REVERT_OPS` (`src-tauri/src/commands/history.rs`), so a session holding large `append_markdown` calls can exceed it. Undo those entries one by one instead.
- **The activity feed is bounded and in-memory.** It holds 100 entries and doesn't survive a restart. For a long-term record, the History view is the source of truth — though it doesn't distinguish agent ops from your own, so match them up by time. An agent's `page_history` / `block_history` does show each op's origin.
- **Quick Capture goes to the active space.** If you switch spaces and capture, it lands in the new space.
