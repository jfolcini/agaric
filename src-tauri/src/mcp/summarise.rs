//! Field-filtered one-line summaries per MCP tool, for the activity feed
//! .
//!
//! Each summariser takes the tool's parsed JSON `args` + structured
//! return `result` and produces a short string that the activity-feed
//! ring buffer / `mcp:activity` event surface render in the
//! Settings → Agent Access activity list. The dispatcher in
//! [`RmcpAdapter`](super::rmcp_adapter::RmcpAdapter)'s `ServerHandler::call_tool`
//! selects the
//! right summariser by tool name on success; tools without a registered
//! summariser fall through to the bare tool name (defensive default for
//! any tool added later without a summariser).
//!
//! # Field-filtering contract
//!
//! - **No block content.** The `content` field of `BlockRow`, the
//!   serialised page title, the literal text of a property `value_text`,
//!   and any tag display name are user content and must never appear in
//!   a summary.
//! - **Counts, tool names, dates, property keys, typed `number` / `date` /
//!   `bool` property values, and eight-character ULID/reference prefixes are
//!   allowed to appear.** Full identifier/reference values are never included;
//!   property keys are emitted verbatim as schema strings.
//! - **Ids come from the result.** A page, parent or tag argument may be a
//!   name (#5397), so a summariser reads the resolved id from the result, or
//!   an argument through `id_arg_prefix`.
//! - **Property keys are schema, not content.** A property key like
//!   `effort` or `due_date` is fine to include; the corresponding
//!   `value_text` is not.
//! - **Error summaries are unchanged.** The dispatcher still clips the
//!   `AppError` chain to 200 chars in the err branch — this module is
//!   only consulted for success.
//!
//! Every summariser is robust against missing / malformed JSON (e.g.
//! result `Value::Null` from a test stub registry): on any extraction
//! failure it falls back to the bare tool name. The dispatcher's
//! "default to `name.clone()`" path therefore never has to guard against
//! a panic from this module.

use agaric_core::ulid::BlockId;
use serde_json::Value;

use super::registry::{
    TOOL_ADD_TAG, TOOL_APPEND_BLOCK, TOOL_APPEND_MARKDOWN, TOOL_BATCH, TOOL_BLOCK_HISTORY,
    TOOL_CAPTURE, TOOL_CREATE_PAGE, TOOL_CREATE_TAG, TOOL_DELETE_BLOCK, TOOL_DELETE_PROPERTY,
    TOOL_EDIT_PAGE_MARKDOWN, TOOL_GET_AGENDA, TOOL_GET_BLOCK, TOOL_GET_JOURNAL, TOOL_GET_PAGE,
    TOOL_GET_PAGE_MARKDOWN, TOOL_JOURNAL_FOR_DATE, TOOL_LIST_BACKLINKS, TOOL_LIST_JOURNAL,
    TOOL_LIST_PAGES, TOOL_LIST_PROPERTY_DEFS, TOOL_LIST_SPACES, TOOL_LIST_TAGS, TOOL_LIST_TRASH,
    TOOL_MOVE_BLOCKS, TOOL_MOVE_PAGE_TO_SPACE, TOOL_PAGE_HISTORY, TOOL_QUERY, TOOL_REMOVE_TAG,
    TOOL_RESOLVE, TOOL_RESTORE_BLOCK, TOOL_SEARCH, TOOL_SET_PAGE_ALIASES, TOOL_SET_PROPERTY,
    TOOL_UNDO, TOOL_UPDATE_BLOCK_CONTENT,
};

/// Number of leading characters of a ULID we expose in summary strings.
/// 8 chars is enough to be visually distinguishable in a feed but short
/// enough that the user does not memorise the full id from the feed
/// alone.
const ULID_PREFIX_LEN: usize = 8;

/// Take the leading [`ULID_PREFIX_LEN`] Unicode scalars of `id`. Safe on
/// short strings (returns the whole input) and on multi-byte chars.
fn ulid_prefix(id: &str) -> String {
    id.chars().take(ULID_PREFIX_LEN).collect()
}

/// [`ulid_prefix`] of `args[key]` when it is a ULID, else empty: since #5397 a
/// page, parent or tag argument may be a title or tag name.
fn id_arg_prefix(args: &Value, key: &str) -> String {
    str_field(args, key)
        .filter(|arg| BlockId::from_string(*arg).is_ok())
        .map_or_else(String::new, ulid_prefix)
}

/// Borrow `result[key]` as a string.
fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// Length of `result[key]` interpreted as a JSON array.
fn array_len(v: &Value, key: &str) -> Option<usize> {
    v.get(key).and_then(Value::as_array).map(Vec::len)
}

/// Length of `result` interpreted as a top-level JSON array.
fn root_array_len(v: &Value) -> usize {
    v.as_array().map_or(0, Vec::len)
}

/// `result["has_more"]` as a bool, defaulting to false.
fn has_more(v: &Value) -> bool {
    v.get("has_more").and_then(Value::as_bool).unwrap_or(false)
}

/// Top-level dispatch: select the right per-tool summariser for `name`.
/// Falls back to the bare tool name when no summariser is registered.
///
/// Always called from [`RmcpAdapter`](super::rmcp_adapter::RmcpAdapter)'s
/// `ServerHandler::call_tool`
/// on the **Ok** branch; the Err branch keeps using the clipped error message and
/// does not invoke this module.
pub fn summarise(name: &str, args: &Value, result: &Value) -> String {
    match name {
        // ---- read-only (tools_ro) ----
        TOOL_LIST_PAGES => summarise_list_pages(args, result),
        TOOL_GET_PAGE => summarise_get_page(args, result),
        TOOL_SEARCH => summarise_search(args, result),
        TOOL_GET_BLOCK => summarise_get_block(args, result),
        TOOL_LIST_BACKLINKS => summarise_list_backlinks(args, result),
        TOOL_LIST_TAGS => summarise_list_tags(args, result),
        TOOL_LIST_PROPERTY_DEFS => summarise_list_property_defs(args, result),
        TOOL_GET_AGENDA => summarise_get_agenda(args, result),
        TOOL_JOURNAL_FOR_DATE => summarise_journal_for_date(args, result),
        TOOL_LIST_SPACES => summarise_list_spaces(args, result),
        TOOL_GET_PAGE_MARKDOWN => summarise_get_page_markdown(args, result),
        TOOL_PAGE_HISTORY => summarise_history(TOOL_PAGE_HISTORY, "page_id", args, result),
        TOOL_BLOCK_HISTORY => summarise_history(TOOL_BLOCK_HISTORY, "block_id", args, result),
        TOOL_GET_JOURNAL => summarise_get_journal(args, result),
        TOOL_LIST_JOURNAL => summarise_list_journal(args, result),
        TOOL_LIST_TRASH => summarise_list_trash(args, result),
        TOOL_RESOLVE => summarise_resolve(args, result),
        TOOL_QUERY => summarise_query(args, result),
        // ---- read-write (tools_rw) ----
        TOOL_APPEND_BLOCK => summarise_append_block(args, result),
        TOOL_APPEND_MARKDOWN => summarise_append_markdown(args, result),
        TOOL_UPDATE_BLOCK_CONTENT => summarise_update_block_content(args, result),
        TOOL_SET_PROPERTY => summarise_set_property(args, result),
        TOOL_ADD_TAG => summarise_add_tag(args, result),
        TOOL_CREATE_PAGE => summarise_create_page(args, result),
        TOOL_DELETE_BLOCK => summarise_delete_block(args, result),
        TOOL_MOVE_PAGE_TO_SPACE => summarise_move_page_to_space(args, result),
        TOOL_CREATE_TAG => summarise_create_tag(args, result),
        TOOL_DELETE_PROPERTY => summarise_delete_property(args, result),
        TOOL_UNDO => summarise_undo(args, result),
        TOOL_CAPTURE => summarise_capture(args, result),
        TOOL_MOVE_BLOCKS => summarise_move_blocks(args, result),
        TOOL_REMOVE_TAG => summarise_remove_tag(args, result),
        TOOL_RESTORE_BLOCK => summarise_restore_block(args, result),
        TOOL_BATCH => summarise_batch(args, result),
        TOOL_EDIT_PAGE_MARKDOWN => summarise_edit_page_markdown(args, result),
        TOOL_SET_PAGE_ALIASES => summarise_set_page_aliases(args, result),
        // Defensive default — keeps the activity feed working when
        // someone adds a new tool without a summariser. This is the
        // pre-existing behaviour for every entry. The privacy
        // guard test in this module asserts every registered MCP tool
        // has a non-fallback summariser arm above; if you add a tool
        // without one the test fails in CI.
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Read-only summarisers
// ---------------------------------------------------------------------------

/// `list_pages — N page(s)` (`(more)` if `has_more`).
pub fn summarise_list_pages(_args: &Value, result: &Value) -> String {
    let n = array_len(result, "items").unwrap_or(0);
    let suffix = if has_more(result) { " (more)" } else { "" };
    format!(
        "list_pages — {n} {}{suffix}",
        if n == 1 { "page" } else { "pages" }
    )
}

/// `get_page — <id-prefix> (N children)` (`(more)` if `has_more`).
pub fn summarise_get_page(_args: &Value, result: &Value) -> String {
    let id = result
        .get("page")
        .and_then(|p| p.get("id"))
        .and_then(|i| i.as_str())
        .unwrap_or("");
    let prefix = ulid_prefix(id);
    let n = array_len(result, "children").unwrap_or(0);
    let suffix = if has_more(result) { " (more)" } else { "" };
    if prefix.is_empty() {
        format!(
            "get_page — {n} {}{suffix}",
            if n == 1 { "child" } else { "children" }
        )
    } else {
        format!(
            "get_page — {prefix} ({n} {}{suffix})",
            if n == 1 { "child" } else { "children" }
        )
    }
}

/// `search — N match(es)` (`(more)` if `has_more`). Never includes the
/// query string — query is user input and counts as content.
pub fn summarise_search(_args: &Value, result: &Value) -> String {
    let n = array_len(result, "items").unwrap_or(0);
    let suffix = if has_more(result) { " (more)" } else { "" };
    format!(
        "search — {n} {}{suffix}",
        if n == 1 { "match" } else { "matches" }
    )
}

/// `get_block — <id-prefix>`. Never includes the block's `content`.
pub fn summarise_get_block(_args: &Value, result: &Value) -> String {
    let id = str_field(result, "id").unwrap_or("");
    let prefix = ulid_prefix(id);
    if prefix.is_empty() {
        "get_block".to_string()
    } else {
        format!("get_block — {prefix}")
    }
}

/// `list_backlinks — N inbound on <id-prefix>`. The block id comes from
/// the request `args` (the result envelope does not echo it).
pub fn summarise_list_backlinks(args: &Value, result: &Value) -> String {
    let block_id = str_field(args, "block_id").unwrap_or("");
    let prefix = ulid_prefix(block_id);
    // #2201 item 1b: the backend now runs the grouped COUNT queries on the
    // FIRST page only and returns `total_count: 0` on later pages (the FE
    // keeps the first page's total for the header). So `total_count` is only
    // meaningful on the first page; on a paginated call it is 0 even though the
    // page still carries groups/blocks. Treat a present-but-zero `total_count`
    // the same as an absent one — `filter(|&t| t > 0)` drops it — so we fall
    // back to the group-derived block count and report THIS page's inbound
    // count instead of a misleading "0 inbound". A genuinely empty first page
    // has no groups, so the fallback still yields 0 (empty case stays correct).
    let n = result
        .get("total_count")
        .and_then(Value::as_u64)
        .map(|u| usize::try_from(u).unwrap_or(usize::MAX))
        .filter(|&t| t > 0)
        .or_else(|| {
            // Fallback for stub registries that return a different
            // shape (or a paginated non-first page whose `total_count` is
            // 0 per the gating above): count blocks across groups.
            result
                .get("groups")
                .and_then(Value::as_array)
                .map(|groups| {
                    groups
                        .iter()
                        .filter_map(|g| g.get("blocks").and_then(Value::as_array))
                        .map(Vec::len)
                        .sum()
                })
        })
        .unwrap_or(0);
    if prefix.is_empty() {
        format!("list_backlinks — {n} inbound")
    } else {
        format!("list_backlinks — {n} inbound on {prefix}")
    }
}

/// `list_tags — N tag(s)`. Never includes tag display names — those are
/// user-authored content even though the tag id is structural.
///
/// `list_tags_inner` is now cursor-paginated, so the result is a
/// `PageResponse { items, next_cursor, has_more }` rather than a
/// top-level array. Count via `array_len(result, "items")`, with a
/// fall-back to the legacy top-level array shape so unit-test fixtures
/// that hand-author flat arrays continue to summarise.
pub fn summarise_list_tags(_args: &Value, result: &Value) -> String {
    let n = array_len(result, "items").unwrap_or_else(|| root_array_len(result));
    format!("list_tags — {n} {}", if n == 1 { "tag" } else { "tags" })
}

/// `list_trash — N block(s)` (`(more)` if `has_more`).
pub fn summarise_list_trash(_args: &Value, result: &Value) -> String {
    let n = array_len(result, "items").unwrap_or(0);
    let suffix = if has_more(result) { " (more)" } else { "" };
    format!(
        "list_trash — {n} {}{suffix}",
        if n == 1 { "block" } else { "blocks" }
    )
}

/// `resolve — N name(s), M matched` (#5397). Never the names, which are page
/// titles and tag names.
pub fn summarise_resolve(_args: &Value, result: &Value) -> String {
    let answers = result.as_array().map_or(&[][..], Vec::as_slice);
    let matched = answers
        .iter()
        .filter(|a| !a["page_id"].is_null() || !a["tag_id"].is_null())
        .count();
    let n = answers.len();
    format!(
        "resolve — {n} {}, {matched} matched",
        if n == 1 { "name" } else { "names" }
    )
}

/// `query — N row(s)`, or `N group(s)` for a grouped query (`(more)` if
/// `has_more`). Never includes the predicates, which carry user text.
pub fn summarise_query(_args: &Value, result: &Value) -> String {
    let groups = array_len(result, "groups").unwrap_or(0);
    let (n, one, many) = if groups > 0 {
        (groups, "group", "groups")
    } else {
        (array_len(result, "rows").unwrap_or(0), "row", "rows")
    };
    let suffix = if has_more(result) { " (more)" } else { "" };
    format!("query — {n} {}{suffix}", if n == 1 { one } else { many })
}

/// `list_property_defs — N def(s)`. The keys themselves are schema and
/// would be safe to include, but we keep the summary terse and just
/// surface the count.
///
/// `list_property_defs_inner` is now cursor-paginated, so the
/// result is a `PageResponse { items, next_cursor, has_more }` rather
/// than a top-level array. Count via `array_len(result, "items")`, with
/// a fall-back to the legacy top-level array shape so unit-test
/// fixtures that hand-author flat arrays continue to summarise.
pub fn summarise_list_property_defs(_args: &Value, result: &Value) -> String {
    let n = array_len(result, "items").unwrap_or_else(|| root_array_len(result));
    format!(
        "list_property_defs — {n} {}",
        if n == 1 { "def" } else { "defs" }
    )
}

/// `get_agenda — N entr(y|ies) (start..end)`. Dates are not user
/// content; entry counts are structural.
///
/// `agenda_range_inner` is cursor-paginated, so the
/// result is a `PageResponse { items, next_cursor, has_more }` rather
/// than a top-level array. Count via `array_len(result, "items")`.
pub fn summarise_get_agenda(args: &Value, result: &Value) -> String {
    let n = array_len(result, "items").unwrap_or_else(|| root_array_len(result));
    let start = str_field(args, "start_date").unwrap_or("");
    let end = str_field(args, "end_date").unwrap_or("");
    let entry_word = if n == 1 { "entry" } else { "entries" };
    if start.is_empty() && end.is_empty() {
        format!("get_agenda — {n} {entry_word}")
    } else {
        format!("get_agenda — {n} {entry_word} ({start}..{end})")
    }
}

/// `journal_for_date — <date> → <id-prefix>`. The date is metadata, the
/// page id is a ULID prefix; neither is content.
pub fn summarise_journal_for_date(args: &Value, result: &Value) -> String {
    let date = str_field(args, "date").unwrap_or("");
    let id = str_field(result, "id").unwrap_or("");
    let prefix = ulid_prefix(id);
    match (date.is_empty(), prefix.is_empty()) {
        (false, false) => format!("journal_for_date — {date} → {prefix}"),
        (false, true) => format!("journal_for_date — {date}"),
        (true, false) => format!("journal_for_date — {prefix}"),
        (true, true) => "journal_for_date".to_string(),
    }
}

/// `list_spaces — N space(s)` (#633). Space names are user-authored
/// content (like tag names) and never appear in the summary; the
/// response is a top-level JSON array, so count via `root_array_len`.
pub fn summarise_list_spaces(_args: &Value, result: &Value) -> String {
    let n = root_array_len(result);
    format!(
        "list_spaces — {n} {}",
        if n == 1 { "space" } else { "spaces" }
    )
}

/// `get_page_markdown — <id-prefix> (N lines)` (#5375). Never includes the
/// markdown, which is the page's content.
pub fn summarise_get_page_markdown(_args: &Value, result: &Value) -> String {
    let prefix = ulid_prefix(str_field(result, "page_id").unwrap_or(""));
    let n = str_field(result, "markdown").map_or(0, |md| md.lines().count());
    let lines = if n == 1 { "line" } else { "lines" };
    if prefix.is_empty() {
        format!("get_page_markdown — {n} {lines}")
    } else {
        format!("get_page_markdown — {prefix} ({n} {lines})")
    }
}

/// `page_history — N op(s) on <id-prefix>` (`(more)` if `has_more`), and the
/// same for `block_history`. Never the rows' before / after text.
pub fn summarise_history(tool: &str, id_key: &str, args: &Value, result: &Value) -> String {
    let prefix = id_arg_prefix(args, id_key);
    let n = array_len(result, "items").unwrap_or(0);
    let ops = if n == 1 { "op" } else { "ops" };
    let suffix = if has_more(result) { " (more)" } else { "" };
    if prefix.is_empty() {
        format!("{tool} — {n} {ops}{suffix}")
    } else {
        format!("{tool} — {n} {ops} on {prefix}{suffix}")
    }
}

/// `get_journal — <date> (N lines)`, or `(no page)` for a missing day
/// (#5396). The date is the argument as given; never the markdown.
pub fn summarise_get_journal(args: &Value, result: &Value) -> String {
    let date = str_field(args, "date").unwrap_or("today");
    match str_field(result, "markdown").filter(|md| !md.is_empty()) {
        Some(md) => {
            let n = md.lines().count();
            format!(
                "get_journal — {date} ({n} {})",
                if n == 1 { "line" } else { "lines" }
            )
        }
        None => format!("get_journal — {date} (no page)"),
    }
}

/// `list_journal — N day(s) (from..to)` (`(more)` if `has_more`) (#5396).
pub fn summarise_list_journal(args: &Value, result: &Value) -> String {
    let n = array_len(result, "items").unwrap_or(0);
    let from = str_field(args, "from").unwrap_or("");
    let to = str_field(args, "to").unwrap_or("");
    let suffix = if has_more(result) { " (more)" } else { "" };
    format!(
        "list_journal — {n} {} ({from}..{to}){suffix}",
        if n == 1 { "day" } else { "days" }
    )
}

// ---------------------------------------------------------------------------
// Read-write summarisers
// ---------------------------------------------------------------------------

/// `append_block — added <id-prefix> under <parent-prefix>`. Never
/// embeds the new block's `content`.
pub fn summarise_append_block(_args: &Value, result: &Value) -> String {
    let parent = str_field(result, "parent_id").unwrap_or("");
    let parent_prefix = ulid_prefix(parent);
    let id = str_field(result, "id").unwrap_or("");
    let id_prefix = ulid_prefix(id);
    match (id_prefix.is_empty(), parent_prefix.is_empty()) {
        (false, false) => format!("append_block — added {id_prefix} under {parent_prefix}"),
        (false, true) => format!("append_block — added {id_prefix}"),
        (true, false) => format!("append_block — added under {parent_prefix}"),
        (true, true) => "append_block".to_string(),
    }
}

/// `append_markdown — N block(s) under <parent-prefix>`, with the pages and
/// tags its names created counted. Never embeds the markdown, a block's
/// content, a created page's or tag's name, or a warning (which names them).
pub fn summarise_append_markdown(args: &Value, result: &Value) -> String {
    let parent_prefix = id_arg_prefix(args, "parent_id");
    let place = if parent_prefix.is_empty() {
        String::new()
    } else {
        format!(" under {parent_prefix}")
    };
    summarise_markdown_append(TOOL_APPEND_MARKDOWN, &place, result)
}

/// `capture — N block(s) on <date>` (#5396), counted as `append_markdown`
/// counts. The date is the argument as given.
pub fn summarise_capture(args: &Value, result: &Value) -> String {
    let date = str_field(args, "date").unwrap_or("today");
    summarise_markdown_append(TOOL_CAPTURE, &format!(" on {date}"), result)
}

/// `<tool> — N block(s)<place>`, then the pages and tags created, from the
/// `blocks` rows a Markdown append returns.
fn summarise_markdown_append(tool: &str, place: &str, result: &Value) -> String {
    let rows = result
        .get("blocks")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let count = |kind: &str| {
        rows.iter()
            .filter(|row| str_field(row, "block_type") == Some(kind))
            .count()
    };
    let plural =
        |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let mut summary = format!(
        "{tool} — {}{place}",
        plural(count("content"), "block", "blocks")
    );
    let (pages, tags) = (count("page"), count("tag"));
    if pages + tags > 0 {
        summary.push_str(&format!(
            " (created {}, {})",
            plural(pages, "page", "pages"),
            plural(tags, "tag", "tags")
        ));
    }
    summary
}

/// `update_block_content — updated <id-prefix>`. Never embeds the new
/// or old text.
pub fn summarise_update_block_content(_args: &Value, result: &Value) -> String {
    let id = str_field(result, "id").unwrap_or("");
    let prefix = ulid_prefix(id);
    if prefix.is_empty() {
        "update_block_content".to_string()
    } else {
        format!("update_block_content — updated {prefix}")
    }
}

/// `set_property — set <key> on <block-prefix>` for `text` types
/// (the text value is content) — but `set <key>=<value> on <block-prefix>`
/// for `number` / `date` / `bool` / `ref` types where the value is structural
/// (numbers, ISO dates, booleans, and ULIDs respectively). For `ref` we prefix
/// the ULID just like every other id.
pub fn summarise_set_property(args: &Value, _result: &Value) -> String {
    let block_id = str_field(args, "block_id").unwrap_or("");
    let block_prefix = ulid_prefix(block_id);
    let key = str_field(args, "key").unwrap_or("");
    // Determine which typed value (if any) was supplied. Per privacy
    // invariants, `value_text` is content and is never embedded; the
    // others are structural and may be.
    let value_part: Option<String> = if let Some(n) = args.get("value_num").and_then(Value::as_f64)
    {
        // `{n}` formats integers without a decimal and floats with one;
        // either way the value is a number, not user-authored prose.
        Some(format!("={n}"))
    } else if let Some(date) = args.get("value_date").and_then(Value::as_str) {
        Some(format!("={date}"))
    } else if let Some(b) = args.get("value_bool").and_then(Value::as_bool) {
        // #697 — booleans are included by the field-filtering contract.
        Some(format!("={b}"))
    } else {
        // `value_text` is content (never embedded); `value_ref` (when
        // present) is a ULID we surface as an 8-char prefix.
        args.get("value_ref")
            .and_then(Value::as_str)
            .map(|ref_id| format!("={}", ulid_prefix(ref_id)))
    };
    let key_part = if key.is_empty() {
        String::new()
    } else {
        key.to_string()
    };
    let target = if block_prefix.is_empty() {
        String::new()
    } else {
        format!(" on {block_prefix}")
    };
    match (key_part.is_empty(), value_part) {
        (false, Some(vp)) => format!("set_property — set {key_part}{vp}{target}"),
        (false, None) => format!("set_property — set {key_part}{target}"),
        (true, _) => {
            if target.is_empty() {
                "set_property".to_string()
            } else {
                format!("set_property —{target}")
            }
        }
    }
}

/// `add_tag — applied <tag-prefix> to <block-prefix>`. ULIDs only — the
/// tag's display name is user content.
pub fn summarise_add_tag(_args: &Value, result: &Value) -> String {
    let block_id = str_field(result, "block_id").unwrap_or("");
    let tag_id = str_field(result, "tag_id").unwrap_or("");
    let block_prefix = ulid_prefix(block_id);
    let tag_prefix = ulid_prefix(tag_id);
    match (tag_prefix.is_empty(), block_prefix.is_empty()) {
        (false, false) => format!("add_tag — applied {tag_prefix} to {block_prefix}"),
        (false, true) => format!("add_tag — applied {tag_prefix}"),
        (true, false) => format!("add_tag — to {block_prefix}"),
        (true, true) => "add_tag".to_string(),
    }
}

/// `create_page — created <id-prefix>`. Never embeds the page title —
/// the title is user content.
pub fn summarise_create_page(_args: &Value, result: &Value) -> String {
    let id = str_field(result, "id").unwrap_or("");
    let prefix = ulid_prefix(id);
    if prefix.is_empty() {
        "create_page".to_string()
    } else {
        format!("create_page — created {prefix}")
    }
}

/// `delete_block — deleted <id-prefix> (N descendants)`. The descendant
/// count comes from the structured `DeleteResponse` envelope.
pub fn summarise_delete_block(args: &Value, result: &Value) -> String {
    let id = str_field(args, "block_id").unwrap_or("");
    let prefix = ulid_prefix(id);
    let descendants = result
        .get("descendants_affected")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let descendant_word = if descendants == 1 {
        "descendant"
    } else {
        "descendants"
    };
    if prefix.is_empty() {
        format!("delete_block — {descendants} {descendant_word}")
    } else {
        format!("delete_block — deleted {prefix} ({descendants} {descendant_word})")
    }
}

/// `move_page_to_space — moved <page-prefix> to <space-prefix>`.
pub fn summarise_move_page_to_space(args: &Value, result: &Value) -> String {
    let page = ulid_prefix(str_field(result, "page_id").unwrap_or(""));
    let target = ulid_prefix(str_field(args, "target_space_id").unwrap_or(""));
    match (page.is_empty(), target.is_empty()) {
        (false, false) => format!("move_page_to_space — moved {page} to {target}"),
        (false, true) => format!("move_page_to_space — moved {page}"),
        (true, false) => format!("move_page_to_space — to {target}"),
        (true, true) => "move_page_to_space".to_string(),
    }
}

/// `create_tag — created <id-prefix>`. Never embeds the tag name — it is
/// user content.
pub fn summarise_create_tag(_args: &Value, result: &Value) -> String {
    let prefix = ulid_prefix(str_field(result, "id").unwrap_or(""));
    if prefix.is_empty() {
        "create_tag".to_string()
    } else {
        format!("create_tag — created {prefix}")
    }
}

/// `delete_property — deleted <key> on <block-prefix>`. The key is schema.
pub fn summarise_delete_property(args: &Value, _result: &Value) -> String {
    let key = str_field(args, "key").unwrap_or("");
    let block = ulid_prefix(str_field(args, "block_id").unwrap_or(""));
    match (key.is_empty(), block.is_empty()) {
        (false, false) => format!("delete_property — deleted {key} on {block}"),
        (false, true) => format!("delete_property — deleted {key}"),
        (true, false) => format!("delete_property — on {block}"),
        (true, true) => "delete_property".to_string(),
    }
}

/// `set_page_aliases — <page-prefix>: N alias(es)`. Never the alias text — it
/// is user content.
pub fn summarise_set_page_aliases(_args: &Value, result: &Value) -> String {
    let page = ulid_prefix(str_field(result, "page_id").unwrap_or(""));
    let n = array_len(result, "aliases").unwrap_or(0);
    let word = if n == 1 { "alias" } else { "aliases" };
    if page.is_empty() {
        format!("set_page_aliases — {n} {word}")
    } else {
        format!("set_page_aliases — {page}: {n} {word}")
    }
}

/// `undo — reverted N op(s)`.
pub fn summarise_undo(_args: &Value, result: &Value) -> String {
    let n = array_len(result, "undone").unwrap_or(0);
    format!("undo — reverted {n} {}", if n == 1 { "op" } else { "ops" })
}

/// `move_blocks — moved N block(s) under <parent-prefix>`.
pub fn summarise_move_blocks(_args: &Value, result: &Value) -> String {
    let n = array_len(result, "moves").unwrap_or(0);
    let parent = ulid_prefix(
        result
            .pointer("/moves/0/new_parent_id")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let noun = if n == 1 { "block" } else { "blocks" };
    if parent.is_empty() {
        format!("move_blocks — moved {n} {noun}")
    } else {
        format!("move_blocks — moved {n} {noun} under {parent}")
    }
}

/// `remove_tag — removed <tag-prefix> from <block-prefix>`.
pub fn summarise_remove_tag(_args: &Value, result: &Value) -> String {
    let block = ulid_prefix(str_field(result, "block_id").unwrap_or(""));
    let tag = ulid_prefix(str_field(result, "tag_id").unwrap_or(""));
    match (tag.is_empty(), block.is_empty()) {
        (false, false) => format!("remove_tag — removed {tag} from {block}"),
        (false, true) => format!("remove_tag — removed {tag}"),
        (true, false) => format!("remove_tag — from {block}"),
        (true, true) => "remove_tag".to_string(),
    }
}

/// `restore_block — restored <block-prefix> (N block(s))`.
pub fn summarise_restore_block(args: &Value, result: &Value) -> String {
    let block = ulid_prefix(str_field(args, "block_id").unwrap_or(""));
    let n = result
        .get("restored_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let noun = if n == 1 { "block" } else { "blocks" };
    if block.is_empty() {
        format!("restore_block — {n} {noun}")
    } else {
        format!("restore_block — restored {block} ({n} {noun})")
    }
}

/// `batch — N op(s) (k <tool>, …)`, the ops counted by the write tool each
/// names, in first-seen order: a batch with any other `op` is refused, so a
/// summarised one names only tools.
pub fn summarise_batch(args: &Value, _result: &Value) -> String {
    let ops = args.get("ops").and_then(Value::as_array);
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for tool in ops
        .into_iter()
        .flatten()
        .filter_map(|op| str_field(op, "op"))
    {
        match counts.iter_mut().find(|(seen, _)| *seen == tool) {
            Some((_, n)) => *n += 1,
            None => counts.push((tool, 1)),
        }
    }
    let n = ops.map_or(0, Vec::len);
    let noun = if n == 1 { "op" } else { "ops" };
    if counts.is_empty() {
        return format!("batch — {n} {noun}");
    }
    let tools: Vec<String> = counts.iter().map(|(t, k)| format!("{k} {t}")).collect();
    format!("batch — {n} {noun} ({})", tools.join(", "))
}

/// `edit_page_markdown — <page-prefix>: N created, …`, the save's non-zero
/// counts, or `no change`.
pub fn summarise_edit_page_markdown(_args: &Value, result: &Value) -> String {
    let page = ulid_prefix(str_field(result, "page_id").unwrap_or(""));
    let changes: Vec<String> = [
        ("created", "created", "created"),
        ("edited", "edited", "edited"),
        ("moved", "moved", "moved"),
        ("deleted", "deleted", "deleted"),
        ("properties_set", "property set", "properties set"),
        (
            "properties_deleted",
            "property deleted",
            "properties deleted",
        ),
    ]
    .into_iter()
    .filter_map(|(key, one, many)| {
        let n = result.get(key).and_then(Value::as_u64).filter(|n| *n > 0)?;
        Some(format!("{n} {}", if n == 1 { one } else { many }))
    })
    .collect();
    let changes = if changes.is_empty() {
        "no change".to_owned()
    } else {
        changes.join(", ")
    };
    format!("edit_page_markdown — {page}: {changes}")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A representative full ULID used across tests so the prefix-len
    // assertion (`<= ULID_PREFIX_LEN`) actually exercises truncation.
    const ULID_A: &str = "01HZTESTBLOCK0000000000001A";
    const ULID_B: &str = "01HZTESTPARENT00000000000B";
    const ULID_TAG: &str = "01HZTESTTAG0000000000000T";
    const ULID_REF: &str = "01HZTESTREF0000000000000R";

    /// Block content / property text values that, if they leaked into a
    /// summary, would prove the privacy invariant is broken. Each
    /// summariser test passes one of these (or a fragment) as the
    /// would-be content and asserts it is absent from the output.
    const SECRETS: &[&str] = &[
        "SECRET_BLOCK_CONTENT",
        "SECRET_TITLE",
        "SECRET_TEXT_VALUE",
        "SECRET_TAG_NAME",
        "SECRET_QUERY",
        "SECRET_ALIAS",
    ];

    /// Checks each secret's first [`ULID_PREFIX_LEN`] characters: a name
    /// passed where an id goes (#5397) leaks as its prefix.
    fn assert_no_secrets(summary: &str) {
        for s in SECRETS {
            assert!(
                !summary.contains(&ulid_prefix(s)),
                "summary {summary:?} leaked secret {s:?}",
            );
        }
    }

    fn assert_no_full_ulid(summary: &str, full: &str) {
        // The full ULID never appears verbatim — only the 8-char prefix.
        assert!(
            !summary.contains(full),
            "summary {summary:?} embedded the full ULID {full:?} instead of the {ULID_PREFIX_LEN}-char prefix",
        );
        // The 8-char prefix should appear when the summariser embeds an id.
        let prefix: String = full.chars().take(ULID_PREFIX_LEN).collect();
        if summary.contains(&prefix[..1]) {
            // best-effort: the prefix is short and not exclusive enough to
            // assert it always appears, so skip the positive check here.
            let _ = prefix;
        }
    }

    // -----------------------------------------------------------------
    // ulid_prefix helper
    // -----------------------------------------------------------------

    #[test]
    fn ulid_prefix_truncates_to_eight_chars() {
        assert_eq!(ulid_prefix(ULID_A).chars().count(), ULID_PREFIX_LEN);
        assert_eq!(ulid_prefix(ULID_A), &ULID_A[..ULID_PREFIX_LEN]);
    }

    #[test]
    fn ulid_prefix_handles_short_strings() {
        assert_eq!(ulid_prefix("ABC"), "ABC");
        assert_eq!(ulid_prefix(""), "");
    }

    // -----------------------------------------------------------------
    // dispatch fallback
    // -----------------------------------------------------------------

    #[test]
    fn summarise_unknown_tool_falls_back_to_bare_name() {
        let s = summarise("tool_not_in_registry", &json!({}), &json!(null));
        assert_eq!(s, "tool_not_in_registry");
    }

    // -----------------------------------------------------------------
    // RO summarisers
    // -----------------------------------------------------------------

    #[test]
    fn list_pages_counts_pages_and_pluralises() {
        let result = json!({
            "items": [
                { "id": ULID_A, "content": "SECRET_BLOCK_CONTENT" },
                { "id": ULID_B, "content": "SECRET_TITLE" }
            ],
            "next_cursor": null,
            "has_more": false,
        });
        let s = summarise_list_pages(&json!({}), &result);
        assert_eq!(s, "list_pages — 2 pages");
        assert_no_secrets(&s);
        assert_no_full_ulid(&s, ULID_A);
    }

    #[test]
    fn list_pages_singular_form_for_one_page() {
        let result = json!({ "items": [{ "id": ULID_A }], "has_more": false });
        let s = summarise_list_pages(&json!({}), &result);
        assert_eq!(s, "list_pages — 1 page");
    }

    #[test]
    fn list_pages_appends_more_marker_when_paged() {
        let result = json!({ "items": [{}, {}, {}], "has_more": true });
        let s = summarise_list_pages(&json!({}), &result);
        assert_eq!(s, "list_pages — 3 pages (more)");
    }

    #[test]
    fn list_pages_robust_to_missing_items() {
        let s = summarise_list_pages(&json!({}), &json!({}));
        assert_eq!(s, "list_pages — 0 pages");
    }

    #[test]
    fn get_page_includes_prefix_and_child_count() {
        let result = json!({
            "page": { "id": ULID_A, "content": "SECRET_TITLE" },
            "children": [
                { "id": ULID_B, "content": "SECRET_BLOCK_CONTENT" }
            ],
            "has_more": false,
        });
        let s = summarise_get_page(&json!({"page_id": ULID_A}), &result);
        assert!(s.starts_with("get_page — "));
        assert!(s.contains(&ULID_A[..ULID_PREFIX_LEN]));
        assert!(s.contains("1 child"));
        assert_no_secrets(&s);
        assert_no_full_ulid(&s, ULID_A);
    }

    #[test]
    fn get_page_marks_more_when_paged() {
        let result = json!({
            "page": { "id": ULID_A },
            "children": [{}, {}, {}],
            "has_more": true,
        });
        let s = summarise_get_page(&json!({}), &result);
        assert!(s.contains("3 children"));
        assert!(s.contains("(more)"));
    }

    #[test]
    fn search_counts_matches_and_never_echoes_query() {
        let args = json!({ "query": "SECRET_QUERY" });
        let result = json!({
            "items": [
                { "id": ULID_A, "content": "SECRET_BLOCK_CONTENT" }
            ],
            "has_more": true,
        });
        let s = summarise_search(&args, &result);
        assert_eq!(s, "search — 1 match (more)");
        assert_no_secrets(&s);
    }

    #[test]
    fn search_pluralises_matches() {
        let result = json!({ "items": [{}, {}], "has_more": false });
        let s = summarise_search(&json!({"query": "SECRET_QUERY"}), &result);
        assert_eq!(s, "search — 2 matches");
    }

    #[test]
    fn get_block_includes_prefix_only() {
        let result = json!({ "id": ULID_A, "content": "SECRET_BLOCK_CONTENT" });
        let s = summarise_get_block(&json!({"block_id": ULID_A}), &result);
        assert_eq!(s, format!("get_block — {}", &ULID_A[..ULID_PREFIX_LEN]));
        assert_no_secrets(&s);
        assert_no_full_ulid(&s, ULID_A);
    }

    #[test]
    fn get_block_falls_back_when_id_missing() {
        let s = summarise_get_block(&json!({}), &json!({}));
        assert_eq!(s, "get_block");
    }

    #[test]
    fn list_backlinks_uses_total_count_and_target_prefix() {
        let args = json!({ "block_id": ULID_A });
        let result = json!({
            "groups": [
                { "page_id": ULID_B, "page_title": "SECRET_TITLE", "blocks": [{}, {}] }
            ],
            "total_count": 5,
            "filtered_count": 5,
            "has_more": false,
            "truncated": false,
        });
        let s = summarise_list_backlinks(&args, &result);
        assert_eq!(
            s,
            format!(
                "list_backlinks — 5 inbound on {}",
                &ULID_A[..ULID_PREFIX_LEN]
            ),
        );
        assert_no_secrets(&s);
        assert_no_full_ulid(&s, ULID_A);
    }

    #[test]
    fn list_backlinks_falls_back_to_group_block_count_when_total_missing() {
        let args = json!({ "block_id": ULID_A });
        let result = json!({
            "groups": [
                { "blocks": [{}, {}] },
                { "blocks": [{}] }
            ],
        });
        let s = summarise_list_backlinks(&args, &result);
        assert!(s.contains("3 inbound"));
    }

    /// #2201 item 1b — on a paginated (non-first) MCP `list_backlinks` call the
    /// backend skips the grouped COUNT and returns `total_count: 0`, yet the
    /// page still carries groups/blocks. The summary must report THIS page's
    /// inbound count (from the groups) rather than a misleading "0 inbound".
    #[test]
    fn list_backlinks_falls_back_to_group_count_when_total_is_zero_on_paginated_page() {
        let args = json!({ "block_id": ULID_A });
        let result = json!({
            "groups": [
                { "page_id": ULID_B, "page_title": "SECRET_TITLE", "blocks": [{}, {}] }
            ],
            // Non-first page: COUNT skipped ⇒ 0 (present, not absent).
            "total_count": 0,
            "filtered_count": 0,
            "has_more": false,
            "truncated": false,
        });
        let s = summarise_list_backlinks(&args, &result);
        assert!(
            s.contains("2 inbound"),
            "paginated page-2 summary should count the page's blocks, got: {s}"
        );
        assert!(
            !s.contains("0 inbound"),
            "must not report a misleading 0 inbound, got: {s}"
        );
        assert_no_secrets(&s);
    }

    /// #2201 item 1b guard — a genuinely empty FIRST page (0 backlinks ⇒ no
    /// groups, `total_count: 0`) must still summarise as "0 inbound".
    #[test]
    fn list_backlinks_reports_zero_for_genuinely_empty_first_page() {
        let args = json!({ "block_id": ULID_A });
        let result = json!({
            "groups": [],
            "total_count": 0,
            "filtered_count": 0,
            "has_more": false,
            "truncated": false,
        });
        let s = summarise_list_backlinks(&args, &result);
        assert!(
            s.contains("0 inbound"),
            "genuinely empty result must report 0 inbound, got: {s}"
        );
    }

    #[test]
    fn list_tags_counts_tags_and_omits_names() {
        let result = json!([
            { "tag_id": ULID_TAG, "name": "SECRET_TAG_NAME", "usage_count": 1, "updated_at": "x" },
            { "tag_id": ULID_B, "name": "SECRET_TAG_NAME", "usage_count": 2, "updated_at": "x" },
        ]);
        let s = summarise_list_tags(&json!({}), &result);
        assert_eq!(s, "list_tags — 2 tags");
        assert_no_secrets(&s);
    }

    #[test]
    fn list_property_defs_counts_defs() {
        let result = json!([
            { "key": "effort", "value_type": "number", "options": null, "created_at": "x" },
            { "key": "due", "value_type": "date", "options": null, "created_at": "x" },
        ]);
        let s = summarise_list_property_defs(&json!({}), &result);
        assert_eq!(s, "list_property_defs — 2 defs");
    }

    #[test]
    fn get_agenda_includes_count_and_date_range() {
        let args = json!({ "start_date": "2025-01-01", "end_date": "2025-01-31" });
        let result = json!([
            { "block": { "id": ULID_A, "content": "SECRET_BLOCK_CONTENT" }, "projected_date": "2025-01-05", "source": "due_date" }
        ]);
        let s = summarise_get_agenda(&args, &result);
        assert_eq!(s, "get_agenda — 1 entry (2025-01-01..2025-01-31)");
        assert_no_secrets(&s);
        assert_no_full_ulid(&s, ULID_A);
    }

    #[test]
    fn get_agenda_pluralises_entries() {
        let args = json!({ "start_date": "2025-01-01", "end_date": "2025-01-31" });
        let result = json!([{}, {}, {}]);
        let s = summarise_get_agenda(&args, &result);
        assert_eq!(s, "get_agenda — 3 entries (2025-01-01..2025-01-31)");
    }

    #[test]
    fn list_spaces_counts_spaces_and_omits_names() {
        let result = json!([
            { "id": ULID_A, "name": "SECRET_TITLE", "is_default": true },
            { "id": ULID_B, "name": "SECRET_TAG_NAME", "is_default": false },
        ]);
        let s = summarise_list_spaces(&json!({}), &result);
        assert_eq!(s, "list_spaces — 2 spaces");
        assert_no_secrets(&s);
        assert_no_full_ulid(&s, ULID_A);
    }

    #[test]
    fn list_spaces_singular_form_for_one_space() {
        let result = json!([{ "id": ULID_A, "name": "SECRET_TITLE", "is_default": true }]);
        let s = summarise_list_spaces(&json!({}), &result);
        assert_eq!(s, "list_spaces — 1 space");
    }

    #[test]
    fn get_page_markdown_includes_prefix_and_line_count_only() {
        let result = json!({
            "page_id": ULID_A,
            "markdown": format!(
                "# SECRET_TITLE\n\n---\naliases: [SECRET_ALIAS]\n---\n\n- SECRET_BLOCK_CONTENT ^{ULID_B}\n"
            ),
        });
        let s = summarise_get_page_markdown(&json!({"page_id": ULID_A}), &result);
        assert_eq!(
            s,
            format!(
                "get_page_markdown — {} (7 lines)",
                &ULID_A[..ULID_PREFIX_LEN]
            )
        );
        assert_no_secrets(&s);
        assert_no_full_ulid(&s, ULID_A);
        assert_no_full_ulid(&s, ULID_B);
    }

    #[test]
    fn journal_for_date_combines_date_and_prefix() {
        let args = json!({ "date": "2025-01-15" });
        let result = json!({ "id": ULID_A, "content": "SECRET_TITLE" });
        let s = summarise_journal_for_date(&args, &result);
        assert_eq!(
            s,
            format!(
                "journal_for_date — 2025-01-15 → {}",
                &ULID_A[..ULID_PREFIX_LEN]
            ),
        );
        assert_no_secrets(&s);
        assert_no_full_ulid(&s, ULID_A);
    }

    // -----------------------------------------------------------------
    // RW summarisers
    // -----------------------------------------------------------------

    #[test]
    fn journal_tools_count_and_omit_content_5396() {
        let rows = json!({
            "page": { "id": ULID_A, "block_type": "page", "content": "2025-01-15" },
            "blocks": [
                { "id": ULID_A, "block_type": "page", "content": "SECRET_TITLE" },
                { "id": ULID_B, "block_type": "content", "content": "SECRET_BLOCK_CONTENT" },
            ],
            "warnings": ["SECRET_TEXT_VALUE"],
        });
        let capture = summarise(
            TOOL_CAPTURE,
            &json!({ "content": "SECRET_BLOCK_CONTENT" }),
            &rows,
        );
        assert_eq!(
            capture,
            "capture — 1 block on today (created 1 page, 0 tags)"
        );
        let day = json!({
            "date": "2025-01-15",
            "page_id": ULID_A,
            "markdown": "# 2025-01-15\n\n- SECRET_BLOCK_CONTENT\n",
        });
        let get = summarise(TOOL_GET_JOURNAL, &json!({ "date": "2025-01-15" }), &day);
        assert_eq!(get, "get_journal — 2025-01-15 (3 lines)");
        let missing = json!({ "date": "2025-01-16", "page_id": null, "markdown": "" });
        let none = summarise(TOOL_GET_JOURNAL, &json!({ "date": "yesterday" }), &missing);
        assert_eq!(none, "get_journal — yesterday (no page)");
        let list = summarise(
            TOOL_LIST_JOURNAL,
            &json!({ "from": "2025-01-01", "to": "2025-01-31" }),
            &json!({ "items": [{ "date": "2025-01-15", "block_count": 2 }], "has_more": true }),
        );
        assert_eq!(list, "list_journal — 1 day (2025-01-01..2025-01-31) (more)");
        for s in [capture, get, none, list] {
            assert_no_secrets(&s);
        }
    }

    #[test]
    fn append_markdown_counts_blocks_and_created_names_and_omits_their_text() {
        let args = json!({
            "parent_id": ULID_B,
            "markdown": "- SECRET_BLOCK_CONTENT [[SECRET_TITLE]] #SECRET_TAG_NAME",
        });
        let result = json!({
            "blocks": [
                { "id": ULID_A, "block_type": "page", "content": "SECRET_TITLE" },
                { "id": ULID_TAG, "block_type": "tag", "content": "SECRET_TAG_NAME" },
                { "id": ULID_A, "block_type": "content", "content": "SECRET_BLOCK_CONTENT" },
                { "id": ULID_A, "block_type": "content", "content": "SECRET_BLOCK_CONTENT" },
            ],
            "warnings": ["SECRET_TEXT_VALUE"],
        });
        let s = summarise_append_markdown(&args, &result);
        assert_eq!(
            s,
            format!(
                "append_markdown — 2 blocks under {} (created 1 page, 1 tag)",
                &ULID_B[..ULID_PREFIX_LEN]
            )
        );
        assert_no_secrets(&s);
        let by_title = summarise_append_markdown(&json!({ "parent_id": "SECRET_TITLE" }), &result);
        assert_eq!(
            by_title,
            "append_markdown — 2 blocks (created 1 page, 1 tag)"
        );
    }

    #[test]
    fn append_block_includes_both_prefixes_and_omits_content() {
        let args = json!({ "parent_id": "SECRET_TITLE", "content": "SECRET_BLOCK_CONTENT" });
        let result = json!({
            "id": ULID_A,
            "block_type": "content",
            "content": "SECRET_BLOCK_CONTENT",
            "parent_id": ULID_B,
            "position": 1,
        });
        let s = summarise_append_block(&args, &result);
        assert_eq!(
            s,
            format!(
                "append_block — added {} under {}",
                &ULID_A[..ULID_PREFIX_LEN],
                &ULID_B[..ULID_PREFIX_LEN],
            ),
        );
        assert_no_secrets(&s);
        assert_no_full_ulid(&s, ULID_A);
        assert_no_full_ulid(&s, ULID_B);
    }

    #[test]
    fn update_block_content_includes_prefix_and_omits_text() {
        let args = json!({ "block_id": ULID_A, "content": "SECRET_BLOCK_CONTENT" });
        let result = json!({
            "id": ULID_A,
            "block_type": "content",
            "content": "SECRET_BLOCK_CONTENT",
        });
        let s = summarise_update_block_content(&args, &result);
        assert_eq!(
            s,
            format!(
                "update_block_content — updated {}",
                &ULID_A[..ULID_PREFIX_LEN]
            ),
        );
        assert_no_secrets(&s);
    }

    #[test]
    fn set_property_text_value_omits_value() {
        // `text` typed property — value is content, must not appear.
        let args = json!({
            "block_id": ULID_A,
            "key": "notes",
            "value_text": "SECRET_TEXT_VALUE",
        });
        let result = json!({ "id": ULID_A });
        let s = summarise_set_property(&args, &result);
        assert_eq!(
            s,
            format!("set_property — set notes on {}", &ULID_A[..ULID_PREFIX_LEN]),
        );
        assert_no_secrets(&s);
    }

    #[test]
    fn set_property_num_value_includes_number() {
        let args = json!({
            "block_id": ULID_A,
            "key": "effort",
            "value_num": 3,
        });
        let s = summarise_set_property(&args, &json!({ "id": ULID_A }));
        assert_eq!(
            s,
            format!(
                "set_property — set effort=3 on {}",
                &ULID_A[..ULID_PREFIX_LEN]
            ),
        );
    }

    #[test]
    fn set_property_date_value_includes_date() {
        let args = json!({
            "block_id": ULID_A,
            "key": "due",
            "value_date": "2025-02-14",
        });
        let s = summarise_set_property(&args, &json!({ "id": ULID_A }));
        assert_eq!(
            s,
            format!(
                "set_property — set due=2025-02-14 on {}",
                &ULID_A[..ULID_PREFIX_LEN]
            ),
        );
    }

    #[test]
    fn set_property_bool_value_includes_bool() {
        let args = json!({
            "block_id": ULID_A,
            "key": "archived",
            "value_bool": true,
        });
        let s = summarise_set_property(&args, &json!({ "id": ULID_A }));
        assert_eq!(
            s,
            format!(
                "set_property — set archived=true on {}",
                &ULID_A[..ULID_PREFIX_LEN]
            ),
        );
    }

    #[test]
    fn set_property_ref_value_includes_ref_prefix_only() {
        let args = json!({
            "block_id": ULID_A,
            "key": "linked",
            "value_ref": ULID_REF,
        });
        let s = summarise_set_property(&args, &json!({ "id": ULID_A }));
        assert_eq!(
            s,
            format!(
                "set_property — set linked={} on {}",
                &ULID_REF[..ULID_PREFIX_LEN],
                &ULID_A[..ULID_PREFIX_LEN],
            ),
        );
        assert_no_full_ulid(&s, ULID_REF);
    }

    #[test]
    fn add_tag_includes_both_prefixes() {
        let args = json!({ "block_id": ULID_A, "tag_id": "SECRET_TAG_NAME" });
        let result = json!({ "block_id": ULID_A, "tag_id": ULID_TAG });
        let s = summarise_add_tag(&args, &result);
        assert_eq!(
            s,
            format!(
                "add_tag — applied {} to {}",
                &ULID_TAG[..ULID_PREFIX_LEN],
                &ULID_A[..ULID_PREFIX_LEN],
            ),
        );
        assert_no_secrets(&s);
        assert_no_full_ulid(&s, ULID_TAG);
    }

    #[test]
    fn create_page_includes_prefix_and_omits_title() {
        let args = json!({ "title": "SECRET_TITLE" });
        let result = json!({
            "id": ULID_A,
            "block_type": "page",
            "content": "SECRET_TITLE",
        });
        let s = summarise_create_page(&args, &result);
        assert_eq!(
            s,
            format!("create_page — created {}", &ULID_A[..ULID_PREFIX_LEN]),
        );
        assert_no_secrets(&s);
    }

    #[test]
    fn delete_block_includes_descendant_count() {
        let args = json!({ "block_id": ULID_A });
        let result = json!({
            "block_id": ULID_A,
            "deleted_at": "2025-01-01T00:00:00Z",
            "descendants_affected": 4,
        });
        let s = summarise_delete_block(&args, &result);
        assert_eq!(
            s,
            format!(
                "delete_block — deleted {} (4 descendants)",
                &ULID_A[..ULID_PREFIX_LEN]
            ),
        );
    }

    #[test]
    fn delete_block_singular_descendant_form() {
        let args = json!({ "block_id": ULID_A });
        let result = json!({ "descendants_affected": 1 });
        let s = summarise_delete_block(&args, &result);
        assert!(s.ends_with("(1 descendant)"));
    }

    #[test]
    fn move_page_to_space_includes_both_prefixes() {
        let args = json!({
            "page_id": "SECRET_TITLE",
            "space_id": ULID_REF,
            "target_space_id": ULID_B,
        });
        let result = json!({ "page_id": ULID_A, "space_id": ULID_B });
        let s = summarise_move_page_to_space(&args, &result);
        assert_eq!(
            s,
            format!(
                "move_page_to_space — moved {} to {}",
                &ULID_A[..ULID_PREFIX_LEN],
                &ULID_B[..ULID_PREFIX_LEN],
            ),
        );
        assert_no_secrets(&s);
    }

    #[test]
    fn create_tag_includes_prefix_and_omits_name() {
        let args = json!({ "name": "SECRET_TAG_NAME", "space_id": ULID_B });
        let result = json!({ "id": ULID_TAG, "block_type": "tag", "content": "SECRET_TAG_NAME" });
        let s = summarise_create_tag(&args, &result);
        assert_eq!(
            s,
            format!("create_tag — created {}", &ULID_TAG[..ULID_PREFIX_LEN]),
        );
        assert_no_secrets(&s);
    }

    #[test]
    fn delete_property_includes_key_and_block_prefix() {
        let args = json!({ "block_id": ULID_A, "key": "effort", "space_id": ULID_B });
        let result = json!({ "block_id": ULID_A, "key": "effort" });
        let s = summarise_delete_property(&args, &result);
        assert_eq!(
            s,
            format!(
                "delete_property — deleted effort on {}",
                &ULID_A[..ULID_PREFIX_LEN]
            ),
        );
    }

    #[test]
    fn set_page_aliases_counts_aliases_and_omits_their_text() {
        let args = json!({ "page_id": "SECRET_TITLE", "aliases": ["SECRET_ALIAS"] });
        let two = json!({ "page_id": ULID_A, "aliases": ["SECRET_ALIAS", "SECRET_ALIAS_2"] });
        let s = summarise(TOOL_SET_PAGE_ALIASES, &args, &two);
        assert_eq!(
            s,
            format!(
                "set_page_aliases — {}: 2 aliases",
                &ULID_A[..ULID_PREFIX_LEN]
            ),
        );
        assert_no_secrets(&s);
        let one = json!({ "page_id": ULID_A, "aliases": ["SECRET_ALIAS"] });
        assert!(summarise(TOOL_SET_PAGE_ALIASES, &args, &one).ends_with(": 1 alias"));
    }

    #[test]
    fn move_blocks_counts_moves_under_parent_prefix() {
        let args = json!({ "block_ids": [ULID_A, ULID_REF], "parent_id": "SECRET_TITLE" });
        let result = json!({ "moves": [
            { "block_id": ULID_A, "new_parent_id": ULID_B, "new_position": 0 },
            { "block_id": ULID_REF, "new_parent_id": ULID_B, "new_position": 1 },
        ] });
        let s = summarise_move_blocks(&args, &result);
        assert_eq!(
            s,
            format!(
                "move_blocks — moved 2 blocks under {}",
                &ULID_B[..ULID_PREFIX_LEN]
            ),
        );
    }

    #[test]
    fn remove_tag_includes_both_prefixes() {
        // The shared fixtures all start `01HZTEST`, which would hide a swap.
        let args = json!({ "block_id": "01BLOCK0000000000000000000", "tag_id": "SECRET_TAG_NAME" });
        let result = json!({
            "block_id": "01BLOCK0000000000000000000",
            "tag_id": "01TAG00000000000000000000T",
        });
        let s = summarise_remove_tag(&args, &result);
        assert_eq!(s, "remove_tag — removed 01TAG000 from 01BLOCK0");
    }

    #[test]
    fn restore_block_counts_restored_blocks() {
        let args = json!({ "block_id": ULID_A, "deleted_at": 1 });
        let result = json!({ "block_id": ULID_A, "restored_count": 3 });
        let s = summarise_restore_block(&args, &result);
        assert_eq!(
            s,
            format!(
                "restore_block — restored {} (3 blocks)",
                &ULID_A[..ULID_PREFIX_LEN]
            ),
        );
    }

    #[test]
    fn resolve_counts_names_and_matches_but_never_names_them_5397() {
        let result = json!([
            { "name": "Secret plan", "page_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "tag_id": null },
            { "name": "work", "page_id": null, "tag_id": "01ARZ3NDEKTSV4RRFFQ69G5FAW" },
            { "name": "nothing", "page_id": null, "tag_id": null },
        ]);
        let s = summarise_resolve(&json!({}), &result);
        assert_eq!(s, "resolve — 3 names, 2 matched");
        assert_eq!(
            summarise(TOOL_RESOLVE, &json!({}), &Value::Null),
            "resolve — 0 names, 0 matched"
        );
    }

    #[test]
    fn list_trash_counts_items_and_flags_more() {
        let result = json!({ "items": [{ "content": "SECRET_BLOCK_CONTENT" }], "has_more": true });
        let s = summarise_list_trash(&json!({}), &result);
        assert_eq!(s, "list_trash — 1 block (more)");
    }

    #[test]
    fn query_counts_rows_or_groups() {
        let rows = json!({ "rows": [{}, {}], "groups": [], "has_more": true });
        assert_eq!(summarise_query(&json!({}), &rows), "query — 2 rows (more)");
        let groups = json!({ "rows": [], "groups": [{ "key": "none", "count": 3 }] });
        assert_eq!(summarise_query(&json!({}), &groups), "query — 1 group");
    }

    #[test]
    fn history_counts_ops_with_target_prefix_and_omits_row_text() {
        let result = json!({
            "items": [
                { "op_type": "edit_block", "before": "SECRET_TEXT_VALUE", "after": "SECRET_BLOCK_CONTENT" },
                { "op_type": "create_block", "after": "SECRET_BLOCK_CONTENT" },
            ],
            "has_more": true,
        });
        let page = summarise(TOOL_PAGE_HISTORY, &json!({ "page_id": ULID_B }), &result);
        assert_eq!(page, "page_history — 2 ops on 01HZTEST (more)");
        let by_title = summarise(
            TOOL_PAGE_HISTORY,
            &json!({ "page_id": "SECRET_TITLE" }),
            &result,
        );
        assert_eq!(by_title, "page_history — 2 ops (more)");
        let block = summarise(TOOL_BLOCK_HISTORY, &json!({ "block_id": ULID_B }), &result);
        assert_eq!(block, "block_history — 2 ops on 01HZTEST (more)");
        assert_no_secrets(&page);
        assert_no_secrets(&block);
    }

    #[test]
    fn undo_counts_reverted_ops() {
        let one = json!({ "undone": [{ "reversed_op_type": "create_block" }] });
        assert_eq!(
            summarise(TOOL_UNDO, &json!({}), &one),
            "undo — reverted 1 op"
        );
        let none = json!({ "undone": [] });
        assert_eq!(
            summarise(TOOL_UNDO, &json!({}), &none),
            "undo — reverted 0 ops"
        );
    }

    #[test]
    fn batch_counts_its_ops_by_tool_5399() {
        let args = json!({ "ops": [
            { "op": "set_property", "block_id": ULID_A, "key": "notes", "value_text": "SECRET_TEXT_VALUE" },
            { "op": "delete_block", "block_id": ULID_B },
            { "op": "set_property", "block_id": ULID_B, "key": "notes", "value_text": "SECRET_TEXT_VALUE" },
        ]});
        let s = summarise(TOOL_BATCH, &args, &json!({ "results": [] }));
        assert_eq!(s, "batch — 3 ops (2 set_property, 1 delete_block)");
        assert_no_secrets(&s);
    }

    #[test]
    fn edit_page_markdown_lists_what_changed_5399() {
        let report = json!({
            "page_id": ULID_A, "created": 1, "edited": 0, "moved": 2, "deleted": 0,
            "properties_set": 1, "properties_deleted": 0,
            "names_created": [{ "id": ULID_B, "content": "SECRET_TITLE" }],
            "warnings": ["SECRET_TAG_NAME"],
        });
        let s = summarise(
            TOOL_EDIT_PAGE_MARKDOWN,
            &json!({ "page_id": "SECRET_TITLE" }),
            &report,
        );
        assert_eq!(
            s,
            "edit_page_markdown — 01HZTEST: 1 created, 2 moved, 1 property set"
        );
        assert_no_secrets(&s);
        let unchanged = json!({ "page_id": ULID_A, "created": 0 });
        assert_eq!(
            summarise(TOOL_EDIT_PAGE_MARKDOWN, &json!({}), &unchanged),
            "edit_page_markdown — 01HZTEST: no change"
        );
    }

    // -----------------------------------------------------------------
    // Cross-cutting privacy guard — every public summariser must
    // refuse to leak the secret payloads regardless of how they appear
    // in the args / result envelope.
    //
    // This test iterates over the **live** tool-description
    // list exposed by `tools_rw::list_tool_descriptions()` (a superset
    // of the RO list), rather than a hand-typed
    // sibling list. Adding a new tool to either registry without also
    // adding a `summarise.rs` arm now fails the bare-name fallback
    // assertion below — closing the silent-failure trap where a new
    // tool would land in the activity feed with the bare tool name.
    // -----------------------------------------------------------------

    #[test]
    fn privacy_guard_no_summariser_leaks_content_or_value_text() {
        // Args envelope is a kitchen-sink of every secret string + every
        // ULID-shaped field any registered summariser might inspect.
        // Any tool that surfaces one of these fields verbatim leaks.
        let dirty_args = json!({
            "query": "SECRET_QUERY",
            "title": "SECRET_TITLE",
            "content": "SECRET_BLOCK_CONTENT",
            "markdown": "- SECRET_BLOCK_CONTENT [[SECRET_TITLE]] #SECRET_TAG_NAME",
            "value_text": "SECRET_TEXT_VALUE",
            "block_id": ULID_A,
            // #5397 — a page, parent or tag argument may be a name.
            "parent_id": "SECRET_TITLE",
            "tag_id": "SECRET_TAG_NAME",
            "page_id": "SECRET_TITLE",
            // #5378 — `create_tag` / `move_page_to_space` / `set_page_aliases` args.
            "name": "SECRET_TAG_NAME",
            "aliases": ["SECRET_ALIAS"],
            "space_id": ULID_B,
            "target_space_id": ULID_B,
            "key": "notes",
            "date": "2025-01-15",
            "start_date": "2025-01-01",
            "end_date": "2025-01-31",
            // #5396 — `list_journal`'s range.
            "from": "2025-01-01",
            "to": "2025-01-31",
            // #5398 — `query`'s predicates carry user text.
            "where": { "type": "Leaf", "primitive": { "type": "Tag", "tag": "SECRET_TAG_NAME" } },
        });

        // Per-tool result shapes. Some summarisers expect a result
        // *object* (with `id`, `items`, `page`, `children`, …);
        // `list_tags` / `list_property_defs` / `get_agenda` expect a
        // top-level *array*. The `kitchen` shape covers every
        // object-shaped summariser plus the defensive default for any
        // future tool added without a per-tool entry below.
        let kitchen = json!({
            "id": ULID_A,
            "block_type": "content",
            "content": "SECRET_BLOCK_CONTENT",
            "parent_id": ULID_B,
            // #5400 — history rows carry a clipped before / after.
            "items": [{
                "id": ULID_A,
                "content": "SECRET_BLOCK_CONTENT",
                "block_id": ULID_A,
                "origin": "agent:test",
                "before": "SECRET_TEXT_VALUE",
                "after": "SECRET_BLOCK_CONTENT",
            }],
            // #5400 — `undo` returns what it reverted.
            "undone": [{
                "reversed_op": { "device_id": ULID_B, "seq": 1 },
                "reversed_op_type": "create_block",
                "new_op_ref": { "device_id": ULID_B, "seq": 2 },
                "new_op_type": "delete_block",
                "is_redo": false,
            }],
            "op_refs": [{ "device_id": ULID_B, "seq": 2 }],
            "page": {
                "id": ULID_A,
                "content": "SECRET_TITLE",
                "properties": [{ "key": "notes", "value_text": "SECRET_TEXT_VALUE" }],
                "tags": [ULID_TAG],
                "aliases": ["SECRET_ALIAS"],
            },
            "children": [{ "id": ULID_B, "content": "SECRET_BLOCK_CONTENT" }],
            // #5398 — `query` rows carry content, the page title and property values.
            "rows": [{
                "id": ULID_A,
                "page_title": "SECRET_TITLE",
                "content": "SECRET_BLOCK_CONTENT",
                "properties": [{ "key": "notes", "value_text": "SECRET_TEXT_VALUE" }],
            }],
            // #5377 — `get_block` carries the block's properties, tags and aliases.
            "properties": [{ "key": "notes", "value_text": "SECRET_TEXT_VALUE" }],
            "tags": [ULID_TAG],
            "aliases": ["SECRET_ALIAS"],
            // #5375 — `get_page_markdown` returns the page as text.
            "page_id": ULID_A,
            "markdown": "# SECRET_TITLE\n\n---\naliases: [SECRET_ALIAS]\n---\n\n- SECRET_BLOCK_CONTENT\n",
            // #5376 — `append_markdown` returns the rows it wrote and warnings
            // naming what stayed text.
            "blocks": [
                { "id": ULID_A, "block_type": "page", "content": "SECRET_TITLE" },
                { "id": ULID_B, "block_type": "content", "content": "SECRET_BLOCK_CONTENT" }
            ],
            "warnings": ["SECRET_TAG_NAME", "SECRET_TEXT_VALUE"],
            "groups": [
                { "page_id": ULID_B, "page_title": "SECRET_TITLE", "blocks": [{}] }
            ],
            "total_count": 1,
            "filtered_count": 1,
            "has_more": false,
            "truncated": false,
            "descendants_affected": 3,
            "block_id": ULID_A,
            "tag_id": ULID_TAG,
            "moves": [{ "block_id": ULID_A, "new_parent_id": ULID_B, "new_position": 0 }],
            "deleted_at": "2025-01-01",
        });
        let result_tags = json!([
            { "tag_id": ULID_TAG, "name": "SECRET_TAG_NAME", "usage_count": 1, "updated_at": "x" }
        ]);
        let result_defs = json!([
            { "key": "notes", "value_type": "text", "options": null, "created_at": "x" }
        ]);
        let result_agenda = json!([
            { "block": { "id": ULID_A, "content": "SECRET_BLOCK_CONTENT" }, "projected_date": "2025-01-05", "source": "due_date" }
        ]);
        let result_spaces = json!([
            { "id": ULID_A, "name": "SECRET_TITLE", "is_default": true }
        ]);

        let result_for = |name: &str| -> &Value {
            match name {
                TOOL_LIST_TAGS => &result_tags,
                TOOL_LIST_PROPERTY_DEFS => &result_defs,
                TOOL_GET_AGENDA => &result_agenda,
                TOOL_LIST_SPACES => &result_spaces,
                _ => &kitchen,
            }
        };

        // Drive iteration from the live registry. The RW list already
        // carries every RO tool, so it alone covers both surfaces.
        let all_descriptions = super::super::tools_rw::list_tool_descriptions();
        assert!(
            !all_descriptions.is_empty(),
            "registry returned zero tools — privacy guard would be vacuous",
        );

        for desc in &all_descriptions {
            let summary = summarise(&desc.name, &dirty_args, result_for(&desc.name));

            // Field-filtering contract — never leak block content, page
            // titles, value_text, tag display names, or query strings.
            assert_no_secrets(&summary);
            // Never leak the full ULID — only the 8-char prefix is OK.
            assert_no_full_ulid(&summary, ULID_A);
            assert_no_full_ulid(&summary, ULID_B);
            assert_no_full_ulid(&summary, ULID_TAG);

            // Drift detector: if a tool registered with the live
            // `tools_ro` / `tools_rw` registry has no matching arm in
            // `summarise()`, it falls through to the default arm
            // (`other => other.to_string()`) and the activity feed
            // ends up with just the bare tool name. Adding a new tool
            // without a summariser entry will fail this assertion.
            assert_ne!(
                summary, desc.name,
                "tool `{}` has no registered summariser — falls through to bare-name \
                 default arm in `summarise()`. Add a `summarise_<name>` arm.",
                desc.name,
            );
        }
    }
}
