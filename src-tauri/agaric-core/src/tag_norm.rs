//! Tag-name normalization — #709 Phase 0 (normalization spec), landed
//! with the #622 tag-convergence fix.
//!
//! A tag's identity IS its (normalized) name (#709): the Loro engine
//! keys each block's tag set by the output of [`normalize_tag_name`],
//! so two peers concurrently adding "#Project" and "#project" converge
//! to one entry by construction. This module is the **single source of
//! truth** for those rules — the SQL re-key (#709 Phase 2), autocomplete
//! and inheritance surfaces (Phase 4) must call this helper rather than
//! re-implementing folding.
//!
//! ## The rules (in order)
//!
//! 1. **NFC** — same canonical composition the FTS pipeline applies at
//!    index *and* query time (`crate::text_utils::nfc_normalise`).
//!    Reused directly so the tag layer cannot drift from
//!    the FTS layer's notion of "the same characters" (e.g. an NFD
//!    `e + U+0301` pasted from Safari composes to `é` in both).
//! 2. **Unicode lowercase** (`str::to_lowercase`) — full Unicode case
//!    folding-by-lowercasing. Deliberately a *superset* of SQLite's
//!    `COLLATE NOCASE` (which folds ASCII `A–Z` only): `Ä`/`ä` are the
//!    same tag here. The ASCII subset behaves identically to NOCASE —
//!    pinned by the drift-guard test below — so the Phase-2 SQL
//!    migration can adopt this helper without re-folding existing
//!    ASCII names differently.
//! 3. **NFC again** — lowercasing an NFC string can emit combining
//!    sequences (e.g. `İ` U+0130 → `i` + U+0307); the second pass
//!    restores canonical composition and makes the function idempotent
//!    (also pinned by test).
//!
//! Deliberately **no trimming / whitespace collapsing**: tag names are
//! `blocks.content` verbatim today, and the SQL layer does not trim —
//! adding it here would make the engine key disagree with every other
//! name surface. Revisit (with a migration) in #709 Phase 2 if desired.
//! A uniqueness check trims anyway, through [`name_key`], which is never
//! stored.
//!
//! ## Stability contract
//!
//! The output is persisted as LoroMap keys inside every vault's CRDT
//! doc (see `BLOCK_TAGS_ROOT` in `loro/engine.rs`). Changing the rules
//! re-keys tag identity and is a wire-format migration, same severity
//! as changing `peer_id_from_device_id` — the pinned-vector test below
//! must only ever change together with such a migration.

use unicode_normalization::UnicodeNormalization;

/// Normalize a tag name to its identity key: NFC → Unicode lowercase
/// → NFC. See the module docs for the rule rationale and stability
/// contract.
pub fn normalize_tag_name(name: &str) -> String {
    crate::text_utils::nfc_normalise(name)
        .to_lowercase()
        .nfc()
        .collect()
}

/// The key two names of one space compare by (#6278): a page title against
/// another page's title or alias, a tag name against another tag's.
/// [`normalize_tag_name`] of the trimmed name, so `Foo`, `foo `, and an NFD
/// spelling of a name are one name. Compared, never stored: the stability
/// contract above covers the engine keys, not this.
///
/// A uniqueness check folds every name of a space, so the fold takes the
/// short way to that key: ASCII lowercases alone, and lowercasing keeps
/// canonical equivalence, so one NFC pass after it suffices, skipped for text
/// already in NFC.
pub fn name_key(name: &str) -> String {
    use unicode_normalization::{IsNormalized, is_nfc_quick};
    let name = name.trim();
    if name.is_ascii() {
        return name.to_ascii_lowercase();
    }
    let lower = name.to_lowercase();
    if is_nfc_quick(lower.chars()) == IsNormalized::Yes {
        lower
    } else {
        lower.nfc().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{name_key, normalize_tag_name};
    use proptest::prelude::*;

    proptest! {
        /// `name_key`'s fast paths fold exactly as the tag key of the trimmed
        /// name does.
        #[test]
        fn name_key_is_the_tag_key_of_the_trimmed_name(
            name in "[ \t\u{a0}\u{85}a-zA-Z\u{c0}-\u{24f}\u{300}-\u{36f}\u{130}\u{131}\u{3a3}\u{3c2}\u{1e9e}\u{212a}\u{212b}\u{1100}-\u{1112}\u{1161}-\u{1175}\u{ac00}-\u{ac10}]{0,12}",
        ) {
            prop_assert_eq!(name_key(&name), normalize_tag_name(name.trim()));
        }

        #[test]
        fn name_key_is_the_tag_key_of_any_trimmed_string(name in any::<String>()) {
            prop_assert_eq!(name_key(&name), normalize_tag_name(name.trim()));
        }
    }

    /// The `nameKeyCases` rows the mock's `nameKey` is pinned by too
    /// (`src/lib/__tests__/name-tokens.test.ts`).
    #[test]
    fn name_key_matches_the_shared_vectors() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Vectors {
            name_key_cases: Vec<Case>,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            input: String,
            key: String,
        }
        let vectors: Vectors = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../conformance/reference-tokens.vectors.json"
        )))
        .expect("the vectors are valid JSON");
        assert!(!vectors.name_key_cases.is_empty());
        for case in vectors.name_key_cases {
            assert_eq!(name_key(&case.input), case.key, "{}", case.name);
        }
    }

    /// Drift guard (pattern: #589) — the tag rules must stay aligned
    /// with the FTS pipeline's NFC normalisation: feeding the helper an
    /// already-FTS-normalised string must change nothing, and a raw NFD
    /// string must reach the same key as its NFC twin.
    #[test]
    fn agrees_with_fts_nfc_rules() {
        let samples = [
            "Draft re\u{0301}sume\u{0301}", // NFD é (Safari paste shape)
            "Draft r\u{e9}sum\u{e9}",       // NFC é
            "ANGSTRO\u{30a}M",              // NFD Å
            "\u{1e9e}-Straße",              // capital ẞ
            "plain ascii TAG",
        ];
        for s in samples {
            assert_eq!(
                normalize_tag_name(s),
                normalize_tag_name(&crate::text_utils::nfc_normalise(s)),
                "tag key for {s:?} must be invariant under FTS NFC \
                 normalisation"
            );
        }
        // NFD and NFC spellings of the same name → same key.
        assert_eq!(
            normalize_tag_name("re\u{0301}ussi"),
            normalize_tag_name("r\u{e9}ussi"),
        );
    }

    /// Drift guard — on the ASCII range the fold must match SQLite's
    /// `COLLATE NOCASE` (A–Z → a–z, everything else untouched), so the
    /// #709 Phase-2 SQL adoption cannot diverge for existing ASCII
    /// names.
    #[test]
    fn ascii_fold_matches_sqlite_nocase() {
        for b in 0u8..=127 {
            let c = b as char;
            let nocase = if c.is_ascii_uppercase() {
                c.to_ascii_lowercase()
            } else {
                c
            };
            assert_eq!(
                normalize_tag_name(&c.to_string()),
                nocase.to_string(),
                "ASCII {c:?} must fold exactly like COLLATE NOCASE"
            );
        }
    }

    /// Idempotence — required for a persisted identity key (re-running
    /// the helper over an already-normalized key must be a no-op), incl.
    /// the U+0130 case where lowercasing emits a combining sequence.
    #[test]
    fn is_idempotent() {
        let samples = ["I\u{0130}stanbul", "ẞß", "Σίσυφος ΣΊΣΥΦΟΣ", "Ǆǅǆ"];
        for s in samples {
            let once = normalize_tag_name(s);
            assert_eq!(
                normalize_tag_name(&once),
                once,
                "normalize_tag_name must be idempotent for {s:?}"
            );
        }
    }

    /// Pinned vectors — the persisted-key wire format. Changing any of
    /// these is a CRDT-doc migration (see module docs), not a refactor.
    #[test]
    fn pinned_known_values() {
        for (input, expected) in [
            ("Project", "project"),
            ("ÄRGER", "ärger"),
            ("re\u{0301}ussi", "r\u{e9}ussi"),
            ("\u{0130}", "i\u{0307}"),
            ("01HZ0000000000000000000T0X", "01hz0000000000000000000t0x"),
        ] {
            assert_eq!(normalize_tag_name(input), expected);
        }
    }
}
