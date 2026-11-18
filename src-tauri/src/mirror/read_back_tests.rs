//! [`markdown_below`]: the files reading back looks at; [`mass_changed`]: when
//! it asks first.

use super::*;

#[test]
fn a_copy_folder_is_skipped_and_any_other_folder_read() {
    let root = tempfile::tempdir().unwrap();
    let copy = root.path().join("Space/assets/01HZZZZZZZZZZZZZZZZZZZZZZZ");
    let sub = root.path().join("Space/Sub");
    std::fs::create_dir_all(&copy).unwrap();
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(copy.join("copy.md"), "").unwrap();
    std::fs::write(sub.join("page.md"), "").unwrap();
    let mut found = Vec::new();
    markdown_below(root.path(), &root.path().join("Space"), &mut found).unwrap();
    assert_eq!(found, ["Space/Sub/page.md"]);
}

#[test]
fn a_missing_folder_holds_none_and_a_file_in_its_place_is_an_error() {
    let root = tempfile::tempdir().unwrap();
    let mut found = Vec::new();
    markdown_below(root.path(), &root.path().join("Gone"), &mut found).unwrap();
    assert_eq!(found, Vec::<String>::new());
    std::fs::write(root.path().join("File"), "").unwrap();
    let err = markdown_below(root.path(), &root.path().join("File"), &mut found).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::NotADirectory);
}

#[test]
fn only_a_folder_with_more_unconfirmed_files_than_the_limit_is_a_mass_change() {
    let files = |folder: &'static str, count| (0..count).map(move |n| format!("{folder}/{n}.md"));
    let changed: Vec<String> = files("A", MASS_CHANGE + 1)
        .chain(files("B", MASS_CHANGE))
        .collect();
    assert_eq!(
        mass_changed(&changed, &HashSet::new()),
        BTreeMap::from([("A", MASS_CHANGE + 1)])
    );
    let confirmed = HashSet::from(["A/0.md".to_owned()]);
    assert_eq!(mass_changed(&changed, &confirmed), BTreeMap::new());
}
