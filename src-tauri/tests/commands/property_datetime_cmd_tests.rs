//! #6758 — a `datetime` property: its definition and the stored form a write
//! takes, a type change into and out of it, a day converted to a time, the
//! Markdown surfaces reading and writing local time, and search.
//!
//! The device's zone is whatever the test host's is, so a text read here
//! carries its offset and a text written is compared with
//! `write_datetime(_, &Local)`: the zone rules themselves are pinned with
//! fixed zones in `agaric_core::date_validation` and `loro::coerce`.

use super::page_cmd_tests::{dup_child, dup_children, dup_page, page_source, save_source, with};
use super::prelude::*;
use agaric_core::date_validation::write_datetime;
use agaric_store::search_types::{SearchPropertyFilter, SearchScope};

const STORED: &str = "2026-11-14T08:30Z";

struct Fixture {
    pool: SqlitePool,
    mat: Materializer,
    dir: tempfile::TempDir,
    page: BlockId,
    block: BlockId,
}

/// A page and a block in the test space, which declares `starts` a datetime.
async fn fixture() -> Fixture {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Trip").await;
    let block = dup_child(&pool, &mat, &page, "flight").await;
    let f = Fixture {
        pool,
        mat,
        dir,
        page,
        block,
    };
    f.declare("starts", "datetime").await.unwrap();
    f
}

fn local(stored: &str) -> String {
    write_datetime(stored, &chrono::Local).expect("a stored datetime")
}

fn message(err: AppError) -> String {
    match err {
        AppError::Validation { message, .. } => message,
        other => panic!("expected a validation refusal, got {other:?}"),
    }
}

fn target(key: &str, value_type: &str) -> PropertyTypeTarget {
    PropertyTypeTarget {
        key: key.into(),
        value_type: value_type.into(),
        options: None,
        multiple: None,
        separator: None,
    }
}

impl Fixture {
    async fn declare(&self, key: &str, value_type: &str) -> Result<PropertyDefinition, AppError> {
        let (key, ty) = (key.into(), value_type.into());
        let def =
            create_property_def_inner(&self.pool, DEV, &self.mat, TEST_SPACE_ID, key, ty, None)
                .await;
        settle(&self.mat).await;
        def
    }

    /// Set `key` on `block` in the text or the date slot.
    async fn set(
        &self,
        block: &BlockId,
        key: &str,
        text: Option<&str>,
        date: Option<&str>,
    ) -> Result<(), AppError> {
        let (id, key) = (block.as_str().into(), key.into());
        let (text, date) = (text.map(str::to_owned), date.map(str::to_owned));
        let set = set_property_inner(
            &self.pool, DEV, &self.mat, id, key, text, None, date, None, None, None,
        )
        .await
        .map(drop);
        settle(&self.mat).await;
        set
    }

    /// `block`'s value under `key`, as `(value_text, value_date)`.
    async fn held(&self, block: &BlockId, key: &str) -> (Option<String>, Option<String>) {
        get_property_inner(&self.pool, block, key)
            .await
            .unwrap()
            .map_or((None, None), |row| (row.value_text, row.value_date))
    }

    async fn change(&self, key: &str, to: &str) -> (i64, i64) {
        let counts = preview_property_type_change_inner(&self.pool, TEST_SPACE_ID, target(key, to))
            .await
            .unwrap();
        change_property_type_inner(
            &self.pool,
            DEV,
            &self.mat,
            TEST_SPACE_ID,
            target(key, to),
            counts,
        )
        .await
        .unwrap();
        settle(&self.mat).await;
        (counts.converted, counts.unfit)
    }

    async fn import(&self, md: &str, file: &str) -> agaric_engine::import::ImportResult {
        let result = import_markdown_inner(
            &self.pool,
            DEV,
            &self.mat,
            self.dir.path(),
            md.into(),
            Some(file.into()),
            TEST_SPACE_ID.into(),
            None,
        )
        .await
        .unwrap();
        settle(&self.mat).await;
        result
    }

    /// The ids of the blocks a search for `starts` = `value` finds, in order
    /// of id; `exclude` searches for the blocks it is not.
    async fn found(&self, value: &str, exclude: bool) -> Vec<String> {
        let mut filter = search_filter(SearchScope::Spaces(vec![
            agaric_store::space::SpaceId::from_trusted(TEST_SPACE_ID),
        ]));
        let named = vec![SearchPropertyFilter {
            key: "starts".into(),
            value: value.into(),
        }];
        if exclude {
            filter.excluded_property_filters = named;
            filter.block_type_filter = Some("content".into());
        } else {
            filter.property_filters = named;
        }
        let page = search_blocks_inner(&self.pool, String::new(), None, None, filter, None)
            .await
            .unwrap();
        let mut ids: Vec<String> = page
            .items
            .into_iter()
            .map(|row| row.id.as_str().to_owned())
            .collect();
        ids.sort();
        ids
    }
}

/// A space declares a datetime, and a block holds one in its stored form
/// only: any other form, and a day, is refused, as is the stored form under a
/// date.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_datetime_key_takes_the_stored_form_only_6758() {
    let f = fixture().await;
    let def = get_property_def_inner(&f.pool, TEST_SPACE_ID, "starts")
        .await
        .unwrap()
        .expect("declared");
    assert_eq!((def.value_type.as_str(), def.multiple), ("datetime", false));

    f.set(&f.block, "starts", None, Some(STORED)).await.unwrap();
    assert_eq!(
        f.held(&f.block, "starts").await,
        (None, Some(STORED.into()))
    );

    for unfit in ["2026-11-14T09:30+01:00", "2026-11-14T09:30", "2026-11-14"] {
        assert_eq!(
            message(
                f.set(&f.block, "starts", None, Some(unfit))
                    .await
                    .unwrap_err()
            ),
            format!("Invalid datetime: '{unfit}'. Expected YYYY-MM-DDTHH:MMZ, in UTC.")
        );
    }
    assert_eq!(
        message(
            f.set(&f.block, "starts", Some(STORED), None)
                .await
                .unwrap_err()
        ),
        "Property 'starts' expects type 'datetime', got 'text'."
    );
    f.declare("day", "date").await.unwrap();
    assert_eq!(
        message(
            f.set(&f.block, "day", None, Some(STORED))
                .await
                .unwrap_err()
        ),
        format!("Invalid date format: '{STORED}'. Expected YYYY-MM-DD.")
    );
    assert_eq!(
        f.held(&f.block, "starts").await,
        (None, Some(STORED.into()))
    );
}

/// Declaring a datetime over values an undeclared key holds is refused: none
/// of them is a stored datetime, a day in the date slot included.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_datetime_is_not_declared_over_held_values_6758() {
    let f = fixture().await;
    f.set(&f.block, "ends", None, Some("2026-11-14"))
        .await
        .unwrap();
    assert_eq!(
        message(f.declare("ends", "datetime").await.unwrap_err()),
        "cannot declare property 'ends' as 'datetime': 1 value(s) already stored under this key \
         would be rejected by that type (1 stored as date). A property definition applies to \
         every block in its space, and it cannot be removed again while any value under the key \
         exists there. Clear or convert those values first, or declare 'ends' as the type they \
         already use."
    );
}

/// A type change to datetime reads each text as the user wrote it and leaves
/// a day, and any other text, not fitting; out of it, a datetime is its local
/// day under a date and its local time with its offset as text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_type_change_reads_and_writes_datetimes_in_local_time_6758() {
    let f = fixture().await;
    let day = dup_child(&f.pool, &f.mat, &f.page, "a day").await;
    let other = dup_child(&f.pool, &f.mat, &f.page, "no time").await;
    f.declare("at", "text").await.unwrap();
    f.set(&f.block, "at", Some("2026-11-14 13:00:30+01:00"), None)
        .await
        .unwrap();
    f.set(&day, "at", Some("2026-11-14"), None).await.unwrap();
    f.set(&other, "at", Some("soon"), None).await.unwrap();

    let listed = list_property_type_change_values_inner(
        &f.pool,
        TEST_SPACE_ID,
        target("at", "datetime"),
        PropertyTypeChangeKind::Converted,
        None,
        None,
    )
    .await
    .unwrap();
    let listed: Vec<_> = listed
        .items
        .into_iter()
        .map(|v| (v.value, v.converted))
        .collect();
    assert_eq!(
        listed,
        [(
            "2026-11-14 13:00:30+01:00".to_owned(),
            Some("2026-11-14T12:00Z".to_owned())
        )]
    );
    assert_eq!(f.change("at", "datetime").await, (1, 2));
    assert_eq!(
        f.held(&f.block, "at").await,
        (None, Some("2026-11-14T12:00Z".into()))
    );
    assert_eq!(f.held(&day, "at").await, (Some("2026-11-14".into()), None));
    assert_eq!(f.held(&other, "at").await, (Some("soon".into()), None));

    // Noon UTC is the 14th in every zone a host runs in.
    assert_eq!(f.change("at", "date").await, (2, 1));
    assert_eq!(
        f.held(&f.block, "at").await,
        (None, Some("2026-11-14".into()))
    );
    assert_eq!(f.held(&day, "at").await, (None, Some("2026-11-14".into())));

    // A day a date key holds does not fit a datetime: it leaves the column
    // the two types share.
    f.declare("due2", "date").await.unwrap();
    f.set(&day, "due2", None, Some("2026-11-14")).await.unwrap();
    assert_eq!(f.change("due2", "datetime").await, (0, 1));
    assert_eq!(
        f.held(&day, "due2").await,
        (Some("2026-11-14".into()), None)
    );

    f.set(&f.block, "starts", None, Some(STORED)).await.unwrap();
    assert_eq!(f.change("starts", "text").await, (1, 0));
    assert_eq!(
        f.held(&f.block, "starts").await,
        (Some(local(STORED)), None)
    );
}

/// Convert… gives each day under a datetime key a time: one replacement a
/// distinct day, read as a local time, written in one op; a replacement that
/// is no datetime refuses the whole conversion.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn convert_gives_each_day_under_a_datetime_key_a_time_6758() {
    let f = fixture().await;
    let second = dup_child(&f.pool, &f.mat, &f.page, "second").await;
    let third = dup_child(&f.pool, &f.mat, &f.page, "third").await;
    f.declare("at", "text").await.unwrap();
    f.set(&f.block, "at", Some("2026-11-14"), None)
        .await
        .unwrap();
    f.set(&second, "at", Some("2026-11-14"), None)
        .await
        .unwrap();
    f.set(&third, "at", Some("2026-11-15"), None).await.unwrap();
    assert_eq!(f.change("at", "datetime").await, (0, 3));

    let one = |unfit| PropertyUnfitCounts {
        unfit,
        unfit_in_trash: 0,
    };
    let map = |value: &str, replacement: &str, unfit| UnfitValueReplacement {
        value: value.into(),
        replacement: replacement.into(),
        acknowledged: one(unfit),
    };
    let convert = |replacements| {
        capture_op_refs(convert_unfit_property_values_inner(
            &f.pool,
            DEV,
            &f.mat,
            TEST_SPACE_ID,
            "at".into(),
            replacements,
        ))
    };
    let refused = convert(vec![
        map("2026-11-14", "2026-11-14T12:00Z", 2),
        map("2026-11-15", "2026-11-15T25:00", 1),
    ])
    .await
    .unwrap_err();
    assert_eq!(
        message(refused),
        "'2026-11-15T25:00' doesn't fit 'at' (datetime)"
    );
    assert_eq!(
        f.held(&f.block, "at").await,
        (Some("2026-11-14".into()), None)
    );

    let converted = convert(vec![
        map("2026-11-14", "2026-11-14T13:00+01:00", 2),
        map("2026-11-15", "2026-11-15T12:00Z", 1),
    ])
    .await
    .unwrap();
    settle(&f.mat).await;
    assert_eq!(converted.inner, one(3));
    assert_eq!(converted.op_refs.len(), 1, "one op, so one undo");
    for (block, stored) in [
        (&f.block, "2026-11-14T12:00Z"),
        (&second, "2026-11-14T12:00Z"),
        (&third, "2026-11-15T12:00Z"),
    ] {
        assert_eq!(f.held(block, "at").await, (None, Some(stored.into())));
    }
}

/// An import reads a datetime key's `key::` lines and front matter into the
/// stored form, warns where it dropped seconds, keeps a line that is no
/// datetime as text and skips such a front matter value.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_import_reads_a_datetime_keys_values_6758() {
    let f = fixture().await;
    f.declare("ends", "datetime").await.unwrap();
    let md = "---\nstarts: 2026-11-14T09:30:15+01:00\nends: 2026-11-14\n---\n\
              - flight\n  starts:: 2026-11-14T09:30+01:00\n\
              - hotel\n  starts:: 2026-11-14 09:30:45+01:00\n\
              - dinner\n  starts:: 2026-11-14\n\
              - walk\n  starts:: 2026-11-14T09:30\n";
    let result = f.import(md, "Plan.md").await;
    assert_eq!(
        result.warnings,
        [
            "`starts:: 2026-11-14 09:30:45+01:00` was read to the minute: a datetime keeps no seconds",
            "`starts:: 2026-11-14` was kept as text: Property 'starts' expects type 'datetime', got 'text'.",
            "`starts: 2026-11-14T09:30:15+01:00` was read to the minute: a datetime keeps no seconds",
            "front matter `ends: 2026-11-14` was skipped: Property 'ends' expects type 'datetime', got 'text'.",
        ]
    );
    let page = BlockId::from_trusted(&result.page_id);
    assert_eq!(f.held(&page, "starts").await, (None, Some(STORED.into())));
    assert_eq!(f.held(&page, "ends").await, (None, None));
    let blocks = dup_children(&f.pool, &page).await;
    let contents: Vec<&str> = blocks.iter().map(|(_, content)| content.as_str()).collect();
    assert_eq!(
        contents,
        ["flight", "hotel", "dinner\nstarts:: 2026-11-14", "walk"]
    );
    let ids: Vec<BlockId> = blocks
        .iter()
        .map(|(id, _)| BlockId::from_trusted(id))
        .collect();
    let held = |i: usize| f.held(&ids[i], "starts");
    assert_eq!(held(0).await, (None, Some(STORED.into())));
    assert_eq!(held(1).await, (None, Some(STORED.into())));
    assert_eq!(held(2).await, (None, None));
    // No zone: the device's local time, which reads back as written.
    let (_, walk) = held(3).await;
    let written = walk.as_deref().map(local).expect("a stored datetime");
    assert!(written.starts_with("2026-11-14T09:30"), "{written}");
    assert_eq!(written.len(), 22);
}

/// The export, and the buffer Edit as Markdown loads, write a datetime as
/// local time with its offset, in a `key::` line and in front matter, single
/// and in a list; a date is written as it is. A save reads the edited line
/// back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_writes_a_datetime_as_local_time_with_its_offset_6758() {
    let f = fixture().await;
    let later = "2026-11-15T17:45Z";
    f.declare("day", "date").await.unwrap();
    let sessions = agaric_store::op::PropertyDefState {
        value_type: "datetime".into(),
        options: None,
        multiple: true,
    };
    create_property_def_state_inner(
        &f.pool,
        DEV,
        &f.mat,
        TEST_SPACE_ID,
        "sessions".into(),
        sessions,
    )
    .await
    .unwrap();
    f.set(&f.block, "starts", None, Some(STORED)).await.unwrap();
    f.set(&f.block, "day", None, Some("2026-11-14"))
        .await
        .unwrap();
    f.set(&f.page, "starts", None, Some(later)).await.unwrap();
    let list = agaric_store::op::PropertyValueFields {
        value_list: Some(agaric_store::op::PropertyList(vec![
            agaric_store::op::PropertyListItem::Text(STORED.into()),
            agaric_store::op::PropertyListItem::Text(later.into()),
        ])),
        ..Default::default()
    };
    set_property_list_inner(
        &f.pool,
        DEV,
        &f.mat,
        f.block.as_str().into(),
        "sessions".into(),
        list,
    )
    .await
    .unwrap();
    settle(&f.mat).await;
    assert!(
        local(STORED).ends_with(":00") && local(STORED).len() == 22,
        "an offset, not Z"
    );

    let md = export_page_markdown_inner(&f.pool, f.page.as_str())
        .await
        .unwrap();
    let lines: Vec<&str> = md
        .lines()
        .filter(|line| line.contains("2026-11-1"))
        .collect();
    assert_eq!(
        lines,
        [
            format!("starts: {}", local(later)),
            "  day:: 2026-11-14".to_owned(),
            format!("  sessions:: {}, {}", local(STORED), local(later)),
            format!("  starts:: {}", local(STORED)),
        ]
    );

    let source = page_source(&f.pool, &f.page).await;
    let line = format!("starts:: {}", local(STORED));
    let edited = with(
        &source,
        &format!("  {line}"),
        "  starts:: 2026-11-14T10:45+01:00",
    );
    save_source(&f.pool, &f.mat, &f.page, &edited, &source)
        .await
        .unwrap();
    settle(&f.mat).await;
    assert_eq!(
        f.held(&f.block, "starts").await,
        (None, Some("2026-11-14T09:45Z".into()))
    );
    assert_eq!(f.held(&f.page, "starts").await, (None, Some(later.into())));
}

/// `prop:starts=` on a declared datetime key finds the instant an operand
/// names, in any form, and the blocks it is not; a day is the device's day.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_reads_a_datetime_keys_operand_6758() {
    let f = fixture().await;
    let other = dup_child(&f.pool, &f.mat, &f.page, "train").await;
    f.set(&f.block, "starts", None, Some("2026-11-14T12:00Z"))
        .await
        .unwrap();
    f.set(&other, "starts", None, Some("2026-11-20T12:00Z"))
        .await
        .unwrap();
    let (flight, train) = ([f.block.as_str().to_owned()], [other.as_str().to_owned()]);

    assert_eq!(f.found("2026-11-14T13:00+01:00", false).await, flight);
    assert_eq!(f.found("2026-11-14T12:00Z", false).await, flight);
    assert_eq!(f.found("2026-11-14T13:00+01:00", true).await, train);
    // Noon UTC is the 14th in every zone a host runs in.
    assert_eq!(f.found("2026-11-14", false).await, flight);
    assert_eq!(f.found("2026-11-14", true).await, train);
    assert_eq!(f.found("2026-11-16", false).await, Vec::<String>::new());
}
