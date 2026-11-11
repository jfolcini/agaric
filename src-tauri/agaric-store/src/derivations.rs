//! Versioned derivations (#6488).
//!
//! A derived cache stores the OUTPUT of a rule: the FTS strip, the link and
//! tag-ref token regexes, the agenda projection, the Pages title sort key, the
//! page-link roll-up. A change to the rule changes what the next write
//! produces, but the rows already in the cache keep the old output until
//! something rewrites them, and the integrity check, which folds with the new
//! rule, reports every one of them.
//!
//! So each rule carries a [`Derivation::version`]. A completed vault-wide
//! rebuild of the cache records the version in `app_settings` under
//! [`Derivation::key`] ([`record`]), and boot rebuilds every cache whose
//! recorded version is not the code's ([`stale`]). The golden test below
//! hashes each rule's output over the shared conformance vectors and fails
//! when the output changes while the version does not.

use sqlx::SqlitePool;

use agaric_core::error::AppError;

/// A rule whose output a cache stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Derivation {
    /// `fts_blocks.stripped`: `fts::strip::strip_for_fts_with_maps`.
    FtsStrip,
    /// `block_links`: `cache::ULID_LINK_RE` and `classify_link_kind`.
    LinkTokens,
    /// `block_tag_refs`: `cache::TAG_REF_RE`.
    TagRefTokens,
    /// `agenda_cache`: `cache::agenda::DESIRED_AGENDA_SQL`.
    Agenda,
    /// `pages_cache.title_sort_key`: `agaric_core::title_sort::title_sort_key`.
    TitleSortKey,
    /// `page_link_cache`: the roll-up in `rebuild_page_link_cache`.
    PageLink,
}

impl Derivation {
    pub const ALL: [Self; 6] = [
        Self::FtsStrip,
        Self::LinkTokens,
        Self::TagRefTokens,
        Self::Agenda,
        Self::TitleSortKey,
        Self::PageLink,
    ];

    /// The `app_settings` key a completed rebuild records the version under.
    pub const fn key(self) -> &'static str {
        match self {
            Self::FtsStrip => "derivation.fts_strip",
            Self::LinkTokens => "derivation.link_tokens",
            Self::TagRefTokens => "derivation.tag_ref_tokens",
            Self::Agenda => "derivation.agenda",
            Self::TitleSortKey => "derivation.title_sort_key",
            Self::PageLink => "derivation.page_link",
        }
    }

    /// Bump when the rule's output changes, together with its entry in the
    /// golden test's `GOLDEN`; the test names both.
    pub const fn version(self) -> i64 {
        match self {
            Self::FtsStrip
            | Self::LinkTokens
            | Self::TagRefTokens
            | Self::Agenda
            | Self::TitleSortKey
            | Self::PageLink => 1,
        }
    }
}

/// Record that the cache `derivation` feeds now holds the current version's
/// output. Called by each vault-wide rebuild once it has written everything,
/// so a rebuild that fails or is cut short leaves the old version and the
/// next boot runs it again.
///
/// # Errors
/// Returns [`AppError`] if the write fails.
pub async fn record<'e, E>(executor: E, derivation: Derivation) -> Result<(), AppError>
where
    E: sqlx::SqliteExecutor<'e>,
{
    let key = derivation.key();
    let version = derivation.version().to_string();
    let now = crate::db::now_ms();
    sqlx::query!(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at \
         WHERE app_settings.value != excluded.value",
        key,
        version,
        now,
    )
    .execute(executor)
    .await?;
    Ok(())
}

/// The derivations whose cache was last rebuilt by another version of the
/// rule, or never: a newer one as well as an older one, so a downgrade
/// rebuilds with the rule it runs.
///
/// # Errors
/// Returns [`AppError`] if the read fails.
pub async fn stale(pool: &SqlitePool) -> Result<Vec<Derivation>, AppError> {
    let mut out = Vec::new();
    for derivation in Derivation::ALL {
        let key = derivation.key();
        let recorded: Option<String> =
            sqlx::query_scalar!("SELECT value FROM app_settings WHERE key = ?", key)
                .fetch_optional(pool)
                .await?;
        if recorded.as_deref() != Some(derivation.version().to_string().as_str()) {
            out.push(derivation);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// Each rule's `(version, golden)`: the version it is at, and the hash of
    /// its output over the conformance vectors at that version. The test
    /// fails on any change to the output, and its message gives both new
    /// values, so a change lands with a bump and every vault rebuilds once.
    const GOLDEN: [(Derivation, i64, u64); 6] = [
        (Derivation::FtsStrip, 1, 9_581_885_676_308_416_399),
        (Derivation::LinkTokens, 1, 6_396_512_025_153_374_395),
        (Derivation::TagRefTokens, 1, 15_668_115_924_102_391_061),
        (Derivation::Agenda, 1, 12_540_476_427_942_296_593),
        (Derivation::TitleSortKey, 1, 5_063_557_284_513_772_505),
        (Derivation::PageLink, 1, 7_934_981_724_046_892_647),
    ];

    const VECTOR_FILES: [&str; 4] = [
        include_str!("../../../conformance/block-content.vectors.json"),
        include_str!("../../../conformance/reference-tokens.vectors.json"),
        include_str!("../../../conformance/document-lines.vectors.json"),
        include_str!("../../../conformance/attachment-refs.vectors.json"),
    ];

    /// The fields of the vector files that hold stored or typed text.
    const TEXT_KEYS: [&str; 5] = ["content", "input", "editor", "transformed", "title"];

    fn vectors() -> Vec<serde_json::Value> {
        VECTOR_FILES
            .iter()
            .map(|file| serde_json::from_str(file).expect("conformance vectors are JSON"))
            .collect()
    }

    /// Every text the vectors carry, in file order.
    fn corpus() -> Vec<String> {
        fn walk(value: &serde_json::Value, key: Option<&str>, out: &mut Vec<String>) {
            match value {
                serde_json::Value::String(s) if key.is_some_and(|k| TEXT_KEYS.contains(&k)) => {
                    out.push(s.clone());
                }
                serde_json::Value::Array(items) => {
                    for item in items {
                        walk(item, key, out);
                    }
                }
                serde_json::Value::Object(map) => {
                    for (k, v) in map {
                        walk(v, Some(k), out);
                    }
                }
                _ => {}
            }
        }
        let mut out = Vec::new();
        for file in vectors() {
            walk(&file, None, &mut out);
        }
        out
    }

    /// `name -> id` resolutions in `field` of the reference-token vectors,
    /// turned into the `id -> name` map the strip reads.
    fn names_by_id(field: &str) -> HashMap<String, String> {
        let file = &vectors()[1];
        file[field]
            .as_object()
            .expect("a resolutions map")
            .iter()
            .map(|(name, id)| (id.as_str().expect("an id").to_owned(), name.clone()))
            .collect()
    }

    /// The lines of `source` between `start` and `end`, comments and blank
    /// lines dropped, for a rule whose output is its SQL.
    fn code_between(source: &str, start: &str, end: &str) -> String {
        let from = source.find(start).expect("start marker");
        let to = from + source[from..].find(end).expect("end marker");
        source[from..to]
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn output(derivation: Derivation) -> Vec<String> {
        let corpus = corpus();
        match derivation {
            Derivation::FtsStrip => {
                let tags = names_by_id("tagResolutions");
                let pages = names_by_id("pageResolutions");
                let block_titles: HashMap<String, String> =
                    serde_json::from_value(vectors()[0]["blockRefTargets"].clone())
                        .expect("block-ref targets");
                corpus
                    .iter()
                    .map(|text| {
                        crate::fts::strip::strip_for_fts_with_maps(
                            "",
                            text,
                            &tags,
                            &pages,
                            &block_titles,
                        )
                    })
                    .collect()
            }
            Derivation::LinkTokens => corpus
                .iter()
                .flat_map(|text| {
                    crate::cache::ULID_LINK_RE.captures_iter(text).map(|caps| {
                        let target = &caps[1];
                        format!(
                            "{target} {}",
                            crate::cache::classify_link_kind(text, target)
                        )
                    })
                })
                .collect(),
            Derivation::TagRefTokens => corpus
                .iter()
                .flat_map(|text| {
                    crate::cache::TAG_REF_RE
                        .captures_iter(text)
                        .map(|caps| caps[1].to_owned())
                })
                .collect(),
            Derivation::Agenda => vec![crate::cache::DESIRED_AGENDA_SQL.to_owned()],
            Derivation::TitleSortKey => corpus
                .iter()
                .map(|text| agaric_core::title_sort::title_sort_key(text))
                .collect(),
            Derivation::PageLink => vec![code_between(
                include_str!("cache/page_links.rs"),
                "async fn rebuild_page_link_cache_impl",
                "/// Read/write split variant of [`rebuild_page_link_cache`]",
            )],
        }
    }

    /// FNV-1a over the outputs, each closed by a NUL: stable across
    /// platforms and toolchains, which `DefaultHasher` is not.
    fn hash(outputs: &[String]) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in outputs
            .iter()
            .flat_map(|o| o.bytes().chain(std::iter::once(0)))
        {
            h ^= u64::from(byte);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        h
    }

    #[test]
    fn a_rule_whose_output_changed_has_a_new_version() {
        let mut stale = Vec::new();
        for (derivation, version, golden) in GOLDEN {
            let outputs = output(derivation);
            assert!(!outputs.is_empty(), "{derivation:?} hashed no output");
            let now = hash(&outputs);
            if now != golden || version != derivation.version() {
                stale.push(format!(
                    "{derivation:?}: output hash {now} (golden {golden}), version {} \
                     (golden {version}). If the output changed, bump `Derivation::version` \
                     and set GOLDEN to ({derivation:?}, <new version>, {now}). A pure \
                     reformat of the hashed source changes no output: set only the new \
                     golden and keep the version, so no vault rebuilds for it.",
                    derivation.version()
                ));
            }
        }
        assert!(stale.is_empty(), "{}", stale.join("\n"));
    }

    #[test]
    fn every_derivation_has_a_golden_and_a_distinct_key() {
        let golden: Vec<Derivation> = GOLDEN.iter().map(|(d, _, _)| *d).collect();
        assert_eq!(golden, Derivation::ALL.to_vec());
        let mut keys: Vec<&str> = Derivation::ALL.iter().map(|d| d.key()).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), Derivation::ALL.len());
    }

    #[tokio::test]
    async fn a_recorded_version_is_not_stale_and_another_is() {
        let (pool, _dir) = crate::test_support::test_pool().await;
        assert_eq!(
            stale(&pool).await.unwrap(),
            Derivation::ALL.to_vec(),
            "a vault no rebuild has recorded is behind on every rule"
        );
        record(&pool, Derivation::Agenda).await.unwrap();
        let key = Derivation::PageLink.key();
        sqlx::query!(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, '0', 0)",
            key
        )
        .execute(&pool)
        .await
        .unwrap();
        let behind = stale(&pool).await.unwrap();
        assert!(!behind.contains(&Derivation::Agenda), "recorded: current");
        assert!(
            behind.contains(&Derivation::PageLink),
            "another version: behind"
        );
        assert_eq!(behind.len(), Derivation::ALL.len() - 1);
    }

    /// A title key an older rule wrote is rewritten from the title, and the
    /// pass records the rule's version.
    #[tokio::test]
    async fn a_title_key_an_older_rule_wrote_is_rekeyed() {
        let (pool, _dir) = crate::test_support::test_pool().await;
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) \
             VALUES ('01J0000000000000000000PAGE', 'page', 'Émile')"
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO pages_cache (page_id, title, title_sort_key, updated_at) \
             VALUES ('01J0000000000000000000PAGE', 'Émile', 'Émile', 1)"
        )
        .execute(&pool)
        .await
        .unwrap();

        let rewritten = crate::cache::rekey_title_sort_keys(&pool).await.unwrap();

        let key: String = sqlx::query_scalar!("SELECT title_sort_key FROM pages_cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!((rewritten, key.as_str()), (1, "emile"));
        assert!(
            !stale(&pool)
                .await
                .unwrap()
                .contains(&Derivation::TitleSortKey)
        );
    }

    /// A link the stored edges lack is derived from the content, and the pass
    /// records the rule's version.
    #[tokio::test]
    async fn a_link_the_edges_lack_is_rederived() {
        let (pool, _dir) = crate::test_support::test_pool().await;
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES \
             ('01J0000000000000000000TRGT', 'page', 'Target'), \
             ('01J0000000000000000000SRCE', 'content', 'see [[01J0000000000000000000TRGT]]')"
        )
        .execute(&pool)
        .await
        .unwrap();

        crate::cache::rederive_block_links(&pool).await.unwrap();

        let edges: Vec<(String, String)> =
            sqlx::query!("SELECT source_id, target_id FROM block_links")
                .fetch_all(&pool)
                .await
                .unwrap()
                .into_iter()
                .map(|r| (r.source_id, r.target_id))
                .collect();
        assert_eq!(
            edges,
            vec![(
                "01J0000000000000000000SRCE".to_owned(),
                "01J0000000000000000000TRGT".to_owned()
            )]
        );
        assert!(
            !stale(&pool)
                .await
                .unwrap()
                .contains(&Derivation::LinkTokens)
        );
    }
}
