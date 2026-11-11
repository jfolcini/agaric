# Session 3797 — Versioned derivations, and the integrity report in plain words

The maintainer wanted the class of #6488 eliminated: a change to a rule a cache stores the output of left every row written before it stale, and the integrity check reported each one. Session 3786 (#6492) re-stripped `fts_blocks` once; this replaces that one-off marker with a mechanism, and rewrites the report for a reader who is not us.

## What shipped

- `agaric-store/src/derivations.rs`: a `Derivation` per rule (FTS strip, link tokens, tag-ref tokens, agenda, title sort key, page-link roll-up), each with a version and an `app_settings` key. Each vault-wide rebuild records its version once it has written everything; boot's `rebuild_stale_derivations` rebuilds every cache whose recorded version is not the code's. The block links and the title keys have no materializer task, so `rederive_block_links` and `rekey_title_sort_keys` run there in one transaction each.
- The tie: `a_rule_whose_output_changed_has_a_new_version` hashes each rule's output over the four `conformance/*.vectors.json` files (SQL rules hash their statement) and fails, naming both new values, when the output moves without the version.
- The report: the screen groups divergences into out-of-date caches (rebuildable), disagreements with the sync engine, and blocks with a non-standard id. Each group says what it is and what to do, and each table gets its plain name and problem above the internal artefact name, three of its keys and one truncated expected-versus-found pair. The pair is on screen only; Copy and the bug report carry group labels, names, counts and every key, never note text (#609, #4854). Only the box, its border and its heading are tinted, so the text keeps the normal tokens' contrast.
- `rebuild_derived_state`: rebuilds every cache, then returns the settled report. Never the engine rows, which no rebuild repairs.
- The membership check skips blocks in `sync_deferred_purges` (a flag on the oracle's block dump, read without a join), and `blocks.id_form` reports blocks whose `id`, `parent_id` or `page_id` is not uppercase.

## Decisions and traps

- The existing `repair.block_links_backfill.v2` and `repair.agenda_cache_rewrite.v1` markers stay: they already ran, and retiring them meant deleting their tests for no gain. New rules use the registry.
- `ArtefactDivergences` is unchanged and the samples ride an optional report field, because Rust and TS tests build both shapes literally.
- The pages-cache rebuild only keys rows whose title changed, so a title-key rule change needs its own pass; the rebuild alone would never reach existing rows.
- The PR moved to `claude/6488-integrity-report` off fresh `main` once #6492 merged; the earlier branch was based on #6492's and would have needed a force-push.
- The cloud container's disk filled three times; `CARGO_INCREMENTAL=0` keeps the target directory from regrowing.

## Tests

Each new test was shown red first: the golden test against placeholder goldens and again against a mutated `TAG_REF_RE`, which it named. Two existing tests changed under the maintainer's standing rule because they pinned wording the maintainer asked to replace; the PR body lists them.
