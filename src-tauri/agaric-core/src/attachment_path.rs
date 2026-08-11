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
//! 1. **The path is not confined.** The lexical shape check the resolvers ran
//!    before this module existed refused `..` and absolute paths but
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
//! `/`-separated, with no `.`, `..`, empty, or drive/stream components, and no
//! component ending in a dot or a space (Windows folds those away at create
//! time, which is failure mode 2 again by another spelling). It can only be
//! obtained by parsing, so a value of this type is a path the GC can compare
//! and the resolvers can join.
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
//! The fallback is built from the attachment id, which is **also** peer-supplied
//! — `BlockId`'s `Deserialize` accepts any non-ULID string with a plain
//! ASCII-uppercase and no error — so it cannot be assumed safe either. If the
//! fallback could itself be a path `parse` refuses, the row would fail to store
//! and the apply transaction would abort on every retry: the same DoS, reached
//! through the storage layer instead of through the validator.
//! [`AttachmentFsPath::for_storage_id`] therefore mints the id into a path only
//! when it is ASCII with no lowercase letters and
//! [`AttachmentFsPath::parse`] accepts it *unchanged*, and substitutes the id's
//! blake3 digest otherwise.
//!
//! `fs_path` is device-local storage detail, not replicated state — the receive
//! path already repoints it (`UPDATE attachments SET fs_path = ?` when a local
//! blob matches by content hash), and each side of a sync resolves bytes
//! through its *own* row. So a coerced path cannot diverge peers in any sense
//! that matters: it changes where this device keeps the bytes, nothing else.
//!
//! # Limitations
//!
//! Canonicalization here is **lexical and byte-exact**. Case and Unicode
//! transformations a real filesystem can apply but this module does not
//! include (#3734):
//!
//! * **Case.** APFS and NTFS are case-insensitive by default, so a peer row
//!   spelled `attachments/PHOTO.PNG` names the same file as an existing
//!   `attachments/photo.png` — two distinct strings in the column, one file on
//!   disk. That is GC failure mode 2 by another spelling: the orphan GC's
//!   directory walk derives whichever case the directory entry actually holds
//!   and cannot match the other row's string. The general peer-steerable case is
//!   not closed. The steerable cases that *are* closed are fallback ids:
//!   [`AttachmentFsPath::for_storage_id`] only mints ASCII ids without
//!   lowercase letters verbatim and compares the `id-<hex>` prefix
//!   case-insensitively. Normalizing every accepted peer path's case here would
//!   rewrite the ULID paths this device already minted and stored, which is a
//!   larger change than the hazard warrants.
//! * **Unicode case folding.** Some case-insensitive filesystems fold non-ASCII
//!   code points too. For example, NTFS's uppercase mapping can fold the dotless
//!   `ı` in a peer path such as `attachments/ıD-file` to `I`, making it collide
//!   with `attachments/ID-file`. The ASCII/lowercase gate above closes this for
//!   fallback ids, but [`AttachmentFsPath::parse`] still accepts either spelling
//!   when it arrives directly as a peer-supplied `fs_path`.
//! * **Unicode form.** HFS+ stores NFD; a row carrying the NFC spelling of the
//!   same name is again one file and two strings.
//!
//! These are narrow in practice because every path this device mints is
//! `attachments/<ULID>` — ASCII, uppercase, and unique by construction — so the
//! collision needs a peer-supplied path to reach it. They are stated here rather
//! than left implicit, because the invariant a reader would otherwise take from
//! the type ("one path string per file") is stronger than what it delivers on
//! those filesystems.

use crate::error::AppError;

/// The single directory under `app_data_dir` that attachment bytes may live
/// in. Every `attachments.fs_path` names a file inside this subtree.
pub const ATTACHMENTS_ROOT: &str = "attachments";

/// Marks a storage-id component that had to be replaced by its digest because
/// the sanitized form was still not a path [`AttachmentFsPath::parse`] accepts.
/// Visible in the row so an operator can tell a digest apart from an id.
const OPAQUE_ID_PREFIX: &str = "id-";

/// MS-DOS device names. Windows resolves these as devices in **every**
/// directory and with any extension (`CON`, `con.png`, `NUL.bin`), so a
/// component whose stem is one of them cannot be created as a file there. That
/// is not a traversal or a GC hazard — the write fails, or the bytes vanish into
/// the device — but `find_missing_attachments` then re-requests that row from a
/// peer on every sync, forever. [`AttachmentFsPath::parse`] therefore refuses
/// such a component *anywhere* in the path (#3734), which is what makes the
/// coercion fallback divert to the digest as well: the loop is closed here
/// rather than left to the writer to discover.
const DOS_DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "COM¹", "COM²",
    "COM³", "LPT¹", "LPT²", "LPT³",
];

/// True when `component` is one Windows resolves as a device rather than a
/// file. Windows does so in **every** directory and with any extension (`CON`,
/// `con.png`, `NUL.bin`), so such a component cannot be created there.
fn is_dos_device_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or("");
    DOS_DEVICE_NAMES
        .iter()
        .any(|d| stem.eq_ignore_ascii_case(d))
}

/// True when `id` opens with the digest namespace marker in any ASCII case.
///
/// ASCII-case-insensitive because the verbatim branch admits only ASCII and the
/// path lands on a filesystem that is case-insensitive on macOS and Windows:
/// `ID-<hex>` and `id-<hex>` are two strings the `UNIQUE` index treats as
/// distinct and one file on APFS/NTFS (#3734).
fn has_opaque_id_prefix(id: &str) -> bool {
    id.get(..OPAQUE_ID_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(OPAQUE_ID_PREFIX))
}

/// The always-parseable, per-id-unique path `for_storage_id` falls back to.
///
/// `id-` plus 64 lowercase hex digits: no separator, no `:`, no control
/// character, no trailing dot or space, never empty — every reason
/// [`AttachmentFsPath::parse`] has to refuse a component is absent by the
/// shape of hex, which is what makes the guarantee provable rather than
/// enumerated.
fn digest_component_path(storage_id: &str) -> String {
    format!(
        "{ATTACHMENTS_ROOT}/{OPAQUE_ID_PREFIX}{}",
        blake3::hash(storage_id.as_bytes()).to_hex()
    )
}

/// A parsed, canonical, confined attachment path.
///
/// Canonical form is `attachments/<component>[/<component>…]`: forward slashes
/// only, at least one component below the root, and no component that is
/// empty, `.`, `..`, all-dots/spaces, carries a `:`, or ends in a dot or a
/// space.
///
/// Construct one with [`AttachmentFsPath::parse`] (rejecting),
/// [`AttachmentFsPath::coerce_from_peer`] (never fails), or
/// [`AttachmentFsPath::for_storage_id`] (local ingest).
///
/// # The construction invariant
///
/// Every non-`parse` constructor returns a value that `parse` accepts, and it
/// is enforced by construction rather than by inspection: [`Self::for_storage_id`]
/// re-parses its own output and falls back to a component whose acceptability
/// is trivially provable (hex digits) if the sanitizer left anything `parse`
/// refuses. That matters because a constructor that can emit an unparseable
/// path re-introduces the very DoS coercion exists to avoid — the row fails to
/// store, the apply transaction aborts, and it aborts identically on every
/// retry.
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
    /// Windows' trailing-dot/space stripping would fold back to `.`/`..`, has a
    /// component Windows resolves as an MS-DOS device (`CON`, `NUL.png`), does
    /// not start at [`ATTACHMENTS_ROOT`], or names no file below that root.
    ///
    /// The device-name rule is about a path that cannot be *written*, not one
    /// that escapes: the write fails or the bytes vanish into the device,
    /// `find_missing_attachments` sees the row as missing, and the peer is asked
    /// for it again on every sync forever. Refusing at the door sends the apply
    /// path to [`Self::for_storage_id`] instead, which is a path that works
    /// (#3734).
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
            // `C:` as a first component is a drive-relative path; `x.png:s` is
            // an NTFS alternate data stream. Neither can occur in a path this
            // app mints (they are ULIDs), so refusing `:` outright is free.
            // Checked before the fold below, so a `:` cannot hide behind one.
            if component.contains(':') {
                return Err(AppError::validation(
                    "attachment path must not contain a drive or stream separator".into(),
                ));
            }
            // Windows silently strips trailing dots and spaces from a path
            // component at create time, so `photo.png.` and `photo.png` name
            // ONE file there and two strings here. Fold rather than merely
            // reject-if-it-empties: a row spelled `attachments/photo.png.`
            // would otherwise have its bytes land at `attachments\photo.png`,
            // whereupon the GC's walk derives `attachments/photo.png`, misses
            // the stored string, and destroys bytes a live row references —
            // the same membership-test failure as `attachments/./photo.png`.
            // Folding here also covers the `.. .` → `..` revival that
            // `sanitize_attachment_filename` guards for display names, since a
            // component that folds to nothing (or to `.`/`..`) is refused.
            let folded = component.trim_end_matches(['.', ' ']);
            if folded.is_empty() || folded == "." || folded == ".." {
                return Err(AppError::validation(
                    "attachment path escapes app data dir".into(),
                ));
            }
            // Checked on the FOLDED form, because that is the name the
            // filesystem would see: Windows strips the trailing space from
            // `CON ` before resolving it as a device.
            if is_dos_device_name(folded) {
                return Err(AppError::validation(
                    "attachment path component names an MS-DOS device".into(),
                ));
            }
            components.push(folded);
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

    /// The canonical path this device mints for an attachment with the given
    /// storage id.
    ///
    /// Local ingest passes a freshly generated ULID and gets
    /// `attachments/<ULID>` back. The coercion fallback passes an
    /// **attachment id**, which is peer-supplied: `BlockId`'s `Deserialize`
    /// accepts any non-ULID string with a plain ASCII-uppercase and no error,
    /// and nothing constrains `attachments.id` to a ULID. So this constructor
    /// treats `storage_id` as untrusted.
    ///
    /// # Two properties, both by construction
    ///
    /// **The result always parses.** The id is minted into the path verbatim
    /// only when it is ASCII without lowercase letters and [`Self::parse`]
    /// accepts the candidate *unchanged* — an identity parse. Anything else
    /// falls to the id's blake3 digest, which is hex and therefore cannot be
    /// refused. The local ULID alphabet is a subset of that admitted shape;
    /// excluding lowercase and non-ASCII peer ids prevents them from exploiting
    /// filesystem case folds.
    /// The remaining path rules are read off `parse` itself rather than
    /// restated, so the two cannot drift apart.
    ///
    /// **Distinct ids stay byte-distinct, and the digest namespace stays
    /// distinct under filesystem case folding for constructor output.**
    /// `attachments.fs_path` carries a partial `UNIQUE` index (migration 0037):
    /// two rows sharing a path means the second
    /// `INSERT OR IGNORE` is silently dropped. A sanitizing fallback cannot
    /// promise this — `""`, `"."` and `" "` all sanitize to one name — but a
    /// digest can, and a verbatim id is distinct from other verbatim ids by
    /// definition. An id spelled like a digest is diverted to the digest branch
    /// too, so the two namespaces cannot be made to overlap by a peer choosing
    /// its own id — and the prefix test is **case-insensitive** (#3734), because
    /// the index compares strings while APFS and NTFS compare files: `ID-<hex>`
    /// and `id-<hex>` are two rows the index is happy with and one file on disk,
    /// which is the collision this branch exists to prevent. Non-ASCII ids are
    /// digested rather than relying on a platform's Unicode folding rules. This
    /// property is scoped to paths minted here; directly accepted peer paths
    /// retain the module-level limitations.
    #[must_use]
    pub fn for_storage_id(storage_id: &str) -> Self {
        let candidate = format!("{ATTACHMENTS_ROOT}/{storage_id}");
        // No device-name test here: `parse` refuses an MS-DOS device component
        // anywhere in the path (#3734), so the identity parse below already
        // diverts one. Restating the rule is what lets the two drift.
        // Local attachment ids are uppercase ASCII ULIDs. Keeping the verbatim
        // branch to ASCII values without lowercase letters makes its
        // case-insensitive uniqueness claim portable: peer-derived lowercase
        // or non-ASCII ids take the per-id digest rather than relying on a
        // filesystem's case table.
        let ascii_without_lowercase =
            storage_id.is_ascii() && !storage_id.bytes().any(|byte| byte.is_ascii_lowercase());
        let mintable = ascii_without_lowercase
            && !storage_id.contains(['/', '\\'])
            && !has_opaque_id_prefix(storage_id)
            && matches!(Self::parse(&candidate), Ok(ref parsed) if parsed.as_str() == candidate);

        if mintable {
            Self(candidate)
        } else {
            Self(digest_component_path(storage_id))
        }
    }

    /// Parse a peer-supplied path, falling back to `attachments/<attachment_id>`
    /// when it cannot be made safe.
    ///
    /// Never fails, and — via [`Self::for_storage_id`] — never returns a value
    /// [`Self::parse`] would refuse, whatever the peer put in *either*
    /// argument. Both halves matter: a fallback that could not be stored would
    /// abort the apply transaction just as a reject would, only later and less
    /// legibly.
    ///
    /// See the module docs for why the apply path must not reject. Compare
    /// [`Self::as_str`] against the input to detect that a rewrite happened
    /// (the callers log a `warn!` when it did).
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

    /// Peer-controlled strings that have, or plausibly could, reach
    /// `for_storage_id` as an attachment id. `BlockId`'s `Deserialize` accepts
    /// any non-ULID string with a plain ASCII-uppercase and no error, so this
    /// is the real domain, not a pathological one.
    const HOSTILE_IDS: &[&str] = &[
        // The one that shipped broken: `:` survives the display sanitizer
        // untouched and `parse` refuses it.
        "C:X",
        "01J0:ATT",
        "x.png:$DATA",
        // Separators and traversal.
        "../../evil",
        "..\\..\\evil",
        "a/b",
        "a\\b",
        "/",
        "\\",
        "..",
        ".",
        "...",
        // Empty / whitespace-only / trailing dot and space.
        "",
        " ",
        "   ",
        "photo.",
        "photo ",
        "photo. . ",
        ". .",
        // Control characters, including the path-truncating NUL.
        "a\0b",
        "\n",
        "\u{7f}",
        // MS-DOS device names, which Windows resolves in every directory.
        "CON",
        "con",
        "NUL.png",
        "LPT9",
        "aux.bin",
        // Long and multi-byte identifiers exercise the digest branch without
        // relying on a byte-truncating sanitizer.
        "ID-01234567890123456789012345678901234567890123456789",
        "\u{e9}",
    ];

    /// The invariant the shipped version asserted over a hand-picked id set and
    /// therefore missed: **whatever** the peer puts in either argument,
    /// `coerce_from_peer` returns something `parse` accepts. A constructor that
    /// can emit an unparseable path re-introduces the reject-in-apply DoS
    /// through the storage layer instead of through the validator.
    #[test]
    fn coercion_always_returns_a_path_parse_accepts() {
        let hostile_paths = [
            "notes.db",
            "notes.db-wal",
            "../../etc/passwd",
            "/etc/passwd",
            "C:\\Windows\\System32",
            "attachments/../notes.db",
            "attachments/photo.png:stream",
            "",
            ".",
            "attachments",
            // Already-good paths, so the loop also covers the accept branch.
            "attachments/photo.png",
            "attachments/./photo.png",
        ];
        let mut digests = 0usize;
        for id in HOSTILE_IDS {
            for path in hostile_paths {
                let coerced = AttachmentFsPath::coerce_from_peer(path, id);
                let reparsed = AttachmentFsPath::parse(coerced.as_str());
                assert!(
                    reparsed.is_ok(),
                    "coerce_from_peer({path:?}, {id:?}) produced {coerced:?}, \
                     which parse refuses: {:?}",
                    reparsed.err()
                );
                // Idempotent as well as accepted: re-parsing must be a no-op,
                // or the value stored is not the value the GC will compare.
                assert_eq!(
                    reparsed.expect("just asserted Ok").as_str(),
                    coerced.as_str(),
                    "coerced path {coerced:?} is accepted but not canonical"
                );
                if coerced.as_str().contains(OPAQUE_ID_PREFIX) {
                    digests += 1;
                }
            }
        }
        // The digest branch must actually be reachable, or this test would keep
        // passing if `for_storage_id` stopped re-parsing.
        assert!(
            digests > 0,
            "no hostile id exercised the digest fallback — the structural \
             guarantee is untested"
        );
    }

    /// Distinct ids must not collapse onto one path: `attachments.fs_path`
    /// carries a partial UNIQUE index (migration 0037), so a constant fallback
    /// would make the second such row collide.
    ///
    /// Compared **case-insensitively** (#3734). The UNIQUE index compares byte
    /// strings, but the paths it indexes are opened on a filesystem that is
    /// case-insensitive by default on macOS and Windows: two rows the index is
    /// perfectly happy with can still be one file on disk, and then one row's
    /// bytes are the other's. An exact-string check cannot see that class at
    /// all, which is how the `ID-<hex>`/`id-<hex>` collision survived the
    /// original test.
    #[test]
    fn the_fallback_keeps_distinct_ids_distinct() {
        let mut seen = std::collections::HashSet::new();
        for id in HOSTILE_IDS {
            let path = AttachmentFsPath::coerce_from_peer("notes.db", id).into_string();
            assert!(
                seen.insert(path.to_ascii_lowercase()),
                "two distinct hostile ids share the fallback path {path:?} \
                 (compared case-insensitively: on APFS/NTFS that is one file)"
            );
        }
    }

    /// Windows folds a trailing dot or space away at create time, so these
    /// spell the same file as the bare name and must reach the row as the
    /// spelling the GC's directory walk produces.
    #[test]
    fn trailing_dots_and_spaces_fold_to_the_walk_form() {
        for spelling in [
            "attachments/photo.png.",
            "attachments/photo.png ",
            "attachments/photo.png..",
            "attachments/photo.png. .",
            "attachments/sub./photo.png",
            "attachments/sub /photo.png",
        ] {
            let parsed = AttachmentFsPath::parse(spelling).expect(spelling);
            assert!(
                !parsed.as_str().contains(". ") && !parsed.as_str().ends_with(['.', ' ']),
                "{spelling:?} kept a trailing dot/space: {parsed:?}"
            );
            assert!(
                !parsed.as_str().contains("./") && !parsed.as_str().contains(" /"),
                "{spelling:?} kept a trailing dot/space on an interior component: {parsed:?}"
            );
        }
        assert_eq!(
            AttachmentFsPath::parse("attachments/photo.png.")
                .unwrap()
                .as_str(),
            "attachments/photo.png"
        );
        assert_eq!(
            AttachmentFsPath::parse("attachments/sub./photo.png ")
                .unwrap()
                .as_str(),
            "attachments/sub/photo.png"
        );
    }

    /// A component that folds away entirely, or folds back to `.`/`..`, is
    /// still refused rather than silently dropped.
    #[test]
    fn a_component_that_folds_to_nothing_is_refused() {
        for bad in [
            "attachments/. ./photo.png",
            "attachments/.. ./photo.png",
            "attachments/   /photo.png",
            "attachments/photo.png/. .",
        ] {
            assert!(
                AttachmentFsPath::parse(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
    }

    /// The digest branch's output, tested directly rather than only through
    /// whichever ids happen to reach it: every reason `parse` has to refuse a
    /// component is absent from hex by construction.
    #[test]
    fn the_digest_fallback_always_parses_and_is_per_id_unique() {
        let mut seen = std::collections::HashSet::new();
        for id in HOSTILE_IDS {
            let path = digest_component_path(id);
            assert!(
                AttachmentFsPath::parse(&path).is_ok(),
                "digest path {path:?} for {id:?} must parse"
            );
            assert!(
                seen.insert(path.clone()),
                "two distinct ids share the digest path {path:?}"
            );
        }
    }

    /// A peer cannot steer its own attachment onto another row's digest path by
    /// naming itself `id-<hex>`: an id spelled like a digest is diverted to the
    /// digest branch, whose output would have to be a blake3 preimage to match.
    ///
    /// Checked over every ASCII spelling of the marker and **compared
    /// case-insensitively** (#3734). The digest path is the file the victim's
    /// bytes live in; on APFS or NTFS `attachments/ID-<hex>` opens that same
    /// file, so a byte-exact `assert_ne!` — which is what shipped — declares the
    /// namespaces disjoint while they are not. The victim is reachable: its row
    /// only holds a digest path if its own id was unmintable, i.e. peer-crafted
    /// in the first place, and both ids come off the same wire.
    #[test]
    fn an_id_spelled_like_a_digest_does_not_collide_with_one() {
        let victim = AttachmentFsPath::for_storage_id(":");
        let digest_component = victim
            .as_str()
            .strip_prefix("attachments/")
            .expect("rooted")
            .to_owned();
        for impostor_id in [
            digest_component.clone(),
            digest_component.to_ascii_uppercase(),
            // Marker uppercased, digits left alone — the minimal spelling that
            // slips a case-sensitive `starts_with`.
            format!(
                "{}{}",
                OPAQUE_ID_PREFIX.to_ascii_uppercase(),
                digest_component
                    .strip_prefix(OPAQUE_ID_PREFIX)
                    .expect("digest carries the marker")
            ),
        ] {
            let impostor = AttachmentFsPath::for_storage_id(&impostor_id);
            assert_ne!(
                victim.as_str().to_ascii_lowercase(),
                impostor.as_str().to_ascii_lowercase(),
                "id {impostor_id:?} lands on the victim's digest path on any \
                 case-insensitive filesystem — the same file, two rows"
            );
            assert!(AttachmentFsPath::parse(impostor.as_str()).is_ok());
        }
    }

    /// Only ASCII identifiers without lowercase letters may mint verbatim. A
    /// lowercase direct caller and a non-ASCII peer id both take the per-id
    /// digest, so filesystem case tables cannot make them alias an uppercase
    /// path or the digest namespace.
    #[test]
    fn lowercase_and_non_ascii_storage_ids_use_distinct_digests() {
        let lowercase = "peer-id";
        assert_eq!(
            AttachmentFsPath::for_storage_id(lowercase).as_str(),
            digest_component_path(lowercase),
            "lowercase direct input must not mint a verbatim path"
        );

        let dotless_i = "ıD-PEER";
        let ascii_i = "ID-PEER";
        let dotless_path = AttachmentFsPath::for_storage_id(dotless_i);
        let ascii_path = AttachmentFsPath::for_storage_id(ascii_i);
        assert_eq!(
            dotless_path.as_str(),
            digest_component_path(dotless_i),
            "a non-ASCII id must not mint the spelling a filesystem may fold"
        );
        assert_eq!(
            ascii_path.as_str(),
            digest_component_path(ascii_i),
            "the ASCII digest-namespace spelling must also take its own digest"
        );
        assert_ne!(
            dotless_path, ascii_path,
            "dotless-ı and ASCII-I ids must remain different files"
        );
    }

    /// #3734 — a component Windows resolves as a device is refused **in the
    /// path**, not only in the fallback id.
    ///
    /// A peer-supplied `attachments/CON` used to parse and be stored. On Windows
    /// the write then fails, or the bytes disappear into the device; either way
    /// `find_missing_attachments` reports the row as missing and asks the peer
    /// for it again on every sync, forever. Nothing else in the pipeline breaks
    /// that loop, which is why it is closed at the parse.
    #[test]
    fn ms_dos_device_components_are_refused_anywhere_in_the_path() {
        for bad in [
            "attachments/CON",
            "attachments/con",
            "attachments/NUL.png",
            "attachments/aux.bin",
            "attachments/LPT9",
            "attachments/com1.tar.gz",
            // Interior components resolve as devices too — the directory
            // itself cannot be created.
            "attachments/PRN/photo.png",
            // Windows strips the trailing space before resolving, so the
            // folded form is what must be tested.
            "attachments/CON ",
            "attachments/nul.",
        ] {
            assert!(
                AttachmentFsPath::parse(bad).is_err(),
                "{bad:?} cannot be written on Windows and must be refused, not \
                 stored and re-requested forever"
            );
        }
        // Names that merely start with a device name are ordinary files.
        for good in [
            "attachments/console.log",
            "attachments/CONTACT",
            "attachments/nulls.bin",
            "attachments/com10",
        ] {
            assert!(
                AttachmentFsPath::parse(good).is_ok(),
                "{good:?} is not a device name and must still parse"
            );
        }
        // And the apply path keeps working: a device-named peer path coerces to
        // this device's own, writable path rather than being rejected.
        let coerced = AttachmentFsPath::coerce_from_peer("attachments/CON", "01J0ATT");
        assert_eq!(coerced.as_str(), "attachments/01J0ATT");
    }

    /// Win32 also reserves COM/LPT followed by the superscript digits ¹, ², or
    /// ³. The stem match is ASCII-case-insensitive and applies before any file
    /// extension, just like the ordinary numbered device names.
    #[test]
    fn superscript_dos_device_stems_are_refused_with_case_and_extensions() {
        for bad in [
            "attachments/COM¹",
            "attachments/com².log",
            "attachments/Com³.tar.gz",
            "attachments/LPT¹",
            "attachments/lpt².bin",
            "attachments/LpT³.data",
        ] {
            assert!(
                AttachmentFsPath::parse(bad).is_err(),
                "{bad:?} is a reserved Win32 device stem and must be refused"
            );
        }
    }

    #[test]
    fn locally_minted_paths_parse() {
        let minted = AttachmentFsPath::for_storage_id("01J0000000000000000000000A");
        assert_eq!(minted.as_str(), "attachments/01J0000000000000000000000A");
        assert!(AttachmentFsPath::parse(minted.as_str()).is_ok());
    }
}
