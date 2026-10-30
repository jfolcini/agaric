<!-- markdownlint-disable MD060 -->
# Agent Access

Agaric exposes itself to AI agents (Claude Desktop, Cursor, Continue, and any other MCP-capable client) via the **Model Context Protocol (MCP)** over a local socket / named pipe. Agents can read and write to your vault using the same primitives the UI uses. There's an in-app activity feed so you can watch (and revert) what an agent does.

## What you can do

- **Enable / disable MCP** (Settings → Agent access): one switch for the one
  socket.
- **Give each client its own agent** (Settings → Agent access → Agents): a
  name, read-only or read-write, the spaces it may use, and a token. Copy its
  Claude Desktop config or Claude Code command from its row; revoke it there
  too.
- **Watch agent activity in real time** in the **ActivityFeed** (Settings → Agent access).
- **Revert a whole session's edits** with one click (the **SessionRevertControls** action).
- **Open Agaric from another app** via the `agaric://` deep-link scheme.
- **Capture quickly into Agaric** via the global Quick Capture hotkey (works even when the app is in the background) — see [editor.md](editor.md) and [keyboard.md](keyboard.md).

## How agents connect

Agaric runs a local MCP server when MCP is enabled: a Unix domain socket (Linux / macOS) or a Windows named pipe — never an open TCP port. Agents connect through the stdio bridge (`agaric-mcp`) bundled with the app, which presents an agent's token before anything else:

```json
{
  "mcpServers": {
    "agaric-planner-3kq9vz": {
      "command": "agaric-mcp",
      "args": ["--socket", "/path/to/mcp.sock", "--token", "agt_…"]
    }
  }
}
```

Settings → Agent access makes that entry for you: add an agent, then use its row's *Copy Claude Desktop config* or *Copy Claude Code command* (`claude mcp add -s user <name> -- agaric-mcp --socket "<path>" --token <token>`). Cursor and Continue use the same command and arguments under their own MCP config keys. While the switch is on, the tab shows the socket's path and its connection count, with *Disconnect all* while any agent is connected.

Each agent has:

- **A name**, which its edits carry as their origin (`agent:<name>`): the activity feed and the `page_history` / `block_history` tools show it, the History view does not. What the client calls itself is not used.
- **Read-only or read-write.** A read-only agent gets only the read tools; a write tool is an unknown tool to it.
- **Spaces**: every space, including ones created later, or a list. The agent sees and uses only those (see [Space scoping](#space-scoping)).
- **A token** (`agt_` and 32 hex digits) that works only against this device's socket. Agents are not synced.

A connection without a token, or with one no agent holds, is refused with an error naming Settings → Agent access, and closed. Revoking an agent refuses its next call, even on a connection that is still open. To change an agent's access, revoke it and add a new one.

**Upgrading from the two sockets.** Before agents, a read-only and a read-write socket each had a switch and a config entry (`agaric-ro`, `agaric-rw`). Those entries stop working: add one agent per client and replace that client's entries with the agent's. Access that was on stays on. A copy of `agaric-mcp` from before agents rejects `--token`, so replace any copy you made (say, on your `PATH`) with the one that ships with the app ([README § Using Agaric with MCP clients](../../README.md#using-agaric-with-mcp-clients)).

## What agents can do

The MCP surface is split into:

- **Read-only tools** (served to every agent): list pages, get page, read a page as Markdown, search, get block, list backlinks, list tags, list property definitions, get agenda, list spaces, fetch a journal page by date, page history, block history, get journal, list journal, list trash, resolve names, query. One carve-out: `journal_for_date` **creates** the journal page if it doesn't exist yet and the date is near today — the only read-registry tool with a write side effect. A day it creates gets the space's journal template, as a day the journal creates does.
- **Read-write tools** (served to a read-write agent): append block, append markdown, update block content, set property, add tag, create page, delete block, move page to space, create tag, delete property, undo, capture, move blocks, remove tag, restore block, batch, edit page markdown, set page aliases, plus every read-only tool. Move blocks reparents or reorders blocks in one call and one transaction, keeping their ids, so links to them and their history survive. Append markdown lands a whole piece of Markdown under a parent in one call and one undo, exactly as a paste in the app does: list items nest, `-` and `*` items become bulleted blocks and `1.` items numbered ones, a heading is a block of its own, `key:: value` lines become properties, and a `[[Page]]` or `#tag` that matches nothing in the parent's space creates that page or tag there. It reads the blocks as `get_page_markdown` writes them, so blocks read from one page and appended under another land as the same blocks, under new ids.

What the page reads return:

- A block row leaves out its null fields: an unset `due_date`, `todo_state` or `parent_id`, and `deleted_at` on a live block.
- `get_block` returns the block's row plus `properties` (every property row, raw, `template` included), `tags` (tag ULIDs; `list_tags` maps them to names), its page's `page_title` and, for a page, `aliases`. `get_page` adds `properties`, `tags` and `aliases` to its `page`; its children are plain rows, without `page_title`, since `page.content` is that title. A block with none of them gets empty arrays.
- `list_pages { space_id, sort?, filters?, cursor?, limit? }` lists a space's pages as the Pages view does. `sort` is `alphabetical` (the default), `created` (newest first), `recently-modified`, `last-opened` (on this device), `most-linked` or `most-content`; `filters` are page predicates a page must all match: `Orphan`, `HasNoInboundLinks`, `Stub`, `Tag` / `TagOrRef`, `PathGlob`, `LastEdited`, `HasProperty`, `Priority`. Each row adds `last_modified_at`, `inbound_link_count` and `child_block_count`; the first page carries `total_count`. A cursor continues only the sort it came from.
- `search { query, space_id, parent_id?, tag_ids?, filter?, include_match_offsets?, cursor?, limit? }` matches each word as a case-insensitive substring and drops words under 3 characters; an empty `query` with a filter lists the matching blocks newest first. `parent_id` matches direct children only. A `tag_ids` tag matches a block that has it attached, written inline as `#tag`, or inherited from an ancestor such as its page. `filter.last_edited` takes `Rolling { days }`, `OlderThan { days }` or `Range { start, end }`. Each row carries its `page_title`, except a page, whose `content` is its title; `match_offsets` only when `include_match_offsets` is true.
- `query { space_id, where, sort?, group_by?, aggregate?, cursor?, limit? }` runs the advanced query engine (the app's query builder) over one space: `where` is its boolean tree of predicates (tags, properties, state, priority, due, scheduled, created and last-edited dates, links, parent), and `group_by` / `aggregate` bucket and count the matches. A row is the block with its page's title and the properties the query reads; a grouped query returns `{ key, title, count, aggregates }` groups instead. An unknown predicate, a malformed date or a `Between` range that ends before it starts is refused. Ids inside `where` are ULIDs, not names, and content is returned as stored, its ids not resolved to names.
- `get_page_markdown` returns `{ page_id, markdown, truncated, next_cursor }`: the page as `# Title`, YAML front matter (aliases, tags, properties), then the blocks as a paste reads them, each with its `key:: value` properties: a plain block as a paragraph, or as a `+` item under a list block, a bulleted block as a `-` item, a numbered one as `1.`, a task as `- [ ]`, children indented under their parent's text. Links, tags and ref-typed values are written as names, for reading; a name two pages share stays text when written back, so an agent writes such a link by ULID. Every block ends with its `^ULID`, the id `update_block_content` takes. With `editable: true` it returns instead the page's whole Markdown as the app's *Edit as Markdown* edits it, never truncated: no title line, a name only where it reads back as the same link, ref-typed values as ids, each block still ending with its `^ULID`.
- A large read stops early: `get_page`, `list_backlinks` and `get_page_markdown` stop at a content budget per call (`RESPONSE_BYTES_CAP` in `src-tauri/src/mcp/tools_ro.rs`), cut at a block or group, with `truncated: true` and a `next_cursor`. Passing it back as `cursor` returns the rest from where the last call stopped, so no block is skipped; one block or group larger than the budget comes back whole.

Several writes at once:

- `batch { ops, space_id }` applies a list of writes in one transaction: one feed entry, one undo. Each op is `{ "op": <tool>, ... }`, one of `append_block`, `update_block_content`, `set_property`, `add_tag`, `remove_tag`, `move_blocks` or `delete_block`, with that tool's arguments less `space_id`. The ops run in order; if any is refused, nothing is written, and the error names the op as `ops[i]`. A batch that would write more operations than one undo reverts is refused.
- `move_page_to_space { page_id, space_id, target_space_id, acknowledge_property_loss? }` moves a page and its blocks to another space. Property definitions are per space, so the move removes each value whose key the target space does not define the same way (type and options) and that is not built in or undeclared in both. Such a move is refused until `acknowledge_property_loss` lists those keys with their counts, `{ "key": count }`; the refusal names them and gives the object to pass, and one that no longer matches is refused the same way. One undo of the move restores the values. A move that would remove more values than one undo reverts is refused, and so is a page whose title the target space already holds.
- `edit_page_markdown { page_id, markdown, base, space_id }` saves a page edited as Markdown, exactly as the app's *Edit as Markdown* saves it: read it with `get_page_markdown` and `editable: true`, edit the text, and send it back with the text read as `base`. Blocks pair by their `^ULID`, and only what changed is written, so moving one block is one move. A page that changed since `base` is refused, so the agent reads it again.

Names in place of ids:

- Wherever a tool takes a page, tag or parent id (`parent_id`, `page_id`, `tag_id`, `tag_ids`), a value that is not a ULID is a name in the call's `space_id`: a page by exact title, else by its one case-insensitive title, else by alias; a tag by name, ignoring case. A name two pages share is refused with a validation error listing them with their ids, and a name nothing has is refused too. Block ids stay ULIDs: blocks have no names. `get_page` and `get_page_markdown` take ids only.
- `append_block` and `update_block_content` write a `[[Name]]` or `#name` as the app's paste does: linked by id, creating the page or tag in the space when nothing matches. A name two pages share stays text, and the result lists it under `warnings`. A page's title and a tag's name are kept as written.
- `resolve { names, space_id }` looks up many names in one call and answers each with `page_id` and `tag_id` (null when nothing matches), or `page_candidates` when pages share the name.

The journal in one call:

- `capture { content, space_id, date? }` appends Markdown, read as append markdown reads it, at the end of the day's journal page, creating the day with the space's journal template first. The day and the blocks land together: one feed entry, one undo.
- `get_journal { space_id, date? }` returns `{ date, page_id, markdown }`, the day as `get_page_markdown` renders it. It never creates the day: a missing day returns `page_id: null` and empty `markdown`.
- `list_journal { space_id, from, to, cursor?, limit? }` lists the days in `[from, to]` as `{ page_id, date, block_count }`, oldest first, cursor paginated.
- `date` is `today` (the default), `yesterday`, or `YYYY-MM-DD`, on the device's clock, so the agent need not guess your timezone. `from` and `to` are `YYYY-MM-DD`.

Undo and history:

- Every write tool's result carries `op_refs` (`[{ device_id, seq }]`), the operations it wrote; a call that wrote nothing has none. `undo { op_refs, space_id }` reverts them through the same path as the activity feed's Undo, as one action that gets its own feed entry, so you can undo the agent's undo. It refuses an operation written by you or by another agent (a guard against mistakes, not a security boundary).
- `list_trash { space_id }` lists a space's deleted blocks, newest first and cursor paginated; `restore_block { block_id, deleted_at, space_id }` brings one back with what was deleted with it.
- `page_history { page_id, space_id }` and `block_history { block_id, space_id }` list who changed what and when, newest first and cursor paginated: device, origin (`user` or `agent:<name>`), op type, timestamp, block, the text or property value the op wrote and, for an edit, the text before it, each clipped to a short excerpt.

Every tool call:

- Is **logged to the activity feed** with timestamp, tool name, summary of the action, and the operations it produced.
- Is **revertable** — every write goes through the same op log as user edits, so `Ctrl+Z` and the History view treat agent ops identically to user ops.

## Space scoping

Every tool takes a required `space_id` except `list_spaces`, which lists the spaces. A call without it is refused with a validation error naming the field.

| Pattern | Tools | Behaviour |
| --- | --- | --- |
| **`space_id` required** | every other tool | The call runs inside the named space. Listings and searches return only that space's rows (`list_property_defs` lists that space's definitions, a built-in one marked `builtin`); a tool that addresses a block or page by id refuses a target in another space with a validation error. `create_page`, `create_tag` and `capture` create in that space; `move_page_to_space` moves the page into a live `target_space_id`. |
| **`space_id` absent** | `list_spaces` | Lists the spaces the agent may use. |

An agent limited to some spaces is refused, before the tool runs, any call whose `space_id` or `target_space_id` names another space; the refusal reaches the activity feed.

### What a limited agent can still see

The limit guards against an agent's mistakes; it is not isolation. Each of these shows at most a title or an id from a space the agent may not use, and only through a link or move you made:

1. `get_page_markdown` and `get_journal` write a link, tag, block reference or ref-typed value that points into another space with its target's title or name. A link written across spaces is refused, so such a link comes from moving one of its pages.
2. `block_history` and `page_history` show a moved block's earlier text from the space it moved out of.
3. `list_backlinks` takes a target in another space; the sources it lists are in the agent's space.
4. A refusal for a block or page in another space names that space's id; the next call naming it is refused.
5. `search.parent_id`, ids inside `query`, and links in written content may name ids from other spaces; what is read or written stays in the agent's space. A ref-typed property naming another space's block is refused.

If a space's contents must not reach an agent at all, don't give that agent the space, and don't link or move pages into its spaces from that one.

## Activity feed

The **ActivityFeed** in the Settings → Agent access tab streams a window of recent tool invocations. It has its own card and stays visible with the switch off, so past agent writes can still be undone. Each entry shows:

- Relative timestamp (*"3s ago"*) and the agent's name.
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

If you decide an agent's last batch of edits was a mistake, hit **Revert session** in the **SessionRevertControls**. It unwinds the agent's ops in reverse — specifically the ones still in the activity feed's 100-entry window, so it reverts exactly what you can see. The revert is itself recorded in the op log, so you can undo it if you change your mind: select its entries in the History view and choose **Revert selected**. For a longer session, use the History view.

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
- **An agent's spaces are a guard against mistakes, not isolation.** A link or a move can show it a title or an id from another space; see [What a limited agent can still see](#what-a-limited-agent-can-still-see).
- **Reverting a session is coarse, and bounded by the feed.** It reverts every agent op still in the 100-entry activity window — not a surgical subset, and not ops that have already scrolled out. Use the History view for either of those.
- **Reverting a session can be too large to run.** It sends every op of every action in one revert, which is capped at `MAX_REVERT_OPS` (`src-tauri/src/commands/history.rs`), so a session holding large `append_markdown` calls can exceed it. Undo those entries one by one instead.
- **The activity feed is bounded and in-memory.** It holds 100 entries and doesn't survive a restart. For a long-term record, the History view is the source of truth — though it doesn't distinguish agent ops from your own, so match them up by time. An agent's `page_history` / `block_history` does show each op's origin.
- **Quick Capture goes to the active space.** If you switch spaces and capture, it lands in the new space.
