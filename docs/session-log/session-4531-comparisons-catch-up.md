# Session 4531 — the README and the Logseq and Obsidian comparisons catch up with main

The maintainer asked for the comparisons with Obsidian and Logseq, and the README, to be checked again: a lot had shipped since #6881 last checked them against the code on 2026-11-18. A Logseq subagent and an Obsidian subagent each took one page pair; this session did the README and reconciled the scorecards.

**What had gone stale.** Issues the pages still named as open gaps had closed: a date-and-time property type (#6758), the mirror adopting a vault or Markdown folder in place (#6540), a tag page you can write on with properties for its blocks (#6755), five complete interface languages (#6750) and checkboxes in embedded rows (#6747). The pages' trip-over lists repeated the matrices' claims, so each correction was made in every copy. Headings folding their sections (#7137) moved the Obsidian *Folding* row to Done.

**Decisions.**

- #6755 is suggested keys plus a bulk set, not inheritance: a tag offers its directly tagged blocks empty rows of its keys and writes nothing until one is filled. Both matrices gained a row for it. In the Logseq matrix, *Tags as classes* is Partial (no defaults, no `Extends`). In the Obsidian matrix, *A tag's page* is Better vs core. Logseq points: Tags 7 → 8.
- The mirror refuses a Logseq graph (`is_logseq_graph` in `src-tauri/src/mirror/adopt.rs`), so the Logseq page says adoption is for a Markdown folder and a graph is imported.
- Upstream: Logseq's newest release is still 2.0.2, so no Logseq cell moved. Obsidian's roadmap lists MCP as active, not shipped, and official agent skills as launched; the web viewer reached mobile in 1.15.1.

**Found, not fixed here.** `docs/SEARCH.md` and `docs/features/properties.md` document `prop:start>2026-11-14T09:30`, but `parsePropToken` in `src/lib/search-query/register.ts` accepts only `key=value`. The matrices follow the code.

**Checks.** `prek run --files` on every changed page (markdownlint, link targets, typos) and `node scripts/comparison-scorecard.mjs --check`.
