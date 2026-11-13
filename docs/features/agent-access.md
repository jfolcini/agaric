<!-- markdownlint-disable MD060 -->
# Agent Access

Agaric exposes itself to AI agents (Claude Desktop, Cursor, Continue, and any other MCP-capable client) via the **Model Context Protocol (MCP)** over a local socket / named pipe. Agents can read and write to your vault using the same primitives the UI uses. There's an in-app activity feed so you can watch (and revert) what an agent does.

## What you can do

- **Enable / disable MCP** (Settings → Agent access): one switch for the one
  socket. On a phone the tab says that no other app there can reach the
  socket yet, so agents are set up on a computer.
- **Give each client its own agent** (Settings → Agent access → Agents): a
  name, read-only or read-write, the spaces it may use, and a token. Copy its
  Claude Desktop config or Claude Code command from its row; revoke it there
  too.
- **Watch agent activity in real time** in the **ActivityFeed** (Settings → Agent access).
- **Revert a whole session's edits** with one click (the **SessionRevertControls** action).
- **Run one tool from a script** with `agaric-mcp call` (see [From a script](#from-a-script)).
- **Open Agaric from another app** via the `agaric://` deep-link scheme.
- **Capture quickly into Agaric** via the global Quick Capture hotkey (works even when the app is in the background) — see [editor.md](editor.md) and [keyboard.md](keyboard.md) — or an `agaric://capture?text=…` link from a bookmarklet, a launcher or a script.

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

- **A name**, which its edits carry as their origin (`agent:<name>`): the activity feed, the History view and the `page_history` / `block_history` tools show it. What the client calls itself is not used.
- **Read-only or read-write.** A read-only agent gets only the read tools; a write tool is an unknown tool to it.
- **Spaces**: every space, including ones created later, or a list. The agent sees and uses only those (see [Space scoping](#space-scoping)).
- **A token** (`agt_` and 32 hex digits) that works only against this device's socket. Agents are not synced.

A connection without a token, or with one no agent holds, is refused with an error naming Settings → Agent access, and closed. Revoking an agent refuses its next call, even on a connection that is still open. To change an agent's access, revoke it and add a new one.

**Upgrading from the two sockets.** Before agents, a read-only and a read-write socket each had a switch and a config entry (`agaric-ro`, `agaric-rw`). Those entries stop working: add one agent per client and replace that client's entries with the agent's. Access that was on stays on. A copy of `agaric-mcp` from before agents rejects `--token`, so replace any copy you made (say, on your `PATH`) with the one that ships with the app ([README § Using Agaric with MCP clients](../../README.md#using-agaric-with-mcp-clients)).

## From a script

`agaric-mcp call <tool> <json>` runs one tool and exits, for a cron job, a git hook, a launcher or a shell alias. It connects as the bridge does, with the same `--token`, `--socket` and `$AGARIC_MCP_SOCKET`, so the agent's mode and spaces apply. `<json>` is the tool's arguments as one JSON object; `list_spaces` with `'{}'` gives the space ids.

```sh
# Append to today's journal (a read-write agent's token)
agaric-mcp --token agt_… call capture '{"space_id":"01HZ…","content":"Call the plumber"}'

# Search, and read the hits with jq
agaric-mcp --token agt_… call search '{"space_id":"01HZ…","query":"plumber"}' | jq -r '.items[].content'
```

The tool's result is printed on stdout as one line of JSON, and the exit status is 0. A call the app refuses (an unknown tool, a write tool on a read-only agent's token, a bad argument, a revoked token) prints the app's message on stderr and exits 1, as does an app that is not running. Arguments that are not a JSON object, or a missing `--token`, exit 2 before connecting.

## What agents can do

The MCP surface is split into:

- **Read-only tools** (served to every agent): list pages, get page, read a page as Markdown, search, get block, list backlinks, list tags, list property definitions, get agenda, list spaces, fetch a journal page by date, page history, block history, get journal, list journal, list trash, resolve names, query, list attachments. One carve-out: `journal_for_date` **creates** the journal page if it doesn't exist yet and the date is near today — the only read-registry tool with a write side effect. A day it creates gets the space's journal template, as a day the journal creates does.
- **Read-write tools** (served to a read-write agent): append block, append markdown, update block content, set property, add tag, create page, delete block, move page to space, create tag, delete property, undo, capture, move blocks, remove tag, restore block, batch, edit page markdown, set page aliases, attach file, add meeting, plus every read-only tool. Move blocks reparents or reorders blocks in one call and one transaction, keeping their ids, so links to them and their history survive. Append markdown lands a whole piece of Markdown under a parent in one call and one undo, exactly as a paste in the app does: list items nest, `-` and `*` items become bulleted blocks and `1.` items numbered ones, a heading is a block of its own, `key:: value` lines become properties, a `- [ ]` task line's Obsidian Tasks fields (`📅`, `⏳`, `⏫` / `🔼` / `🔽`, `🔁 every …`, a done task's `✅`) its dates, priority, repeat rule and completion date, one it cannot read staying text with a warning, and a `[[Page]]` or `#tag` that matches nothing in the parent's space creates that page or tag there. It reads the blocks as `get_page_markdown` writes them, so blocks read from one page and appended under another land as the same blocks, under new ids.

What the page reads return:

- A block row leaves out its null fields: an unset `due_date`, `todo_state` or `parent_id`, and `deleted_at` on a live block.
- `get_block` returns the block's row plus `properties` (every property row, raw, `template` included), `tags` (tag ULIDs; `list_tags` maps them to names), its page's `page_title` and, for a page, `aliases`. `get_page` adds `properties`, `tags` and `aliases` to its `page`; its children are plain rows, without `page_title`, since `page.content` is that title. A block with none of them gets empty arrays. A block with files attached, `get_page`'s `page` and children included, also carries `attachments`, one `{ id, filename, mime_type }` each; a block without has no `attachments`.
- `list_attachments { space_id, block_id | page_id, cursor?, limit? }` lists the files attached to one block, or to a page and every live block on it, oldest first and cursor paginated, as `{ id, block_id, filename, mime_type, size_bytes, created_at, path }`. `path` is the file's absolute path under the app data directory, for the agent to read. The file is read-only: identical files attached twice share one file on disk, and an edit in place breaks the hash stored for it. To replace a file, attach a new one.
- `attach_file { space_id, block_id, path, filename? }` attaches a file on this device to a block, as attaching it in the app does: the same 50 MB cap and allowed types, identical bytes stored once, one undo, and the file syncs to your other devices. `path` is absolute; the file is copied in and the original is not touched. A directory, a symbolic link, a missing path or a file over the cap is refused before anything is read. `filename` defaults to the file's name, and its extension gives the type, one the app accepts: an image, audio, PDF, text or Markdown, JSON, zip or tar file (the tool's description lists the extensions). It returns the attachment as `list_attachments` lists it. A recording's transcript is a Markdown file named after it with `.transcript.md`, and its summary with `.summary.md`, each attached to the recording's block. A transcript has one paragraph per segment, `[hh:mm:ss] **Speaker:** text` (`[mm:ss]` works too, and the speaker is optional); clicking a timestamp in the app seeks the recording.
- `add_meeting { space_id, title?, date?, template?, page?, block_id?, audio_path?, transcript_path?, summary_markdown?, summary_path? }` adds a meeting in one call, as one undo. It makes the page `<title> <YYYY-MM-DD>` (*Meeting* by default, today by default), tagged `#meeting` with the `meeting_date` property, and links it at the end of that day's journal, creating the day if it is missing.
  - `template`, a template page of the space by id or title, is copied under the page with its variables read against the meeting's date and title. Its block reading `<% recording %>` becomes the recording block; without one, the recording block opens the page.
  - Every file is optional. The audio, the transcript (stored as `<name>.transcript.md`) and an attached summary (`<name>.summary.md`) go onto the recording block. `summary_markdown` is written as blocks just above the recording block instead, and is refused together with `summary_path`.
  - `page` or `block_id` adds the files to an existing meeting: a page's recording block is its first block holding a file. `title`, `date` and `template` are refused with them.
  - The paths are checked as `attach_file` checks them. A refused call writes nothing and stores no bytes.
- `list_pages { space_id, sort?, filters?, cursor?, limit? }` lists a space's pages as the Pages view does. `sort` is `alphabetical` (the default), `created` (newest first), `recently-modified`, `last-opened` (on this device), `most-linked` or `most-content`; `filters` are page predicates a page must all match: `Orphan`, `HasNoInboundLinks`, `Stub`, `Tag` / `TagOrRef`, `PathGlob`, `LastEdited`, `HasProperty`, `Priority`. Each row adds `last_modified_at`, `inbound_link_count` and `child_block_count`; the first page carries `total_count`. A cursor continues only the sort it came from.
- `search { query, space_id, parent_id?, tag_ids?, filter?, include_match_offsets?, cursor?, limit? }` matches each word as a case-insensitive substring and drops words under 3 characters; an empty `query` with a filter lists the matching blocks newest first. `parent_id` matches direct children only. A `tag_ids` tag matches a block that has it attached, written inline as `#tag`, or inherited from an ancestor such as its page. `filter.last_edited` takes `Rolling { days }`, `OlderThan { days }` or `Range { start, end }`. Each row carries its `page_title`, except a page, whose `content` is its title; `match_offsets` only when `include_match_offsets` is true.
- `query { space_id, where, sort?, group_by?, aggregate?, cursor?, limit? }` runs the advanced query engine (the app's query builder) over one space: `where` is its boolean tree of predicates (tags, properties, state, priority, due, scheduled, created and last-edited dates, links, parent), and `group_by` / `aggregate` bucket and count the matches. A row is the block with its page's title and the properties the query reads; a grouped query returns `{ key, title, count, aggregates }` groups instead. Template pages and the blocks on them are left out unless a `HasProperty` leaf on `template` asks for blocks that have it; a negated one (`NotExists`, `Ne`, or under `Not`) still leaves them out. Saved views are always left out. An unknown predicate, a malformed date or a `Between` range that ends before it starts is refused. Ids inside `where` are ULIDs, not names, and content is returned as stored, its ids not resolved to names.
- `get_page_markdown` returns `{ page_id, title, markdown, truncated, next_cursor }`: the page's title, and the page's Markdown exactly as the app's *Edit as Markdown* edits it, the text `edit_page_markdown` takes back. It opens with YAML front matter (aliases, tags, properties); the title has no line. Then come the blocks as a paste reads them, each with its `key:: value` properties (a value with a line break or surrounding spaces quoted): a plain block as a paragraph, or as a `+` item under another block, a bulleted block as a `-` item, a numbered one as `1.`, a task as `- [ ]`, its priority, dates and rule as Obsidian Tasks signifiers at the end of its line (`⏫ 🔁 every week 📅 2026-10-05`), children indented under their parent's text. A link, tag or ref-typed value is written as its name where that name reads back as the same page or tag in the page's space (a ref-typed value as `[[Title]]`), else as its ULID; a block reference as `[[Title#Heading]]` to a heading whose text no other heading of its page shares and holds no link or markup syntax or `:`, and that no ref-typed value or attachment addresses, else as `[[#^ULID]]` to a block of the page and `[[Title#^ULID]]` to another page's, where that reads back as the same block, else as `((ULID))`. Every block ends with its `^ULID`, the id `update_block_content` takes. Appended as it is with `append_markdown`, which drops the front matter a text opens with (with a warning), the read lands as the same blocks: a `[[#^ULID]]` reads as the live block of that id in the page's space wherever it is appended.
- A large read stops early: `get_page`, `list_backlinks` and `get_page_markdown` stop at a content budget per call (`RESPONSE_BYTES_CAP` in `src-tauri/src/mcp/tools_ro.rs`), cut at a block or group, with `truncated: true` and a `next_cursor`. Passing it back as `cursor` returns the rest from where the last call stopped, so no block is skipped; one block or group larger than the budget comes back whole.

Several writes at once:

- `batch { ops, space_id }` applies a list of writes in one transaction: one feed entry, one undo. Each op is `{ "op": <tool>, ... }`, one of `append_block`, `update_block_content`, `set_property`, `add_tag`, `remove_tag`, `move_blocks` or `delete_block`, with that tool's arguments less `space_id`. The ops run in order; if any is refused, nothing is written, and the error names the op as `ops[i]`. A batch that would write more operations than one undo reverts is refused.
- `move_page_to_space { page_id, space_id, target_space_id, acknowledge_property_loss? }` moves a page and its blocks to another space. Property definitions are per space, so the move removes each value whose key the target space does not define the same way (type and options) and that is not built in or undeclared in both. Such a move is refused until `acknowledge_property_loss` lists those keys with their counts, `{ "key": count }`; the refusal names them and gives the object to pass, and one that no longer matches is refused the same way. One undo of the move restores the values. A move that would remove more values than one undo reverts is refused, and so is a page whose title or alias the target space already holds, in any case.
- `edit_page_markdown { page_id, markdown, base, space_id }` saves a page edited as Markdown, exactly as the app's *Edit as Markdown* saves it: read it with `get_page_markdown`, every stretch of a truncated read, edit the text, and send it back with the text read as `base`. Blocks pair by their `^ULID`, and only what changed is written, so moving one block is one move. A page that changed since `base` is refused, so the agent reads it again.

Names in place of ids:

- Wherever a tool takes a page, tag or parent id (`parent_id`, `page_id`, `tag_id`, `tag_ids`), a value that is not a ULID is a name in the call's `space_id`: a page by title, ignoring case, else by alias, the oldest page (the lowest id) where several match; a tag by name, ignoring case. A name nothing has is refused with a validation error. Block ids stay ULIDs: blocks have no names. `get_page` and `get_page_markdown` take ids only.
- `append_block` and `update_block_content` write a `[[Name]]` or `#name` as the app's paste does: linked by id, creating the page or tag in the space when nothing matches; a name several pages share links the oldest of them. A page's title and a tag's name are kept as written. Logseq's `^^x^^` highlight, LaTeX's `\(x\)` and `\[x\]` math and Obsidian's `![[Note]]` embed are written in Agaric's form as a paste writes them ([import-export.md](import-export.md#import-settings--data)): content that is one `![[Note]]` is an embed of the page, one among text a link.
- `resolve { names, space_id }` looks up many names in one call and answers each with `page_id` and `tag_id` (null when nothing matches), the oldest page where several share the name.

The journal in one call:

- `capture { content, space_id, date? }` appends Markdown, read as append markdown reads it, at the end of the day's journal page, creating the day with the space's journal template first. The day and the blocks land together: one feed entry, one undo.
- `get_journal { space_id, date? }` returns `{ date, page_id, markdown }`, the day's whole Markdown as `get_page_markdown` reads it. It never creates the day: a missing day returns `page_id: null` and empty `markdown`.
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

The limit guards against an agent's mistakes; it is not isolation. Each of these shows at most a title, a block's first line or an id from a space the agent may not use, and only through a link or move you made or an id the agent writes:

1. `get_page_markdown` and `get_journal` write a link, tag, block reference or ref-typed value that points into another space with its target's id. A link, tag or block reference that `append_block`, `append_markdown`, `update_block_content`, `capture` or `batch` writes to another space's block is written as the text it shows, its target's title, name or first line, with a warning, and any other write of one is refused, so such a link comes from moving one of its pages.
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
| `agaric://settings/<tab>` | Open Settings to a specific tab (e.g. `agent`, `keyboard`, `data`). |
| `agaric://settings/safe-mode` | Turn custom CSS off and open Settings › Appearance ([appearance.md](appearance.md#custom-css)). |
| `agaric://capture?text=<text>` | Open Quick Capture holding the text. Nothing is saved until you press *Capture*. |

The OS handler is registered on app install. From a terminal: `open agaric://...` (macOS), `xdg-open` (Linux), `start` (Windows).

A page's kebab → *Copy app link* copies its `agaric://page/<id>` link, to paste into a calendar entry or a task manager.

The capture link takes one parameter, `text`, percent-encoded as `encodeURIComponent` writes it (`+` also reads as a space); other parameters are ignored. A bookmarklet that captures the page you are reading: `javascript:location.href='agaric://capture?text='+encodeURIComponent(document.title+' '+location.href)`. Without `text` Quick Capture opens empty. Newlines, `[[links]]` and `#tags` arrive as plain text, as if typed. If Quick Capture is already open, the text goes below what you typed. A text longer than a block can hold, or a malformed escape (a `%` not followed by two hex digits, or bytes that are not UTF-8), opens nothing; the first says so in a toast.

On **Android** no link opens the app yet: the scheme is not registered there (#6555).

## Pitfalls to know

- **MCP listens locally only.** It's never exposed over the network. Two computers can't share one Agaric's MCP — pair them via [sync.md](sync.md) instead.
- **An agent's spaces are a guard against mistakes, not isolation.** A link or a move can show it a title or an id from another space; see [What a limited agent can still see](#what-a-limited-agent-can-still-see).
- **Reverting a session is coarse, and bounded by the feed.** It reverts every agent op still in the 100-entry activity window — not a surgical subset, and not ops that have already scrolled out. Use the History view for either of those.
- **Reverting a session can be too large to run.** It sends every op of every action in one revert, which is capped at `MAX_REVERT_OPS` (`src-tauri/src/commands/history.rs`), so a session holding large `append_markdown` calls can exceed it. Undo those entries one by one instead.
- **The activity feed is bounded and in-memory.** It holds 100 entries and doesn't survive a restart. For a long-term record, the History view is the source of truth; it badges each agent op with the agent's name.
- **Quick Capture goes to the active space.** If you switch spaces and capture, it lands in the new space.
