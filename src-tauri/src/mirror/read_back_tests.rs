//! [`markdown_below`]: the files reading back looks at.

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
