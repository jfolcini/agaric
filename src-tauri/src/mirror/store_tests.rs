//! The state files' error handling: a missing path is nothing to read or
//! remove, and any other error is reported, never read as missing. A
//! directory where a file belongs, or a file where a directory belongs, fails
//! even for root, which ignores permissions.

use std::io::ErrorKind;

use tempfile::TempDir;

use super::*;

/// A `StateDir` in a fresh app data dir, bound to the folder `"/notes"`.
fn bound() -> (TempDir, StateDir) {
    let data = TempDir::new().unwrap();
    let mut states = StateDir::new(data.path());
    states.bind("/notes").unwrap();
    (data, states)
}

#[test]
fn a_marker_or_file_that_is_a_directory_is_an_error() {
    let root = TempDir::new().unwrap();
    std::fs::create_dir(root.path().join(MARKER_NAME)).unwrap();
    assert_eq!(
        marker_device(root.path()).unwrap_err().kind(),
        ErrorKind::IsADirectory
    );
    assert_eq!(
        read_optional(root.path()).unwrap_err().kind(),
        ErrorKind::IsADirectory
    );
}

#[test]
fn states_whose_directory_is_a_file_are_an_error() {
    let (_data, states) = bound();
    let dir = states.dir_for("/notes");
    std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
    std::fs::write(&dir, b"").unwrap();
    assert_eq!(states.load().unwrap_err().kind(), ErrorKind::NotADirectory);
    states.forget("/elsewhere").unwrap();
    assert_eq!(
        states.forget("/notes").unwrap_err().kind(),
        ErrorKind::NotADirectory
    );
}

#[test]
fn deleting_a_missing_state_is_nothing_and_a_directory_in_its_place_an_error() {
    let (_data, states) = bound();
    states.delete("01PAGE").unwrap();
    std::fs::create_dir_all(states.file("01PAGE").unwrap()).unwrap();
    assert_eq!(
        states.delete("01PAGE").unwrap_err().kind(),
        ErrorKind::IsADirectory
    );
}

#[test]
fn legacy_states_that_cannot_be_adopted_are_left_and_reported() {
    let data = TempDir::new().unwrap();
    let base = data.path().join("mirror");
    let legacy = base.join("state");
    std::fs::create_dir_all(&legacy).unwrap();

    // `mirror/folder`, naming their owner, is a directory.
    std::fs::create_dir(base.join("folder")).unwrap();
    let mut states = StateDir::new(data.path());
    assert_eq!(
        states.bind("/notes").unwrap_err().kind(),
        ErrorKind::IsADirectory
    );
    assert!(legacy.is_dir(), "the states are not moved");
    std::fs::remove_dir(base.join("folder")).unwrap();

    // Their new directory is a dangling link: not there, yet no rename lands.
    let target = states.dir_for("/notes");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(data.path().join("nowhere"), &target).unwrap();
    assert_eq!(
        states.bind("/notes").unwrap_err().kind(),
        ErrorKind::NotADirectory
    );
    assert!(legacy.is_dir(), "the states are not moved");
}

#[test]
fn an_owner_record_that_cannot_be_removed_is_reported() {
    let data = TempDir::new().unwrap();
    std::fs::create_dir_all(data.path().join("mirror/folder")).unwrap();
    let mut states = StateDir::new(data.path());
    assert_eq!(
        states.bind("/notes").unwrap_err().kind(),
        ErrorKind::IsADirectory
    );
}
