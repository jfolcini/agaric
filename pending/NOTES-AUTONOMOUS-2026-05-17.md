# Notes — autonomous implementation cycle (2026-05-17 overnight)

> The maintainer asked me to implement pending/ plans cycle-after-cycle while sleeping,
> with the standing rule: **don't ask questions if I can help it; log decisions here**.
> This file is the audit trail for every non-trivial decision I made without their input.
> Review before scheduling the next cycle.

## Scope I picked up

Plans tackled in dependency order (each its own commit):

1. **PEND-50** — search foundation (page-grouped renderer + FTS5 snippet highlighting)
2. **PEND-54** — inline filter syntax framework (depends on PEND-50)
3. **PEND-52** — in-page find (frontend-only, independent)
4. **PEND-55** — toggle row + search history (depends on PEND-50)
5. **PEND-51** — Cmd+K palette (depends on PEND-50)
6. **PEND-53** — property filters (depends on PEND-54)

## Plans I deliberately skipped (rationale)

- **PEND-10 (iroh transport adoption)** — explicitly L scale (14-19 weeks), needs the
  maintainer's iroh-stability spike decision. Not autonomously implementable.
- **PEND-36 (Play Store publishing)** — has 3 open maintainer decisions (D1-D3) about
  account ownership, paperwork path, and the closed-test cohort. Not autonomously
  decidable.
- **PEND-49 (OSSF Silver roadmap)** — requires the maintainer to fill in the
  bestpractices.dev self-assessment form. Not autonomously fillable.
- **PEND-56/57/58 (Pages view trio)** — substantial scope (~55-67 h combined), and the
  three were authored in the very session that ran out of time; landing them on top of
  fresh plans is high-risk. Deferred to the maintainer's next supervised cycle.
- **design-system-perf-review-2026-05-09.md** — two open items, neither scoped tightly
  enough for an autonomous pass.

## Standing decisions applied across every plan

These resolve the "Open questions" sections where the plan offered a recommendation;
I took the **Recommendation** verbatim unless noted otherwise.

- **Feature flags.** Where a plan proposes a flag (e.g. PEND-50's `searchV1` rollout
  flag, PEND-55's `searchToggles` etc.), I shipped behind the flag default-on, and added
  a localStorage override so a downgrade leaves users on the old path. **Why:** keeps
  rollback cheap if the maintainer dislikes any landed change.
- **i18n keys.** Every new string lands as an English-default i18n key in
  `src/i18n/locales/en.json`. No machine-translation; the maintainer adds other locales
  when they want.
- **Telemetry.** No telemetry instrumentation added in this autonomous pass. The plans
  call out instrumentation as deferred; I left it deferred.
- **Backend wire compat.** Every IPC change is additive (`#[serde(default)]` on new
  fields). Old frontends keep working against new backend, and vice versa.

## Per-plan decisions (filled in as each cycle lands)

### PEND-50 — search foundation — LANDED (`95a55773`)

- **Page-name-only counts:** "1 match (in name)" via new `search.matchCountInGroupNameOnly` i18n key (plan's recommendation).
- **`<mark>` highlight contrast:** reused `--accent` / `--accent-foreground` theme tokens (light ≈ 7.1:1, dark ≈ 8.0:1; both clear WCAG AA). No new tokens.
- **Snippet window constant:** left at backend default 32. Bumping deferred to a later perf pass.
- **`useListKeyboardNavigation` not extended:** kept the hook unchanged; routed `onKeyDown` through a new `listOnKeyDown` prop on `CollapsibleGroupList`. Workaround is short + idiomatic; no TODO needed.
- **i18n delivery shape:** the codebase uses TS-namespace files (`src/lib/i18n/references.ts`), not JSON locale files. The plan's step referring to `src/i18n/locales/en.json` collapses into the references.ts additions.
- **SearchHelpDialog export shape:** named export (Biome `lint/style/noDefaultExport` is enforced project-wide).
- **Existing tests migrated:** `src/lib/__tests__/tauri.test.ts` and `src/components/__tests__/SearchPanel.test.tsx` updated to the new struct shape; behaviour assertions unchanged.
- **Test delta:** +43 (10 backend, 33 frontend). 9925 / 9925 vitest, 3682 / 3682 nextest, clippy clean.
- **Biome rule ignores added (2, both with rationale comments):** `aria-activedescendant` on conditional-role `<ul>` in `CollapsibleGroupList`; `role="option"` on `<li>` in `SearchResultBlockRow`. Both are canonical WAI-ARIA listbox patterns the linter misclassifies.

### PEND-54 — inline filter syntax

(populated when cycle completes)

### PEND-52 — in-page find

(populated when cycle completes)

### PEND-55 — toggle row + search history

(populated when cycle completes)

### PEND-51 — Cmd+K palette

(populated when cycle completes)

### PEND-53 — property filters

(populated when cycle completes)

## State at end of autonomous cycle

(populated when the loop terminates — final commit, final CI status, what's
landed vs. what's not, anything red the maintainer needs to triage)
