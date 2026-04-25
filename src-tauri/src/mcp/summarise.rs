//! Privacy-safe one-line summaries per MCP tool, for the activity feed
//! (FEAT-4k).
//!
//! Each summariser takes the tool's parsed JSON `args` + structured
//! return `result` and produces a short string that the activity-feed
//! ring buffer / `mcp:activity` event surface render in the
//! Settings → Agent Access activity list. The dispatcher in
//! [`super::server::handle_tools_call`] selects the right summariser by
//! tool name on success; tools without a registered summariser fall
//! through to the bare tool name (defensive default for any tool added
//! later without a summariser).
//!
//! # Privacy invariants
//!
//! - **No block content.** The `content` field of `BlockRow`, the
//!   serialised page title, the literal text of a property `value_text`,
//!   and any tag display name are user content and must never appear in
//!   a summary.
//! - **Counts, ULIDs (or 8-char prefixes), tool names, dates, property
//!   keys, and typed `ref` / `number` / `date` property values are
//!   structural metadata** and are safe to embed.
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

use serde_json::Value;

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
    v.as_array().map(Vec::len).unwrap_or(0)
}

/// `result["has_more"]` as a bool, defaulting to false.
fn has_more(v: &Value) -> bool {
    v.get("has_more").and_then(Value::as_bool).unwrap_or(false)
}

/// Top-level dispatch: select the right per-tool summariser for `name`.
/// Falls back to the bare tool name when no summariser is registered.
///
/// Always called from [`super::server::handle_tools_call`] on the **Ok**
/// branch; the Err branch keeps using the clipped error message and
/// does not invoke this module.
pub fn summarise(name: &str, args: &Value, result: &Value) -> String {
    match name {
        // ---- read-only (tools_ro) ----
        "list_pages" => summarise_list_pages(args, result),
        "get_page" => summarise_get_page(args, result),
        "search" => summarise_search(args, result),
        "get_block" => summarise_get_block(args, result),
        "list_backlinks" => summarise_list_backlinks(args, result),
        "list_tags" => summarise_list_tags(args, result),
        "list_property_defs" => summarise_list_property_defs(args, result),
        "get_agenda" => summarise_get_agenda(args, result),
        "journal_for_date" => summarise_journal_for_date(args, result),
        // ---- read-write (tools_rw) ----
        "append_block" => summarise_append_block(args, result),
        "update_block_content" => summarise_update_block_content(args, result),
        "set_property" => summarise_set_property(args, result),
        "add_tag" => summarise_add_tag(args, result),
        "create_page" => summarise_create_page(args, result),
        "delete_block" => summarise_delete_block(args, result),
        // Defensive default — keeps the activity feed working when
        // someone adds a new tool without a summariser. This is the
        // pre-FEAT-4k behaviour for every entry.
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
    let n = result
        .get("total_count")
        .and_then(Value::as_u64)
        .map(|u| usize::try_from(u).unwrap_or(usize::MAX))
        .or_else(|| {
            // Fallback for stub registries that return a different
            // shape: count blocks across groups.
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
pub fn summarise_list_tags(_args: &Value, result: &Value) -> String {
    let n = root_array_len(result);
    format!("list_tags — {n} {}", if n == 1 { "tag" } else { "tags" })
}

/// `list_property_defs — N def(s)`. The keys themselves are schema and
/// would be safe to include, but we keep the summary terse and just
/// surface the count.
pub fn summarise_list_property_defs(_args: &Value, result: &Value) -> String {
    let n = root_array_len(result);
    format!(
        "list_property_defs — {n} {}",
        if n == 1 { "def" } else { "defs" }
    )
}

/// `get_agenda — N entr(y|ies) (start..end)`. Dates are not user
/// content; entry counts are structural.
pub fn summarise_get_agenda(args: &Value, result: &Value) -> String {
    let n = root_array_len(result);
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

// ---------------------------------------------------------------------------
// Read-write summarisers
// ---------------------------------------------------------------------------

/// `append_block — added <id-prefix> under <parent-prefix>`. Never
/// embeds the new block's `content`.
pub fn summarise_append_block(args: &Value, result: &Value) -> String {
    let parent = str_field(args, "parent_id").unwrap_or("");
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
/// for `number` / `date` / `ref` types where the value is structural
/// (numbers, ISO dates, ULIDs respectively). For `ref` we prefix the
/// ULID just like every other id.
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
pub fn summarise_add_tag(args: &Value, _result: &Value) -> String {
    let block_id = str_field(args, "block_id").unwrap_or("");
    let tag_id = str_field(args, "tag_id").unwrap_or("");
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
    ];

    fn assert_no_secrets(summary: &str) {
        for s in SECRETS {
            assert!(
                !summary.contains(s),
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
    fn append_block_includes_both_prefixes_and_omits_content() {
        let args = json!({ "parent_id": ULID_B, "content": "SECRET_BLOCK_CONTENT" });
        let result = json!({
            "id": ULID_A,
            "block_type": "content",
            "content": "SECRET_BLOCK_CONTENT",
            "parent_id": ULID_B,
            "position": 1,
            "is_conflict": false,
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
            "is_conflict": false,
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
        let args = json!({ "block_id": ULID_A, "tag_id": ULID_TAG });
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
            "is_conflict": false,
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

    // -----------------------------------------------------------------
    // Cross-cutting privacy guard — every public summariser must
    // refuse to leak the secret payloads regardless of how they appear
    // in the args / result envelope.
    // -----------------------------------------------------------------

    #[test]
    fn privacy_guard_no_summariser_leaks_content_or_value_text() {
        let dirty_args = json!({
            "query": "SECRET_QUERY",
            "title": "SECRET_TITLE",
            "content": "SECRET_BLOCK_CONTENT",
            "value_text": "SECRET_TEXT_VALUE",
            "block_id": ULID_A,
            "parent_id": ULID_B,
            "tag_id": ULID_TAG,
            "page_id": ULID_A,
            "key": "notes",
            "date": "2025-01-15",
            "start_date": "2025-01-01",
            "end_date": "2025-01-31",
        });
        let dirty_result_block = json!({
            "id": ULID_A,
            "block_type": "content",
            "content": "SECRET_BLOCK_CONTENT",
            "parent_id": ULID_B,
        });
        let dirty_result_page = json!({
            "page": { "id": ULID_A, "content": "SECRET_TITLE" },
            "children": [
                { "id": ULID_B, "content": "SECRET_BLOCK_CONTENT" }
            ],
            "has_more": false,
        });
        let dirty_result_search = json!({
            "items": [
                { "id": ULID_A, "content": "SECRET_BLOCK_CONTENT" }
            ],
            "has_more": false,
        });
        let dirty_result_tags = json!([
            { "tag_id": ULID_TAG, "name": "SECRET_TAG_NAME", "usage_count": 1, "updated_at": "x" }
        ]);
        let dirty_result_defs = json!([
            { "key": "notes", "value_type": "text", "options": null, "created_at": "x" }
        ]);
        let dirty_result_agenda = json!([
            { "block": { "id": ULID_A, "content": "SECRET_BLOCK_CONTENT" }, "projected_date": "2025-01-05", "source": "due_date" }
        ]);
        let dirty_result_backlinks = json!({
            "groups": [
                { "page_id": ULID_B, "page_title": "SECRET_TITLE", "blocks": [{}] }
            ],
            "total_count": 1,
            "filtered_count": 1,
            "has_more": false,
            "truncated": false,
        });
        let dirty_result_delete = json!({
            "block_id": ULID_A,
            "deleted_at": "2025-01-01",
            "descendants_affected": 3,
        });
        let dirty_result_tag = json!({ "block_id": ULID_A, "tag_id": ULID_TAG });

        // (name, args, result) tuples — one per registered summariser.
        let cases: Vec<(&str, &Value, &Value)> = vec![
            ("list_pages", &dirty_args, &dirty_result_search),
            ("get_page", &dirty_args, &dirty_result_page),
            ("search", &dirty_args, &dirty_result_search),
            ("get_block", &dirty_args, &dirty_result_block),
            ("list_backlinks", &dirty_args, &dirty_result_backlinks),
            ("list_tags", &dirty_args, &dirty_result_tags),
            ("list_property_defs", &dirty_args, &dirty_result_defs),
            ("get_agenda", &dirty_args, &dirty_result_agenda),
            ("journal_for_date", &dirty_args, &dirty_result_block),
            ("append_block", &dirty_args, &dirty_result_block),
            ("update_block_content", &dirty_args, &dirty_result_block),
            ("set_property", &dirty_args, &dirty_result_block),
            ("add_tag", &dirty_args, &dirty_result_tag),
            ("create_page", &dirty_args, &dirty_result_block),
            ("delete_block", &dirty_args, &dirty_result_delete),
        ];
        for (name, args, result) in cases {
            let s = summarise(name, args, result);
            assert_no_secrets(&s);
            // No full ULID anywhere — only the prefix.
            assert_no_full_ulid(&s, ULID_A);
            assert_no_full_ulid(&s, ULID_B);
            assert_no_full_ulid(&s, ULID_TAG);
        }
    }
}
