# `pending/` — planned tasks

> **Workplans now live as GitHub issues**, not files in this directory.
>
> Browse: [`plan` label](https://github.com/jfolcini/agaric/issues?q=is%3Aissue+is%3Aopen+label%3Aplan). When a plan is finished or rejected, close the issue — `git log` + the issue is the audit trail.
>
> This file curates a recommended order across the open `plan`-labelled issues. It is **not** the index; the label is. If the recommended order goes stale and nobody is reading it, delete it.

## What's still in this directory

- `IDEAS.md` — long-running idea backlog (not work-plan tickets).
- `REVIEW-LATER.md` — single-task notes that don't warrant their own issue.
- `README.md` — this file.

## Recommended order (curated, 2026-05-27)

Dependency- and impact-ordered. The quick wins are independent of each other and of the sync epic.

**Recently shipped (closed issues, kept here for context):**

- PEND-76 — pre-existing data-integrity fixes (F1–F5). Shipped via PR #53. F1 remote-change propagation + F5 sync-ingress gating fold into the sync epic; F2/F3 still want a real-device smoke test.
- PEND-78 / PEND-79 / PEND-77 Tier A — quick wins shipped together: recent-strip cross-space leak fix, AppImage Linux desktop self-integration, and `word_diff` + `space_filter_canonical` property tests.

**Active — pick a quick win:**

- [#89 — PEND-83](https://github.com/jfolcini/agaric/issues/89) Hierarchical pages: pill display + child-pages leak into Unlinked refs. **~6-10 h, FE-only, in-use.** Recommended first.
- [#83 — PEND-68](https://github.com/jfolcini/agaric/issues/83) Dedicated star/delete page actions + quick-nav in the recent strip. ~10-14 h, FE-only, complements PEND-83.
- [#81 — PEND-57](https://github.com/jfolcini/agaric/issues/81) Pages view: multi-select + bulk operations + saved views. ~17-22 h; resolve the 5 open Qs before coding.

**Sync epic — Option A locked, latent until sync is in use:**

- [#86 — PEND-80](https://github.com/jfolcini/agaric/issues/86) Extend Loro engine: typed values, real `deleted_at`, `LoroTree`. Foundation for the rest.
- [#87 — PEND-81](https://github.com/jfolcini/agaric/issues/87) Make sync complete & rock-solid (re-projects remote changes once PEND-80 lands).

Option B (op-based sync) is rejected. The maintainer doesn't currently sync — weigh against in-use features before scheduling.

**Strategic / decision-gated:**

- [#78 — PEND-10](https://github.com/jfolcini/agaric/issues/78) iroh transport adoption. 14-19 weeks; start with a 3-week time-boxed Phase 0 spike. Kill criterion: iroh v1.0 wire-format stability.
- [#79 — PEND-36](https://github.com/jfolcini/agaric/issues/79) Publish on Google Play Store. ~1 day eng + multi-week paperwork; 3 maintainer decisions (D1-D3) gate the engineering.
- [#80 — PEND-49](https://github.com/jfolcini/agaric/issues/80) OpenSSF Best Practices Passing → Silver. ~10-20 h cheap wins; answer the meta-question ("pursue Silver at all while solo?") before doing more than the form update.

**Watch-only / deferred:**

- [#82 — PEND-66](https://github.com/jfolcini/agaric/issues/82) Replace `document.execCommand` once browsers actually drop support. Revisit quarterly.
- [#84 — PEND-69](https://github.com/jfolcini/agaric/issues/84) `noExcessiveCognitiveComplexity` ×13 prod refactor — deliberately deferred (regression-risky sub-function extraction).
- [#88 — PEND-82](https://github.com/jfolcini/agaric/issues/88) Biome → OXC toolchain migration. Latent — Biome is currently clean, this is ecosystem alignment, not pain relief.

**Cross-cutting / dated notes:**

- [#90 — Design-system performance review (2026-05-09)](https://github.com/jfolcini/agaric/issues/90) Tier 1.3 + Tier 2.6 follow-up.

## Workflow notes

- Open each issue's body before starting — it has the full plan, cost/impact/risk, and open questions.
- Reviewer corrections go in issue comments. The body is the plan; comments are the diff.
- When a plan is done or rejected, **close the issue** (don't delete it — closed issues remain searchable and the body stays as historical record).
- Keep this `recommended order` curated by hand; otherwise the `plan` label filter on GitHub is the index.
