## Session 982 — graph edge-set telemetry tripwire (#426) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#426` |
| **Dimension** | performance (scaling; mobile-conditional, medium) |
| **Tests** | existing list_page_links suite (no behaviour change) |
| **Files touched** | 1 |
| **Schema / wire-format** | none |

**Summary:** `list_page_links_inner_split` (graph view) loads the ENTIRE edge
set in one `fetch_all` with no `LIMIT` — intentional (the renderer wants the
whole graph), and the query is well-indexed. But on a 10k+ page vault with high
link density the edge set can grow large enough to strain the mobile webview
once `Vec<PageLink>` crosses the IPC boundary.

The audit's recommendation has two tiers: (1) a mobile **ego-graph / edge-cap
degradation** (truncate or neighborhood-load), and (2) "at minimum, **measure**
peak memory / IPC payload before shipping mobile." Tier 1 is a UX decision
(silently dropping graph edges) that needs product sign-off and a real
device-memory measurement — out of scope for a unilateral backend change, and
consistent with this campaign's bench-first handling of measure-flagged scaling
items (#416/#424).

This ships the safe minimum: a **warn-only telemetry tripwire**. When the
returned edge set exceeds `GRAPH_EDGE_WARN_THRESHOLD` (50k), a `warn!` fires
with the edge count — **nothing is truncated**, so there is no behaviour/UX
change. The scaling regime becomes observable in logs *before* it OOMs a device
(the "measure/surface before shipping mobile" minimum). The threshold is
explicitly documented as a telemetry tripwire, NOT a functional limit: its exact
value only governs when the log fires, to be calibrated against real device
measurements when the mobile degradation is designed.

**Deferred (documented in code + PR):** the truncating edge cap / ego-graph
degradation, pending a UX decision + device-memory measurement.

**Files touched:**
- `commands/pages.rs` — `GRAPH_EDGE_WARN_THRESHOLD` const + post-fetch warn in `list_page_links_inner_split`.

**Verification:**
- `cargo nextest run list_page_links page_link` → **34 passed** (no behaviour
  change — the warn is observational; the full edge set is still returned).
  clippy + rustfmt clean.

**Commit plan:** single commit; branched off `main`; PR against `main`.
