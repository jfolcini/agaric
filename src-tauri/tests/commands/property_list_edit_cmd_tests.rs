//! #6741 — defining and editing a list: a type change to and from a list, the
//! list shape in the don't-fit rules, a list as one line of text in Duplicate
//! and Edit as Markdown, and a key rename or merge carrying one.

use super::page_cmd_tests::{duplicate, page_source, save_source, with};
use super::prelude::*;
use super::property_list_cmd_tests::{Fixture, assert_refused, fixture, list_def, nums, texts};
use agaric_store::op::{OpRef, PropertyDefState, PropertyList};

fn single_def(value_type: &str) -> PropertyDefState {
    PropertyDefState {
        multiple: false,
        ..list_def(value_type, None)
    }
}

/// What a type change asks for: the item type, a select's options, whether
/// the key holds a list afterwards, and where its text splits or joins.
type To<'a> = (
    &'a str,
    Option<&'a str>,
    Option<bool>,
    Option<ListSeparator>,
);

fn target(key: &str, (ty, options, multiple, separator): To<'_>) -> PropertyTypeTarget {
    PropertyTypeTarget {
        key: key.into(),
        value_type: ty.into(),
        options: options.map(str::to_owned),
        multiple,
        separator,
    }
}

impl Fixture {
    async fn declare(&self, key: &str, def: PropertyDefState) {
        create_property_def_state_inner(&self.pool, DEV, &self.mat, &self.a, key.into(), def)
            .await
            .unwrap_or_else(|e| panic!("declare {key}: {e:?}"));
    }

    async fn set_text(&self, block: &BlockId, key: &str, text: &str) {
        let (id, key, text) = (block.as_str().into(), key.into(), Some(text.into()));
        set_property_inner(
            &self.pool, DEV, &self.mat, id, key, text, None, None, None, None, None,
        )
        .await
        .unwrap();
        settle(&self.mat).await;
    }

    async fn preview(&self, key: &str, to: To<'_>) -> Result<(i64, i64), AppError> {
        preview_property_type_change_inner(&self.pool, &self.a, target(key, to))
            .await
            .map(|counts| (counts.converted, counts.unfit))
    }

    /// The values of `kind` a change lists, as `(value, converted)`, by block.
    async fn listed(
        &self,
        key: &str,
        to: To<'_>,
        kind: PropertyTypeChangeKind,
    ) -> Vec<(String, Option<String>)> {
        let target = target(key, to);
        list_property_type_change_values_inner(&self.pool, &self.a, target, kind, None, None)
            .await
            .unwrap()
            .items
            .into_iter()
            .map(|value| (value.value, value.converted))
            .collect()
    }

    /// Change `key`'s type, acknowledging what the preview answers; the
    /// preview's `(converted, unfit)` and the op to undo.
    async fn change(&self, key: &str, to: To<'_>) -> ((i64, i64), OpRef) {
        let (converted, unfit) = self.preview(key, to).await.unwrap();
        let changed = capture_op_refs(change_property_type_inner(
            &self.pool,
            DEV,
            &self.mat,
            &self.a,
            target(key, to),
            PropertyTypeChangeCounts { converted, unfit },
        ))
        .await
        .unwrap();
        settle(&self.mat).await;
        ((converted, unfit), changed.op_refs[0].clone())
    }

    /// `block`'s single text value under `key`.
    async fn text(&self, block: &BlockId, key: &str) -> Option<String> {
        get_property_inner(&self.pool, block, key)
            .await
            .unwrap()
            .and_then(|row| row.value_text)
    }

    async fn holds_a_list(&self, key: &str) -> bool {
        get_property_def_inner(&self.pool, &self.a, key)
            .await
            .unwrap()
            .expect("declared")
            .multiple
    }

    /// `key`'s values that don't fit it, as `(value, form)`, by block.
    async fn unfit(&self, key: &str) -> Vec<(String, PropertyValueForm)> {
        list_unfit_property_values_inner(&self.pool, &self.a, key.into(), None, None)
            .await
            .unwrap()
            .items
            .into_iter()
            .map(|value| (value.value, value.form))
            .collect()
    }

    async fn unfit_counts(&self, key: &str) -> PropertyUnfitCounts {
        count_property_usage_inner(&self.pool, &self.a)
            .await
            .unwrap()
            .into_iter()
            .find(|usage| usage.key == key)
            .expect("the key is declared")
            .unfit
    }
}

const COMMA: Option<ListSeparator> = Some(ListSeparator::Comma);
const SEMICOLON: Option<ListSeparator> = Some(ListSeparator::Semicolon);

/// A text key becomes one that holds a list: each text splits at the commas,
/// its parts trimmed and its blank ones dropped; a text with no part is kept
/// as it is and doesn't fit. The preview, the two lists and the write agree,
/// and the undo puts the texts and the definition back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_type_change_splits_text_into_a_list_and_its_undo_restores_the_text_6741() {
    let f = fixture().await;
    f.declare("people", single_def("text")).await;
    f.set_text(&f.child, "people", "Ann, Bob ,, Cy").await;
    f.set_text(&f.page, "people", "Solo").await;
    f.set_text(&f.target, "people", " , ").await;
    let to: To<'_> = ("text", None, Some(true), COMMA);

    assert_eq!(f.preview("people", to).await.unwrap(), (2, 1));
    let converted = f
        .listed("people", to, PropertyTypeChangeKind::Converted)
        .await;
    assert_eq!(
        converted,
        [
            ("Solo".to_owned(), Some("Solo".to_owned())),
            ("Ann, Bob ,, Cy".to_owned(), Some("Ann, Bob, Cy".to_owned())),
        ],
        "a list shows as its line of text"
    );
    let unfit = f.listed("people", to, PropertyTypeChangeKind::Unfit).await;
    assert_eq!(unfit, [(" , ".to_owned(), None)]);

    let (counts, op) = f.change("people", to).await;
    assert_eq!(counts, (2, 1));
    assert!(f.holds_a_list("people").await);
    assert_eq!(
        f.list(&f.child, "people").await,
        Some(texts(&["Ann", "Bob", "Cy"]))
    );
    assert_eq!(f.list(&f.page, "people").await, Some(texts(&["Solo"])));
    assert_eq!(f.text(&f.target, "people").await.as_deref(), Some(" , "));
    assert_eq!(
        f.unfit("people").await,
        [(" , ".to_owned(), PropertyValueForm::Text)],
        "a single value under a key that holds a list doesn't fit"
    );

    f.undo(op).await;
    assert!(!f.holds_a_list("people").await);
    assert_eq!(
        f.text(&f.child, "people").await.as_deref(),
        Some("Ann, Bob ,, Cy")
    );
    assert_eq!(f.text(&f.page, "people").await.as_deref(), Some("Solo"));
    assert_eq!(f.unfit("people").await, []);
}

/// The separator is the one chosen: a semicolon splits at semicolons only,
/// and none makes the whole text one item, which the list of values shows as
/// the list's line of text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_type_change_splits_only_at_the_separator_chosen_6741() {
    let f = fixture().await;
    for key in ["halved", "whole"] {
        f.declare(key, single_def("text")).await;
        f.set_text(&f.child, key, "a; b, c").await;
    }
    f.change("halved", ("text", None, Some(true), SEMICOLON))
        .await;
    let whole: To<'_> = ("text", None, Some(true), None);
    assert_eq!(
        f.listed("whole", whole, PropertyTypeChangeKind::Converted)
            .await,
        [("a; b, c".to_owned(), Some(r#""a; b, c""#.to_owned()))],
        "a list of one item that holds a comma shows quoted, apart from a split"
    );
    f.change("whole", whole).await;
    assert_eq!(
        f.list(&f.child, "halved").await,
        Some(texts(&["a", "b, c"]))
    );
    assert_eq!(f.list(&f.child, "whole").await, Some(texts(&["a; b, c"])));
}

/// Each item is held to the type the key changes to: every part a number
/// under `number`, every part an option under a select. A value with one
/// part that isn't is kept whole and doesn't fit. A number becomes a list of
/// that number.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_type_change_holds_each_item_of_the_new_list_to_its_type_6741() {
    let f = fixture().await;
    f.declare("marks", single_def("text")).await;
    f.set_text(&f.child, "marks", "1, 2.5").await;
    f.set_text(&f.page, "marks", "1, x").await;
    let (counts, _) = f.change("marks", ("number", None, Some(true), COMMA)).await;
    assert_eq!(counts, (1, 1));
    assert_eq!(f.list(&f.child, "marks").await, Some(nums(&[1.0, 2.5])));
    assert_eq!(f.text(&f.page, "marks").await.as_deref(), Some("1, x"));

    f.declare("phase", single_def("text")).await;
    f.set_text(&f.child, "phase", "draft, review").await;
    f.set_text(&f.page, "phase", "draft, other").await;
    let options = Some(r#"["draft","review"]"#);
    let (counts, _) = f
        .change("phase", ("select", options, Some(true), COMMA))
        .await;
    assert_eq!(counts, (1, 1));
    assert_eq!(
        f.list(&f.child, "phase").await,
        Some(texts(&["draft", "review"]))
    );
    assert_eq!(
        f.text(&f.page, "phase").await.as_deref(),
        Some("draft, other")
    );

    f.declare("weight", single_def("number")).await;
    let (id, key) = (f.child.as_str().into(), "weight".into());
    set_property_inner(
        &f.pool,
        DEV,
        &f.mat,
        id,
        key,
        None,
        Some(3.0),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&f.mat).await;
    let (counts, _) = f
        .change("weight", ("number", None, Some(true), COMMA))
        .await;
    assert_eq!(counts, (1, 0));
    assert_eq!(f.list(&f.child, "weight").await, Some(nums(&[3.0])));
}

/// A key stops holding a list: a list of one item becomes that item; a
/// longer one becomes a text only, its items joined by the separator chosen,
/// and is otherwise kept as the list it is, which doesn't fit. The undo puts
/// the lists back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_type_change_from_a_list_joins_takes_one_item_or_keeps_the_list_6741() {
    let f = fixture().await;
    let pair = texts(&["Ann", "Doe, Jane"]);
    f.set_list(&f.child, "authors", pair.clone()).await.unwrap();
    f.set_list(&f.page, "authors", texts(&["Solo"]))
        .await
        .unwrap();
    assert_eq!(
        f.preview("authors", ("text", None, Some(false), None))
            .await
            .unwrap(),
        (1, 1),
        "with no separator only the list of one item converts"
    );
    let to: To<'_> = ("text", None, Some(false), SEMICOLON);
    assert_eq!(
        f.listed("authors", to, PropertyTypeChangeKind::Converted)
            .await,
        [
            ("Solo".to_owned(), Some("Solo".to_owned())),
            (
                r#"Ann, "Doe, Jane""#.to_owned(),
                Some("Ann; Doe, Jane".to_owned())
            ),
        ]
    );
    let (counts, op) = f.change("authors", to).await;
    assert_eq!(counts, (2, 0));
    assert!(!f.holds_a_list("authors").await);
    assert_eq!(
        f.text(&f.child, "authors").await.as_deref(),
        Some("Ann; Doe, Jane")
    );
    assert_eq!(f.text(&f.page, "authors").await.as_deref(), Some("Solo"));
    f.undo(op).await;
    assert!(f.holds_a_list("authors").await);
    assert_eq!(f.list(&f.child, "authors").await, Some(pair));
    assert_eq!(f.list(&f.page, "authors").await, Some(texts(&["Solo"])));

    f.set_list(&f.child, "scores", nums(&[1.0, 2.0]))
        .await
        .unwrap();
    f.set_list(&f.page, "scores", nums(&[3.0])).await.unwrap();
    let (counts, _) = f.change("scores", ("text", None, Some(false), COMMA)).await;
    assert_eq!(counts, (2, 0), "a text takes the joined numbers");
    assert_eq!(f.text(&f.child, "scores").await.as_deref(), Some("1, 2"));
    assert_eq!(f.text(&f.page, "scores").await.as_deref(), Some("3"));

    f.set_list(&f.child, "read", texts(&["2026-01-05", "2026-02-06"]))
        .await
        .unwrap();
    f.set_list(&f.page, "read", texts(&["2026-03-07"]))
        .await
        .unwrap();
    let (counts, _) = f.change("read", ("date", None, Some(false), COMMA)).await;
    assert_eq!(counts, (1, 1), "only a text or a URL takes a joined list");
    let page_row = get_property_inner(&f.pool, &f.page, "read").await.unwrap();
    assert_eq!(
        page_row.and_then(|row| row.value_date).as_deref(),
        Some("2026-03-07")
    );
    assert_eq!(
        f.list(&f.child, "read").await,
        Some(texts(&["2026-01-05", "2026-02-06"]))
    );
    assert_eq!(
        f.unfit("read").await,
        [("2026-01-05, 2026-02-06".to_owned(), PropertyValueForm::List)],
        "a list under a key that holds one value doesn't fit"
    );
}

/// A list changes its items' type whole or not at all, and keeps being a list
/// when the change says nothing about it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_changes_its_items_type_whole_or_not_at_all_6741() {
    let f = fixture().await;
    f.set_list(&f.child, "authors", texts(&["1", "2"]))
        .await
        .unwrap();
    f.set_list(&f.page, "authors", texts(&["1", "x"]))
        .await
        .unwrap();
    let (counts, op) = f.change("authors", ("number", None, None, COMMA)).await;
    assert_eq!(counts, (1, 1));
    assert!(f.holds_a_list("authors").await);
    assert_eq!(f.list(&f.child, "authors").await, Some(nums(&[1.0, 2.0])));
    assert_eq!(f.list(&f.page, "authors").await, Some(texts(&["1", "x"])));
    assert_eq!(
        f.unfit("authors").await,
        [("1, x".to_owned(), PropertyValueForm::List)],
        "a list with an item that isn't a number doesn't fit a list of numbers"
    );
    f.undo(op).await;
    assert_eq!(f.list(&f.child, "authors").await, Some(texts(&["1", "2"])));
    assert_eq!(f.unfit("authors").await, []);
}

/// A change is refused when it changes neither the type nor whether the key
/// holds a list, and when it would make a boolean hold one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_type_change_is_refused_when_it_changes_nothing_or_lists_booleans_6741() {
    let f = fixture().await;
    for multiple in [None, Some(true)] {
        let same = f.preview("authors", ("text", None, multiple, None)).await;
        assert_refused(same.map(drop), "'authors' is already a text property");
    }
    let flags = f
        .preview("single", ("boolean", None, Some(true), None))
        .await;
    assert_refused(flags.map(drop), "cannot hold a list of booleans");
    assert_eq!(
        f.preview("single", ("text", None, Some(true), None))
            .await
            .unwrap(),
        (0, 0),
        "the flag alone is a change"
    );
}

/// A select that holds a list: a list with an item outside the options
/// doesn't fit, and adding the values that don't fit to the options adds that
/// item.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_select_list_with_an_item_outside_the_options_doesnt_fit_6741() {
    let f = fixture().await;
    f.set_list(&f.child, "stages", texts(&["draft"]))
        .await
        .unwrap();
    f.set_list(&f.page, "stages", texts(&["draft", "review"]))
        .await
        .unwrap();
    assert_eq!(f.unfit("stages").await, []);
    let narrowed = r#"["draft"]"#.to_owned();
    update_property_def_options_inner(&f.pool, DEV, &f.mat, &f.a, "stages".into(), narrowed)
        .await
        .unwrap();
    settle(&f.mat).await;
    assert_eq!(
        f.unfit("stages").await,
        [("draft, review".to_owned(), PropertyValueForm::List)]
    );
    let counts = f.unfit_counts("stages").await;
    assert_eq!((counts.unfit, counts.unfit_in_trash), (1, 0));

    let widened = add_unfit_values_to_options_inner(&f.pool, DEV, &f.mat, &f.a, "stages".into())
        .await
        .unwrap();
    settle(&f.mat).await;
    assert_eq!(widened.options.as_deref(), Some(r#"["draft","review"]"#));
    assert_eq!(f.unfit("stages").await, []);
}

/// The other actions on a value that doesn't fit: under a key that holds a
/// list, a replacement's text is read as a list; a list moves only to a key
/// that holds one and takes its items, a single value only to one that
/// doesn't; and a removal takes a list out, which its undo puts back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_action_on_a_value_that_doesnt_fit_takes_the_list_shape_6741() {
    let f = fixture().await;
    // `people` holds a list, and one single text that doesn't fit it.
    f.declare("people", single_def("text")).await;
    f.set_text(&f.child, "people", " , ").await;
    f.change("people", ("text", None, Some(true), COMMA)).await;
    let one = PropertyUnfitCounts {
        unfit: 1,
        unfit_in_trash: 0,
    };
    let replacement = |replacement: &str| {
        vec![UnfitValueReplacement {
            value: " , ".into(),
            replacement: replacement.into(),
            acknowledged: one,
        }]
    };
    // A single value does not move to a key that holds a list.
    let moved = preview_unfit_property_move_inner(&f.pool, &f.a, "people".into(), "kept".into())
        .await
        .unwrap();
    assert_eq!((moved.moved, moved.unfit_there), (0, 1));
    let blank = convert_unfit_property_values_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.a,
        "people".into(),
        replacement(" , "),
    )
    .await;
    assert_refused(blank.map(drop), "doesn't fit 'people'");
    convert_unfit_property_values_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.a,
        "people".into(),
        replacement(r#"Ann, "Doe, Jane""#),
    )
    .await
    .unwrap();
    settle(&f.mat).await;
    assert_eq!(
        f.list(&f.child, "people").await,
        Some(texts(&["Ann", "Doe, Jane"]))
    );

    // `scores` holds one number, and one list that doesn't fit it.
    f.set_list(&f.child, "scores", nums(&[1.0, 2.0]))
        .await
        .unwrap();
    f.change("scores", ("number", None, Some(false), None))
        .await;
    assert_eq!(
        f.unfit("scores").await,
        [("1, 2".to_owned(), PropertyValueForm::List)]
    );
    f.declare("mark", single_def("number")).await;
    f.declare("marks", list_def("text", None)).await;
    let to_single =
        preview_unfit_property_move_inner(&f.pool, &f.a, "scores".into(), "mark".into())
            .await
            .unwrap();
    assert_eq!((to_single.moved, to_single.unfit_there), (0, 1));
    let to_list = preview_unfit_property_move_inner(&f.pool, &f.a, "scores".into(), "marks".into())
        .await
        .unwrap();
    assert_eq!((to_list.moved, to_list.unfit_there), (1, 0));
    move_unfit_property_values_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.a,
        "scores".into(),
        "marks".into(),
        to_list,
    )
    .await
    .unwrap();
    settle(&f.mat).await;
    assert_eq!(
        f.list(&f.child, "marks").await,
        Some(texts(&["1", "2"])),
        "each item is read under the type of the key it moves to"
    );
    assert_eq!(f.list(&f.child, "scores").await, None);

    // `read` holds one date, and one list that doesn't fit it.
    let dates = texts(&["2026-01-05", "2026-02-06"]);
    f.set_list(&f.child, "read", dates.clone()).await.unwrap();
    f.change("read", ("date", None, Some(false), None)).await;
    let removed = capture_op_refs(remove_unfit_property_values_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.a,
        "read".into(),
        one,
    ))
    .await
    .unwrap();
    settle(&f.mat).await;
    assert_eq!(f.list(&f.child, "read").await, None);
    f.undo(removed.op_refs[0].clone()).await;
    assert_eq!(f.list(&f.child, "read").await, Some(dates));
}

/// The lists `block` holds, by key.
async fn lists(f: &Fixture, block: &BlockId) -> Vec<(String, PropertyList)> {
    get_properties_inner(&f.pool, block.clone())
        .await
        .unwrap()
        .into_iter()
        .filter_map(|row| Some((row.key, row.value_list?)))
        .collect()
}

/// A block's lists, of every item type.
async fn hold_every_list(f: &Fixture) -> Vec<(String, PropertyList)> {
    let related = texts(&[f.target.as_str(), f.other.as_str()]);
    let held = [
        ("authors", texts(&["Smith, John", "Doe", "a [b"])),
        ("read", texts(&["2026-01-05", "2026-02-06"])),
        ("related", related),
        ("scores", nums(&[2.5, 4.0])),
        ("stages", texts(&["draft", "review"])),
    ];
    for (key, list) in &held {
        f.set_list(&f.child, key, list.clone()).await.unwrap();
    }
    held.map(|(key, list)| (key.to_owned(), list)).to_vec()
}

/// Duplicate copies each list a block holds, item for item, a list of refs as
/// the blocks it names.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_copies_each_list_a_block_holds_6741() {
    let f = fixture().await;
    let held = hold_every_list(&f).await;
    let copy = duplicate(&f.pool, &f.mat, &f.child).await;
    assert_eq!(copy.len(), 1);
    assert_eq!(lists(&f, &copy[0].id).await, held);
    assert_eq!(
        lists(&f, &f.child).await,
        held,
        "the original keeps its own"
    );
}

/// A text under a key that holds a list, a value that doesn't fit it, is
/// written as a list of one: Edit as Markdown's line and Duplicate's copy read
/// it back as that one item, never as the parts its comma splits it into, so a
/// copy is refused rather than saved as items the block never held.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_text_under_a_list_key_is_one_item_when_its_line_is_read_back_6741() {
    let f = fixture().await;
    f.declare("marks", single_def("text")).await;
    f.set_text(&f.child, "marks", "1, 2").await;
    f.change("marks", ("number", None, Some(true), SEMICOLON))
        .await;
    assert_eq!(f.text(&f.child, "marks").await.as_deref(), Some("1, 2"));

    let source = page_source(&f.pool, &f.page).await;
    // A list of one item holding a comma, as a whole-line JSON string.
    let line = r#"marks:: "\"1, 2\"""#;
    assert_eq!(source.matches(line).count(), 1, "`{line}` in:\n{source}");
    let copy = duplicate_block_inner(&f.pool, DEV, &f.mat, f.child.clone()).await;
    assert_refused(copy.map(drop), r#"got the item Text("1, 2")"#);
}

/// Edit as Markdown writes a list as one `key:: a, b` line, a ref item as a
/// link to its page, and reads the line back as the list: a save that changes
/// the line writes the new list, one that changes nothing writes nothing, and
/// an item the definition refuses refuses the save, naming the line.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_as_markdown_writes_a_list_as_one_line_and_reads_it_back_6741() {
    let f = fixture().await;
    let held = hold_every_list(&f).await;
    let source = page_source(&f.pool, &f.page).await;
    for line in [
        r#"authors:: "Smith, John", Doe, "a [b""#,
        "read:: 2026-01-05, 2026-02-06",
        "related:: [[Ann]], [[Bob]]",
        "scores:: 2.5, 4",
        "stages:: draft, review",
    ] {
        assert_eq!(source.matches(line).count(), 1, "`{line}` in:\n{source}");
    }
    let ops = f.op_count().await;
    save_source(&f.pool, &f.mat, &f.page, &source, &source)
        .await
        .unwrap();
    assert_eq!(
        f.op_count().await,
        ops,
        "an unchanged buffer writes nothing"
    );

    let edited = with(&source, "[[Ann]], [[Bob]]", "Bob");
    let edited = with(&edited, "2.5, 4", "7, 1e2");
    let edited = with(&edited, r#""Smith, John", Doe, "a [b""#, r#"Zed , "x, y""#);
    save_source(&f.pool, &f.mat, &f.page, &edited, &source)
        .await
        .unwrap();
    settle(&f.mat).await;
    let mut wanted = held;
    wanted[0].1 = texts(&["Zed", "x, y"]);
    wanted[2].1 = texts(&[f.other.as_str()]);
    wanted[3].1 = nums(&[7.0, 100.0]);
    assert_eq!(lists(&f, &f.child).await, wanted);

    let now = page_source(&f.pool, &f.page).await;
    let refused = save_source(
        &f.pool,
        &f.mat,
        &f.page,
        &with(&now, "7, 100", "7, x"),
        &now,
    )
    .await;
    assert_refused(refused.map(drop), "`scores:: 7, x` cannot be saved");
    let unknown = save_source(
        &f.pool,
        &f.mat,
        &f.page,
        &with(&now, "related:: [[Bob]]", "related:: [[Bob]], [[Nobody]]"),
        &now,
    )
    .await;
    assert_refused(unknown.map(drop), "no page is titled 'Nobody'");
    assert_eq!(
        lists(&f, &f.child).await,
        wanted,
        "a refused save writes nothing"
    );
}

/// The page's own list is a front matter line of the buffer, read back as the
/// list.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_as_markdown_reads_the_pages_own_list_from_its_front_matter_6741() {
    let f = fixture().await;
    f.set_list(&f.page, "authors", texts(&["Zed", "Doe, Jane"]))
        .await
        .unwrap();
    let source = page_source(&f.pool, &f.page).await;
    let edited = with(&source, "Zed", "Zoe");
    save_source(&f.pool, &f.mat, &f.page, &edited, &source)
        .await
        .unwrap();
    settle(&f.mat).await;
    assert_eq!(
        f.list(&f.page, "authors").await,
        Some(texts(&["Zoe", "Doe, Jane"]))
    );
}

/// A rename moves a key's lists to its new name, and a merge moves them to
/// the key it merges into.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_key_rename_and_a_merge_carry_a_list_6741() {
    let f = fixture().await;
    let authors = texts(&["Smith, John", "Doe"]);
    f.set_list(&f.child, "authors", authors.clone())
        .await
        .unwrap();
    let (old, new) = ("authors".to_owned(), "writers".to_owned());
    let renamed = rename_property_key_inner(&f.pool, DEV, &f.mat, &f.a, old, new)
        .await
        .unwrap();
    settle(&f.mat).await;
    assert!(renamed.multiple);
    assert_eq!(f.list(&f.child, "writers").await, Some(authors.clone()));
    assert_eq!(f.list(&f.child, "authors").await, None);

    let (from, into) = ("writers".to_owned(), "kept".to_owned());
    let counts = preview_property_merge_inner(&f.pool, &f.a, from.clone(), into.clone())
        .await
        .unwrap();
    assert_eq!((counts.moved, counts.dropped), (1, 0));
    merge_property_key_inner(&f.pool, DEV, &f.mat, &f.a, from, into, counts)
        .await
        .unwrap();
    settle(&f.mat).await;
    assert_eq!(f.list(&f.child, "kept").await, Some(authors));
    assert_eq!(f.list(&f.child, "writers").await, None);
}

/// A list of refs written with a page's `[[Title]]` or title names that page,
/// as a single ref value's text does; a title no page holds refuses the write.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ref_item_written_as_a_title_names_its_page_6741() {
    let f = fixture().await;
    f.set_list(
        &f.child,
        "related",
        texts(&["[[Ann]]", f.other.as_str(), "Ann"]),
    )
    .await
    .unwrap();
    let (ann, bob) = (f.target.as_str(), f.other.as_str());
    assert_eq!(
        f.list(&f.child, "related").await,
        Some(texts(&[ann, bob, ann]))
    );
    let ops = f.op_count().await;
    let unknown = f
        .set_list(&f.child, "related", texts(&["[[Nobody]]"]))
        .await;
    assert_refused(unknown, "no page is titled 'Nobody'");
    assert_eq!(f.op_count().await, ops);
    f.set_list(&f.child, "authors", texts(&["[[Ann]]"]))
        .await
        .unwrap();
    assert_eq!(
        f.list(&f.child, "authors").await,
        Some(texts(&["[[Ann]]"])),
        "under any other type an item is its text"
    );
}

/// A template's block that holds a list lands with it: a batch spec's typed
/// property takes a list as `set_property` does, and refuses one under a key
/// that holds a single value, writing nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_batch_spec_carries_a_list_6741() {
    let f = fixture().await;
    let spec = |key: &str, list: PropertyList| {
        let value = SetPropertyArgs {
            value_list: Some(list),
            ..Default::default()
        };
        CreateBlockSpec {
            block_type: "content".into(),
            content: "from a template".into(),
            parent_id: Some(f.page.clone()),
            parent_index: None,
            block_id: None,
            position: None,
            properties: std::collections::HashMap::new(),
            typed_properties: [(key.to_owned(), value)].into(),
        }
    };
    let authors = texts(&["Smith, John", "Doe"]);
    let created = create_blocks_batch_inner(
        &f.pool,
        DEV,
        &f.mat,
        vec![
            spec("authors", authors.clone()),
            spec("scores", nums(&[2.5])),
        ],
    )
    .await
    .unwrap();
    settle(&f.mat).await;
    assert_eq!(f.list(&created[0].id, "authors").await, Some(authors));
    assert_eq!(f.list(&created[1].id, "scores").await, Some(nums(&[2.5])));

    let ops = f.op_count().await;
    let refused =
        create_blocks_batch_inner(&f.pool, DEV, &f.mat, vec![spec("single", texts(&["a"]))]).await;
    assert_refused(refused.map(drop), "holds one value, not a list");
    assert_eq!(f.op_count().await, ops);
}
