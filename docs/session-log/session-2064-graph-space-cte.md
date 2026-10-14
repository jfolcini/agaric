# Session 2064 — Graph: narrow the space CTE, gate the scoped probe

Item 4 of #5426. #5538 (#5415) removed the unscoped `list_page_links` read,
so the `interactive_slo` probe that had been in the green tier since #2178
now measures the space-scoped read, and that read was over budget.

`fetch_page_link_edges` and `count_page_link_edges` built `space_members`
from every block in the space and checked both ends of each cache row
against it. Every rendered endpoint is a live page, so the CTE now takes
`block_type = 'page' AND deleted_at IS NULL`, a range of
`idx_blocks_space_type`. The trap: without `sqlite_stat1` the planner turns
both `IN` lists into index seek keys and probes every (page, page) pair,
which is slower than the old shape; a unary `+` on each keeps them filters
on the cache scan. The dead `?1 IS NULL OR` arm went with it. The old
queries stay as `#[cfg(test)]` oracles, and a test asserts both agree on a
two-space fixture with content blocks, deleted pages, tag filters and caps.

Measured: on this box the narrowed read is about a quarter faster at 100K
(fetch and count alike). CI runners vary by up to about 1.7× between runs of
the same code, so CI only bounds it: `main`'s read ran several times over its
200 ms budget, and the narrowed one is still over it on every runner. Under
budget needs the space on `page_link_cache` itself, a schema change left to
the maintainer on #5426. The probe moves to the gated problem tier with a
deferred assertion, and `docs/architecture/operations.md` says why.

Item 4's `ORDER BY edge_count DESC` over every live edge is untouched.
Items 1–3 are separate PRs.

Suites run: the `pages::links` and `list_page_links` nextest subsets, with
the oracle test shown red against two mutated copies (the fetch CTE taking
only deleted pages, the count dropping the target-membership filter); the
pre-push verify; clippy and `cargo doc` with the CI lint flags over the
workspace; and the `bench-slo` lane dispatched on this branch with the
problem tier enabled, plus once on `main` for the before number.
