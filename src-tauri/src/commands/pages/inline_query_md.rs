//! #2968 — human-readable, roundtrip-safe markdown export/import for structured
//! inline query blocks.
//!
//! An inline query block stores its filter as `{{query v2:<base64url(JSON
//! FilterExpr)>}}` (see `src/lib/inline-query-spec.ts`). The base64url payload
//! is opaque in any external tool AND any tag/page ULIDs embedded inside the
//! encoded `FilterExpr` DANGLE after a re-import into a different vault (the
//! ids name the OLD vault's tag/page blocks). Pre-#2968 export emitted the
//! `v2:` token verbatim, so both problems shipped.
//!
//! This module makes export/import symmetric with the existing `#[ULID]` /
//! `[[ULID]]` / `((ULID))` reference handling (#1446/#1924/#2963):
//!
//! * **Export** ([`rewrite_inline_queries_for_export`]) decodes the stored
//!   `v2:` payload into the REAL [`FilterExpr`] type (the query engine's own
//!   type — no schema re-implementation), walks every ULID-bearing ref field,
//!   and resolves each ULID to its human-readable NAME using the SAME batched
//!   `tag_names` / `page_titles` maps the surrounding exporter already builds.
//!   It re-encodes the name-carrying spec under a `v2n:` (v2-with-names) marker
//!   and appends a plaintext, human-readable description, so the exported form
//!   is `{{query v2n:<base64url(names)> <description>}}`. The base64url machine
//!   payload survives the markdown pipeline byte-for-byte (its alphabet
//!   `A–Z a–z 0–9 - _` contains none of the serializer's escapable chars, and
//!   none of the `#[` / `[[` / `((` tokens the other rewrites key on), while the
//!   description carries the resolved names in plaintext for humans + external
//!   tools.
//!
//! * **Import** ([`rewrite_inline_queries_for_import`]) detects the `v2n:`
//!   form, decodes it, and remaps every embedded NAME back to the NEW vault's
//!   ULID via the same `resolved_page_links` / `resolved_tag_tokens` maps the
//!   inbound `[[Page]]` / `#tag` resolution passes already build (create-if-
//!   missing included — the query's referenced names are harvested into those
//!   passes via [`query_tag_names`] / [`query_page_names`]). It re-encodes the
//!   ULID-carrying spec back to the canonical `{{query v2:<base64url(ULIDs)>}}`
//!   form BEFORE the other rewrites run, so the LIVE editor representation is
//!   UNCHANGED — the readable form exists only inside the exported `.md` file.
//!
//! A ref that cannot be resolved degrades gracefully: on export an
//! unresolvable ULID is left in the machine payload (never surfaced as a raw
//! opaque token in the readable description — it simply keeps its id there); on
//! import an unresolvable name is left as a name, which the query engine treats
//! as a non-matching id (an empty result for that leaf) rather than a crash. A
//! corrupt/undecodable payload is left verbatim.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use regex::Regex;

use crate::filters::{FilterExpr, FilterPrimitive, PropertyPredicate, PropertyValue};

/// The structured payload of a `v2:` inline query block. Mirrors the TS
/// `InlineQuerySpec` in `src/lib/inline-query-spec.ts` (`{ filter, table? }`)
/// so a Rust-encoded payload is byte-compatible with the frontend decoder and
/// vice-versa. `filter` deserializes into the query engine's OWN
/// [`FilterExpr`] type, so no schema is re-implemented here.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct InlineQuerySpec {
    pub filter: FilterExpr,
    /// Render matches as a table (vs. the default list). Omitted ⇒ `false`,
    /// matching the TS encoder which only emits `table` when `true`.
    #[serde(default)]
    pub table: bool,
}

/// Which resolution map a ref field routes through. The field POSITION in the
/// `FilterExpr` tree encodes the kind (a `Tag`'s id is always a tag; a
/// `ChildOf`'s parent / a `Ref` property value is a page/block), so export and
/// import never need an in-payload marker to tell tag refs from page refs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefKind {
    Tag,
    Page,
}

/// Canonical stored form: `{{query v2:<base64url>}}` (what the live editor
/// writes and what export reads). Capture 1 is the whole `v2:<base64url>`
/// payload. The base64url alphabet has no `{`/`}`, so the token is unambiguous.
static EXPORT_QUERY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\{\{query\s+(v2:[A-Za-z0-9_\-]+)\s*\}\}").expect("invalid inline-query export re")
});

/// Readable exported form: `{{query v2n:<base64url> <description>}}`. Capture 1
/// is the base64url machine payload (name-carrying spec); the `[^{}]*` swallows
/// the space + human description up to the closing `}}` (the description is
/// sanitized to contain no braces, so this never over-matches into a following
/// token).
static IMPORT_QUERY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\{\{query\s+v2n:([A-Za-z0-9_\-]+)[^{}]*\}\}")
        .expect("invalid inline-query import re")
});

/// True for a canonical 26-char Crockford-base32 ULID (`[0-9A-Z]{26}`), matching
/// the `TAG_REF_RE` / `PAGE_LINK_RE` ULID class. Used to tell a raw
/// (unresolved) id from a human NAME sitting in a ref field.
fn is_ulid(s: &str) -> bool {
    s.len() == 26
        && s.bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
}

// ── FilterExpr ref walk ───────────────────────────────────────────────────

/// Apply `f` to every ULID-bearing ref field in the tree, tagged by
/// [`RefKind`]. Recurses `And`/`Or` children, the `Not` child, and the nested
/// `HasParentMatching` matcher. The tree depth is bounded by the engine's own
/// `FilterExpr::MAX_DEPTH` for any payload that ran through the compiler; a
/// hand-crafted deeper payload would only over-recurse this read/rewrite (no
/// SQL), and is not a correctness concern here.
fn walk_refs<F: FnMut(RefKind, &mut String)>(expr: &mut FilterExpr, f: &mut F) {
    match expr {
        FilterExpr::Leaf { primitive } => walk_primitive(primitive, f),
        FilterExpr::And { children } | FilterExpr::Or { children } => {
            for child in children {
                walk_refs(child, f);
            }
        }
        FilterExpr::Not { child } => walk_refs(child, f),
    }
}

fn walk_primitive<F: FnMut(RefKind, &mut String)>(p: &mut FilterPrimitive, f: &mut F) {
    match p {
        // Tag identity fields carry a TAG ULID.
        FilterPrimitive::Tag { tag } | FilterPrimitive::TagOrRef { tag } => f(RefKind::Tag, tag),
        // Structural / relational fields carry a BLOCK ULID (a page, in the
        // common case) — routed through the page-title map.
        FilterPrimitive::ChildOf { parent } => f(RefKind::Page, parent),
        FilterPrimitive::LinksTo { target } => f(RefKind::Page, target),
        FilterPrimitive::LinkedFrom { source } => f(RefKind::Page, source),
        // A `HasProperty` predicate whose value is a `Ref` carries a block ref.
        FilterPrimitive::HasProperty { predicate, .. } => {
            if let Some(PropertyValue::Ref { value }) = predicate_value_mut(predicate) {
                f(RefKind::Page, value);
            }
        }
        // Nested parent matcher — recurse.
        FilterPrimitive::HasParentMatching { matcher } => walk_refs(matcher, f),
        // Every other primitive carries no cross-vault ULID ref (globs, dates,
        // priorities, states, block types, snippet/regex toggles, `Space`).
        _ => {}
    }
}

/// The mutable `PropertyValue` operand of a comparison predicate, or `None` for
/// the value-less `Exists` / `NotExists`.
fn predicate_value_mut(p: &mut PropertyPredicate) -> Option<&mut PropertyValue> {
    match p {
        PropertyPredicate::Eq { value }
        | PropertyPredicate::Ne { value }
        | PropertyPredicate::Lt { value }
        | PropertyPredicate::Gt { value }
        | PropertyPredicate::Lte { value }
        | PropertyPredicate::Gte { value }
        | PropertyPredicate::Contains { value }
        | PropertyPredicate::StartsWith { value } => Some(value),
        PropertyPredicate::Exists | PropertyPredicate::NotExists => None,
    }
}

// ── codec ─────────────────────────────────────────────────────────────────

/// Decode a stored `v2:<base64url>` payload into a spec (ULIDs in ref fields).
pub(crate) fn decode_v2(payload: &str) -> Option<InlineQuerySpec> {
    let b64 = payload.strip_prefix("v2:")?;
    decode_b64(b64)
}

/// Decode a `v2n:` base64url token into a spec (NAMES in ref fields).
fn decode_v2n(b64: &str) -> Option<InlineQuerySpec> {
    decode_b64(b64)
}

fn decode_b64(b64: &str) -> Option<InlineQuerySpec> {
    let bytes = URL_SAFE_NO_PAD.decode(b64).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn encode_spec_b64(spec: &InlineQuerySpec) -> Option<String> {
    let json = serde_json::to_vec(spec).ok()?;
    Some(URL_SAFE_NO_PAD.encode(json))
}

/// Encode a spec into the canonical stored `v2:<base64url>` payload.
pub(crate) fn encode_v2(spec: &InlineQuerySpec) -> Option<String> {
    Some(format!("v2:{}", encode_spec_b64(spec)?))
}

// ── human-readable description ────────────────────────────────────────────

/// Render a one-line, best-effort human description of a (name-carrying)
/// filter tree. Not re-parsed on import (the `v2n:` base64 is the machine
/// payload) — it exists purely so the exported markdown carries the resolved
/// tag/page NAMES in plaintext for humans and external tools.
fn describe(expr: &FilterExpr) -> String {
    match expr {
        FilterExpr::Leaf { primitive } => describe_primitive(primitive),
        FilterExpr::And { children } => join_children(children, " AND "),
        FilterExpr::Or { children } => join_children(children, " OR "),
        FilterExpr::Not { child } => format!("NOT {}", describe(child)),
    }
}

fn join_children(children: &[FilterExpr], sep: &str) -> String {
    let parts: Vec<String> = children.iter().map(describe).collect();
    match parts.len() {
        0 => String::new(),
        1 => parts.into_iter().next().unwrap_or_default(),
        _ => format!("({})", parts.join(sep)),
    }
}

/// Render a ref value for the human description: its resolved NAME, or a
/// clearly-marked `(unresolved)` when the value is still a raw ULID (its target
/// could not be resolved to a name — a deleted/dangling ref). Never surfaces a
/// bare opaque id in the readable output.
fn readable_ref(value: &str) -> &str {
    if is_ulid(value) {
        "(unresolved)"
    } else {
        value
    }
}

fn describe_primitive(p: &FilterPrimitive) -> String {
    match p {
        FilterPrimitive::Tag { tag } | FilterPrimitive::TagOrRef { tag } => {
            format!("tag:{}", readable_ref(tag))
        }
        FilterPrimitive::ChildOf { parent } => format!("child-of:{}", readable_ref(parent)),
        FilterPrimitive::LinksTo { target } => format!("links-to:{}", readable_ref(target)),
        FilterPrimitive::LinkedFrom { source } => format!("linked-from:{}", readable_ref(source)),
        FilterPrimitive::PathGlob { pattern, exclude } => {
            format!("{}path:{pattern}", if *exclude { "not-" } else { "" })
        }
        FilterPrimitive::Space { space_id } => format!("space:{space_id}"),
        FilterPrimitive::State { values, .. } => format!("state:{}", values.join(",")),
        FilterPrimitive::Priority { values, .. } => format!("priority:{}", values.join(",")),
        FilterPrimitive::BlockType { values, .. } => format!("block-type:{}", values.join(",")),
        FilterPrimitive::HasProperty { key, predicate } => describe_property(key, predicate),
        FilterPrimitive::HasParentMatching { matcher } => {
            format!("has-parent-matching:[{}]", describe(matcher))
        }
        // Dates / search toggles / structural markers: the allowed-key token is
        // a fine label (carries no cross-vault ref).
        other => other.allowed_key().to_string(),
    }
}

fn describe_property(key: &str, predicate: &PropertyPredicate) -> String {
    match predicate {
        PropertyPredicate::Exists => format!("has-property:{key}"),
        PropertyPredicate::NotExists => format!("not-has-property:{key}"),
        _ => match predicate_value(predicate) {
            Some(v) => format!("{key}={}", property_value_str(v)),
            None => format!("has-property:{key}"),
        },
    }
}

fn predicate_value(p: &PropertyPredicate) -> Option<&PropertyValue> {
    match p {
        PropertyPredicate::Eq { value }
        | PropertyPredicate::Ne { value }
        | PropertyPredicate::Lt { value }
        | PropertyPredicate::Gt { value }
        | PropertyPredicate::Lte { value }
        | PropertyPredicate::Gte { value }
        | PropertyPredicate::Contains { value }
        | PropertyPredicate::StartsWith { value } => Some(value),
        PropertyPredicate::Exists | PropertyPredicate::NotExists => None,
    }
}

fn property_value_str(v: &PropertyValue) -> String {
    match v {
        PropertyValue::Text { value } | PropertyValue::Date { value } => value.clone(),
        // A `Ref` value is a block ULID — mark it when unresolved so no raw
        // opaque id reaches the readable description.
        PropertyValue::Ref { value } => readable_ref(value).to_string(),
        PropertyValue::Num { value } => format!("{value}"),
    }
}

/// Strip braces / newlines from a description so it can sit inside a
/// `{{query … <desc>}}` token without breaking the delimiter or the
/// single-line block grammar. Collapses whitespace runs.
fn sanitize_desc(desc: &str) -> String {
    let cleaned: String = desc
        .chars()
        .map(|c| match c {
            '{' | '}' | '\n' | '\r' | '\t' => ' ',
            other => other,
        })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ── export ────────────────────────────────────────────────────────────────

/// Collect the tag/page ULIDs embedded in every `v2:` inline query in
/// `content` into `out`, so the exporter's batched title-resolution query
/// (which otherwise only sees `#[ULID]` / `[[ULID]]` plaintext tokens) also
/// loads the names for query-embedded refs.
pub(crate) fn collect_export_ref_ulids(content: &str, out: &mut HashSet<String>) {
    if !content.contains("{{query") {
        return;
    }
    for caps in EXPORT_QUERY_RE.captures_iter(content) {
        if let Some(mut spec) = decode_v2(&caps[1]) {
            walk_refs(&mut spec.filter, &mut |_kind, s| {
                if is_ulid(s) {
                    out.insert(s.clone());
                }
            });
        }
    }
}

/// Rewrite every stored `{{query v2:<base64(ULIDs)>}}` token in `content` into
/// the human-readable, roundtrip-safe `{{query v2n:<base64(names)> <desc>}}`
/// form, resolving embedded tag/page ULIDs via `tag_names` / `page_titles`. A
/// ULID absent from both maps (deleted / non-page block target) keeps its id in
/// the machine payload; a corrupt payload is left verbatim.
pub(crate) fn rewrite_inline_queries_for_export(
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
) -> String {
    if !content.contains("{{query") {
        return content.to_string();
    }
    EXPORT_QUERY_RE
        .replace_all(content, |caps: &regex::Captures| {
            let whole = caps[0].to_string();
            let Some(mut spec) = decode_v2(&caps[1]) else {
                return whole;
            };
            walk_refs(&mut spec.filter, &mut |kind, s| {
                if !is_ulid(s) {
                    return;
                }
                let name = match kind {
                    RefKind::Tag => tag_names.get(s.as_str()),
                    RefKind::Page => page_titles.get(s.as_str()),
                };
                if let Some(n) = name {
                    *s = n.clone();
                }
            });
            let desc = sanitize_desc(&describe(&spec.filter));
            match encode_spec_b64(&spec) {
                Some(b64) if desc.is_empty() => format!("{{{{query v2n:{b64}}}}}"),
                Some(b64) => format!("{{{{query v2n:{b64} {desc}}}}}"),
                None => whole,
            }
        })
        .into_owned()
}

// ── import ────────────────────────────────────────────────────────────────

/// The DISTINCT tag NAMES referenced by `v2n:` inline queries across `blocks`,
/// for the inbound-tag resolve-or-create pre-pass to create + map.
pub(crate) fn query_tag_names(blocks: &[crate::import::ParsedBlock]) -> Vec<String> {
    collect_query_names(blocks, RefKind::Tag)
}

/// The DISTINCT page NAMES referenced by `v2n:` inline queries across `blocks`,
/// for the inbound page-link resolve-or-create pre-pass to create + map.
pub(crate) fn query_page_names(blocks: &[crate::import::ParsedBlock]) -> Vec<String> {
    collect_query_names(blocks, RefKind::Page)
}

fn collect_query_names(blocks: &[crate::import::ParsedBlock], want: RefKind) -> Vec<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    for block in blocks {
        if !block.content.contains("{{query") {
            continue;
        }
        for caps in IMPORT_QUERY_RE.captures_iter(&block.content) {
            if let Some(mut spec) = decode_v2n(&caps[1]) {
                walk_refs(&mut spec.filter, &mut |kind, s| {
                    if kind == want && !is_ulid(s) && !s.is_empty() {
                        set.insert(s.clone());
                    }
                });
            }
        }
    }
    set.into_iter().collect()
}

/// Rewrite every `{{query v2n:<base64(names)> <desc>}}` token in `content` back
/// to the canonical stored `{{query v2:<base64(ULIDs)>}}` form, remapping
/// embedded NAMES to the new vault's ULIDs via `resolved_page_links` /
/// `resolved_tag_tokens`. A name absent from its map is left as a name (the
/// engine treats it as a non-matching id — an empty leaf, never a crash); a
/// corrupt payload is left verbatim. Runs BEFORE the `[[Page]]` / `#tag`
/// rewrites so the resulting base64 token is inert for them.
pub(crate) fn rewrite_inline_queries_for_import(
    content: &str,
    resolved_page_links: &HashMap<String, String>,
    resolved_tag_tokens: &HashMap<String, String>,
) -> String {
    if !content.contains("{{query") {
        return content.to_string();
    }
    IMPORT_QUERY_RE
        .replace_all(content, |caps: &regex::Captures| {
            let whole = caps[0].to_string();
            let Some(mut spec) = decode_v2n(&caps[1]) else {
                return whole;
            };
            walk_refs(&mut spec.filter, &mut |kind, s| {
                if is_ulid(s) {
                    return;
                }
                let mapped = match kind {
                    RefKind::Tag => resolved_tag_tokens.get(s.as_str()),
                    RefKind::Page => resolved_page_links.get(s.as_str()),
                };
                if let Some(id) = mapped {
                    *s = id.clone();
                }
            });
            match encode_v2(&spec) {
                Some(v2) => format!("{{{{query {v2}}}}}"),
                None => whole,
            }
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag_leaf(id: &str) -> FilterExpr {
        FilterExpr::Leaf {
            primitive: FilterPrimitive::Tag {
                tag: id.to_string(),
            },
        }
    }

    fn stored_v2(filter: FilterExpr) -> String {
        let spec = InlineQuerySpec {
            filter,
            table: false,
        };
        format!("{{{{query {}}}}}", encode_v2(&spec).unwrap())
    }

    const TAG_ULID: &str = "01TAG00000000000000000TAG1";
    const PAGE_ULID: &str = "01PAGE0000000000000000PAG1";

    #[test]
    fn is_ulid_recognizes_crockford_shape() {
        assert!(is_ulid(TAG_ULID));
        assert!(!is_ulid("rust")); // a name
        assert!(!is_ulid("01tag00000000000000000tag1")); // lowercase
        assert!(!is_ulid("01TAG")); // too short
    }

    #[test]
    fn export_replaces_tag_ulid_with_name_and_is_readable() {
        let content = format!("prefix {} suffix", stored_v2(tag_leaf(TAG_ULID)));
        let tag_names = HashMap::from([(TAG_ULID.to_string(), "rust".to_string())]);
        let out = rewrite_inline_queries_for_export(&content, &tag_names, &HashMap::new());

        // NON-TAUTOLOGY: the original opaque `v2:` payload must be gone.
        assert!(!out.contains("v2:"), "opaque v2 payload survived: {out}");
        assert!(out.contains("v2n:"), "expected the names marker: {out}");
        // Human-readable: the resolved NAME appears in plaintext.
        assert!(out.contains("tag:rust"), "expected readable desc: {out}");
        // The raw tag ULID must not appear as a plaintext description token.
        assert!(
            !out.contains(&format!("tag:{TAG_ULID}")),
            "raw ULID leaked into desc: {out}"
        );
        // Surrounding text preserved.
        assert!(out.starts_with("prefix ") && out.ends_with(" suffix"));
    }

    #[test]
    fn export_keeps_unresolved_ulid_in_payload_not_in_desc() {
        // A ULID with no entry in either map (deleted target): the desc keeps
        // the id (best-effort), but nothing crashes and the token still becomes
        // the readable `v2n:` form.
        let content = stored_v2(tag_leaf(TAG_ULID));
        let out = rewrite_inline_queries_for_export(&content, &HashMap::new(), &HashMap::new());
        assert!(out.contains("v2n:"), "still emits names form: {out}");
        // The readable description must NOT surface the bare opaque ULID; it is
        // marked unresolved instead.
        assert!(
            out.contains("tag:(unresolved)"),
            "expected unresolved marker: {out}"
        );
        assert!(
            !out.contains(&format!("tag:{TAG_ULID}")),
            "raw ULID must not reach the description: {out}"
        );
    }

    #[test]
    fn import_remaps_name_back_to_new_ulid_roundtrip() {
        // Export with a name map, then import with a fresh-vault name→id map.
        let content = stored_v2(tag_leaf(TAG_ULID));
        let tag_names = HashMap::from([(TAG_ULID.to_string(), "rust".to_string())]);
        let exported = rewrite_inline_queries_for_export(&content, &tag_names, &HashMap::new());

        const NEW_TAG: &str = "01NEWTAG000000000000NEW01";
        let resolved_tag_tokens = HashMap::from([("rust".to_string(), NEW_TAG.to_string())]);
        let imported =
            rewrite_inline_queries_for_import(&exported, &HashMap::new(), &resolved_tag_tokens);

        // Back to the canonical stored form, now targeting the NEW vault's tag.
        assert!(
            imported.contains("v2:"),
            "expected canonical v2 form: {imported}"
        );
        assert!(
            !imported.contains("v2n:"),
            "names form must be gone: {imported}"
        );
        let payload = imported
            .strip_prefix("{{query ")
            .and_then(|s| s.strip_suffix("}}"))
            .unwrap();
        let spec = decode_v2(payload).expect("decodes");
        match spec.filter {
            FilterExpr::Leaf {
                primitive: FilterPrimitive::Tag { tag },
            } => assert_eq!(tag, NEW_TAG, "ref must remap to the new vault's tag id"),
            other => panic!("unexpected filter: {other:?}"),
        }
        // The OLD vault's ULID must not survive the roundtrip.
        assert!(!imported.contains(TAG_ULID), "old ULID leaked: {imported}");
    }

    #[test]
    fn import_leaves_unresolved_name_as_name() {
        let content = stored_v2(tag_leaf(TAG_ULID));
        let tag_names = HashMap::from([(TAG_ULID.to_string(), "ghost".to_string())]);
        let exported = rewrite_inline_queries_for_export(&content, &tag_names, &HashMap::new());
        // Empty resolve maps ⇒ name kept; still a valid v2 payload, no crash.
        let imported =
            rewrite_inline_queries_for_import(&exported, &HashMap::new(), &HashMap::new());
        let payload = imported
            .strip_prefix("{{query ")
            .and_then(|s| s.strip_suffix("}}"))
            .unwrap();
        let spec = decode_v2(payload).expect("decodes");
        match spec.filter {
            FilterExpr::Leaf {
                primitive: FilterPrimitive::Tag { tag },
            } => assert_eq!(tag, "ghost", "unresolved name kept verbatim"),
            other => panic!("unexpected filter: {other:?}"),
        }
    }

    #[test]
    fn collect_export_ulids_gathers_embedded_refs() {
        let content = stored_v2(FilterExpr::And {
            children: vec![
                tag_leaf(TAG_ULID),
                FilterExpr::Leaf {
                    primitive: FilterPrimitive::ChildOf {
                        parent: PAGE_ULID.to_string(),
                    },
                },
            ],
        });
        let mut set = HashSet::new();
        collect_export_ref_ulids(&content, &mut set);
        assert!(set.contains(TAG_ULID));
        assert!(set.contains(PAGE_ULID));
    }

    #[test]
    fn corrupt_payload_left_verbatim() {
        let content = "{{query v2:!!!not-base64!!!}}";
        // `!` is outside the export regex's base64url class, so the token never
        // matches → returned unchanged (no panic).
        let out = rewrite_inline_queries_for_export(content, &HashMap::new(), &HashMap::new());
        assert_eq!(out, content);
    }

    #[test]
    fn page_kind_ref_roundtrips_via_page_map() {
        let content = stored_v2(FilterExpr::Leaf {
            primitive: FilterPrimitive::ChildOf {
                parent: PAGE_ULID.to_string(),
            },
        });
        let page_titles = HashMap::from([(PAGE_ULID.to_string(), "My Page".to_string())]);
        let exported = rewrite_inline_queries_for_export(&content, &HashMap::new(), &page_titles);
        assert!(
            exported.contains("child-of:My Page"),
            "readable: {exported}"
        );

        const NEW_PAGE: &str = "01NEWPAGE00000000000NEW01";
        let resolved_page_links = HashMap::from([("My Page".to_string(), NEW_PAGE.to_string())]);
        let imported =
            rewrite_inline_queries_for_import(&exported, &resolved_page_links, &HashMap::new());
        let payload = imported
            .strip_prefix("{{query ")
            .and_then(|s| s.strip_suffix("}}"))
            .unwrap();
        let spec = decode_v2(payload).unwrap();
        match spec.filter {
            FilterExpr::Leaf {
                primitive: FilterPrimitive::ChildOf { parent },
            } => assert_eq!(parent, NEW_PAGE),
            other => panic!("unexpected: {other:?}"),
        }
    }
}
