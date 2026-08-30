# Session 1460 — the comparison that flattered itself

Full re-audit of `COMPARISON.md` (Agaric vs Logseq). The document was last revised
2026-08-04 on top of a 2026-06-17 review. Seven parallel domain audits verified every
Agaric claim against `main` at `12a4cab`; two web audits re-established Logseq's state
as of 2026-08-30.

## Why this was not a refresh

The previous revision was not merely stale. Fifteen of its claims were **false**, and
several of them were load-bearing:

- Sync was described as "mTLS WebSocket with TOFU cert pinning (ECDSA P-256)". That
  stack was deleted in the iroh cutover; the transport is QUIC/UDP with ed25519
  endpoint ids and no certificate anywhere.
- Task/deadline reminders were credited. `notifyTask` has exactly one production
  caller: the "send test notification" button. There is no scheduler, so no reminder
  has ever fired.
- Multi-device sync was rated **Done** and **Better** while `docs/features/sync.md`
  says a full two-way sync end to end remains unverified (#3507), and while a session
  is one-directional by design (#610).
- Tag inheritance was credited as a capability. `block_tag_inherited` is materialized,
  incrementally maintained across five propagation paths, and has a rebuild job — and
  no production caller enables it. (Corrected in review: the resolver *does* read it —
  `src-tauri/agaric-store/src/tag_query/resolve.rs:35,123` — so "no query surface reads
  it" was too strong. `src/lib/tauri/queries.ts:240` supplies `?? false`; only tests
  pass anything else.)
- Inline queries were rated live-updating. `staleTime: Infinity`, no invalidation of
  the `queryExecution` key anywhere; they refetch on mount and on expression change.

A comparison document is used to decide what to build next, so an overstated own-side
column is worse than no document. Part 10 now carries the full corrections log — 15
false claims, 9 overstated, plus the understated capabilities and the refreshed
external numbers.

## The finding that reframed the whole document

Logseq split into two products on 2026-04-24 and shipped **2.0.1 on 2026-07-13**. The
previous revision's premise — "last stable 0.10.15, DB version is nightly-only with
data-loss warnings" — describes a world that ended before it was written.

What 2.0 shipped that the document has to credit: Markdown Mirror (a plain-markdown
projection of a DB graph written to disk, which blunts our "binary vs plain text"
argument *in Logseq's favour*), a native **MCP server** (which removes our exclusivity
on agent access), a bundled CLI with terminal queries, Graph View V2, Table/List/Gallery
views, hourly automated backups, typed properties with multi-value and defaults, and
tags-as-classes with `Extends` multiple inheritance and bidirectional properties.

Over the same ten weeks this repository produced **one `feat` commit**. The last ~460
session logs are guards, fuzzers, mutation harnesses and review follow-ups; the 130-issue
backlog contains almost no product work. The engineering rigour is real — it is the
direction that is the finding.

## Scorecard

Rescored against three columns (OG frozen / 2.0 beta / Agaric) with two new categories,
extensibility and project risk. Linking dropped 8→5 (10 was Logseq's score in that row) (no embeds of any kind, refs are
60-char chips since #4228 removed the hover reveal, `block_links` has no kind
discriminator). Sync dropped 9→5. Task management dropped 10→8. Search rose to 9 —
in-page find with regex and the 11-prefix filter DSL were both missing from the document
entirely.

Totals: **OG 127 / 2.0 142 / Agaric 134**, against the previous "Logseq 127 / Agaric
154". On raw capability Logseq 2.0 is now ahead. Weighted for the target workflow —
journal, tasks, project notes, one person, no cloud — Agaric still wins clearly. Both
statements belong in the document; only the second was there before.

## New: Part 5, what we built and cannot reach

Five subsystems whose cost is paid and whose benefit is not collected: the tag
inheritance table above; `listStyle` (a full read pipeline — `ListMarkerContext`,
`computeListOrdinals`, `ListMarker`, a ProseMirror decoration — whose `setListStyle`
and `clearListStyle` have no production callers, so the app carries two competing list
models); the advanced-query engine (10 property operators and 4 value types, of which
the builder exposes 4 operators on Text only); the notification subsystem; and i18next
(~3,056 keys, one locale, a docblock forbidding a second).

Also recorded there: six documentation claims that are actively false. The worst is
`docs/features/tags-and-links.md` describing block references as rendering "the target
block's content inline, kept live" — they render a 60-character title chip. That line is
very likely where the previous revision's block-ref claims came from.

## Method notes

- The working checkout is a **shallow clone** (76 commits, all dated 2026-08-26 onward),
  so `git log --since` is useless for "what shipped since the last review". Every audit
  hit this independently and fell back to session logs and in-code issue references.
- Test counts were recomputed rather than carried forward: **6,292** Rust test functions
  (`grep -rE '^[[:space:]]*#\[(tokio::)?test(\(|\])' src-tauri --include=*.rs | wc -l`;
  the unanchored form gives 6,312, which is why the command belongs beside the number),
  793 frontend test files, 110 Playwright specs, ~905 total. The old "~15,000+ across
  ~550 files" was an undercount. The axe figure was also understated (**597** assertions
  across **284** files under `src/`) — but only 4 of 110 e2e specs run axe in a real
  browser.
- Quality signals that do not mean what they look like, now stated in the document:
  Stryker runs with `thresholds.break` unset (informational, cannot fail a build); fuzz
  and the bench SLO gate run weekly, not per-PR; the 100K-block benchmark measures
  latency only, never peak memory.

## Not done here

The six false doc claims in Part 5 are flagged, not fixed — they are edits to
`docs/features/*` and belong in their own change. Same for the two stale docblocks
(`advanced_query.rs` "structural-only", `AdvancedQueryView.tsx` "saved views remain a
follow-up").
