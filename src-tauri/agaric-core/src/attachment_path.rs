//! Peer-supplied attachment `fs_path` parsing (#3370).
//!
//! `attachments.fs_path` is the on-disk location of an attachment's bytes,
//! relative to `app_data_dir`. Unlike `filename` (a display string —
//! [`crate::attachment_filename`]) it is a **real path that reaches the
//! filesystem**: every resolver joins it onto `app_data_dir` and then reads,
//! writes, renames or unlinks whatever it names.
//!
//! It is also **peer-supplied**. The value in a replicated `AddAttachment` op
//! is whatever the originating device put in the payload, and the local
//! origination guard cannot vet it — the same asymmetry #3029 documented for
//! `filename`. Before this module, the apply path stored that string verbatim.
//!
//! Two distinct things go wrong when it is stored verbatim, and this module
//! exists so neither can be expressed in the column:
//!
//! 1. **The path is not confined.** The shape check the resolvers ran
//!    (`check_attachment_fs_path_shape`) refused `..` and absolute paths but
//!    accepted any other *relative* path — `notes.db`, `notes.db-wal`, a key
//!    file. `app_data_dir` holds the SQLite database itself, so a peer that
//!    named one of those in `fs_path` and then answered the resulting
//!    file-request with its own bytes wrote them over the file. Confinement to
//!    the [`ATTACHMENTS_ROOT`] subtree is what makes an attachment path only
//!    ever able to name an attachment.
//!
//! 2. **The path is not canonical.** `attachments/./photo.png` and
//!    `attachments/photo.png` name the same file, but the orphan GC decides
//!    what to unlink by testing a walk-derived path string for membership in
//!    the set of stored `fs_path` strings. A non-canonical spelling misses that
//!    set, and the GC destroys the bytes of a row that references them. Storing
//!    the canonical spelling is what keeps that membership test meaningful.
//!
//! [`AttachmentFsPath`] is the parsed form: rooted at `attachments/`,
//! `/`-separated, with no `.`, `..`, empty, or drive/stream components. It can
//! only be obtained by parsing, so a value of this type is a path the GC can
//! compare and the resolvers can join.
//!
//! # Reject at the door, coerce on the apply path
//!
//! [`AttachmentFsPath::parse`] rejects, and is what the resolvers and the
//! snapshot-restore trust boundary use. The replicated-op apply path uses
//! [`AttachmentFsPath::coerce_from_peer`], which never fails — the #3029
//! precedent: a hard reject inside apply/replay would wedge the pipeline on one
//! hostile op, which is a DoS against the local user rather than a defence. An
//! unusable value is replaced by the deterministic `attachments/<attachment_id>`
//! path, which is exactly the shape this device's own ingest mints.
//!
//! `fs_path` is device-local storage detail, not replicated state — the receive
//! path already repoints it (`UPDATE attachments SET fs_path = ?` when a local
//! blob matches by content hash), and each side of a sync resolves bytes
//! through its *own* row. So a coerced path cannot diverge peers in any sense
//! that matters: it changes where this device keeps the bytes, nothing else.

use crate::attachment_filename::sanitize_attachment_filename;
use crate::error::AppError;

/// The single directory under `app_data_dir` that attachment bytes may live
/// in. Every `attachments.fs_path` names a file inside this subtree.
pub const ATTACHMENTS_ROOT: &str = "attachments";

/// A parsed, canonical, confined attachment path.
///
/// Canonical form is `attachments/<component>[/<component>…]`: forward slashes
/// only, at least one component below the root, and no component that is
/// empty, `.`, `..`, all-dots/spaces, or carries a `:`.
///
/// Construct one with [`AttachmentFsPath::parse`] (rejecting),
/// [`AttachmentFsPath::coerce_from_peer`] (never fails), or
/// [`AttachmentFsPath::for_storage_id`] (local ingest).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AttachmentFsPath(String);

impl AttachmentFsPath {
    /// Parse a stored or peer-supplied string into its canonical form.
    ///
    /// Normalizes rather than merely checking: `\` is treated as a separator on
    /// every platform (so one op canonicalizes identically on every device),
    /// empty and `.` components are dropped, and the result is re-joined with
    /// `/`. `attachments/./photo.png` and `attachments//photo.png` therefore
    /// both parse to `attachments/photo.png`.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Validation`] when the input is empty, absolute,
    /// contains `..`, contains a control character or a `:` (a Windows drive
    /// spec or NTFS alternate-data-stream suffix), has a component that
    /// Windows' trailing-dot/space stripping would fold back to `.`/`..`, does
    /// not start at [`ATTACHMENTS_ROOT`], or names no file below that root.
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        if raw.is_empty() {
            return Err(AppError::validation(
                "attachment path must not be empty".into(),
            ));
        }
        if raw.chars().any(char::is_control) {
            return Err(AppError::validation(
                "attachment path must not contain control characters".into(),
            ));
        }
        // A leading separator is the POSIX root. Checked on the raw string
        // because the component walk below deliberately drops empty segments,
        // which would otherwise silently *demote* `/etc/passwd` to a relative
        // path instead of refusing it.
        if raw.starts_with('/') || raw.starts_with('\\') {
            return Err(AppError::validation(
                "attachment path escapes app data dir".into(),
            ));
        }

        let mut components: Vec<&str> = Vec::new();
        for component in raw.split(['/', '\\']) {
            match component {
                // Dropped, not rejected: these are spellings of the same path,
                // and canonicalizing them is the point of parsing.
                "" | "." => continue,
                ".." => {
                    return Err(AppError::validation(
                        "attachment path escapes app data dir".into(),
                    ));
                }
                _ => {}
            }
            // Windows silently strips trailing dots and spaces from a path
            // component, which turns `.. .` back into `..` — the same edge
            // `sanitize_attachment_filename` guards for display names.
            if component.trim_end_matches(['.', ' ']).is_empty() {
                return Err(AppError::validation(
                    "attachment path escapes app data dir".into(),
                ));
            }
            // `C:` as a first component is a drive-relative path; `x.png:s` is
            // an NTFS alternate data stream. Neither can occur in a path this
            // app mints (they are ULIDs), so refusing `:` outright is free.
            if component.contains(':') {
                return Err(AppError::validation(
                    "attachment path must not contain a drive or stream separator".into(),
                ));
            }
            components.push(component);
        }

        if components.first().copied() != Some(ATTACHMENTS_ROOT) {
            return Err(AppError::validation(format!(
                "attachment path must live under `{ATTACHMENTS_ROOT}/`"
            )));
        }
        if components.len() < 2 {
            return Err(AppError::validation(
                "attachment path names no file below the attachments root".into(),
            ));
        }

        Ok(Self(components.join("/")))
    }

    /// The canonical path this device mints for a freshly ingested attachment.
    ///
    /// `storage_id` is run through [`sanitize_attachment_filename`] so the
    /// result is a single safe component even if a caller ever passes
    /// something less disciplined than the ULID the ingest path generates.
    #[must_use]
    pub fn for_storage_id(storage_id: &str) -> Self {
        Self(format!(
            "{ATTACHMENTS_ROOT}/{}",
            sanitize_attachment_filename(storage_id)
        ))
    }

    /// Parse a peer-supplied path, falling back to `attachments/<attachment_id>`
    /// when it cannot be made safe.
    ///
    /// Never fails — see the module docs for why the apply path must not reject.
    /// Compare [`Self::as_str`] against the input to detect that a rewrite
    /// happened (the callers log a `warn!` when it did).
    #[must_use]
    pub fn coerce_from_peer(raw: &str, attachment_id: &str) -> Self {
        Self::parse(raw).unwrap_or_else(|_| Self::for_storage_id(attachment_id))
    }

    /// The canonical path, relative to `app_data_dir`, `/`-separated.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consume into the owned canonical string.
    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl std::fmt::Display for AttachmentFsPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for AttachmentFsPath {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_paths_round_trip_unchanged() {
        for good in [
            "attachments/01J0000000000000000000000A",
            "attachments/sub/photo.png",
            "attachments/a/b/c.bin",
        ] {
            let parsed = AttachmentFsPath::parse(good).expect(good);
            assert_eq!(parsed.as_str(), good, "{good:?} must survive verbatim");
        }
    }

    /// The GC decides what to unlink by string-comparing a walk-derived path
    /// against the stored `fs_path`. These spellings all name the same file and
    /// must all collapse onto the one string the walk produces.
    #[test]
    fn equivalent_spellings_canonicalize_to_the_walk_form() {
        for spelling in [
            "attachments/./photo.png",
            "attachments//photo.png",
            "./attachments/photo.png",
            "attachments\\photo.png",
            "attachments/.//photo.png",
        ] {
            let parsed = AttachmentFsPath::parse(spelling).expect(spelling);
            assert_eq!(
                parsed.as_str(),
                "attachments/photo.png",
                "{spelling:?} must canonicalize to the directory-walk spelling"
            );
        }
    }

    #[test]
    fn traversal_is_refused() {
        for bad in [
            "../../etc/passwd",
            "attachments/../../escape",
            "attachments/../notes.db",
            "..",
            "attachments/.. ./notes.db",
        ] {
            assert!(
                AttachmentFsPath::parse(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn absolute_paths_are_refused() {
        for bad in ["/etc/passwd", "/attachments/photo.png", "\\attachments\\x"] {
            assert!(
                AttachmentFsPath::parse(bad).is_err(),
                "{bad:?} must be refused, not demoted to a relative path"
            );
        }
    }

    /// The reachable consequence #3370 is about: `app_data_dir` holds the
    /// SQLite database, and a relative path outside `attachments/` names it.
    #[test]
    fn relative_paths_outside_the_attachments_root_are_refused() {
        for bad in [
            "notes.db",
            "notes.db-wal",
            "notes.db-shm",
            "sync/keys.json",
            "photo.png",
            "Attachments/photo.png",
        ] {
            assert!(
                AttachmentFsPath::parse(bad).is_err(),
                "{bad:?} is outside the attachments root and must be refused"
            );
        }
    }

    #[test]
    fn drive_and_stream_separators_are_refused() {
        for bad in [
            "C:\\Windows\\System32",
            "attachments/photo.png:stream",
            "attachments/C:notes.db",
        ] {
            assert!(
                AttachmentFsPath::parse(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn empty_and_rootless_paths_are_refused() {
        for bad in ["", "attachments", "attachments/", "attachments/."] {
            assert!(
                AttachmentFsPath::parse(bad).is_err(),
                "{bad:?} names no file below the attachments root"
            );
        }
    }

    #[test]
    fn control_characters_are_refused() {
        assert!(AttachmentFsPath::parse("attachments/photo\0.png").is_err());
        assert!(AttachmentFsPath::parse("attachments/photo\n.png").is_err());
    }

    #[test]
    fn coercion_keeps_a_usable_path_and_canonicalizes_it() {
        let coerced = AttachmentFsPath::coerce_from_peer("attachments/./photo.png", "ATT1");
        assert_eq!(coerced.as_str(), "attachments/photo.png");
    }

    #[test]
    fn coercion_falls_back_to_the_attachment_id_for_a_hostile_path() {
        for hostile in ["notes.db", "../../etc/passwd", "/etc/passwd", ""] {
            let coerced = AttachmentFsPath::coerce_from_peer(hostile, "01J0ATT");
            assert_eq!(
                coerced.as_str(),
                "attachments/01J0ATT",
                "{hostile:?} must fall back to the device-local path"
            );
            // The fallback must itself be a value `parse` accepts, or the
            // resolvers would refuse to read back what apply just stored.
            assert!(AttachmentFsPath::parse(coerced.as_str()).is_ok());
        }
    }

    #[test]
    fn the_fallback_is_safe_even_for_a_hostile_attachment_id() {
        let coerced = AttachmentFsPath::coerce_from_peer("notes.db", "../../evil");
        assert!(
            AttachmentFsPath::parse(coerced.as_str()).is_ok(),
            "{coerced} must still parse"
        );
        // The separators in the hostile id are neutralized rather than
        // preserved, so it stays one component below the root — `.._.._evil`
        // is a legal file name, `../../evil` is not a legal path.
        assert_eq!(coerced.as_str(), "attachments/.._.._evil");
        assert_eq!(
            coerced.as_str().split('/').count(),
            2,
            "the fallback must be exactly `attachments/<one component>`"
        );
    }

    #[test]
    fn locally_minted_paths_parse() {
        let minted = AttachmentFsPath::for_storage_id("01J0000000000000000000000A");
        assert_eq!(minted.as_str(), "attachments/01J0000000000000000000000A");
        assert!(AttachmentFsPath::parse(minted.as_str()).is_ok());
    }
}
