# Session 2834 — COMPARISON.md, revision 2026-10-21

The Agaric vs Logseq comparison was last revised on 2026-08-30 at v0.9.9. Since then 1,076 PRs merged on Agaric's side, 0.9.9 to 0.20.0, and Logseq shipped 2.0.2, still in beta. This revision re-verifies both columns.

- **Method.** Three read-only audits, each citing code or a URL for every changed claim:
  - Logseq OG and 2.0 since 2026-08-30;
  - Agaric's editor, page, linking, template and import sections;
  - Agaric's data, sync, agent, mobile and scorecard sections.

  A writer applied them, and a separate verifier then spot-checked about 35 claims against the code and the cited sources. It fixed three errors (the iroh version, the theme count, Logseq's Open Collective budget) and toned down claims that outran their evidence.
- **Scorecard.** Old totals 127 / 142 / 134 (Logseq OG / 2.0 / Agaric); new 127 / 144 / 144.
  - Agaric gains in page management, editor, linking, tags, queries, agent access, sync and extensibility.
  - Logseq 2.0 gains in search and mobile.
  - Logseq 2.0's agent-access rise was declined: the token API merged after the 2.0.2 release, and the scorecard counts shipped functionality.
- **Corrections of the last revision.**
  - Logseq 2.0 has used a trigram FTS index since 2024, so the CJK and substring "Better" holds against OG only.
  - Template insertion was never atomic.
  - `FilterPrimitive` has 23 variants; one audit's 24 was wrong.
  - Priority levels are fixed at 1/2/3 since #6017, which is a regression from "Better".
- **New parts.**
  - Part 7 is a per-persona table.
  - Part 11, "Coming from Logseq / Coming from Obsidian", ranks each app's popular features by the plugin marketplaces' download stats and says how well Agaric supports each.
- **Sync, from the maintainer.** Sync is used daily between Android and Linux, in both directions. The document now leads with sync as the differentiator and ranks the five gaps that keep it from working out of the box:
  1. discovery across networks;
  2. background sync on Android;
  3. backup;
  4. the invisible quarantine;
  5. proof on other networks.

  `docs/features/sync.md` and `docs/FEATURE-MAP.md` no longer call two-way sync unverified. #3507 closed in August, and `e2e-tauri/sync-two-device.e2e.ts` is a required lane.

Checks run: markdownlint, `check-doc-code-paths`, `check-md-link-targets`, `check-dead-symbol-citations`, `check-architecture-citations` and typos over the changed files.
