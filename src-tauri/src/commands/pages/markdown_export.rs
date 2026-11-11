//! Rendering a page or a block run as Markdown and the loaders that feed it:
//! [`PageExportData`] and [`load_page_export_data`], [`render_page_markdown`],
//! [`render_page_document`], [`render_clipboard_source`], [`push_bullet`],
//! [`push_block_bullet`] and [`render_frontmatter`].

use super::*;

/// One projected `block_properties` row destined for the exported YAML
/// frontmatter (#384). A row stores its value in exactly one of the typed
/// columns; the emit loop in [`export_page_markdown_inner`] picks the populated
/// one. Lifted to module scope (#1920) from the function body for readability.
pub(super) struct FrontmatterRow {
    pub(super) key: String,
    pub(super) value_text: Option<String>,
    pub(super) value_date: Option<String>,
    pub(super) value_num: Option<f64>,
    pub(super) value_ref: Option<String>,
    pub(super) value_bool: Option<i64>,
}

/// Render a [`FrontmatterRow`]'s single populated value column as plain text
/// (#2962). Shared by the page-frontmatter emit loop and the descendant
/// `key:: value` property emit loop in [`export_page_markdown_inner`] so both
/// paths resolve a `block_properties` row identically.
///
/// Precedence: date, then text, then ref (`[[Title]]` where `link` gives the
/// target's title, else the raw id, #6277 F3), then numeric, then bool. A
/// `block_properties` row stores its value in exactly one column (enforced by
/// the `exactly_one_value` CHECK), so at most one branch ever fires; the
/// ordering is a defensive fallback, not a real precedence rule.
fn frontmatter_row_value<'a>(
    prop: &FrontmatterRow,
    link: impl Fn(&str) -> Option<&'a str>,
) -> String {
    if let Some(d) = prop.value_date.as_deref() {
        d.to_string()
    } else if let Some(t) = prop.value_text.as_deref() {
        t.to_string()
    } else if let Some(rf) = prop.value_ref.as_deref().filter(|s| !s.is_empty()) {
        link(rf).map_or_else(|| rf.to_string(), |title| format!("[[{title}]]"))
    } else if let Some(n) = prop.value_num {
        // Render integers without a trailing ".0"; keep fractional values
        // as-is. `{n}` on an f64 already emits "3" for 3.0 in Rust's default
        // float formatting, so no lossy `as i64` cast is needed.
        format!("{n}")
    } else if let Some(b) = prop.value_bool {
        if b != 0 {
            "true".to_string()
        } else {
            "false".to_string()
        }
    } else {
        String::new()
    }
}

/// The title `names` writes the ref-typed value `id` with, as `[[Title]]`
/// (#6277 F3): the target page's under [`Names::Always`], and under
/// [`Names::ReadBack`] only where the link reads back as that page, both as a
/// ref value is read (`ref_name`, then the link rule in the page's space) and
/// as one link: so not for a title two pages share and the lower id holds, a
/// page of another space, or a title holding `]` or a line break. Under
/// either policy, not for a title shaped like a block id, which reads back as
/// that id.
fn ref_link<'a>(data: &'a PageExportData, names: Names, id: &str) -> Option<&'a str> {
    let title = data.ref_titles.get(id)?;
    let name = title.trim();
    if BlockId::from_string(name).is_ok_and(|block| block.as_str() == name) {
        return None;
    }
    let link = format!("[[{title}]]");
    let reads_back = || {
        HUMAN_PAGE_LINK_RE
            .find(&link)
            .is_some_and(|m| m.as_str() == link)
            && data.name_snapshot.pages.find(title) == Some(id)
    };
    (names == Names::Always || reads_back()).then_some(title.as_str())
}

/// Everything [`export_page_markdown_inner`] reads from the database, resolved
/// under the single #660 snapshot transaction before any rendering starts.
///
/// A struct rather than a dozen parameters: the split of this function (#4639)
/// separates "read the vault" from "render the markdown", and the seam between
/// them is exactly this set. Grouping it also keeps the ordering guarantee
/// visible — every field is read inside one `BEGIN DEFERRED` snapshot, so the
/// renderer cannot observe a half-updated vault.
pub(super) struct PageExportData {
    pub(super) page: BlockRow,
    pub(super) descendants: Vec<BlockRow>,
    pub(super) attachments_by_block: HashMap<String, Vec<(String, String)>>,
    pub(super) tag_names: HashMap<String, String>,
    pub(super) page_titles: HashMap<String, String>,
    pub(super) block_ref_replacement: HashMap<String, String>,
    /// The page's blocks a file anchors with their `^ID` (#6277): those a
    /// block ref or embed from any page, a ref-typed property value or an
    /// attachment addresses, so a link to one reads back as the block. Read
    /// under [`Anchors::Addressed`] only.
    pub(super) addressed_blocks: HashSet<String>,
    pub(super) descendant_properties: HashMap<String, Vec<FrontmatterRow>>,
    pub(super) list_styles: HashMap<String, String>,
    pub(super) ref_titles: HashMap<String, String>,
    pub(super) properties: Vec<FrontmatterRow>,
    pub(super) aliases: Vec<String>,
    pub(super) tag_names_fm: Vec<String>,
    /// Read by the buffer and the clipboard only, to decide which names they
    /// may write.
    pub(super) name_snapshot: NameSnapshot,
}

/// What a page is read for, which decides what [`load_page_export_data`]
/// reads beyond the block tree, its references and its blocks' properties.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum PageRead {
    /// An export: the attachments, the page's own properties, aliases and
    /// tags, and the titles of the pages ref-typed property values name.
    Export,
    /// The buffer, the clipboard and a buffer save: the page's own
    /// properties, aliases and tags (#5160 S8), and the names a block and a
    /// ref-typed value may be written with.
    Buffer,
    /// A duplicate, which writes every id raw: nothing more.
    Duplicate,
    /// The mirror's file: the buffer's reads and the blocks something
    /// addresses, which alone carry an anchor.
    File,
}

/// How a render writes a page's block tree, each block laid out as a Document
/// buffer lays it out (#5691), which `import::parse_document_outline` reads
/// back as exactly this tree: a plain block is its own paragraph, a list block
/// carries its marker and a task is `- [ ] x`, which has no list style (D3), or
/// a `todo_state::` line for a state outside the checkbox alphabet; a blank
/// line separates blocks but neighbouring list lines (D1), a plain block under
/// another block is a `+` item and a line holding only `\` an empty line (D4).
/// Two policies tell the renderings apart (#6277 E4): which ids it writes as
/// names, and which blocks carry their `^ID`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct RenderMode {
    pub(super) names: Names,
    pub(super) anchors: Anchors,
}

/// Which tag, page and block ids a render writes as names and links.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Names {
    /// Every id that resolves, and a ref-typed value as a link to its page:
    /// an export, for other tools, which a `Markdown` file import reads as a
    /// paste does (#6277 decision 1).
    Always,
    /// Only a name that reads back as the same id ([`humanise_refs_for_source`],
    /// [`ref_link`]): text that comes back to Agaric, the buffer, the
    /// clipboard, the mirror's file and the page an MCP agent reads.
    ReadBack,
}

/// Which blocks a render writes with their `^ID`. A block that leaves a fence
/// open, or that alone reads back as other content, as one ending in ` ^` and
/// a block id does, carries it under every policy.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Anchors {
    /// Those something addresses (#6277 decision 6), so a link to one reads
    /// back as the block: the files, an export and the mirror's, which an
    /// import reads with its title rules ([`DocumentLayout::place`]).
    Addressed,
    /// Only those that need one: a block copy.
    Needed,
    /// Every block, so a save or an agent can name it: the buffer Edit as
    /// Markdown edits, which an MCP agent reads and saves too, and the
    /// renderings Duplicate and a template copy read back.
    Every,
}

impl RenderMode {
    /// The buffer: [`Names::ReadBack`] and [`Anchors::Every`].
    pub(super) const DOCUMENT: Self = Self {
        names: Names::ReadBack,
        anchors: Anchors::Every,
    };
}

/// A page as the Markdown mirror writes its file (#5363): the text, and for
/// each of its lines the id of the block that starts there, `None` on every
/// other line, both from one render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageFile {
    pub text: String,
    pub line_ids: Vec<Option<String>>,
    /// The page's buffer from the same read, every block anchored: the base
    /// an ingest of this text saves against.
    pub buffer: String,
}

/// The page's file: its front matter and block tree, with
/// [`Names::ReadBack`] and [`Anchors::Addressed`].
pub(super) fn render_page_file(data: &PageExportData) -> PageFile {
    let mut text = String::new();
    let mode = RenderMode {
        names: Names::ReadBack,
        anchors: Anchors::Addressed,
    };
    render_frontmatter(&mut text, data, mode.names);
    let starts = render_block_tree(&mut text, data.page.id.as_str(), data, mode);
    let line_ids = block_start_lines(&text, &starts);
    let (buffer, _) = render_page_document(data);
    PageFile {
        text,
        line_ids,
        buffer,
    }
}

/// One entry per line of `text`, each block's id, from `starts`, on the line
/// the block starts on. A block's offset includes the blank line written
/// before it, which is never its own first line: a bare empty first line is
/// written `\`.
fn block_start_lines(text: &str, starts: &[(String, usize)]) -> Vec<Option<String>> {
    let mut ids = vec![None; text.split('\n').count()];
    let (mut line, mut at) = (0, 0);
    for (id, start) in starts {
        let start = start + usize::from(text[*start..].starts_with('\n'));
        line += text[at..start].matches('\n').count();
        at = start;
        ids[line] = Some(id.clone());
    }
    ids
}

/// The page's buffer, its front matter and then its block tree in
/// [`RenderMode::DOCUMENT`], every block with its `^ID`, and the ids of the
/// blocks it holds, in order.
pub(super) fn render_page_document(data: &PageExportData) -> (String, Vec<String>) {
    let (output, starts) = render_page_document_spans(data);
    (output, starts.into_iter().map(|(id, _)| id).collect())
}

/// [`render_page_document`], with each block's id and the byte offset it
/// starts at, the blank line before it included, in render order.
pub(super) fn render_page_document_spans(data: &PageExportData) -> (String, Vec<(String, usize)>) {
    let mut output = String::new();
    render_frontmatter(&mut output, data, RenderMode::DOCUMENT.names);
    let starts = render_block_tree(
        &mut output,
        data.page.id.as_str(),
        data,
        RenderMode::DOCUMENT,
    );
    (output, starts)
}

/// Writes one block where `layout` places it ([`DocumentLayout::place`]),
/// then, at its text's column, the reserved-column task metadata, the block's
/// custom `key:: value` properties, and its non-inline attachments, which an
/// export's read alone loads. The orphan safety net renders a stray through this same path
/// at depth 0, so a stray and a walked block cannot drift apart.
fn render_block(
    output: &mut String,
    block: &BlockRow,
    depth: usize,
    data: &PageExportData,
    list_ordinals: &HashMap<String, usize>,
    mode: RenderMode,
    layout: &mut DocumentLayout,
) {
    let PageExportData {
        attachments_by_block,
        descendant_properties,
        list_styles,
        ..
    } = data;
    let id = block.id.clone().into_string();
    let content = block.content.as_deref().unwrap_or("");
    let list_marker = list_marker_for(&id, list_styles, list_ordinals);
    let task_marker = task_marker(block);
    let file = mode.anchors == Anchors::Addressed;
    let (indent, list_marker, prop_indent) = layout.place(output, block, depth, list_marker, file);
    let props = descendant_properties
        .get(&id)
        .map_or(&[][..], Vec::as_slice);
    let task = (!task_marker.is_empty()).then(|| TaskLine::of(block, props));
    let markers = (indent.as_str(), list_marker.as_str(), task_marker.as_str());
    push_bullet(output, block, markers, task.as_ref(), data, mode);
    let written = task.as_ref().map_or(&[][..], |task| task.keys.as_slice());

    // #1916 — task metadata (TODO/DONE state, priority, scheduled/due
    // dates) lives in the reserved `blocks` columns, not in
    // `block_properties`, so it is invisible to the content render above.
    // Emit each populated column as a `key:: value` property line at the
    // block's text column, which every reader attaches to the block, and the
    // apply path routes the reserved keys `todo_state` / `priority` /
    // `due_date` / `scheduled_date` into their columns via
    // `typed_property_args_for_string_value`. A state already written as a
    // checkbox is not written twice.
    push_column_lines(
        output,
        block,
        &prop_indent,
        !task_marker.is_empty(),
        written,
    );

    // #2962 — custom `block_properties` on this block (anything NOT one
    // of the 4 reserved `blocks` columns above) round-trip the same way:
    // one `key:: value` line per property at the block's text column, which
    // the readers read back into `block.properties`. `descendant_properties` was
    // batch-read once for the whole subtree, so this is a HashMap lookup,
    // not a per-block query. A ref-typed value is a link where `mode` writes
    // its name ([`ref_link`]). Every mode quotes a value its line cannot carry
    // as it is (#5160 X5, #6277 A2).
    let link = |id: &str| ref_link(data, mode.names, id);
    // `completed_at` is the app's: only a done task's `✅` writes it.
    for prop in props
        .iter()
        .filter(|prop| prop.key != "completed_at" && !written.contains(&prop.key.as_str()))
    {
        let value = import::write_source_property_value(&frontmatter_row_value(prop, link));
        output.push_str(&format!("{prop_indent}{}:: {value}\n", prop.key));
    }

    // #2961 — emit a link line for each block-scoped (non-inline)
    // attachment, a plain `+` child of this block. Skips any
    // attachment whose id already appears as an `attachment:<id>` token
    // in `content` — that's an inline image, already rendered above by
    // `push_bullet` — so only
    // genuine file attachments (PDFs/docs/images with no inline token)
    // get a line here. Only an export's read loads them: in the buffer,
    // attachments have their own UI.
    if let Some(atts) = attachments_by_block.get(&id) {
        for (att_id, filename) in atts {
            if content.contains(&format!("attachment:{att_id}")) {
                continue;
            }
            let label = attachment_link_label(filename);
            output.push_str(&format!("{prop_indent}+ [{label}](attachment:{att_id})\n"));
        }
    }
}

/// A block's reserved columns as `key:: value` lines at `indent`: its task
/// state unless its checkbox writes it, and each column but those its Tasks
/// signifiers wrote (`written`).
fn push_column_lines(
    output: &mut String,
    block: &BlockRow,
    indent: &str,
    checkbox: bool,
    written: &[&str],
) {
    let todo_state = block.todo_state.as_deref().filter(|_| !checkbox);
    for (key, value) in [
        ("todo_state", todo_state),
        ("priority", block.priority.as_deref()),
        ("scheduled_date", block.scheduled_date.as_deref()),
        ("due_date", block.due_date.as_deref()),
    ] {
        if let Some(v) = value.filter(|s| !s.is_empty() && !written.contains(&key)) {
            output.push_str(&format!("{indent}{key}:: {v}\n"));
        }
    }
}

/// Where a Document buffer's walk stands (#5691): for each open depth, the
/// column its block's children are written at, and whether the block before
/// opens with a marker.
#[derive(Default)]
struct DocumentLayout {
    open: Vec<usize>,
    previous_marked: Option<bool>,
}

impl DocumentLayout {
    /// Place `block`, at `depth`, in a Document buffer: write the blank line
    /// before it, unless it and the block before both open with a marker
    /// (D1), and return its indent, its marker and the indent of its property
    /// lines and children. A block with a task state in the checkbox alphabet
    /// is a task, whatever its `list_marker` (D3), and one with another state
    /// has no marker. A plain block is bare at the top, but a `+` item under
    /// any block, where an indented bare line would continue a list block (D4)
    /// and read as code to other tools past four columns (decision 2, #6277),
    /// where it opens the buffer with `---`, which would open front matter,
    /// and where it is the first block of a `file` (an export or the mirror's)
    /// and opens with `# `, which an import takes for the page's title
    /// (`import::strip_title_heading`) or, over `---` lines, for an older
    /// export's title over its front matter.
    /// A bare parent's children sit two columns in, the `+ ` marker's width.
    fn place(
        &mut self,
        output: &mut String,
        block: &BlockRow,
        depth: usize,
        list_marker: String,
        file: bool,
    ) -> (String, String, String) {
        self.open.truncate(depth);
        let parent = self.open.last().copied();
        let column = parent.unwrap_or(0);
        let content = block.content.as_deref().unwrap_or("");
        let opens_misread = (output.is_empty() && content.starts_with("---"))
            || (file && self.previous_marked.is_none() && content.starts_with("# "));
        let marker = match block.todo_state.as_deref() {
            Some(state) if import::task_marker_for(state).is_some() => "- ".to_string(),
            None if !list_marker.is_empty() => list_marker,
            _ if parent.is_some() || opens_misread => "+ ".to_string(),
            _ => String::new(),
        };
        let marked = !marker.is_empty();
        if self
            .previous_marked
            .is_some_and(|previous| !(previous && marked))
        {
            output.push('\n');
        }
        self.previous_marked = Some(marked);
        let child = column + if marked { marker.len() } else { 2 };
        self.open.push(child);
        (" ".repeat(column), marker, " ".repeat(child))
    }
}

/// The checkbox a bullet writes for the block's task state: none for a state
/// outside the checkbox alphabet, which stays a `todo_state::` line.
pub(super) fn task_marker(block: &BlockRow) -> String {
    block
        .todo_state
        .as_deref()
        .and_then(import::task_marker_for)
        .map(|marker| format!("[{marker}] "))
        .unwrap_or_default()
}

/// How a checkbox task's first line is written (#6277 D3): its fields as the
/// Tasks signifiers at its end, and its own signifiers escaped where they
/// would not read back as its text ([`import::write_task_fields`]).
struct TaskLine {
    signifiers: Vec<String>,
    /// The keys the signifiers write, which write no `key::` line.
    keys: Vec<&'static str>,
    done: bool,
}

impl TaskLine {
    /// The task line of `block`, a checkbox task holding `props`. A rule with
    /// a bound stays `repeat*::` lines, as does any value no signifier reads
    /// back as ([`import::task_signifier`]).
    fn of(block: &BlockRow, props: &[FrontmatterRow]) -> Self {
        let done = block.todo_state.as_deref() == Some("DONE");
        let prop = |key: &str| {
            let row = props.iter().find(|row| row.key == key)?;
            Some(frontmatter_row_value(row, |_| None))
        };
        let bounded = prop("repeat-until").is_some() || prop("repeat-count").is_some();
        let mut line = Self {
            signifiers: Vec::new(),
            keys: Vec::new(),
            done,
        };
        for key in import::TASK_SIGNIFIER_KEYS {
            let value = match key {
                "priority" => block.priority.clone(),
                "scheduled_date" => block.scheduled_date.clone(),
                "due_date" => block.due_date.clone(),
                "repeat" if bounded => None,
                _ => prop(key),
            };
            if let Some(signifier) = value.and_then(|v| import::task_signifier(key, &v, done)) {
                line.signifiers.push(signifier);
                line.keys.push(key);
            }
        }
        line
    }

    /// `text`, the task's content, with its first line written as a task line.
    fn write(&self, text: &str) -> String {
        let (first, rest) = text.split_once('\n').unzip();
        let first = import::write_task_fields(first.unwrap_or(text), &self.signifiers, self.done);
        match rest {
            Some(rest) => format!("{first}\n{rest}"),
            None => first,
        }
    }
}

/// A block's content with its tag, page and block ids resolved to names and
/// links and its inline queries made readable, as an export writes it, less
/// the export's anchor.
pub(super) fn named_block_text(content: &str, data: &PageExportData) -> String {
    let resolved = resolve_ulids_for_export(
        content,
        &data.tag_names,
        &data.page_titles,
        &data.block_ref_replacement,
    );
    // #2968 — rewrite structured `{{query v2:…}}` payloads to the readable,
    // roundtrip-safe `v2n:` names form (resolving embedded tag/page ULIDs).
    super::inline_query_md::rewrite_inline_queries_for_export(
        &resolved,
        &data.tag_names,
        &data.page_titles,
    )
}

/// A block as `mode` writes it: its text with every name
/// ([`named_block_text`]) or with those that read back, and its `^ID` where
/// [`Anchors`] puts one. A checkbox task's first line is its [`TaskLine`].
///
/// Whether a name may replace an id that must read back depends on whether
/// the parser will read the block as code, which the bullet's fence tracking
/// decides; so the raw bullet is written first, and rewritten with names when
/// they read back.
fn push_bullet(
    output: &mut String,
    block: &BlockRow,
    (indent, list_marker, task_marker): (&str, &str, &str),
    task: Option<&TaskLine>,
    data: &PageExportData,
    mode: RenderMode,
) {
    let id = block.id.as_str();
    let content = block.content.as_deref().unwrap_or("");
    let anchored = match mode.anchors {
        Anchors::Every => true,
        Anchors::Addressed => data.addressed_blocks.contains(id),
        Anchors::Needed => false,
    };
    let push = |output: &mut String, content: &str| {
        let line = task.map_or_else(|| content.to_string(), |task| task.write(content));
        if anchored {
            push_anchored_bullet(output, indent, list_marker, task_marker, &line, id)
        } else {
            let markers = (indent, list_marker, task_marker);
            push_clipboard_bullet(output, markers, &line, content, id)
        }
    };
    if mode.names == Names::Always {
        push(output, &named_block_text(content, data));
        return;
    }
    let start = output.len();
    let is_code = push(output, content);
    // A copy leaves its page, so a ref in it names its target's page.
    let own_page = mode.anchors != Anchors::Needed;
    let Some(named) = humanise_refs_for_source(
        content,
        is_code,
        &data.tag_names,
        &data.page_titles,
        &data.name_snapshot,
        own_page,
    ) else {
        return;
    };
    output.truncate(start);
    push(output, &named);
}

/// `written`, a Document block that reads back as `content`, without its
/// `^id`, unless the block needs it to read back as a paste reads it: when the
/// block leaves a fence open, which the anchor line ends, or when the block
/// alone reads back as other content, as one ending in ` ^` and a block id
/// does. Returns whether any line is code.
fn push_clipboard_bullet(
    output: &mut String,
    (indent, list_marker, task_marker): (&str, &str, &str),
    written: &str,
    content: &str,
    id: &str,
) -> bool {
    let start = output.len();
    let code = push_block_bullet(output, indent, list_marker, task_marker, written);
    let read_back = import::parse_pasted_text(&output[start..]);
    if !code.open && matches!(read_back.as_slice(), [block] if block.content == content) {
        return code.any;
    }
    output.truncate(start);
    push_anchored_bullet(output, indent, list_marker, task_marker, written, id)
}

/// `content` as a Document block with `^id` at the end of its last line or,
/// when that line is code, on a line of its own, which the parser reads as the
/// end of any fence the block leaves open; also when that line holds nothing,
/// which is written as an escape the anchor would turn into text
/// ([`import::needs_blank_line_escape`]). Returns whether any line is code.
fn push_anchored_bullet(
    output: &mut String,
    indent: &str,
    list_marker: &str,
    task_marker: &str,
    content: &str,
    id: &str,
) -> bool {
    let start = output.len();
    let blank_last = content
        .rsplit_once('\n')
        .is_some_and(|(_, last)| import::needs_blank_line_escape(last));
    if !blank_last {
        // Written with the marker, not appended to: the marker can change the
        // last line's escape (`key::` becomes the property line `key:: ^ID`).
        // Whether the last line is code does not depend on the marker, since
        // fences are told by their prefix.
        let anchored = format!("{content} ^{id}");
        let code = push_block_bullet(output, indent, list_marker, task_marker, &anchored);
        if !code.last {
            return code.any;
        }
        output.truncate(start);
    }
    let code = push_block_bullet(output, indent, list_marker, task_marker, content);
    let column = continuation_indent(indent, list_marker);
    output.push_str(&format!("{column}^{id}\n"));
    code.any
}

/// The indent of a block's continuation lines: its text's column, a bare
/// block's own.
fn continuation_indent(indent: &str, list_marker: &str) -> String {
    format!("{indent}{}", " ".repeat(list_marker.len()))
}

/// The `---` YAML frontmatter block, emitted only when the page carries
/// properties, aliases or tags. A ref value is `"[[Title]]"` where `names`
/// writes its name ([`ref_link`]), else its id.
fn render_frontmatter(output: &mut String, data: &PageExportData, names: Names) {
    let PageExportData {
        properties,
        aliases,
        tag_names_fm,
        ..
    } = data;
    // Frontmatter (if properties, aliases, or tags exist)
    //
    // (#1433) `aliases`/`tags` are emitted as YAML *flow sequences*
    // (`[a, b]`). An item is emitted *bare* only when it is unambiguously a
    // plain string in flow context — i.e. it does not look like a YAML
    // scalar token (`true`/`null`/a number/etc.), does not start with a YAML
    // indicator, has no surrounding whitespace, and contains no
    // flow-significant or control characters. Anything else is emitted as a
    // YAML double-quoted scalar with `\`, `"` and all control characters
    // (`\n`, `\t`, `\r`, and `\xNN` for the rest) escaped, which is valid for
    // *any* string. Legacy scalar property values keep their verbatim
    // emission below. #1920 — the emit helpers now live in `markdown_yaml`;
    // the import side unquotes a flow item in `import::flow_item`.
    use super::markdown_yaml::{yaml_flow_sequence, yaml_scalar_emit};

    if !properties.is_empty() || !aliases.is_empty() || !tag_names_fm.is_empty() {
        output.push_str("---\n");
        if !aliases.is_empty() {
            output.push_str(&format!("aliases: {}\n", yaml_flow_sequence(aliases)));
        }
        if !tag_names_fm.is_empty() {
            output.push_str(&format!("tags: {}\n", yaml_flow_sequence(tag_names_fm)));
        }
        for prop in properties {
            let value = frontmatter_row_value(prop, |id| ref_link(data, names, id));
            // #2715 — route the scalar through the YAML emit helper so a value
            // carrying a newline, a leading `---`, quotes, or other
            // YAML-significant content is quoted / block-scalar-encoded instead
            // of written verbatim (which could inject keys or break out of the
            // frontmatter fence). `yaml_scalar_emit` is symmetric with the
            // import-side `parse_frontmatter` re-parse.
            output.push_str(&yaml_scalar_emit(&prop.key, &value));
        }
        output.push_str("---\n\n");
    }
}

/// The page block's own non-inline attachments, which neither render loop
/// below reaches (#2991).
fn render_page_attachments(output: &mut String, page_id: &str, data: &PageExportData) {
    let PageExportData {
        page,
        attachments_by_block,
        ..
    } = data;
    // #2991 — emit the PAGE block's own non-inline attachments.
    //
    // `attachments_by_block` was batch-fetched above (2b) for the page id
    // AND every descendant, but neither render loop below iterates the page
    // block itself: the DFS loop only walks `descendants`, and the orphan
    // safety net only walks entries of `descendants` not reached by the DFS.
    // An attachment attached directly to the page/title block (rather than
    // to one of its descendant blocks) was therefore fetched but never
    // emitted — silently dropped from the export, the same data-loss class
    // #2961 fixed for descendant blocks, just for the root block.
    //
    // Dedup mirrors the DFS/orphan loops EXACTLY: an attachment id already
    // present as an `attachment:<id>` token in the page's own `content` (an
    // inline image) is skipped here so it isn't double-emitted — it was
    // already rendered inline as part of the `# {title}` line above.
    //
    // Emitted at depth 0 (no indent), right after the front matter and title
    // and before the descendant blocks, each a paragraph of its own: these
    // lines aren't nested under any block (the page has none — its content
    // is the `# Title` heading), so they sit at the same top level as the
    // first-level descendant blocks below.
    if let Some(atts) = attachments_by_block.get(page_id) {
        let page_content = page.content.as_deref().unwrap_or("");
        for (att_id, filename) in atts {
            if page_content.contains(&format!("attachment:{att_id}")) {
                continue;
            }
            let label = attachment_link_label(filename);
            output.push_str(&format!("[{label}](attachment:{att_id})\n\n"));
        }
    }
}

/// CRITICAL: `descendants` is ordered FLAT by `(position, id)` over the
/// keyset — `position` is the *sibling* slot (dense within a parent), so
/// two blocks under different parents can share a position and the global
/// order does NOT guarantee parent-before-child (e.g. a child whose id
/// sorts before its parent's). Emitting in that flat order would both
/// mis-compute depth AND, worse, present a child bullet before its parent
/// bullet, which the importer's document-order parent-stack would
/// mis-reparent. So we re-order the subtree into DFS pre-order here:
/// build `parent_id -> children` (children sorted by `(position, id)`,
/// matching the read order), then walk depth-first from the page root.
/// This guarantees every parent precedes its children and yields the
/// correct depth for indentation.
fn group_children_by_parent<'a>(
    page_id: &str,
    descendants: &'a [BlockRow],
) -> HashMap<String, Vec<&'a BlockRow>> {
    let mut children_by_parent: HashMap<String, Vec<&BlockRow>> = HashMap::new();
    for block in descendants {
        let parent_key = block
            .parent_id
            .as_ref()
            .map_or_else(|| page_id.to_string(), |p| p.clone().into_string());
        children_by_parent
            .entry(parent_key)
            .or_default()
            .push(block);
    }
    for children in children_by_parent.values_mut() {
        // The read query already orders by `(COALESCE(position, sentinel),
        // id)`; preserve that sibling order within each parent.
        children.sort_by(|a, b| {
            let pa = a.position.unwrap_or(NULL_POSITION_SENTINEL);
            let pb = b.position.unwrap_or(NULL_POSITION_SENTINEL);
            pa.cmp(&pb)
                .then_with(|| a.id.clone().into_string().cmp(&b.id.clone().into_string()))
        });
    }
    children_by_parent
}

/// Render the resolved export data as markdown. Pure — no database access, so
/// the whole document is built from one consistent snapshot (#660).
///
/// The block tree is laid out on its own, as if it opened the file: an import
/// drops the `# Title` line before it (`import::strip_title_heading`), and so
/// does a ZIP, so a first block opening with `---` or `# ` is a `+` item there
/// too, not front matter or the title ([`DocumentLayout::place`]).
pub(super) fn render_page_markdown(page_id: &str, data: &PageExportData) -> String {
    // The front matter, at byte 0 where Obsidian and GitHub read it, then the
    // `# Title` line (#6277 A1).
    let mut output = String::new();
    render_frontmatter(&mut output, data, Names::Always);
    let title = data.page.content.as_deref().unwrap_or("Untitled");
    output.push_str(&format!("# {title}\n\n"));
    render_page_attachments(&mut output, page_id, data);
    let mut blocks = String::new();
    let mode = RenderMode {
        names: Names::Always,
        anchors: Anchors::Addressed,
    };
    render_block_tree(&mut blocks, page_id, data, mode);
    output.push_str(&blocks);
    output
}

/// The stretch of `markdown` that starts at `cursor`'s block, or at the top,
/// and ends at the last block start that keeps it within `max_bytes`, never
/// short of one block; with the id of the block the next stretch starts at,
/// or `None` when this one reaches the end (#5402). `starts` is each block's
/// id and start offset, in order. Read in turn, the stretches are `markdown`.
pub(super) fn agent_markdown_stretch(
    markdown: &str,
    starts: &[(String, usize)],
    cursor: Option<&str>,
    max_bytes: usize,
) -> Result<(String, Option<String>), AppError> {
    let begin = match cursor {
        None => 0,
        Some(cursor) => starts
            .iter()
            .find(|(id, _)| id == cursor)
            .map(|(_, start)| *start)
            .ok_or_else(|| {
                AppError::validation(format!(
                    "cursor '{cursor}' names no block on this page any more; read the page \
                     again without a cursor"
                ))
            })?,
    };
    // A stretch stops where a block starts, never before the first block:
    // the front matter comes with it.
    let mut stops = starts
        .iter()
        .skip(1)
        .filter(|(_, start)| *start > begin)
        .map(|(id, start)| (Some(id), *start))
        .chain(std::iter::once((None, markdown.len())));
    let mut stop = stops.next().expect("the end of the page is always a stop");
    for next in stops {
        if next.1 - begin > max_bytes {
            break;
        }
        stop = next;
    }
    Ok((markdown[begin..stop.1].to_owned(), stop.0.cloned()))
}

/// `source`, a buffer with each block's `^ID` written in it, as the text with
/// those anchors removed and the id each of its lines carries: the block's on
/// the line it starts on, none on every other (#5160 A). An anchor ends its
/// block's last line or, when that line is code, is a line of its own, which
/// goes. Everything else is kept as written, so the parse by id reads the text
/// back as the blocks the anchors named. What is not an anchor, a `^word` that
/// is no block id, stays. Public so the command tests can write an edited
/// buffer as the source it was loaded from, anchors and all. CRLF and CR line
/// ends, as some clients send text, are read as the parser reads them, or a
/// line keeps its anchor behind a `\r` (#6277 B1); the parser drops a BOM.
pub fn anchor_free(source: &str) -> (String, Vec<Option<String>>) {
    let (text, ids, _) = anchor_free_kept(source);
    (text, ids)
}

/// [`anchor_free`], with the line of `source`, line ends normalised, that each
/// line of the text was kept from: the mirror maps the ids of one onto the
/// lines of the other (#5363).
pub fn anchor_free_kept(source: &str) -> (String, Vec<Option<String>>, Vec<usize>) {
    let source = source.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<(&str, Option<String>)> =
        source.split('\n').map(|line| (line, None)).collect();
    let mut own_lines = HashSet::new();
    for block in import::parse_document_outline(&source).blocks {
        let (Some(word), Some(start)) = (block.block_anchor, block.line) else {
            continue;
        };
        let Ok(id) = BlockId::from_string(&word) else {
            continue;
        };
        let last = start - 1 + block.content.split('\n').count() - 1;
        let anchor = format!("^{word}");
        if lines
            .get(last + 1)
            .is_some_and(|(line, _)| line.trim() == anchor)
        {
            own_lines.insert(last + 1);
        } else if let Some((line, _)) = lines.get_mut(last) {
            *line = line.strip_suffix(&format!(" {anchor}")).unwrap_or(line);
        }
        if let Some((_, carried)) = lines.get_mut(start - 1) {
            *carried = Some(id.into_string());
        }
    }
    let mut kept = Vec::new();
    let (text, ids): (Vec<&str>, Vec<Option<String>>) = lines
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !own_lines.contains(i))
        .map(|(i, line)| {
            kept.push(i);
            line
        })
        .unzip();
    (text.join("\n"), ids, kept)
}

/// Every descendant of `page_id`, depth-first in sibling order, each through
/// [`render_block`]. Returns the ids it rendered, in render order, each with
/// the byte offset in `output` it starts at, the blank line a Document layout
/// writes before it included.
pub(super) fn render_block_tree(
    output: &mut String,
    page_id: &str,
    data: &PageExportData,
    mode: RenderMode,
) -> Vec<(String, usize)> {
    let children_by_parent = group_children_by_parent(page_id, &data.descendants);
    // #4552 slice 4 — positional ordinals for `ordered` blocks. Computed HERE,
    // once `children_by_parent` is grouped and sibling-sorted, because an
    // ordinal is a function of a block's NEIGHBOURS, which only this assembler
    // knows (`markdown-serialize.ts` sees one block in isolation). Nothing
    // numeric is stored: the number is re-derived on every export, so a
    // reorder renumbers and a hand-written `3.` / `7.` normalises on the first
    // round trip.
    let list_ordinals = compute_list_ordinals(&children_by_parent, &data.list_styles);
    let roots = children_by_parent
        .get(page_id)
        .map_or(&[][..], Vec::as_slice);
    let mut layout = DocumentLayout::default();
    let mut rendered = render_subtrees(
        output,
        roots,
        &children_by_parent,
        &list_ordinals,
        data,
        mode,
        &mut layout,
    );
    let visited: HashSet<String> = rendered.iter().map(|(id, _)| id.clone()).collect();

    // Safety net: any descendant NOT reachable by DFS from the page root
    // (e.g. an orphan whose `parent_id` points outside this subtree while its
    // denormalised `page_id` still names this page) would otherwise be
    // silently dropped — the pre-fix flat loop emitted every descendant. Emit
    // such strays at depth 0 in the read order so the export stays lossless.
    for block in &data.descendants {
        let id = block.id.clone().into_string();
        if visited.contains(&id) {
            continue;
        }
        let start = output.len();
        render_block(output, block, 0, data, &list_ordinals, mode, &mut layout);
        rendered.push((id, start));
    }
    rendered
}

/// `roots` at depth 0 and everything under them, depth-first in sibling
/// order, each through [`render_block`]. Returns the ids it rendered, in
/// render order, each with the byte offset in `output` it starts at, the blank
/// line a Document layout writes before it included.
fn render_subtrees<'a>(
    output: &mut String,
    roots: &[&'a BlockRow],
    children_by_parent: &HashMap<String, Vec<&'a BlockRow>>,
    list_ordinals: &HashMap<String, usize>,
    data: &PageExportData,
    mode: RenderMode,
    layout: &mut DocumentLayout,
) -> Vec<(String, usize)> {
    // Iterative DFS pre-order. A visited set guards against a pathological
    // parent cycle (a block whose ancestor chain loops back) so export can
    // never infinite-loop on corrupt data.
    let mut visited: HashSet<String> = HashSet::new();
    let mut rendered = Vec::new();
    // Stack of (block, depth), pushed in reverse so siblings pop in order.
    let mut stack: Vec<(&BlockRow, usize)> = roots.iter().rev().map(|b| (*b, 0)).collect();
    while let Some((block, depth)) = stack.pop() {
        let id = block.id.clone().into_string();
        if !visited.insert(id.clone()) {
            continue;
        }
        rendered.push((id.clone(), output.len()));
        render_block(output, block, depth, data, list_ordinals, mode, layout);

        // Push this block's children (reversed so they pop in sibling order)
        // at depth + 1.
        if let Some(kids) = children_by_parent.get(&id) {
            for kid in kids.iter().rev() {
                stack.push((kid, depth + 1));
            }
        }
    }
    rendered
}

/// `root` and its subtree as a Document buffer writes them, `root` at depth 0:
/// every block with its `^ID`, which ends a fence the block leaves open and
/// keeps a trailing ` ^word` in its content from reading back as an anchor. A
/// page nested under `root` is not here: `descendants` stops at a nested page.
/// Returns the buffer and the ids it holds, in order.
pub(super) fn render_subtree(data: &PageExportData, root: &BlockRow) -> (String, Vec<String>) {
    let children_by_parent = group_children_by_parent(data.page.id.as_str(), &data.descendants);
    let list_ordinals = compute_list_ordinals(&children_by_parent, &data.list_styles);
    let mut output = String::new();
    let ids = render_subtrees(
        &mut output,
        &[root],
        &children_by_parent,
        &list_ordinals,
        data,
        RenderMode::DOCUMENT,
        &mut DocumentLayout::default(),
    )
    .into_iter()
    .map(|(id, _)| id)
    .collect();
    (output, ids)
}

/// Step 1 of the export read half: the page row, refused unless it is an
/// undeleted `page` block.
async fn load_page_row(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> Result<BlockRow, AppError> {
    // 1. Get the page
    //
    // Filter `deleted_at IS NULL` (mirrors `get_active_block_inner`)
    // so a soft-deleted page surfaces as `NotFound` instead of exporting
    // as `# Title\n\n` with no descendants. The descendant walk below
    // already filters `deleted_at IS NULL`, so prior to this fix the page
    // row itself was the only row that could leak. Inlined here (rather
    // than calling `get_active_block_inner`, which takes `&SqlitePool`)
    // so the page read shares the #660 snapshot tx with the walk below.
    let page = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: agaric_core::ulid::BlockId", block_type, content,
                parent_id as "parent_id: agaric_core::ulid::BlockId", position,
                deleted_at, todo_state, priority, due_date, scheduled_date,
                page_id as "page_id: agaric_core::ulid::BlockId"
           FROM blocks
           WHERE id = ? AND deleted_at IS NULL"#,
        page_id,
    )
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("block '{page_id}'")))?;
    if page.block_type != "page" {
        return Err(AppError::validation("not a page".into()));
    }
    Ok(page)
}

/// Step 2: every undeleted descendant of `page_id`, in render order.
async fn load_descendants(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> Result<Vec<BlockRow>, AppError> {
    // 2. Walk the full descendant subtree, cursor-paginated over the
    //    `(position, id)` keyset on the denormalised `page_id` column.
    //    Loops through every page of results — `next_cursor = None`
    //    ends the walk. Pre-fix this used `list_children` with a hard
    //    `limit = 1000` direct-children cap and silently dropped every
    // Descendant beyond it.
    //
    //    Page size of 200 matches `MAX_PAGE_SIZE` in the pagination
    //    layer; the `+ 1` fetch-limit + `truncate` shape mirrors
    //    `pagination::build_page_response`. `Cursor` and `PageRequest`
    //    are reused from `agaric_store::pagination` as the single source of
    //    truth for keyset cursor encoding (versioning, base64).
    const DESCENDANT_PAGE_SIZE: i64 = 200;
    let mut descendants: Vec<BlockRow> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let req = PageRequest::new(cursor, Some(DESCENDANT_PAGE_SIZE))?;
        let fetch_limit = req.limit + 1;
        let (cursor_flag, cursor_pos, cursor_id): (Option<i64>, i64, &str) =
            match req.after.as_ref() {
                Some(c) => (Some(1), c.position.unwrap_or(NULL_POSITION_SENTINEL), &c.id),
                None => (None, 0, ""),
            };

        // Mirrors `get_page_inner`'s subtree walk: keyset on
        // `(COALESCE(position, sentinel), id)` over `page_id = ?1`, with
        // the page row itself (`id = ?1`) excluded.
        let rows = sqlx::query_as!(
            BlockRow,
            r#"SELECT id as "id!: agaric_core::ulid::BlockId", block_type, content,
                    parent_id as "parent_id: agaric_core::ulid::BlockId", position,
                    deleted_at,
                     todo_state, priority, due_date, scheduled_date,
                    page_id as "page_id: agaric_core::ulid::BlockId"
             FROM blocks
             WHERE page_id = ?1
               AND id != ?1
               AND deleted_at IS NULL
               AND (?2 IS NULL OR (
                    COALESCE(position, ?6) > ?3
                    OR (COALESCE(position, ?6) = ?3 AND id > ?4)))
             ORDER BY COALESCE(position, ?6) ASC, id ASC
             LIMIT ?5"#,
            page_id,                // ?1
            cursor_flag,            // ?2
            cursor_pos,             // ?3
            cursor_id,              // ?4
            fetch_limit,            // ?5
            NULL_POSITION_SENTINEL, // ?6
        )
        .fetch_all(&mut *conn)
        .await?;

        let limit_usize = usize::try_from(req.limit).unwrap_or(usize::MAX);
        let has_more = rows.len() > limit_usize;
        let mut page_rows = rows;
        if has_more {
            page_rows.truncate(limit_usize);
        }

        let next_cursor = if has_more {
            let last = page_rows.last().expect("has_more implies non-empty");
            let cur = Cursor {
                id: last.id.clone().into_string(),
                position: Some(last.position.unwrap_or(NULL_POSITION_SENTINEL)),
                deleted_at: None,
                seq: None,
                rank: None,
            };
            Some(cur.encode()?)
        } else {
            None
        };

        descendants.extend(page_rows);
        match next_cursor {
            None => break,
            Some(s) => cursor = Some(s),
        }
    }
    Ok(descendants)
}

/// Step 2b: block-scoped attachments for the page and its descendants,
/// grouped by owning block.
async fn load_attachments(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    descendants: &[BlockRow],
) -> Result<HashMap<String, Vec<(String, String)>>, AppError> {
    // 2b. (#2961) Batch-fetch block-scoped attachments for the page block
    //     and every descendant, grouped by owning `block_id`.
    //
    //     `attachments` has no "inline" flag: an inline image leaves BOTH a
    //     row here AND a `![filename](attachment:<id>)` token in the owning
    //     block's `content` (same id), as an imported file link leaves a
    //     `[label](attachment:<id>)` token; a non-image file (or an image
    //     dropped with no editor open) leaves ONLY a row. The render loop
    //     below dedups on that token — via a plain substring check against
    //     `attachment:<id>`, which is reliable because ULIDs are unique —
    //     so inline images and links aren't double-emitted while block-file
    //     attachments (previously invisible in export) get a link line.
    //
    //     Mirrors `list_attachments_batch_inner`'s `json_each(?)` batching
    //     and the tag/page-reference batching just below: one query for
    //     the whole subtree instead of one per block. Run through the
    //     #660 snapshot tx (`&mut *conn`), before `tx.commit()`, so it
    //     observes the same consistent read as the rest of the export.
    let mut attachment_block_ids: Vec<String> = Vec::with_capacity(descendants.len() + 1);
    attachment_block_ids.push(page_id.to_string());
    for block in descendants {
        attachment_block_ids.push(block.id.clone().into_string());
    }
    let attachment_ids_json = serde_json::to_string(&attachment_block_ids)?;
    let attachment_rows = sqlx::query!(
        r#"SELECT id, block_id, filename FROM attachments
           WHERE block_id IN (SELECT value FROM json_each(?1))
           ORDER BY created_at ASC, id ASC"#,
        attachment_ids_json,
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut attachments_by_block: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for r in attachment_rows {
        attachments_by_block
            .entry(r.block_id)
            .or_default()
            .push((r.id, r.filename));
    }
    Ok(attachments_by_block)
}

/// The page's blocks something addresses (#6277 decision 6): the target of a
/// block ref or embed from any live block, a ref-typed property value of one,
/// or an attachment's owner. With them, those a value or an attachment holds,
/// which no link names by heading ([`resolve_heading_refs`] reads the same).
async fn load_addressed_blocks(
    conn: &mut sqlx::SqliteConnection,
    descendants: &[BlockRow],
) -> Result<(HashSet<String>, HashSet<String>), AppError> {
    let ids: Vec<&str> = descendants.iter().map(|b| b.id.as_str()).collect();
    let ids_json = serde_json::to_string(&ids)?;
    let rows = sqlx::query!(
        r#"SELECT b.id AS "id!",
                  (EXISTS (SELECT 1 FROM block_properties p JOIN blocks s ON s.id = p.block_id
                           WHERE p.value_ref = b.id AND s.deleted_at IS NULL)
                   OR EXISTS (SELECT 1 FROM attachments a
                              WHERE a.block_id = b.id AND a.deleted_at IS NULL))
                      AS "held!: bool"
           FROM blocks b
           WHERE b.id IN (SELECT value FROM json_each(?1))
             AND (EXISTS (SELECT 1 FROM block_links l JOIN blocks s ON s.id = l.source_id
                          WHERE l.target_id = b.id AND l.kind = 'block_ref'
                            AND s.deleted_at IS NULL)
                  OR EXISTS (SELECT 1 FROM block_properties p JOIN blocks s ON s.id = p.block_id
                             WHERE p.value_ref = b.id AND s.deleted_at IS NULL)
                  OR EXISTS (SELECT 1 FROM attachments a
                             WHERE a.block_id = b.id AND a.deleted_at IS NULL))"#,
        ids_json,
    )
    .fetch_all(&mut *conn)
    .await?;
    let held = rows
        .iter()
        .filter(|r| r.held)
        .map(|r| r.id.clone())
        .collect();
    Ok((rows.into_iter().map(|r| r.id).collect(), held))
}

/// The `#[…]`, `[[…]]` and `((…))` tokens found in a page's descendants,
/// resolved to the names and links the renderer emits.
struct PageReferences {
    tag_names: HashMap<String, String>,
    page_titles: HashMap<String, String>,
    block_ref_replacement: HashMap<String, String>,
    /// The targets of the page's refs to its own blocks.
    addressed_blocks: HashSet<String>,
    /// Each block ref target's page title, which a buffer may name it by.
    block_ref_titles: HashMap<String, String>,
}

/// The `#[…]` / `[[…]]` targets and the `((…))` targets a page's descendants
/// mention, deduped. Two sets because they resolve against different things:
/// a tag/page link names its own block, a block reference names its block's
/// PAGE.
fn collect_reference_ulids(descendants: &[BlockRow]) -> (HashSet<String>, HashSet<String>) {
    // #1920 — canonical path (`agaric_store::cache` defines these; `agaric_store::fts::strip`
    // imports them for its own use).
    use agaric_store::cache::{BLOCK_REF_RE, PAGE_LINK_RE, TAG_REF_RE};

    // 3. Batch-resolve tag/page references: regex-extract the union of
    //    `#[ULID]` and `[[ULID]]` tokens from descendant content, then
    //    issue ONE `json_each(?)` query for the deduped ULID set.
    //    Pre-fix two full-table scans loaded every non-deleted tag /
    // Page in the vault on each export.
    //
    //    The block_type discriminator is applied in Rust rather than in
    //    SQL: the union query returns `(id, block_type, content)` and
    //    the loop fans rows into `tag_names` / `page_titles` per type,
    //    preserving the existing maps' semantics (tags drop NULL
    //    content; pages substitute `"Untitled"`).
    //
    //    #2963 — `((ULID))` block references are collected into a SEPARATE set
    //    (`block_ref_ulids`): unlike a tag / page link they can target a block
    //    of ANY type, and export resolves them against the target's PAGE (title
    //    + same-page-vs-cross-page classification), not the block-type fan-out
    //    used for tags/pages — so they need their own query below.
    let mut ulid_set: HashSet<String> = HashSet::new();
    let mut block_ref_ulids: HashSet<String> = HashSet::new();
    for block in descendants {
        if let Some(content) = block.content.as_deref() {
            for cap in TAG_REF_RE.captures_iter(content) {
                ulid_set.insert(cap[1].to_string());
            }
            for cap in PAGE_LINK_RE.captures_iter(content) {
                ulid_set.insert(cap[1].to_string());
            }
            for cap in BLOCK_REF_RE.captures_iter(content) {
                block_ref_ulids.insert(cap[1].to_string());
            }
            // #2968 — also load the tag/page ULIDs embedded inside a structured
            // `{{query v2:…}}` payload (invisible to the plaintext-token regexes
            // above) so they resolve to names in the readable export below.
            super::inline_query_md::collect_export_ref_ulids(content, &mut ulid_set);
        }
    }
    (ulid_set, block_ref_ulids)
}

/// Step 3: one `json_each(?)` query for the whole deduped tag/page target set,
/// fanned into the two maps by block type.
async fn resolve_tag_and_page_names(
    conn: &mut sqlx::SqliteConnection,
    ulid_set: HashSet<String>,
) -> Result<(HashMap<String, String>, HashMap<String, String>), AppError> {
    let mut tag_names: HashMap<String, String> = HashMap::new();
    let mut page_titles: HashMap<String, String> = HashMap::new();
    if !ulid_set.is_empty() {
        let ulids: Vec<String> = ulid_set.into_iter().collect();
        for (id, block_type, content) in load_live_blocks(conn, &ulids).await? {
            match block_type.as_str() {
                "tag" => {
                    if let Some(c) = content {
                        tag_names.insert(id, c);
                    }
                }
                "page" => {
                    page_titles.insert(id, content.unwrap_or_else(|| "Untitled".to_string()));
                }
                _ => {}
            }
        }
    }
    Ok((tag_names, page_titles))
}

/// The live blocks of `ids`, in one `json_each(?)` query: each one's id,
/// type and content.
pub(super) async fn load_live_blocks(
    conn: &mut sqlx::SqliteConnection,
    ids: &[String],
) -> Result<Vec<(String, String, Option<String>)>, AppError> {
    // sqlx requires `String` (NOT `Vec<String>`) for `json_each(?)`
    // binds — encode the set as a JSON array text and bind that.
    let ids_json = serde_json::to_string(ids)?;
    let rows = sqlx::query!(
        r#"SELECT id, block_type, content FROM blocks
               WHERE id IN (SELECT value FROM json_each(?1))
                 AND deleted_at IS NULL"#,
        ids_json,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.id, r.block_type, r.content))
        .collect())
}

/// Step 3b: resolve `((ULID))` targets to a roundtrip-safe link, and record
/// which of them live on THIS page and so need an `^<ULID>` anchor marker,
/// into `refs`' block-ref fields.
/// They are read from the content as well as from `block_links`
/// ([`load_addressed_blocks`]), which the materializer derives in the
/// background: the page's own `[[#^ULID]]` must find its anchor.
async fn resolve_block_refs(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    block_ref_ulids: HashSet<String>,
    refs: &mut PageReferences,
) -> Result<(), AppError> {
    // 3b. (#2963) Resolve `((ULID))` block references to a human-readable,
    //     roundtrip-safe token, and record which TARGET blocks (those on THIS
    //     page) must carry an Obsidian `^<ULID>` block-anchor marker on their
    //     own exported line so the emitted `[[#^<ULID>]]` link re-imports back
    //     to a real block reference.
    //
    //     For each referenced target we need its owning PAGE (to classify
    //     same-page vs cross-page and, when cross-page, to name it). One
    //     `json_each(?)` query joins each target block to its page block:
    //       * target on THIS page  → emit an anchor-only `[[#^<ULID>]]` link.
    //         The importer's #2510 intra-note anchor pass rewrites it back to a
    //         real `((<new ULID>))` block ref (base is empty ⇒ implicitly this
    //         page), and the `^<ULID>` marker we stamp on the target's line
    //         (see the emit loop) is what that pass matches on.
    //       * target on ANOTHER page → emit `[[<Target Page>#^<ULID>]]`. This
    //         renders as a block link in Obsidian. Read back into a space
    //         where that block still lives on that page, or by a folder import
    //         beside that page's export, which anchors the block (#6277), it
    //         is the block ref again (#5160 D10); anywhere else it degrades to
    //         a page link + a warning. Still strictly better than the opaque
    //         `((ULID))` (which no external tool renders and which the
    //         importer strips entirely).
    //       * target missing / deleted → absent from the map; the resolver
    //         emits a `(unresolved block reference)` literal (never a raw ULID).
    if !block_ref_ulids.is_empty() {
        let ulids: Vec<String> = block_ref_ulids.into_iter().collect();
        let ids_json = serde_json::to_string(&ulids)?;
        let rows = sqlx::query!(
            r#"SELECT b.id AS "id!", b.page_id AS "page_id?", p.content AS "page_title?"
               FROM blocks b
               LEFT JOIN blocks p ON p.id = b.page_id
               WHERE b.id IN (SELECT value FROM json_each(?1))
                 AND b.deleted_at IS NULL"#,
            ids_json,
        )
        .fetch_all(&mut *conn)
        .await?;
        for r in rows {
            if let Some(title) = &r.page_title {
                refs.block_ref_titles.insert(r.id.clone(), title.clone());
            }
            // A target whose denormalised `page_id` equals the page being
            // exported is same-page: anchor-only link + it will get a marker.
            if r.page_id.as_deref() == Some(page_id) {
                refs.addressed_blocks.insert(r.id.clone());
                refs.block_ref_replacement
                    .insert(r.id.clone(), format!("[[#^{}]]", r.id));
            } else {
                // Cross-page (or a target with no page, e.g. a page block):
                // name the target's page (fallback "Untitled") so the link is
                // human-readable.
                let title = r.page_title.unwrap_or_else(|| "Untitled".to_string());
                refs.block_ref_replacement
                    .insert(r.id.clone(), format!("[[{title}#^{}]]", r.id));
            }
        }
    }
    Ok(())
}

/// Steps 3 and 3b: one batched lookup per token flavour over the whole subtree.
async fn resolve_references(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    descendants: &[BlockRow],
) -> Result<PageReferences, AppError> {
    let (ulid_set, block_ref_ulids) = collect_reference_ulids(descendants);
    let (tag_names, page_titles) = resolve_tag_and_page_names(conn, ulid_set).await?;
    let mut refs = PageReferences {
        tag_names,
        page_titles,
        block_ref_replacement: HashMap::new(),
        addressed_blocks: HashSet::new(),
        block_ref_titles: HashMap::new(),
    };
    resolve_block_refs(conn, page_id, block_ref_ulids, &mut refs).await?;
    Ok(refs)
}

/// Step 4: the page's own frontmatter properties.
async fn load_page_properties(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> Result<Vec<FrontmatterRow>, AppError> {
    // 4. Get page properties for frontmatter.
    //
    // #384: exclude internal/system-managed keys so they don't leak into the
    // exported frontmatter. The explicit list is required because it is not
    // `op::is_builtin_property_key`'s set: `template` is not built in, and
    // the repeat rule is built in but exported. The list below is `space` /
    // `is_space` / `template` plus the lifecycle keys that get stored in
    // `block_properties` (the reserved-column keys —
    // todo_state/priority/due_date/scheduled_date — live on the `blocks`
    // table, never in `block_properties`, so they never appear here).
    //
    // #384: also project value_ref and value_num so numeric and
    // page-reference properties render instead of silently dropping to
    // empty (the old query only selected value_text + value_date).
    //
    // DRIFT WARNING (#3797) — the `key NOT IN (…)` list below is duplicated in
    // FOUR places and nothing checks them against each other. Change one,
    // change all four: (1) here; (2) the descendant-property query further
    // down this function; (3) `FRONTMATTER_RESERVED_KEYS` in
    // `agaric-engine/src/import.rs`; (4) `INLINE_PROPERTY_RESERVED_KEYS` in
    // `src/lib/inline-property-parse.ts`. Copies (1) and (2) are literal SQL,
    // so grepping for either constant name will NOT find them.
    //
    // ASYMMETRY (#4552 slice 4) — `listStyle` is added to the two EXPORT
    // copies (this one and the descendant-property query below) and
    // DELIBERATELY NOT to the two import/parse copies
    // (`FRONTMATTER_RESERVED_KEYS`, `INLINE_PROPERTY_RESERVED_KEYS`). The four
    // copies are not one set with four spellings; they answer two different
    // questions, and `listStyle` answers them differently:
    //
    //   * EXPORT ("may this key be written as a `key:: value` line?") — NO.
    //     A styled block already exports its list-ness as the `- ` / `N. `
    //     marker emitted by the descendant walk below. Emitting the property
    //     line as well would render the marker twice on re-import (once as
    //     structure, once as a visible property row).
    //   * IMPORT ("must this key be refused when it appears in a file?") — NO,
    //     it must be accepted. `listStyle` is a user-settable `select`
    //     property (built in since #5841): typing `listStyle:: bullet`
    //     inline, or hand-writing it in a markdown file, must keep working.
    //     The reserved keys are excluded there because they are column-backed
    //     or lifecycle-managed and would FAIL `set_property_in_tx`;
    //     `listStyle` has no such constraint.
    //
    // So this is an export-only suppression of a REDUNDANT line, not a
    // reservation of the key — and adding `listStyle` to the other two copies
    // would be a regression, not a consistency fix.
    // `src/lib/__tests__/inline-property-parse.test.ts` pins its absence from
    // `INLINE_PROPERTY_RESERVED_KEYS` so a later "add it everywhere" edit
    // fails loudly.
    let property_rows = sqlx::query!(
        r#"SELECT key AS "key!", value_text, value_date, value_num, value_ref,
                  value_bool AS "value_bool: i64"
           FROM block_properties
           WHERE block_id = ?1
             AND key NOT IN (
                'space', 'is_space', 'created_at', 'completed_at',
                'repeat-seq', 'repeat-origin', 'template', 'listStyle'
             )"#,
        page_id,
    )
    .fetch_all(&mut *conn)
    .await?;

    let properties: Vec<FrontmatterRow> = property_rows
        .into_iter()
        // #2722 — never emit a `block_properties` row named `aliases`/`tags` as
        // a property line: those keys are emitted as frontmatter from their OWN
        // sources (`page_aliases` rows / `block_tags` associations, read in step
        // 4b below). A page carrying a legacy stale `aliases`/`tags` TEXT
        // property (left by a pre-#2722 re-import) would otherwise DOUBLE-emit
        // the key (a duplicate YAML key). Filtered in Rust — not the SQL `NOT
        // IN` — so the query string (and its offline `.sqlx` entry) is
        // unchanged. New imports intercept both keys and never create such rows,
        // so this is the belt-and-braces guard for pre-existing data.
        .filter(|r| r.key != "aliases" && r.key != "tags")
        .map(|r| FrontmatterRow {
            key: r.key,
            value_text: r.value_text,
            value_date: r.value_date,
            value_num: r.value_num,
            value_ref: r.value_ref,
            value_bool: r.value_bool,
        })
        .collect();
    Ok(properties)
}

/// Step 4a's two maps: `key:: value` rows per descendant, and the list-style
/// marker each descendant renders with.
struct DescendantProperties {
    properties: HashMap<String, Vec<FrontmatterRow>>,
    list_styles: HashMap<String, String>,
}

/// Step 4a: both maps in one pass over the subtree.
async fn load_descendant_properties(
    conn: &mut sqlx::SqliteConnection,
    descendants: &[BlockRow],
) -> Result<DescendantProperties, AppError> {
    // 4a. (#2962) Batch-read `block_properties` for EVERY descendant block in
    // ONE query — mirrors the page-property batch read directly above — so
    // custom `key:: value` properties on descendant blocks round-trip
    // through export instead of being silently dropped (pre-fix, only the 4
    // reserved `blocks` columns were emitted per descendant; any custom
    // `block_properties` row was invisible to the exporter even though
    // import faithfully parses and persists it).
    //
    // The exclusion list is identical to the page-property query above: the
    // import parser (`FRONTMATTER_RESERVED_KEYS` in
    // `agaric-engine::import::parse_logseq_markdown`) filters this exact key
    // set from EVERY block's body `key:: value` lines — page AND
    // descendant alike — before it ever reaches `block_properties`, so no
    // descendant row can carry one of these keys. The `NOT IN` here is
    // therefore belt-and-braces symmetry with the page query, not new
    // behavior. The recurrence rule (`repeat`, `repeat-until`,
    // `repeat-count`) is emitted, so a duplicate, a copy and an export keep a
    // repeating task repeating (#5160 P4); `repeat-seq` and `repeat-origin`
    // describe one occurrence and stay out.
    //
    // The 4 reserved `blocks` columns (todo_state/priority/scheduled_date/
    // due_date) need no exclusion here: migration 0088's `key_not_reserved`
    // CHECK constraint forbids them from ever landing in `block_properties`
    // at all, so they simply cannot appear in these rows. They continue to
    // be emitted from the `blocks` columns in the descendant walk below,
    // exactly as before.
    //
    // DRIFT WARNING (#3797) — the `key NOT IN (…)` list below is duplicated in
    // FOUR places and nothing checks them against each other. Change one,
    // change all four: (1) here; (2) the page-property query above; (3)
    // `FRONTMATTER_RESERVED_KEYS` in `agaric-engine/src/import.rs`; (4)
    // `INLINE_PROPERTY_RESERVED_KEYS` in `src/lib/inline-property-parse.ts`.
    // Copies (1) and (2) are literal SQL, so grepping for either constant name
    // will NOT find them.
    //
    // #6277 D3 — `completed_at` is read HERE, unlike the other three copies:
    // a done task writes it as its `✅` signifier (`TaskLine`), and no block
    // writes it as a line.
    //
    // #4552 slice 4 — `listStyle` is excluded HERE (and in the page query
    // above) but NOT from the two import-side copies; the full rationale for
    // that deliberate asymmetry is on the page-property query above. In short:
    // the descendant walk below emits this block's list-ness as a `- ` / `N. `
    // MARKER, so a `listStyle:: ordered` line here would be a duplicate
    // rendering of the same fact — while an inline / hand-written
    // `listStyle:: bullet` must still IMPORT, which is why the import copies
    // are left alone. This one is NOT belt-and-braces symmetry with the import
    // filter: it is load-bearing, because the importer does write `listStyle`
    // rows.
    let descendant_ids: Vec<String> = descendants
        .iter()
        .map(|b| b.id.clone().into_string())
        .collect();
    let mut descendant_properties: HashMap<String, Vec<FrontmatterRow>> = HashMap::new();
    // #4552 slice 4 — `listStyle` per descendant, read SEPARATELY because the
    // query above now excludes it (see the asymmetry comment there). It is not
    // a `key:: value` property line in the export; it is the input to the
    // `- ` / `N. ` MARKER the descendant walk emits, so it needs its own map
    // rather than a row in `descendant_properties`. Only the `value_text`
    // column is read: `listStyle` is a `select`-typed definition (migration
    // 0103) whose values are the plain strings `bullet` / `ordered`.
    let mut list_styles: HashMap<String, String> = HashMap::new();
    if !descendant_ids.is_empty() {
        let ids_json = serde_json::to_string(&descendant_ids)?;
        let style_rows = sqlx::query!(
            r#"SELECT block_id AS "block_id!", value_text
               FROM block_properties
               WHERE block_id IN (SELECT value FROM json_each(?1))
                 AND key = 'listStyle'"#,
            ids_json,
        )
        .fetch_all(&mut *conn)
        .await?;
        for r in style_rows {
            // Absent / unrecognised means `none` — mirrors `asListStyle` in
            // `src/lib/list-style.ts`, so a stray row never emits a marker the
            // renderer would not draw.
            if let Some(v) = r.value_text.filter(|v| v == "bullet" || v == "ordered") {
                list_styles.insert(r.block_id, v);
            }
        }
        let rows = sqlx::query!(
            r#"SELECT block_id AS "block_id!", key AS "key!", value_text, value_date,
                      value_num, value_ref, value_bool AS "value_bool: i64"
               FROM block_properties
               WHERE block_id IN (SELECT value FROM json_each(?1))
                 AND key NOT IN (
                    'space', 'is_space', 'created_at',
                    'repeat-seq', 'repeat-origin', 'template', 'listStyle'
                 )
               ORDER BY block_id ASC, key ASC"#,
            ids_json,
        )
        .fetch_all(&mut *conn)
        .await?;
        for r in rows {
            descendant_properties
                .entry(r.block_id)
                .or_default()
                .push(FrontmatterRow {
                    key: r.key,
                    value_text: r.value_text,
                    value_date: r.value_date,
                    value_num: r.value_num,
                    value_ref: r.value_ref,
                    value_bool: r.value_bool,
                });
        }
    }

    Ok(DescendantProperties {
        properties: descendant_properties,
        list_styles,
    })
}

/// Resolves every `value_ref` reached by the page's and its descendants'
/// properties to the title of the live page it names; a ref to any other
/// block, or to a deleted one, has none and is written as its id.
async fn resolve_property_ref_titles(
    conn: &mut sqlx::SqliteConnection,
    page_properties: &[FrontmatterRow],
    descendant_properties: &HashMap<String, Vec<FrontmatterRow>>,
) -> Result<HashMap<String, String>, AppError> {
    // Covers BOTH the page's own properties and every descendant block's
    // properties in the single batched lookup below.
    let mut ref_ids: HashSet<String> = HashSet::new();
    for r in page_properties {
        if let Some(rf) = r.value_ref.as_deref()
            && !rf.is_empty()
        {
            ref_ids.insert(rf.to_string());
        }
    }
    for rows in descendant_properties.values() {
        for r in rows {
            if let Some(rf) = r.value_ref.as_deref()
                && !rf.is_empty()
            {
                ref_ids.insert(rf.to_string());
            }
        }
    }
    let mut ref_titles: HashMap<String, String> = HashMap::new();
    if !ref_ids.is_empty() {
        let ids: Vec<String> = ref_ids.into_iter().collect();
        let ids_json = serde_json::to_string(&ids)?;
        let rows = sqlx::query!(
            r#"SELECT id, content FROM blocks
               WHERE id IN (SELECT value FROM json_each(?1))
                 AND block_type = 'page'
                 AND deleted_at IS NULL"#,
            ids_json,
        )
        .fetch_all(&mut *conn)
        .await?;
        for r in rows {
            if let Some(c) = r.content {
                ref_titles.insert(r.id, c);
            }
        }
    }
    Ok(ref_titles)
}

/// Step 4b: the page's aliases and tag names, both frontmatter-only.
async fn load_frontmatter_lists(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> Result<(Vec<String>, Vec<String>), AppError> {
    // 4b. (#1433) Read the page's aliases and tag names for frontmatter.
    //
    // Aliases come straight from `page_aliases`, sorted alphabetically so
    // the exported sequence is deterministic (mirrors
    // `get_page_aliases_inner`'s `ORDER BY alias`). Read through the #660
    // snapshot tx so they observe the same consistent state as the rest of
    // the export.
    let aliases: Vec<String> = sqlx::query_scalar!(
        "SELECT alias FROM page_aliases WHERE page_id = ?1 ORDER BY alias",
        page_id,
    )
    .fetch_all(&mut *conn)
    .await?;

    // Tags are the tag blocks explicitly associated with the page block via
    // `block_tags`; the human-readable NAME is the tag block's `content`.
    // We emit names (not ULIDs). NULL-content tag blocks are skipped, and
    // the results are ordered by name (NOCASE, matching the `tags_cache`
    // UNIQUE index collation) then id for a stable, reproducible sequence.
    let tag_names_fm: Vec<String> = sqlx::query_scalar!(
        r#"SELECT t.content AS "content!"
             FROM block_tags bt
             JOIN blocks t ON t.id = bt.tag_id
            WHERE bt.block_id = ?1
              AND t.block_type = 'tag'
              AND t.deleted_at IS NULL
              AND t.content IS NOT NULL
            ORDER BY t.content COLLATE NOCASE ASC, t.id ASC"#,
        page_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok((aliases, tag_names_fm))
}

/// The selected blocks of `data`'s page no other selected block holds, in
/// document order, each at depth 0, with its subtree when `with_children`.
pub(super) fn render_clipboard_source(
    data: &PageExportData,
    selected: &[String],
    with_children: bool,
) -> String {
    let children_by_parent = group_children_by_parent(data.page.id.as_str(), &data.descendants);
    let list_ordinals = compute_list_ordinals(&children_by_parent, &data.list_styles);
    let selected: HashSet<&str> = selected.iter().map(String::as_str).collect();
    let mut roots = Vec::new();
    let mut stack: Vec<&BlockRow> = children_by_parent
        .get(data.page.id.as_str())
        .map_or(Vec::new(), |kids| kids.iter().rev().copied().collect());
    while let Some(block) = stack.pop() {
        if selected.contains(block.id.as_str()) {
            roots.push(block);
        } else if let Some(kids) = children_by_parent.get(block.id.as_str()) {
            stack.extend(kids.iter().rev());
        }
    }
    let no_children = HashMap::new();
    let children = if with_children {
        &children_by_parent
    } else {
        &no_children
    };
    let mut output = String::new();
    render_subtrees(
        &mut output,
        &roots,
        children,
        &list_ordinals,
        data,
        RenderMode {
            names: Names::ReadBack,
            anchors: Anchors::Needed,
        },
        &mut DocumentLayout::default(),
    );
    output
}

/// Steps 1-4b: every read the page is rendered from, through the caller's
/// snapshot. What `read` does not need is left empty.
pub(super) async fn load_page_export_data(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    read: PageRead,
) -> Result<PageExportData, AppError> {
    let export = read == PageRead::Export;
    let front_matter = read != PageRead::Duplicate;
    let page = load_page_row(conn, page_id).await?;
    let descendants = load_descendants(conn, page_id).await?;
    let attachments_by_block = if export {
        load_attachments(conn, page_id, &descendants).await?
    } else {
        HashMap::new()
    };
    let mut refs = resolve_references(conn, page_id, &descendants).await?;
    // A duplicate writes every id raw, so it names no heading.
    let headings = if read == PageRead::Duplicate {
        HashMap::new()
    } else {
        let replacement = &mut refs.block_ref_replacement;
        resolve_heading_refs(conn, replacement, &refs.block_ref_titles).await?
    };
    if export || read == PageRead::File {
        let (addressed, held) = load_addressed_blocks(conn, &descendants).await?;
        refs.addressed_blocks.extend(addressed);
        drop_named_heading_anchors(conn, page_id, &mut refs.addressed_blocks, &held).await?;
    }
    let properties = if front_matter {
        load_page_properties(conn, page_id).await?
    } else {
        Vec::new()
    };
    let descendant = load_descendant_properties(conn, &descendants).await?;
    let ref_titles = if front_matter {
        resolve_property_ref_titles(conn, &properties, &descendant.properties).await?
    } else {
        HashMap::new()
    };
    let (aliases, tag_names_fm) = if front_matter {
        load_frontmatter_lists(conn, page_id).await?
    } else {
        (Vec::new(), Vec::new())
    };
    let name_snapshot = if matches!(read, PageRead::Buffer | PageRead::File) {
        load_name_snapshot(conn, &page.id, &descendants, &refs, &ref_titles, headings).await?
    } else {
        NameSnapshot::default()
    };
    Ok(PageExportData {
        page,
        descendants,
        attachments_by_block,
        tag_names: refs.tag_names,
        page_titles: refs.page_titles,
        block_ref_replacement: refs.block_ref_replacement,
        addressed_blocks: refs.addressed_blocks,
        descendant_properties: descendant.properties,
        list_styles: descendant.list_styles,
        ref_titles,
        properties,
        aliases,
        tag_names_fm,
        name_snapshot,
    })
}

/// The block refs among `titles`' targets a link may name by heading (#6277
/// F4), each with its text ([`unique_headings`]), read through the anchor
/// pass's own query for the pages holding a heading target. A target a
/// ref-typed value or an attachment holds keeps its `^ULID` line, so it is
/// named by id ([`load_addressed_blocks`] reads the same). Each one's export
/// link in `replacement` becomes `[[Title#Heading]]`, its own page's too.
async fn resolve_heading_refs(
    conn: &mut sqlx::SqliteConnection,
    replacement: &mut HashMap<String, String>,
    titles: &HashMap<String, String>,
) -> Result<HashMap<String, String>, AppError> {
    if titles.is_empty() {
        return Ok(HashMap::new());
    }
    let ids = serde_json::to_string(&titles.keys().collect::<Vec<_>>())?;
    let rows = sqlx::query!(
        r#"SELECT b.id AS "id!", b.page_id AS "page_id!",
                  (EXISTS (SELECT 1 FROM block_properties p JOIN blocks s ON s.id = p.block_id
                           WHERE p.value_ref = b.id AND s.deleted_at IS NULL)
                   OR EXISTS (SELECT 1 FROM attachments a
                              WHERE a.block_id = b.id AND a.deleted_at IS NULL))
                      AS "held!: bool"
           FROM blocks b
           WHERE b.id IN (SELECT value FROM json_each(?1))
             AND b.block_type = 'content' AND b.deleted_at IS NULL
             AND b.page_id IS NOT NULL AND ltrim(b.content) LIKE '#%'"#,
        ids,
    )
    .fetch_all(&mut *conn)
    .await?;
    let named: HashSet<&str> = rows
        .iter()
        .filter(|r| !r.held)
        .map(|r| r.id.as_str())
        .collect();
    if named.is_empty() {
        return Ok(HashMap::new());
    }
    let pages = rows.iter().map(|r| r.page_id.as_str()).collect();
    let candidates = load_anchor_candidates(conn, &pages).await?;
    let headings = unique_headings(&candidates, |id| named.contains(id));
    for (id, heading) in &headings {
        replacement.insert(id.clone(), format!("[[{}#{heading}]]", titles[id]));
    }
    Ok(headings)
}

/// Take out of `addressed` the headings of `page_id` every link names by
/// text (#6277 F4): those [`resolve_heading_refs`] names, a heading no
/// ref-typed value or attachment `held`s. Their lines are written bare, as
/// Obsidian puts no block id on a heading, so no line both carries `^ULID`
/// and is named `[[Title#Heading]]`.
async fn drop_named_heading_anchors(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    addressed: &mut HashSet<String>,
    held: &HashSet<String>,
) -> Result<(), AppError> {
    let candidates = load_anchor_candidates(conn, &HashSet::from([page_id])).await?;
    let named = unique_headings(&candidates, |id| {
        addressed.contains(id) && !held.contains(id)
    });
    addressed.retain(|id| !named.contains_key(id));
    Ok(())
}

/// What the importer would resolve the page's referenced names against: its
/// space's pages the link bodies the render writes may name, the titles of
/// ref-typed values among them, the blocks its block links may name
/// ([`read_ref_blocks`]) and the `headings` they may name by text, and its
/// space's tags. A page in no space gets the empty snapshot, so every name
/// stays raw.
async fn load_name_snapshot(
    conn: &mut sqlx::SqliteConnection,
    page_id: &BlockId,
    descendants: &[BlockRow],
    refs: &PageReferences,
    ref_titles: &HashMap<String, String>,
    headings: HashMap<String, String>,
) -> Result<NameSnapshot, AppError> {
    let Some(space) = agaric_store::space::resolve_block_space(&mut *conn, page_id).await? else {
        return Ok(NameSnapshot::default());
    };
    let mut bodies = rendered_link_bodies(descendants, &refs.page_titles);
    bodies.extend(ref_titles.values().cloned());
    let block_links = refs.block_ref_titles.iter();
    bodies.extend(block_links.map(|(id, title)| format!("{title}#^{id}")));
    let titles = &refs.block_ref_titles;
    bodies.extend(
        headings
            .iter()
            .map(|(id, text)| format!("{}#{text}", titles[id])),
    );
    let mut pages = snapshot_page_link_matches(conn, space.as_str(), &bodies).await?;
    read_ref_blocks(conn, &mut pages, page_id.as_str(), &refs.block_ref_titles).await?;
    pages.headings = headings;
    Ok(NameSnapshot {
        pages,
        tag_id_by_norm: snapshot_tags_by_norm(conn, space.as_str()).await?,
    })
}

/// Fill `pages` with the blocks a block link to one of `titles`' targets may
/// name (#6277 F2): those an anchor names on the page its title names, as the
/// anchor pass reads them, and on `page_id`, the page an anchor-only link
/// names. With no block ref, none.
async fn read_ref_blocks(
    conn: &mut sqlx::SqliteConnection,
    pages: &mut LinkMatches,
    page_id: &str,
    titles: &HashMap<String, String>,
) -> Result<(), AppError> {
    pages.own_page = Some(page_id.to_owned());
    if titles.is_empty() {
        return Ok(());
    }
    let mut named: HashSet<String> = titles
        .values()
        .filter_map(|title| pages.find(title).map(str::to_owned))
        .collect();
    named.insert(page_id.to_owned());
    let named = named.iter().map(String::as_str).collect();
    let candidates = load_anchor_candidates(conn, &named).await?;
    pages.blocks = candidates.into_iter().map(|c| (c.id, c.page_id)).collect();
    Ok(())
}

/// The link bodies the render writes for `descendants`: each linked page's
/// title, with the link's label.
fn rendered_link_bodies(
    descendants: &[BlockRow],
    page_titles: &HashMap<String, String>,
) -> Vec<String> {
    use agaric_store::cache::{PAGE_LINK_RE, page_link_label};
    let contents = descendants.iter().filter_map(|b| b.content.as_deref());
    contents
        .flat_map(|content| PAGE_LINK_RE.captures_iter(content))
        .filter_map(|caps| {
            let title = page_titles.get(&caps[1])?;
            Some(match page_link_label(&caps) {
                Some(label) => format!("{title}|{label}"),
                None => title.clone(),
            })
        })
        .collect()
}

/// #2961 — sanitize an attachment's `filename` for use as markdown link
/// TEXT (the `[label]` half of `[label](attachment:<id>)`).
///
/// Strips `[`, `]`, `\r` and `\n`: unescaped brackets would prematurely
/// close the link's label span and a raw newline would break the single-line
/// bullet the importer expects. This is purely cosmetic — the `attachment:
/// <id>` URL (not the label) is what the ZIP-export resolver and re-import
/// match on, so a mangled label can never misroute the attachment's bytes.
pub(super) fn attachment_link_label(filename: &str) -> String {
    filename
        .chars()
        .filter(|c| !matches!(c, '[' | ']' | '\r' | '\n'))
        .collect()
}

/// #4552 slice 4 — derive each `ordered` block's POSITIONAL ordinal from its
/// sibling group.
///
/// A run of consecutive `ordered` same-parent siblings numbers `1, 2, 3, …`;
/// ANY non-`ordered` sibling (a `bullet`, or a plain block) ends the run, so
/// the next `ordered` sibling restarts at `1`. This is the same rule as
/// `computeListOrdinals` (`src/lib/list-ordinals.ts`), so the exported number
/// matches the one the editor draws, and it matches CommonMark, where a
/// changed marker type starts a new list.
///
/// `children_by_parent`'s vectors are already sibling-sorted by
/// `(position, id)` — the same order the DFS emits them in — so a single pass
/// per group is enough. Blocks with no entry in the returned map are not
/// `ordered` and take no number. A block with a task state is written as a
/// task whatever its style (#5691 D3), so it ends a run.
fn compute_list_ordinals(
    children_by_parent: &HashMap<String, Vec<&BlockRow>>,
    list_styles: &HashMap<String, String>,
) -> HashMap<String, usize> {
    let mut ordinals: HashMap<String, usize> = HashMap::new();
    for children in children_by_parent.values() {
        let mut run: usize = 0;
        for child in children {
            let id = child.id.clone().into_string();
            let task = child.todo_state.is_some();
            if list_styles.get(&id).map(String::as_str) == Some("ordered") && !task {
                run += 1;
                ordinals.insert(id, run);
            } else {
                run = 0;
            }
        }
    }
    ordinals
}

/// #4552 slice 4 — the markdown list marker a block's `listStyle` projects to,
/// written before the block's text.
///
/// `"- "` for `bullet` (the canonical bullet char, matching
/// `serializeBulletList`), `"<n>. "` for `ordered` (the positional ordinal
/// from [`compute_list_ordinals`], never a stored number), and `""` for a
/// block with no `listStyle` row — `none` is the absence of the property and
/// is never written.
fn list_marker_for(
    id: &str,
    list_styles: &HashMap<String, String>,
    ordinals: &HashMap<String, usize>,
) -> String {
    match list_styles.get(id).map(String::as_str) {
        Some("bullet") => "- ".to_string(),
        // An `ordered` block always has an ordinal (it is in exactly one
        // sibling group, and every `ordered` member of a group is numbered);
        // the `1` fallback keeps a marker on the line rather than silently
        // dropping the block's list-ness if that ever stops holding.
        Some("ordered") => format!("{}. ", ordinals.get(id).copied().unwrap_or(1)),
        _ => String::new(),
    }
}

/// #2716 — append a block's (already ULID-resolved) `content` as a Document
/// buffer writes it (#5691): its markers, `"+ "` among them
/// ([`DocumentLayout::place`]), and the first line, or the text alone, then
/// every further line at the text's column, each escaped that would read as
/// anything but that line of the block ([`import::needs_document_line_escape`]):
/// blank, a list item, a `key:: value` property, or a heading, a fence or a
/// thematic break, which start blocks of their own there. Every
/// escape has its unescape in the reader.
///
/// Lines inside a fenced code block (```` ``` ```` or `~~~`, closed by a run of
/// the same character at least as long) are emitted verbatim: the reader takes
/// them as code without an escape, and code must not gain stray backslashes.
/// The one exception is [`import::needs_anchor_line_escape`], for a code line
/// the reader would take as a line that ends the fence.
///
/// #4552 slice 4 — `list_marker` (from [`list_marker_for`]) is the block's
/// `listStyle` marker: `""`, `"- "`, `"+ "` or `"<n>. "`. `task_marker`
/// (`"[x] "`, or `""`) follows it (#5160 D6). A first line that would itself
/// read as a marker the block does not write is backslash-escaped
/// ([`first_line_needs_escape`]).
///
/// Returns which lines are code, as the parser's fence tracking will see them.
pub(super) fn push_block_bullet(
    output: &mut String,
    indent: &str,
    list_marker: &str,
    task_marker: &str,
    resolved: &str,
) -> CodeLines {
    let mut lines = resolved.split('\n').peekable();
    let first = lines.next().unwrap_or("");
    let followed = lines.peek().is_some();
    let line_start = output.len();
    output.push_str(indent);
    let markers = format!("{list_marker}{task_marker}");
    if first.is_empty() && !markers.is_empty() {
        // An EMPTY first line after a marker: emit the bare marker (`-`,
        // `1.`, `- [ ]`) rather than a line with trailing whitespace. Both
        // forms read back identically, but only this one is a byte-level
        // fixpoint.
        output.push_str(markers.trim_end());
    } else {
        output.push_str(&markers);
        if first_line_needs_escape(first, followed, list_marker, task_marker) {
            output.push('\\');
        }
        output.push_str(first);
    }
    // Fences are tracked over each line as written, escape and marker
    // included, with the reader's own probes: an escaped ```` \- ``` ```` opens
    // no fence there, so it must open none here either.
    let mut in_fence = import::document_fence_opener(&output[line_start..]);
    let mut code = CodeLines {
        any: in_fence.is_some(),
        last: in_fence.is_some(),
        open: false,
    };
    output.push('\n');

    let cont_indent = continuation_indent(indent, list_marker);
    for line in lines {
        let line_start = output.len();
        output.push_str(&cont_indent);
        let needs_escape = if in_fence.is_some() {
            import::needs_anchor_line_escape(line)
        } else {
            import::needs_document_line_escape(line)
        };
        if needs_escape {
            output.push('\\');
        }
        output.push_str(line);
        let written = &output[line_start..];
        code.last = if let Some(fence) = in_fence {
            if import::closes_fence(written, fence) {
                in_fence = None;
            }
            true
        } else {
            in_fence = import::document_fence_opener(written);
            in_fence.is_some()
        };
        code.any |= code.last;
        output.push('\n');
    }
    code.open = in_fence.is_some();
    code
}

/// Which lines of a written bullet the parser reads as code, and whether the
/// bullet leaves a fence open.
pub(super) struct CodeLines {
    any: bool,
    last: bool,
    pub(super) open: bool,
}

/// `true` when a block's first line needs a leading `\` to read back as text
/// rather than as a marker the block does not write.
///
/// A Document buffer reads one list marker, so after one it escapes only a
/// checkbox (#5160 D6, `import::needs_task_marker_escape`), and a line with
/// none, `followed` by the block's other lines or not, as
/// [`import::needs_bare_line_escape`] says: unescaped, `- foo` would read back
/// as a bulleted block whose text is `foo` (#4552 slice 4).
fn first_line_needs_escape(
    first: &str,
    followed: bool,
    list_marker: &str,
    task_marker: &str,
) -> bool {
    if list_marker.is_empty() {
        import::needs_bare_line_escape(first, followed)
    } else {
        task_marker.is_empty() && import::needs_task_marker_escape(first)
    }
}
