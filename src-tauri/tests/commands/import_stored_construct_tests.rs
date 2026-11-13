//! #6033 S13 — what an import stores for each Markdown and Logseq construct,
//! read back from the database rather than from the parser's output.

use crate::prelude::*;
use agaric_engine::import::{ImportDialect, ImportResult, VaultFile};

const MD: ImportDialect = ImportDialect::Markdown;
const LOGSEQ: ImportDialect = ImportDialect::LogseqOrg;

/// A pool and materializer over the test space, ready for an import.
async fn fixture() -> (SqlitePool, tempfile::TempDir, Materializer) {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    (pool, dir, mat)
}

/// `md` imported as the file `name` under `dialect`, settled.
async fn import(
    pool: &SqlitePool,
    mat: &Materializer,
    dir: &std::path::Path,
    name: &str,
    md: &str,
    dialect: ImportDialect,
    vault: Option<Vec<VaultFile>>,
) -> ImportResult {
    let result = import_markdown_with_progress(
        pool,
        DEV,
        mat,
        dir,
        md.into(),
        Some(name.into()),
        TEST_SPACE_ID.into(),
        dialect,
        vault,
        None,
        None,
    )
    .await
    .unwrap();
    settle(mat).await;
    result
}

/// What importing `md` alone under `dialect` stores ([`stored`]), and its
/// warnings.
async fn import_stored(md: &str, dialect: ImportDialect) -> (Vec<String>, Vec<String>) {
    let (pool, dir, mat) = fixture().await;
    let result = import(&pool, &mat, dir.path(), "Note.md", md, dialect, None).await;
    let lines = stored(&pool, &result.page_id).await;
    mat.shutdown();
    (lines, result.warnings)
}

/// Every live block under `page_id`, depth first, one [`describe`] line each,
/// indented two spaces per level.
async fn stored(pool: &SqlitePool, page_id: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack: Vec<(String, usize)> = children(pool, page_id)
        .await
        .into_iter()
        .rev()
        .map(|id| (id, 0))
        .collect();
    while let Some((id, depth)) = stack.pop() {
        out.push(format!(
            "{}{}",
            "  ".repeat(depth),
            describe(pool, &id).await
        ));
        for child in children(pool, &id).await.into_iter().rev() {
            stack.push((child, depth + 1));
        }
    }
    out
}

async fn children(pool: &SqlitePool, parent: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT id FROM blocks WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, id",
    )
    .bind(parent)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// A block as one line: its content quoted, with each `#[ULID]` of a tag block
/// shown as `#[tag:<name>]`, then whichever task columns, property rows (bar
/// the lifecycle stamps) it has, the tags `block_tags` gives it and the inline
/// tag refs the materializer indexed in `block_tag_refs`.
async fn describe(pool: &SqlitePool, id: &str) -> String {
    let (content, todo, priority, scheduled, due): (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT content, todo_state, priority, scheduled_date, due_date FROM blocks WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap();
    let mut content = content;
    for (tag, name) in all_tags(pool).await {
        content = content.replace(&format!("#[{tag}]"), &format!("#[tag:{name}]"));
    }
    let mut line = format!("{content:?}");
    for (name, value) in [
        ("todo", todo),
        ("priority", priority),
        ("scheduled", scheduled),
        ("due", due),
    ] {
        if let Some(value) = value {
            line.push_str(&format!(" {name}={value}"));
        }
    }
    for (key, value) in properties(pool, id).await {
        line.push_str(&format!(" {key}={value}"));
    }
    for (label, query) in [
        (
            "tags",
            "SELECT t.content FROM block_tags x JOIN blocks t ON t.id = x.tag_id \
             WHERE x.block_id = ? ORDER BY t.content",
        ),
        (
            "refs",
            "SELECT t.content FROM block_tag_refs x JOIN blocks t ON t.id = x.tag_id \
             WHERE x.source_id = ? ORDER BY t.content",
        ),
    ] {
        let names: Vec<String> = sqlx::query_scalar(query)
            .bind(id)
            .fetch_all(pool)
            .await
            .unwrap();
        if !names.is_empty() {
            line.push_str(&format!(" {label}={names:?}"));
        }
    }
    line
}

/// `id`'s property rows bar the lifecycle stamps, each value as text.
async fn properties(pool: &SqlitePool, id: &str) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT key, COALESCE(value_text, CAST(value_num AS TEXT), value_date, value_ref, \
         CAST(value_bool AS TEXT)) FROM block_properties \
         WHERE block_id = ? AND key NOT IN ('created_at', 'completed_at') ORDER BY key",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// Every tag block, `(id, name)`, by name.
async fn all_tags(pool: &SqlitePool) -> Vec<(String, String)> {
    sqlx::query_as("SELECT id, content FROM blocks WHERE block_type = 'tag' ORDER BY content")
        .fetch_all(pool)
        .await
        .unwrap()
}

/// The names of every tag block.
async fn tag_block_names(pool: &SqlitePool) -> Vec<String> {
    all_tags(pool).await.into_iter().map(|(_, n)| n).collect()
}

/// The `listStyle` a Markdown `- ` bullet stores; a Logseq outline bullet is
/// structure and stores none.
fn dash_style(dialect: ImportDialect) -> &'static str {
    match dialect {
        ImportDialect::Markdown => " listStyle=bullet",
        ImportDialect::LogseqOrg => "",
    }
}

fn strings<const N: usize>(lines: [&str; N]) -> Vec<String> {
    lines.map(String::from).to_vec()
}

// ======================================================================
// Tags
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_a_nested_tag_and_its_parent_as_two_tags_in_both_dialects() {
    for dialect in [MD, LOGSEQ] {
        let (pool, dir, mat) = fixture().await;
        let md = "- plan #project/alpha and #project\n";
        let result = import(&pool, &mat, dir.path(), "Note.md", md, dialect, None).await;
        assert_eq!(
            stored(&pool, &result.page_id).await,
            [format!(
                "\"plan #[tag:project/alpha] and #[tag:project]\"{} \
                 refs=[\"project\", \"project/alpha\"]",
                dash_style(dialect)
            )],
            "{dialect:?}"
        );
        assert_eq!(
            tag_block_names(&pool).await,
            ["project", "project/alpha"],
            "{dialect:?}: exactly the two tag blocks"
        );
        assert_eq!(result.warnings, Vec::<String>::new(), "{dialect:?}");
        mat.shutdown();
    }
}

/// The second block puts a `#` after whitespace inside a link title and an
/// inline code span, which only the guard spans keep from being tags: in the
/// first block every non-tag `#` but `#42` follows a non-space, so the regex
/// alone already skips them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_only_real_tags_and_keeps_numbers_urls_and_fragments_verbatim() {
    for dialect in [MD, LOGSEQ] {
        let (pool, dir, mat) = fixture().await;
        let md = "- issue #42 at https://example.com/page#section, [x](http://a.org/p#frag) \
                  and #real\n- see [y](http://a.org/q \"a #title\") and `x #code`\n";
        let result = import(&pool, &mat, dir.path(), "Note.md", md, dialect, None).await;
        let style = dash_style(dialect);
        assert_eq!(
            stored(&pool, &result.page_id).await,
            [
                format!(
                    "\"issue #42 at https://example.com/page#section, \
                     [x](http://a.org/p#frag) and #[tag:real]\"{style} refs=[\"real\"]"
                ),
                format!("\"see [y](http://a.org/q \\\"a #title\\\") and `x #code`\"{style}"),
            ],
            "{dialect:?}"
        );
        assert_eq!(tag_block_names(&pool).await, ["real"], "{dialect:?}");
        assert_eq!(result.warnings, Vec::<String>::new(), "{dialect:?}");
        mat.shutdown();
    }
}

// ======================================================================
// Inline formatting, math, quotes, tables, fences, breaks
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_keeps_inline_formatting_and_math_as_written() {
    let line = "- **b** *i* ~~s~~ ==h== `c` $x_i$ and cost $5\n";
    for dialect in [MD, LOGSEQ] {
        assert_eq!(
            import_stored(line, dialect).await,
            (
                vec![format!(
                    "\"**b** *i* ~~s~~ ==h== `c` $x_i$ and cost $5\"{}",
                    dash_style(dialect)
                )],
                vec![]
            ),
            "{dialect:?}"
        );
    }
    assert_eq!(
        import_stored("- $$\n  x^2 + y^2\n  = z\n  $$\n", LOGSEQ).await,
        (strings([r#""$$\nx^2 + y^2\n= z\n$$""#]), vec![]),
        "a Logseq `$$` bullet is one block, its continuation lines dedented"
    );
    assert_eq!(
        import_stored("$$\nx^2\n$$\n", MD).await,
        (strings([r#""$$\nx^2\n$$""#]), vec![]),
        "a Markdown `$$` paragraph is one block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_a_block_quote_or_callout_as_one_verbatim_block() {
    for (md, dialect) in [
        ("> line one\n> line two\n", MD),
        ("- > line one\n  > line two\n", LOGSEQ),
    ] {
        assert_eq!(
            import_stored(md, dialect).await,
            (strings([r#""> line one\n> line two""#]), vec![]),
            "{dialect:?}"
        );
    }
    assert_eq!(
        import_stored("> [!note] Title\n> body\n", MD).await,
        (strings([r#""> [!note] Title\n> body""#]), vec![]),
        "an Obsidian callout is stored as written"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_a_gfm_table_as_one_verbatim_block_in_both_dialects() {
    for (md, dialect) in [
        ("| a | b |\n| --- | --- |\n| 1 | 2 |\n", MD),
        ("- | a | b |\n  | --- | --- |\n  | 1 | 2 |\n", LOGSEQ),
    ] {
        assert_eq!(
            import_stored(md, dialect).await,
            (
                strings([r#""| a | b |\n| --- | --- |\n| 1 | 2 |""#]),
                vec![]
            ),
            "{dialect:?}: the separator row is no thematic break"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_a_tilde_fence_as_one_code_block_with_tags_and_links_literal() {
    let (pool, dir, mat) = fixture().await;
    let md = "~~~\n#tag [[x]]\n~~~\n";
    let result = import(&pool, &mat, dir.path(), "Note.md", md, MD, None).await;
    assert_eq!(
        stored(&pool, &result.page_id).await,
        [r#""~~~\n#tag [[x]]\n~~~""#]
    );
    assert_eq!(
        tag_block_names(&pool).await,
        Vec::<String>::new(),
        "no tag minted from code"
    );
    let pages: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM blocks WHERE block_type = 'page' AND content = 'x'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(pages, Vec::<String>::new(), "no page minted from code");
    assert_eq!(result.warnings, Vec::<String>::new());
    mat.shutdown();
}

/// No blank line separates the breaks, so a break the reader missed would
/// continue the paragraph above it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_each_star_and_underscore_break_as_its_own_block() {
    assert_eq!(
        import_stored("a\n***\nb\n___\nc\n", MD).await,
        (
            strings(["\"a\"", "\"***\"", "\"b\"", "\"___\"", "\"c\""]),
            vec![]
        )
    );
}

// ======================================================================
// Tasks and planning
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_each_checkbox_variant_as_its_todo_state_without_the_marker() {
    assert_eq!(
        import_stored("- [X] upper\n* [ ] star\n+ [/] plus\n1. [-] ordered\n", MD).await,
        (
            strings([
                "\"upper\" todo=DONE",
                "\"star\" todo=TODO",
                "\"plus\" todo=DOING",
                "\"ordered\" todo=CANCELLED",
            ]),
            vec![]
        ),
        "a task stores no listStyle"
    );
}

const TASK_KEYWORD_LINES: &str = "- LATER a\n- WAIT b\n- WAITING c\n- DOING d\n\
                                  - IN-PROGRESS e\n- CANCELED f\n- CANCELLED g\n- CANCEL h\n";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_logseq_task_keywords_as_todo_state_without_the_keyword() {
    assert_eq!(
        import_stored(TASK_KEYWORD_LINES, LOGSEQ).await,
        (
            strings([
                "\"a\" todo=TODO",
                "\"b\" todo=TODO",
                "\"c\" todo=TODO",
                "\"d\" todo=DOING",
                "\"e\" todo=DOING",
                "\"f\" todo=CANCELLED",
                "\"g\" todo=CANCELLED",
                "\"h\" todo=CANCELLED",
            ]),
            vec![]
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_keeps_task_keywords_as_text_in_the_markdown_dialect() {
    assert_eq!(
        import_stored(TASK_KEYWORD_LINES, MD).await,
        (
            strings([
                "\"LATER a\" listStyle=bullet",
                "\"WAIT b\" listStyle=bullet",
                "\"WAITING c\" listStyle=bullet",
                "\"DOING d\" listStyle=bullet",
                "\"IN-PROGRESS e\" listStyle=bullet",
                "\"CANCELED f\" listStyle=bullet",
                "\"CANCELLED g\" listStyle=bullet",
                "\"CANCEL h\" listStyle=bullet",
            ]),
            vec![]
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_org_planning_lines_as_dates_and_repeat_rules() {
    assert_eq!(
        import_stored(
            "- a\n  SCHEDULED: <2026-10-01 Thu ++1d>\n- b\n  DEADLINE: <2026-10-02 Fri .+1m>\n\
             - c\n  SCHEDULED: <2026-10-03 Sat 10:00-11:30>\n",
            LOGSEQ
        )
        .await,
        (
            strings([
                "\"a\" scheduled=2026-10-01 repeat=++1d",
                "\"b\" due=2026-10-02 repeat=.+1m",
                "\"c\" scheduled=2026-10-03",
            ]),
            vec![]
        ),
        "a time range is dropped without a warning"
    );
}

// ======================================================================
// List markers and headings
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_list_style_from_markdown_list_markers() {
    assert_eq!(
        import_stored("* a\n+ b\n1) c\n3. d\n", MD).await,
        (
            strings([
                "\"a\" listStyle=bullet",
                "\"b\"",
                "\"c\" listStyle=ordered",
                "\"d\" listStyle=ordered",
            ]),
            vec![]
        ),
        "a `+` item is a plain block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_list_style_from_markers_inside_logseq_bullets() {
    assert_eq!(
        import_stored("- plain\n- - inner\n- 1. inner ordered\n1. outer\n", LOGSEQ).await,
        (
            strings([
                "\"plain\"",
                "\"inner\" listStyle=bullet",
                "\"inner ordered\" listStyle=ordered",
                "\"outer\" listStyle=ordered",
            ]),
            vec![]
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_nests_logseq_bullets_under_the_heading_before_them() {
    assert_eq!(
        import_stored("# H\n- a\n- b\n", LOGSEQ).await,
        (strings(["\"# H\"", "  \"a\"", "  \"b\""]), vec![])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_writes_logseq_heading_properties_as_heading_markers() {
    assert_eq!(
        import_stored(
            "- # inner\n- Plan\n  heading:: 3\n- parent\n  - child\n    heading:: true\n",
            LOGSEQ
        )
        .await,
        (
            strings([
                "\"# inner\"",
                "\"### Plan\"",
                "\"parent\"",
                "  \"### child\""
            ]),
            vec![]
        ),
        "`heading:: true` one level down is `###`, as Logseq renders it"
    );
}

// ======================================================================
// Front matter
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_block_style_front_matter_lists_as_aliases_tags_and_properties() {
    let (pool, dir, mat) = fixture().await;
    let md = "---\naliases:\n  - Al\n  - Bee\ntags:\n  - a/b\n  - c\n\
              cssclasses: [wide, dark]\ncategory: notes\n---\n- body\n";
    let result = import(&pool, &mat, dir.path(), "Note.md", md, MD, None).await;
    let aliases: Vec<String> =
        sqlx::query_scalar("SELECT alias FROM page_aliases WHERE page_id = ? ORDER BY alias")
            .bind(&result.page_id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(aliases, ["Al", "Bee"]);
    assert_eq!(
        describe(&pool, &result.page_id).await,
        "\"Note\" category=notes cssclasses=wide, dark tags=[\"a/b\", \"c\"]",
        "a flow sequence is one comma-joined text property"
    );
    assert_eq!(tag_block_names(&pool).await, ["a/b", "c"]);
    assert_eq!(
        stored(&pool, &result.page_id).await,
        ["\"body\" listStyle=bullet"]
    );
    assert_eq!(result.warnings, Vec::<String>::new());
    mat.shutdown();
}

// ======================================================================
// Attachments and links
// ======================================================================

/// The note sits at the vault root, so `../assets/` climbs out of it and only
/// the basename fallback finds the files.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_ingests_logseq_parent_assets_refs_as_attachments() {
    let (pool, dir, mat) = fixture().await;
    let vault = vec![
        VaultFile {
            path: "assets/cat_123.png".into(),
            bytes: vec![0x89, b'P', b'N', b'G'].into(),
        },
        VaultFile {
            path: "assets/doc.pdf".into(),
            bytes: b"%PDF-1.4".to_vec().into(),
        },
    ];
    let md = "- ![cat](../assets/cat_123.png)\n- [doc](../assets/doc.pdf)\n";
    let result = import(&pool, &mat, dir.path(), "Cats.md", md, LOGSEQ, Some(vault)).await;
    let rows: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT a.id, b.content, a.filename, a.size_bytes FROM attachments a \
         JOIN blocks b ON b.id = a.block_id WHERE a.deleted_at IS NULL ORDER BY a.filename",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let [(cat, cat_block, ..), (doc, doc_block, ..)] = rows.as_slice() else {
        panic!("two attachment rows, got {rows:?}");
    };
    assert_eq!(cat_block, &format!("![cat](attachment:{cat})"), "{rows:?}");
    assert_eq!(doc_block, &format!("[doc](attachment:{doc})"), "{rows:?}");
    assert_eq!(
        rows.iter()
            .map(|(_, _, name, size)| (name.as_str(), *size))
            .collect::<Vec<_>>(),
        [("cat_123.png", 4), ("doc.pdf", 8)]
    );
    assert_eq!(
        stored(&pool, &result.page_id).await,
        [
            format!("\"![cat](attachment:{cat})\""),
            format!("\"[doc](attachment:{doc})\""),
        ]
    );
    assert_eq!(result.warnings, Vec::<String>::new());
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_links_a_wiki_link_with_a_nested_heading_anchor_to_its_page_and_warns() {
    let (pool, dir, mat) = fixture().await;
    let note = import(
        &pool,
        &mat,
        dir.path(),
        "Note.md",
        "## H\n\nbody\n",
        MD,
        None,
    )
    .await;
    let md = "- see [[Note#H#Sub]]\n";
    let result = import(&pool, &mat, dir.path(), "Other.md", md, MD, None).await;
    assert_eq!(
        stored(&pool, &result.page_id).await,
        [format!("\"see [[{}]]\" listStyle=bullet", note.page_id)]
    );
    let titles: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM blocks WHERE block_type = 'page' AND deleted_at IS NULL \
         AND id != ? ORDER BY content",
    )
    .bind(TEST_SPACE_ID)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(titles, ["Note", "Other"], "no page minted for the anchor");
    assert_eq!(
        result.warnings,
        ["1 wikilink block/heading anchors were dropped; links resolve to the page"]
    );
    mat.shutdown();
}

// ======================================================================
// Front matter and headings the import does not read
// ======================================================================

/// Only YAML front matter is read: TOML's `+++` fence and a JSON object at the
/// top of the file are text, so they set no property and mint no tag.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_keeps_toml_and_json_front_matter_as_a_text_block() {
    for (md, block) in [
        (
            "+++\ntitle = \"T\"\ntags = [\"a\"]\n+++\n\nbody\n",
            r#""+++\ntitle = \"T\"\ntags = [\"a\"]\n+++""#,
        ),
        (
            "{\n  \"title\": \"T\",\n  \"tags\": [\"a\"]\n}\n\nbody\n",
            r#""{\n  \"title\": \"T\",\n  \"tags\": [\"a\"]\n}""#,
        ),
    ] {
        let (pool, dir, mat) = fixture().await;
        let result = import(&pool, &mat, dir.path(), "Note.md", md, MD, None).await;
        assert_eq!(describe(&pool, &result.page_id).await, "\"Note\"", "{md:?}");
        assert_eq!(
            stored(&pool, &result.page_id).await,
            [block, "\"body\""],
            "{md:?}"
        );
        assert_eq!(tag_block_names(&pool).await, Vec::<String>::new(), "{md:?}");
        assert_eq!(result.warnings, Vec::<String>::new(), "{md:?}");
        mat.shutdown();
    }
}

/// A setext heading is not read: `===` continues the paragraph above it, and
/// `---` is a thematic break of its own after the paragraph.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_keeps_a_setext_heading_as_its_text_and_underline() {
    assert_eq!(
        import_stored("Title\n=====\n\nbody\n", MD).await,
        (strings([r#""Title\n=====""#, "\"body\""]), vec![])
    );
    assert_eq!(
        import_stored("intro\n\nSub\n---\nmore\n", MD).await,
        (
            strings(["\"intro\"", "\"Sub\"", "\"---\"", "\"more\""]),
            vec![]
        )
    );
}

// ======================================================================
// Evernote and Joplin notes, as their converters write them
// ======================================================================

/// The id of the live page titled `title`.
async fn page_titled(pool: &SqlitePool, title: &str) -> String {
    sqlx::query_scalar(
        "SELECT id FROM blocks WHERE block_type = 'page' AND content = ? AND deleted_at IS NULL",
    )
    .bind(title)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Every live attachment as `(filename, id)`, by filename.
async fn attachment_ids(pool: &SqlitePool) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT filename, id FROM attachments WHERE deleted_at IS NULL ORDER BY filename",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

/// What `enexNoteToMarkdown` writes for a note (`src/lib/enex-import.ts`): its
/// dates, source URL and tags as front matter, then the Turndown body, whose
/// `TODO`, `#word`, `[[x]]` and `key::` text goes through the same grammar as
/// a Markdown file's.
const ENEX_NOTE: &str = "---\ncreated: \"2021-01-02T03:04:05.000Z\"\n\
    updated: \"2022-03-04T05:06:07.000Z\"\nsource-url: \"https://example.com/a?b=1&c=2\"\n\
    tags:\n  - \"C++\"\n  - \"2024\"\nsource: evernote\n---\n\n\
    # Head\n\n- one\n  1. first\n  2. second\n\n> quoted\n\n---\n\n~~gone~~ and `code`\n\n\
    ```\n#notatag\n```\n\nTODO call Bob\n\nsee #word and [[Other]]\n\nstatus:: done\n\n\
    - [ ] Simple\n- [x] Due\n  due_date:: 2022-05-28\n\n![](pic.png)\n";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_an_evernote_note_as_its_converter_writes_it() {
    let (pool, dir, mat) = fixture().await;
    let vault = vec![VaultFile {
        path: "pic.png".into(),
        bytes: vec![0x89, b'P', b'N', b'G'].into(),
    }];
    let result = import(
        &pool,
        &mat,
        dir.path(),
        "Notes/Meeting.md",
        ENEX_NOTE,
        MD,
        Some(vault),
    )
    .await;
    assert_eq!(
        describe(&pool, &result.page_id).await,
        "\"Notes/Meeting\" created=2021-01-02T03:04:05.000Z source=evernote \
         source-url=https://example.com/a?b=1&c=2 updated=2022-03-04T05:06:07.000Z \
         tags=[\"2024\", \"C++\"]"
    );
    let other = page_titled(&pool, "Other").await;
    let attachments = attachment_ids(&pool).await;
    let [(name, pic)] = attachments.as_slice() else {
        panic!("one attachment, got {attachments:?}");
    };
    assert_eq!(name, "pic.png");
    assert_eq!(
        stored(&pool, &result.page_id).await,
        [
            "\"# Head\"".to_string(),
            "\"one\" listStyle=bullet".into(),
            "  \"first\" listStyle=ordered".into(),
            "  \"second\" listStyle=ordered".into(),
            "\"> quoted\"".into(),
            "\"---\"".into(),
            "\"~~gone~~ and `code`\"".into(),
            r#""```\n#notatag\n```""#.into(),
            "\"TODO call Bob\"".into(),
            format!("\"see #[tag:word] and [[{other}]]\" status=done refs=[\"word\"]"),
            "\"Simple\" todo=TODO".into(),
            "\"Due\" todo=DONE due=2022-05-28".into(),
            format!("\"![](attachment:{pic})\""),
        ],
        "a `key::` paragraph is a property of the block above it"
    );
    assert_eq!(tag_block_names(&pool).await, ["2024", "C++", "word"]);
    assert_eq!(result.warnings, Vec::<String>::new());
    mat.shutdown();
}

/// What `jexNoteToMarkdown` writes for a Joplin to-do whose body links another
/// note and three resources (`src/lib/jex-import.ts`): a resource named like a
/// note (`notes.txt`) is embedded, so it lands a file link, not a page link.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_stores_a_joplin_note_with_its_to_do_note_link_and_resources() {
    let (pool, dir, mat) = fixture().await;
    let linked = "---\nsource: joplin\n---\n\n- plan\n";
    let other = import(
        &pool,
        &mat,
        dir.path(),
        "Work/Other note.md",
        linked,
        MD,
        None,
    )
    .await;
    let md = "---\ncreated: \"2024-01-02T03:04:05.000Z\"\nupdated: \"2024-01-03T03:04:05.000Z\"\n\
              tags:\n  - \"C++\"\n  - \"v1.2\"\nsource: joplin\n---\n\n\
              - [ ] Buy milk\n  due_date:: 2024-01-05\n\n\
              See [[Work/Other note|the plan]] and [the paper](paper.pdf), \
              ![notes](notes.txt), ![](pic.png).\n";
    let vault = vec![
        VaultFile {
            path: "paper.pdf".into(),
            bytes: b"%PDF-1.4".to_vec().into(),
        },
        VaultFile {
            path: "notes.txt".into(),
            bytes: b"hello".to_vec().into(),
        },
        VaultFile {
            path: "pic.png".into(),
            bytes: vec![0x89, b'P', b'N', b'G'].into(),
        },
    ];
    let result = import(
        &pool,
        &mat,
        dir.path(),
        "Work/Groceries.md",
        md,
        MD,
        Some(vault),
    )
    .await;
    assert_eq!(
        describe(&pool, &result.page_id).await,
        "\"Work/Groceries\" created=2024-01-02T03:04:05.000Z source=joplin \
         updated=2024-01-03T03:04:05.000Z tags=[\"C++\", \"v1.2\"]"
    );
    let attachments = attachment_ids(&pool).await;
    let [(_, notes), (_, paper), (_, pic)] = attachments.as_slice() else {
        panic!("three attachments, got {attachments:?}");
    };
    assert_eq!(
        attachments
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["notes.txt", "paper.pdf", "pic.png"]
    );
    assert_eq!(
        stored(&pool, &result.page_id).await,
        [
            "\"Buy milk\" todo=TODO due=2024-01-05".to_string(),
            format!(
                "\"See [[{}|the plan]] and [the paper](attachment:{paper}), \
                 [notes](attachment:{notes}), ![](attachment:{pic}).\"",
                other.page_id
            ),
        ]
    );
    assert_eq!(tag_block_names(&pool).await, ["C++", "v1.2"]);
    assert_eq!(result.warnings, Vec::<String>::new());
    mat.shutdown();
}
