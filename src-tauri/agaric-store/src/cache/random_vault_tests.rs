//! A seeded stream of raw-SQL writes over the tables the whole-vault rebuilds
//! read (`blocks`, `block_tags`, `block_properties`, `block_links`) and the caches they
//! write, for the tests that hold a rebuild against the form it replaced
//! (#6522): the same writes go to two databases, each rebuild runs on one,
//! and the caches must stay equal.
//!
//! The writes are not what commands produce. A rebuild is a function of the
//! tables it reads, so the tests reach more of its inputs by writing those
//! tables directly: drifted `space_id`s, cache rows for blocks that should
//! have none, names that collide only after Unicode folding.

use sqlx::SqlitePool;

const PAGES: usize = 6;
const CONTENTS: usize = 18;
const TAGS: usize = 8;
const SPACES: [&str; 2] = ["0000000000000000000000SPC0", "0000000000000000000000SPC1"];
const TAG_NAMES: [&str; 8] = [
    "alpha",
    "Alpha",
    "beta",
    "ÉCOLE",
    "école",
    "date/2025-01-05",
    "date/2025-01-06",
    "date/2025-13-99",
];
const DATES: [&str; 3] = ["2025-01-05", "2025-01-06", "2025-02-01"];
const DATE_KEYS: [&str; 4] = ["due", "deadline", "created_at", "repeat-until"];

/// xorshift64*, so a failure names the seed that made it.
pub(crate) struct RandomVault(u64);

fn id(kind: &str, n: usize) -> String {
    format!("{:0>26}", format!("{kind}{n}"))
}

impl RandomVault {
    pub(crate) fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        usize::try_from(self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 33).unwrap() % n
    }

    fn page(&mut self) -> String {
        id("PG", self.below(PAGES))
    }

    fn tag(&mut self) -> String {
        id("TG", self.below(TAGS))
    }

    fn block(&mut self) -> String {
        match self.below(6) {
            0 => self.page(),
            1 => self.tag(),
            _ => id("CT", self.below(CONTENTS)),
        }
    }

    /// A space, quoted, or `NULL`.
    fn space(&mut self) -> String {
        match self.below(3) {
            0 => "NULL".to_owned(),
            n => format!("'{}'", SPACES[n - 1]),
        }
    }

    fn date(&mut self) -> &'static str {
        DATES[self.below(DATES.len())]
    }

    /// Content naming two tags and one block that is not a tag.
    fn text(&mut self) -> String {
        format!(
            "note #[{}] #[{}] #[{}]",
            self.tag(),
            self.tag(),
            id("CT", self.below(CONTENTS))
        )
    }

    /// The two spaces every later write may name.
    pub(crate) async fn seed_spaces(pools: &[&SqlitePool]) {
        for space in SPACES {
            for sql in [
                format!(
                    "INSERT INTO blocks (id, block_type, content, page_id) \
                     VALUES ('{space}', 'page', 'space', '{space}')"
                ),
                format!("INSERT OR IGNORE INTO spaces (id) VALUES ('{space}')"),
            ] {
                for pool in pools {
                    sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
                        .execute(*pool)
                        .await
                        .unwrap();
                }
            }
        }
    }

    /// Run the next write on every pool. A write the schema refuses (a
    /// missing parent, a CHECK) is refused on all of them alike. Returns
    /// whether it was accepted.
    pub(crate) async fn mutate(&mut self, pools: &[&SqlitePool]) -> bool {
        let sql = self.statement();
        let mut accepted = Vec::with_capacity(pools.len());
        for pool in pools {
            let result = sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
                .execute(*pool)
                .await;
            accepted.push(result.is_ok());
        }
        assert!(
            accepted.iter().all(|ok| *ok == accepted[0]),
            "the pools diverged on `{sql}`: {accepted:?}"
        );
        accepted[0]
    }

    fn statement(&mut self) -> String {
        match self.below(24) {
            0..=1 => self.insert_page(),
            2..=5 => self.insert_content(),
            6..=7 => self.insert_tag(),
            8..=9 => format!(
                "INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES ('{}', '{}')",
                self.block(),
                self.tag()
            ),
            10 => format!(
                "DELETE FROM block_tags WHERE block_id = '{}' AND tag_id = '{}'",
                self.block(),
                self.tag()
            ),
            11 => self.rewrite_content(),
            12 => format!(
                "UPDATE blocks SET deleted_at = 1767139200000 WHERE id = '{}'",
                self.block()
            ),
            13 => format!(
                "UPDATE blocks SET deleted_at = NULL WHERE id = '{}'",
                self.block()
            ),
            14 => self.set_date_column(),
            15 => self.write_property(),
            16 => format!(
                "UPDATE blocks SET space_id = {} WHERE id = '{}'",
                self.space(),
                self.block()
            ),
            17 => self.reparent(),
            18 => {
                let block = self.block();
                format!(
                    "DELETE FROM blocks WHERE id = '{block}' AND NOT EXISTS \
                     (SELECT 1 FROM blocks c WHERE c.parent_id = '{block}')"
                )
            }
            19 => format!(
                "INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES ('{}', '{}')",
                self.block(),
                self.block()
            ),
            20 => format!(
                "DELETE FROM block_links WHERE source_id = '{}'",
                self.block()
            ),
            _ => self.stale_a_cache(),
        }
    }

    fn insert_page(&mut self) -> String {
        let (page, n, space) = (self.page(), self.below(4), self.space());
        format!(
            "INSERT OR IGNORE INTO blocks (id, block_type, content, page_id, space_id) \
             VALUES ('{page}', 'page', 'Page {n}', '{page}', {space})"
        )
    }

    /// A content block under a page or an earlier content block, so the tree
    /// stays acyclic. It takes its parent's page; its space is the parent's,
    /// or now and then another one.
    fn insert_content(&mut self) -> String {
        let n = self.below(CONTENTS);
        let parent = self.earlier_parent(n);
        let space = if self.below(5) == 0 {
            self.space()
        } else {
            format!("(SELECT space_id FROM blocks WHERE id = '{parent}')")
        };
        format!(
            "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, page_id, space_id) \
             VALUES ('{}', 'content', '{}', '{parent}', \
                     (SELECT page_id FROM blocks WHERE id = '{parent}'), {space})",
            id("CT", n),
            self.text()
        )
    }

    fn earlier_parent(&mut self, n: usize) -> String {
        if n == 0 || self.below(3) == 0 {
            self.page()
        } else {
            id("CT", self.below(n))
        }
    }

    fn insert_tag(&mut self) -> String {
        format!(
            "INSERT OR IGNORE INTO blocks (id, block_type, content, space_id) \
             VALUES ('{}', 'tag', '{}', {})",
            self.tag(),
            TAG_NAMES[self.below(TAG_NAMES.len())],
            self.space()
        )
    }

    /// New content for one block: a name for a tag, a title or text with tag
    /// references for the rest, sometimes none at all.
    fn rewrite_content(&mut self) -> String {
        match self.below(5) {
            0 => format!(
                "UPDATE blocks SET content = NULL WHERE id = '{}'",
                self.block()
            ),
            1..=2 => format!(
                "UPDATE blocks SET content = '{}' WHERE id = '{}'",
                TAG_NAMES[self.below(TAG_NAMES.len())],
                self.tag()
            ),
            _ => format!(
                "UPDATE blocks SET content = '{}' WHERE id = '{}' AND block_type != 'tag'",
                self.text(),
                self.block()
            ),
        }
    }

    fn set_date_column(&mut self) -> String {
        let column = ["due_date", "scheduled_date"][self.below(2)];
        let value = if self.below(4) == 0 {
            "NULL".to_owned()
        } else {
            format!("'{}'", self.date())
        };
        format!(
            "UPDATE blocks SET {column} = {value} WHERE id = '{}'",
            self.block()
        )
    }

    fn write_property(&mut self) -> String {
        match self.below(6) {
            0 => format!(
                "INSERT OR REPLACE INTO block_properties (block_id, key, value_text) \
                 VALUES ('{}', 'template', 'true')",
                self.page()
            ),
            1 => format!(
                "DELETE FROM block_properties WHERE block_id = '{}'",
                self.block()
            ),
            _ => format!(
                "INSERT OR REPLACE INTO block_properties (block_id, key, value_date) \
                 VALUES ('{}', '{}', '{}')",
                self.block(),
                DATE_KEYS[self.below(DATE_KEYS.len())],
                self.date()
            ),
        }
    }

    fn reparent(&mut self) -> String {
        let n = self.below(CONTENTS);
        let parent = self.earlier_parent(n);
        format!(
            "UPDATE blocks SET parent_id = '{parent}', \
                 page_id = (SELECT page_id FROM blocks WHERE id = '{parent}') \
             WHERE id = '{}' AND block_type = 'content'",
            id("CT", n)
        )
    }

    /// Drift planted in a cache: a row removed, a row altered, or a row for a
    /// block that should have none.
    fn stale_a_cache(&mut self) -> String {
        let (block, tag, other, space, date) = (
            self.block(),
            self.tag(),
            self.block(),
            self.space(),
            self.date(),
        );
        match self.below(17) {
            0 => format!("DELETE FROM agenda_cache WHERE block_id = '{block}'"),
            1 => format!(
                "INSERT OR REPLACE INTO agenda_cache (date, block_id, source) \
                 VALUES ('{date}', '{block}', 'property:due')"
            ),
            2 => format!(
                "UPDATE agenda_cache SET source = 'column:due_date' WHERE block_id = '{block}'"
            ),
            3 => format!("DELETE FROM block_tag_refs WHERE source_id = '{block}'"),
            4 => format!(
                "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) \
                 VALUES ('{block}', '{other}')"
            ),
            5 => format!("DELETE FROM tags_cache WHERE tag_id = '{tag}'"),
            6 => format!(
                "UPDATE tags_cache SET usage_count = usage_count + 1 WHERE tag_id = '{tag}'"
            ),
            7 => format!("UPDATE OR IGNORE tags_cache SET name = 'stale' WHERE tag_id = '{tag}'"),
            8 => {
                format!("UPDATE OR IGNORE tags_cache SET space_id = {space} WHERE tag_id = '{tag}'")
            }
            9 => format!(
                "INSERT OR IGNORE INTO tags_cache (tag_id, space_id, name, usage_count, updated_at) \
                 VALUES ('{block}', {space}, 'ghost', 3, '')"
            ),
            10 => format!("DELETE FROM pages_cache WHERE page_id = '{block}'"),
            11 => format!(
                "UPDATE pages_cache SET title = 'stale', title_sort_key = '' \
                 WHERE page_id = '{block}'"
            ),
            12 => format!(
                "UPDATE pages_cache SET space_id = {space}, last_edited_ms = 0 \
                 WHERE page_id = '{block}'"
            ),
            13 => format!(
                "INSERT OR IGNORE INTO pages_cache (page_id, title, updated_at) \
                 VALUES ('{block}', 'ghost', 1)"
            ),
            14 => format!(
                "UPDATE pages_cache SET inbound_link_count = 7, child_block_count = 7 \
                 WHERE page_id = '{block}'"
            ),
            15 => format!("DELETE FROM block_tag_inherited WHERE block_id = '{block}'"),
            _ => format!(
                "INSERT OR REPLACE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
                 VALUES ('{block}', '{tag}', '{other}')"
            ),
        }
    }
}

/// Every row of `table`, in a stable order, for comparing two databases.
/// `columns` leaves out the timestamps a rebuild takes from the clock.
pub(crate) async fn rows(pool: &SqlitePool, table: &str, columns: &str) -> Vec<String> {
    let sql = format!("SELECT json_array({columns}) FROM {table} ORDER BY json_array({columns})");
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_all(pool)
        .await
        .unwrap()
}

/// Hold a rebuild against the form it replaced: over several seeds, write
/// the same random rounds to two databases, run `oracle` on one and
/// `rebuild` on the other after each round, and assert that they report the
/// same number of changes and leave `table` equal. Both return that number.
///
/// Fails if the rounds never gave the rebuilds anything to change or never
/// left a row in `table`, so the comparison cannot pass on empty tables.
pub(crate) async fn assert_rebuild_matches_oracle(
    table: &str,
    columns: &str,
    oracle: impl AsyncFn(&SqlitePool) -> u64,
    rebuild: impl AsyncFn(&SqlitePool) -> u64,
) {
    const SEEDS: u64 = 6;
    const ROUNDS: usize = 30;
    const WRITES_PER_ROUND: usize = 8;
    let (mut rounds_with_changes, mut most_rows) = (0, 0);
    for seed in 1..=SEEDS {
        let (oracle_pool, _oracle_dir) = crate::test_support::test_pool().await;
        let (pool, _dir) = crate::test_support::test_pool().await;
        let pools = [&oracle_pool, &pool];
        RandomVault::seed_spaces(&pools).await;
        let mut vault = RandomVault::new(seed);
        for round in 0..ROUNDS {
            for _ in 0..WRITES_PER_ROUND {
                vault.mutate(&pools).await;
            }
            let expected = oracle(&oracle_pool).await;
            let changed = rebuild(&pool).await;
            let got = rows(&pool, table, columns).await;
            assert_eq!(
                got,
                rows(&oracle_pool, table, columns).await,
                "seed {seed}, round {round}: {table} differs from the oracle's"
            );
            assert_eq!(
                changed, expected,
                "seed {seed}, round {round}: changes reported"
            );
            rounds_with_changes += usize::from(expected > 0);
            most_rows = most_rows.max(got.len());
        }
    }
    assert!(
        rounds_with_changes >= 10 && most_rows >= 3,
        "the rounds must give the rebuild work: {rounds_with_changes} rounds changed {table}, \
         which held at most {most_rows} rows"
    );
}
